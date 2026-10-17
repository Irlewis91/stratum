// STRATUM for Windows: the native audio engine. Each plugin track is a strip: instrument (or sample voices) -> effects ->
// volume and pan -> master -> the Windows audio output (WASAPI). Notes and samples arrive from the page with a delay in
// seconds; mixdowns are rendered offline through the same strips. Mirrors shell/plugins.swift on the Mac.
#include "engine.h"
#include "plughost.h"
#include "../shell/airwin.h"
#include "../shell/wavesynth.h"
#include "../shell/tune.h"
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <shlobj.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

namespace engine {
namespace {

std::string utf8(const std::wstring &w) {
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    if (n) WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}
std::wstring wide(const std::string &s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    if (n) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}
double nowSeconds() { static LARGE_INTEGER f = [] { LARGE_INTEGER x; QueryPerformanceFrequency(&x); return x; }(); LARGE_INTEGER c; QueryPerformanceCounter(&c); return (double)c.QuadPart / f.QuadPart; }

// ---------------------------------------------------------------- transport
struct Transport {
    std::atomic<double> bpm{120}, beat0{0}, t0{0};
    std::atomic<bool> playing{false};
    std::atomic<double> offlineBeat{-1};
    double beat() const { double o = offlineBeat; if (o >= 0) return o; return playing ? beat0 + (nowSeconds() - t0) * bpm / 60 : (double)beat0; }
    bool moving() const { return playing || offlineBeat >= 0; }
} transport;

// ---------------------------------------------------------------- samples and voices
struct Sample { std::vector<float> l, r; double rate = 44100; };

struct Voice {
    bool active = false;
    std::shared_ptr<Sample> sample;
    double pos = 0, step = 1;
    float gain = 1;
    long long start = 0;
    long long hold = LLONG_MAX;
    int attack = 0, release = 1, released = -1;
    long long age = 0;
    bool loop = false;
};

class VoiceBank {
public:
    static const int size = 96;
    void add(const Voice &v) {
        std::lock_guard<std::mutex> g(lock);
        int slot = 0; long long oldest = -1;
        for (int i = 0; i < size; i++) { if (!voices[i].active) { slot = i; break; } if (voices[i].age > oldest) { oldest = voices[i].age; slot = i; } }
        voices[slot] = v; voices[slot].active = true;
    }
    void clear() { std::lock_guard<std::mutex> g(lock); for (auto &v : voices) v = Voice(); }
    void render(long long time, int frames, float *l, float *r) {
        std::fill(l, l + frames, 0.f); std::fill(r, r + frames, 0.f);
        if (!lock.try_lock()) return;
        for (auto &v : voices) {
            if (!v.active) continue;
            Sample *s = v.sample.get();
            if (!s || s->l.size() < 2) { v.active = false; continue; }
            const long long count = (long long)s->l.size();
            bool done = false;
            int from = (int)std::max(0LL, std::min((long long)frames, v.start - time));
            for (int f = from; f < frames; f++) {
                float env = v.attack > 0 && v.age < v.attack ? (float)v.age / v.attack : 1.f;
                if (v.age >= v.hold) { v.released++; env *= std::max(0.f, 1.f - (float)v.released / v.release); if (v.released >= v.release) { done = true; break; } }
                long long i0 = (long long)v.pos;
                if (i0 >= count - 1) { if (v.loop && count > 1) { v.pos -= (double)(count - 1); i0 = (long long)v.pos; } else { done = true; break; } }
                float fr = (float)(v.pos - (double)i0), g = v.gain * env;
                l[f] += (s->l[i0] + (s->l[i0 + 1] - s->l[i0]) * fr) * g;
                r[f] += (s->r[i0] + (s->r[i0 + 1] - s->r[i0]) * fr) * g;
                v.pos += v.step; v.age++;
            }
            if (done) { v.active = false; v.sample.reset(); }
        }
        lock.unlock();
    }
private:
    std::mutex lock;
    Voice voices[size];
};

// ---------------------------------------------------------------- units
struct Unit {
    virtual ~Unit() {}
    virtual bool instrument() const = 0;
    virtual void setup(double sr, int maxFrames) = 0;
    virtual void note(int on, int pitch, float vel, int offset) {}
    virtual void allOff() {}
    virtual void process(const float *const *in, float *const *out, int n) = 0;
    virtual Json params() { return Json::array(); }
    virtual std::string setParam(int i, double v) { return ""; }
    virtual std::string state() { return ""; }
    virtual void setState(const std::string &b64) {}
    virtual bool openEditor(HWND, int *, int *) { return false; }
    virtual void closeEditor() {}
    virtual void idle() {}
};

void resizeEditor(void *hwnd, int w, int h) {
    HWND win = GetAncestor((HWND)hwnd, GA_ROOT);
    RECT r{0, 0, w, h};
    AdjustWindowRectEx(&r, (DWORD)GetWindowLongPtrW(win, GWL_STYLE), FALSE, (DWORD)GetWindowLongPtrW(win, GWL_EXSTYLE));
    SetWindowPos(win, nullptr, 0, 0, r.right - r.left, r.bottom - r.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}

struct PlugUnit : Unit {
    V3 *p;
    bool inst;
    std::vector<int> held;
    explicit PlugUnit(V3 *v) : p(v), inst(v3_is_instrument(v) != 0) {}
    ~PlugUnit() { v3_destroy(p); }
    bool instrument() const override { return inst; }
    void setup(double sr, int max) override { v3_setup(p, sr, max); }
    void note(int on, int pitch, float vel, int off) override { v3_note(p, on, pitch, vel, off); }
    void allOff() override { for (int k = 0; k < 128; k += 1) v3_note(p, 0, k, 0, 0); }
    void process(const float *const *in, float *const *out, int n) override { v3_transport(p, transport.bpm, transport.beat(), transport.moving()); v3_process(p, in, out, n); }
    Json params() override {
        Json out = Json::array();
        for (int i = 0, n = std::min(64, v3_param_count(p)); i < n; i++) {
            unsigned id = 0; int steps = 0; char name[256] = {0}, text[128] = {0};
            if (!v3_param_info(p, i, &id, name, sizeof name, &steps)) continue;
            double v = v3_param_get(p, id);
            v3_param_text(p, id, v, text, sizeof text);
            Json e; e["i"] = (int)id; e["name"] = name; e["v"] = v; e["text"] = text;
            out.push(e);
        }
        return out;
    }
    std::string setParam(int i, double v) override { char text[128] = {0}; v3_param_set(p, (unsigned)i, v); v3_param_text(p, (unsigned)i, v3_param_get(p, (unsigned)i), text, sizeof text); return text; }
    std::string state() override {
        unsigned char *d = nullptr; int n = 0;
        if (!v3_get_state(p, &d, &n) || !d) return "";
        std::string s = "W3:" + b64encode(d, n); v3_free(d); return s;
    }
    void setState(const std::string &st) override {
        if (st.rfind("W3:", 0) != 0) return;   // settings saved by the Mac app are in its own format
        auto d = b64decode(st.substr(3)); if (!d.empty()) v3_set_state(p, d.data(), (int)d.size());
    }
    bool openEditor(HWND h, int *w, int *hh) override { return v3_open_view(p, h, w, hh, resizeEditor) != 0; }
    void closeEditor() override { v3_close_view(p); }
    void idle() override { v3_idle(p); }
};

// Built-in units share one shape: numbered controls, each 0..1 or a list of options.
struct Control { std::string name; int options = 0; };
std::string pct(double v) { char t[32]; snprintf(t, sizeof t, "%.0f%%", v * 100); return t; }

struct AirwinUnit : Unit {
    void *fx;
    explicit AirwinUnit(void *f) : fx(f) {}
    ~AirwinUnit() { aw_destroy(fx); }
    bool instrument() const override { return false; }
    void setup(double sr, int) override { aw_set_rate(fx, sr); }
    void process(const float *const *in, float *const *out, int n) override { aw_process(fx, (float **)in, (float **)out, n); }
    Json params() override {
        Json out = Json::array();
        for (int i = 0; i < aw_params(fx); i++) {
            char name[256] = {0}, text[256] = {0};
            aw_param_name(fx, i, name, sizeof name); aw_param_display(fx, i, text, sizeof text);
            Json e; e["i"] = i; e["name"] = name; e["v"] = (double)aw_get(fx, i); e["text"] = text; out.push(e);
        }
        return out;
    }
    std::string setParam(int i, double v) override { aw_set(fx, i, (float)std::max(0.0, std::min(1.0, v))); char t[256] = {0}; aw_param_display(fx, i, t, sizeof t); return t; }
    std::string state() override { Json a = Json::array(); for (int i = 0; i < aw_params(fx); i++) a.push((double)aw_get(fx, i)); return "WJ:" + a.dump(); }
    void setState(const std::string &st) override { if (st.rfind("WJ:", 0) != 0) return; Json a = Json::parse(st.substr(3)); for (size_t i = 0; i < a.size(); i++) aw_set(fx, (int)i, (float)a[i].num()); }
};

struct WaveUnit : Unit {
    void *s = ws_create(48000);
    ~WaveUnit() { ws_destroy(s); }
    bool instrument() const override { return true; }
    void setup(double sr, int) override { ws_set_rate(s, sr); }
    void note(int on, int pitch, float vel, int off) override { ws_note(s, on, pitch, vel, off); }
    void allOff() override { ws_all_off(s); }
    void process(const float *const *, float *const *out, int n) override { ws_transport(s, transport.bpm, transport.beat()); ws_process(s, out[0], out[1], n); }
    Json params() override {
        Json out = Json::array();
        for (int i = 0; i < ws_param_count(); i++) {
            char text[128] = {0}; ws_display(s, i, text, sizeof text);
            float v = ws_get(s, i); int n = ws_param_options(i); bool indexed = ws_param_kind(i) == 1;
            Json e; e["i"] = i; e["name"] = ws_param_name(i); e["text"] = text;
            e["v"] = indexed ? (n > 1 ? v / (n - 1) : 0.0) : (double)v;
            if (indexed) { Json o = Json::array(); for (int k = 0; k < n; k++) o.push(ws_param_option(i, k)); e["options"] = o; e["index"] = (int)std::lround(v); }
            out.push(e);
        }
        return out;
    }
    std::string setParam(int i, double v) override {
        v = std::max(0.0, std::min(1.0, v));
        if (ws_param_kind(i) == 1) { int n = ws_param_options(i); ws_set(s, i, (float)std::lround(v * (n - 1))); } else ws_set(s, i, (float)v);
        char t[128] = {0}; ws_display(s, i, t, sizeof t); return t;
    }
    std::string state() override {
        Json j; Json a = Json::array(); for (int i = 0; i < ws_param_count(); i++) a.push((double)ws_get(s, i)); j["v"] = a;
        for (int osc = 0; osc < 2; osc++) {
            const float *d = nullptr; const char *name = nullptr; int n = ws_custom_table(s, osc, &d, &name);
            if (n > 0 && d) { j["t" + std::to_string(osc)] = b64encode((const unsigned char *)d, (size_t)n * 2048 * 4); j["n" + std::to_string(osc)] = name ? name : "Imported"; }
        }
        return "WJ:" + j.dump();
    }
    void setState(const std::string &st) override {
        if (st.rfind("WJ:", 0) != 0) return;
        Json j = Json::parse(st.substr(3));
        for (int osc = 0; osc < 2; osc++) {
            auto d = b64decode(j["t" + std::to_string(osc)].str());
            if (d.size() >= 2048 * 4) ws_load_table(s, osc, (const float *)d.data(), (int)(d.size() / (2048 * 4)), j["n" + std::to_string(osc)].str("Imported").c_str());
        }
        for (size_t i = 0; i < j["v"].size(); i++) ws_set(s, (int)i, (float)j["v"][i].num());
    }
};

struct TuneUnit : Unit {
    void *t = tn_create(48000);
    ~TuneUnit() { tn_destroy(t); }
    bool instrument() const override { return false; }
    void setup(double sr, int) override { tn_set_rate(t, sr); }
    void process(const float *const *in, float *const *out, int n) override { tn_process(t, in, out, n); }
    Json params() override {
        Json out = Json::array();
        for (int i = 0; i < tn_param_count(); i++) {
            char text[64] = {0}; tn_display(t, i, text, sizeof text);
            float v = tn_get(t, i); int n = tn_param_options(i); bool indexed = tn_param_kind(i) == 1;
            Json e; e["i"] = i; e["name"] = tn_param_name(i); e["text"] = text;
            e["v"] = indexed ? (n > 1 ? v / (n - 1) : 0.0) : (double)v;
            if (indexed) { Json o = Json::array(); for (int k = 0; k < n; k++) o.push(tn_param_option(i, k)); e["options"] = o; e["index"] = (int)std::lround(v); }
            out.push(e);
        }
        return out;
    }
    std::string setParam(int i, double v) override {
        v = std::max(0.0, std::min(1.0, v));
        if (tn_param_kind(i) == 1) { int n = tn_param_options(i); tn_set(t, i, (float)std::lround(v * (n - 1))); } else tn_set(t, i, (float)v);
        char s[64] = {0}; tn_display(t, i, s, sizeof s); return s;
    }
    std::string state() override { Json a = Json::array(); for (int i = 0; i < tn_param_count(); i++) a.push((double)tn_get(t, i)); return "WJ:" + a.dump(); }
    void setState(const std::string &st) override { if (st.rfind("WJ:", 0) != 0) return; Json a = Json::parse(st.substr(3)); for (size_t i = 0; i < a.size(); i++) tn_set(t, (int)i, (float)a[i].num()); }
};

// ---------------------------------------------------------------- strips
struct Event { long long at; int on, pitch; float vel; };
const int MAXF = 4096;
struct Strip {
    std::unique_ptr<Unit> inst;
    std::string instID;
    std::vector<std::unique_ptr<Unit>> fx;
    std::vector<std::string> fxIDs;
    std::unique_ptr<VoiceBank> bank;
    std::atomic<float> vol{0.8f}, pan{0}; std::atomic<bool> mute{false};
    std::mutex evLock;
    std::vector<Event> events;
    std::map<int, HWND> windows;
    std::vector<float> a[2], b[2];
    Strip() { for (int c = 0; c < 2; c++) { a[c].assign(MAXF, 0); b[c].assign(MAXF, 0); } events.reserve(1024); }
};

HWND mainWnd = nullptr;
std::function<void(int, const Json &)> replyFn;
std::mutex graph;                                   // the audio thread skips a block while the main thread holds this
std::mutex structure;                               // main-thread requests and strip changes (the audio thread never waits on it)
std::map<std::string, std::unique_ptr<Strip>> strips;
std::map<std::string, std::shared_ptr<Sample>> samples;
std::atomic<float> master{1};
std::atomic<long long> sampleTime{0};
std::atomic<double> rate{48000};
std::atomic<bool> offline{false}, offlineAck{false}, quit{false};
std::atomic<float> peak{0};
std::thread audioThread;

// One block of the whole engine, at engine time `t0`. Called on the audio thread (or the main thread for mixdowns).
void renderBlock(long long t0, int n, float *L, float *R) {
    std::fill(L, L + n, 0.f); std::fill(R, R + n, 0.f);
    if (!graph.try_lock()) return;
    for (auto &kv : strips) {
        Strip &s = *kv.second;
        float *a[2] = {s.a[0].data(), s.a[1].data()}, *b[2] = {s.b[0].data(), s.b[1].data()};
        if (s.inst) {
            if (s.evLock.try_lock()) {
                // Notes due in this block, in time order (a note-off before a note-on at the same moment).
                Event due[256]; int nd = 0;
                for (size_t i = 0; i < s.events.size() && nd < 256;) {
                    if (s.events[i].at < t0 + n) { due[nd++] = s.events[i]; s.events[i] = s.events.back(); s.events.pop_back(); }
                    else i++;
                }
                s.evLock.unlock();
                std::sort(due, due + nd, [](const Event &x, const Event &y) { return x.at != y.at ? x.at < y.at : x.on < y.on; });
                for (int i = 0; i < nd; i++) s.inst->note(due[i].on, due[i].pitch, due[i].vel, (int)std::max(0LL, std::min((long long)n - 1, due[i].at - t0)));
            }
            s.inst->process(nullptr, a, n);
        } else if (s.bank) s.bank->render(t0, n, a[0], a[1]);
        else continue;
        for (auto &f : s.fx) { f->process(a, b, n); std::swap(a[0], b[0]); std::swap(a[1], b[1]); }
        if (s.mute) continue;
        float v = s.vol, p = std::max(-1.f, std::min(1.f, (float)s.pan)), gl = v * std::min(1.f, 1 - p), gr = v * std::min(1.f, 1 + p);
        for (int i = 0; i < n; i++) { L[i] += a[0][i] * gl; R[i] += a[1][i] * gr; }
    }
    graph.unlock();
    float m = master, pk = peak;
    for (int i = 0; i < n; i++) { L[i] *= m; R[i] *= m; pk = std::max(pk, std::fabs(L[i])); }
    peak = pk;
}

// ---------------------------------------------------------------- Windows audio output
void audioMain() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    DWORD task = 0; HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    std::vector<float> L(MAXF), R(MAXF);
    while (!quit) {
        IMMDeviceEnumerator *en = nullptr; IMMDevice *dev = nullptr; IAudioClient *client = nullptr; IAudioRenderClient *render = nullptr; WAVEFORMATEX *fmt = nullptr;
        HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        bool ok = SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void **)&en))
            && SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &dev))
            && SUCCEEDED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void **)&client))
            && SUCCEEDED(client->GetMixFormat(&fmt))
            && SUCCEEDED(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 100000, 0, fmt, nullptr))
            && SUCCEEDED(client->SetEventHandle(ev))
            && SUCCEEDED(client->GetService(__uuidof(IAudioRenderClient), (void **)&render));
        UINT32 frames = 0;
        if (ok) ok = SUCCEEDED(client->GetBufferSize(&frames)) && SUCCEEDED(client->Start());
        if (!ok) {
            // No sound device (or it is busy): keep time moving silently, and try again in a few seconds.
            if (fmt) CoTaskMemFree(fmt);
            if (render) render->Release(); if (client) client->Release(); if (dev) dev->Release(); if (en) en->Release(); CloseHandle(ev);
            double sr = rate; if (sr <= 0) rate = 48000;
            for (int k = 0; k < 300 && !quit; k++) {
                Sleep(10);
                if (offline) { offlineAck = true; continue; }
                offlineAck = false;
                int n = (int)(rate * 0.01);
                long long t = sampleTime; renderBlock(t, n, L.data(), R.data()); sampleTime = t + n;
            }
            continue;
        }
        rate = fmt->nSamplesPerSec;
        bool isFloat = fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT || (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE && ((WAVEFORMATEXTENSIBLE *)fmt)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
        int ch = fmt->nChannels, bits = fmt->wBitsPerSample;
        {   // plugins learn the device's sample rate
            std::lock_guard<std::mutex> g(graph);
            for (auto &kv : strips) { if (kv.second->inst) kv.second->inst->setup(rate, MAXF); for (auto &f : kv.second->fx) f->setup(rate, MAXF); }
        }
        while (!quit) {
            if (WaitForSingleObject(ev, 200) != WAIT_OBJECT_0) continue;
            UINT32 pad = 0;
            if (FAILED(client->GetCurrentPadding(&pad))) break;   // the device went away: start over
            UINT32 avail = frames - pad;
            if (!avail) continue;
            BYTE *data = nullptr;
            if (FAILED(render->GetBuffer(avail, &data))) break;
            for (UINT32 done = 0; done < avail;) {
                int n = (int)std::min<UINT32>(avail - done, MAXF);
                if (offline) { offlineAck = true; std::fill(L.begin(), L.begin() + n, 0.f); std::fill(R.begin(), R.begin() + n, 0.f); }
                else { offlineAck = false; long long t = sampleTime; renderBlock(t, n, L.data(), R.data()); sampleTime = t + n; }
                for (int i = 0; i < n; i++) {
                    for (int c = 0; c < ch; c++) {
                        float x = c == 0 ? L[i] : c == 1 ? R[i] : 0.f;
                        size_t at = ((size_t)(done + i) * ch + c);
                        if (isFloat) ((float *)data)[at] = x;
                        else if (bits == 16) ((short *)data)[at] = (short)std::max(-32768.f, std::min(32767.f, x * 32767.f));
                        else if (bits == 32) ((int *)data)[at] = (int)std::max(-2147483648.0, std::min(2147483647.0, (double)x * 2147483647.0));
                    }
                }
                done += n;
            }
            render->ReleaseBuffer(avail, 0);
        }
        client->Stop();
        CoTaskMemFree(fmt); render->Release(); client->Release(); dev->Release(); en->Release(); CloseHandle(ev);
        if (!quit) Sleep(500);
    }
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    CoUninitialize();
}

// ---------------------------------------------------------------- plugin catalogue
std::wstring dataDir() {
    PWSTR p = nullptr; std::wstring d;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &p))) d = std::wstring(p) + L"\\STRATUM";
    CoTaskMemFree(p); CreateDirectoryW(d.c_str(), nullptr); return d;
}
std::vector<std::wstring> pluginFolders() {
    std::vector<std::wstring> f;
    wchar_t buf[MAX_PATH];
    if (GetEnvironmentVariableW(L"CommonProgramFiles", buf, MAX_PATH)) { f.push_back(std::wstring(buf) + L"\\VST3"); f.push_back(std::wstring(buf) + L"\\VST2"); f.push_back(std::wstring(buf) + L"\\Steinberg\\VST2"); }
    if (GetEnvironmentVariableW(L"ProgramFiles", buf, MAX_PATH)) { f.push_back(std::wstring(buf) + L"\\VSTPlugins"); f.push_back(std::wstring(buf) + L"\\Steinberg\\VSTPlugins"); }
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH)) f.push_back(std::wstring(buf) + L"\\Programs\\Common\\VST3");
    DWORD n = sizeof buf;
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\VST", L"VSTPluginsPath", RRF_RT_REG_SZ, nullptr, buf, &n) == ERROR_SUCCESS) f.push_back(buf);
    if (GetEnvironmentVariableW(L"STRATUM_VST3_PATH", buf, MAX_PATH)) f.push_back(buf);
    return f;
}
void findPlugins(const std::wstring &dir, std::vector<std::wstring> &out, int depth = 0) {
    if (depth > 6) return;
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((dir + L"\\*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        std::wstring name = fd.cFileName;
        if (name == L"." || name == L"..") continue;
        std::wstring path = dir + L"\\" + name, low = name;
        for (auto &c : low) c = towlower(c);
        bool v3 = low.size() > 5 && low.compare(low.size() - 5, 5, L".vst3") == 0, dll = low.size() > 4 && low.compare(low.size() - 4, 4, L".dll") == 0;
        if (v3) out.push_back(path);                         // a .vst3 file, or a .vst3 bundle folder (not looked inside)
        else if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) findPlugins(path, out, depth + 1);
        else if (dll) out.push_back(path);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
}
long long stampOf(const std::wstring &path) {
    WIN32_FILE_ATTRIBUTE_DATA a; if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &a)) return 0;
    return ((long long)a.ftLastWriteTime.dwHighDateTime << 32) | a.ftLastWriteTime.dwLowDateTime;
}
std::string readFile(const std::wstring &p) {
    HANDLE f = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (f == INVALID_HANDLE_VALUE) return "";
    std::string s; char buf[65536]; DWORD n = 0;
    while (ReadFile(f, buf, sizeof buf, &n, nullptr) && n) s.append(buf, n);
    CloseHandle(f); return s;
}
void writeFile(const std::wstring &p, const std::string &s) {
    HANDLE f = CreateFileW(p.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
    if (f == INVALID_HANDLE_VALUE) return;
    DWORD n = 0; WriteFile(f, s.data(), (DWORD)s.size(), &n, nullptr); CloseHandle(f);
}

// Every VST3 and VST2 plugin in the standard folders. Each file is opened once and the result remembered until it changes,
// because opening a plugin runs its code.
Json pluginCatalogue() {
    std::wstring cachePath = dataDir() + L"\\plugin-scan.json";
    Json cache = Json::parse(readFile(cachePath)), keep = Json::object(), out = Json::array();
    std::set<std::wstring> seen;
    for (auto &folder : pluginFolders()) {
        std::vector<std::wstring> files; findPlugins(folder, files);
        for (auto &path : files) {
            if (!seen.insert(path).second) continue;
            std::string key = utf8(path); long long stamp = stampOf(path);
            Json classes;
            if (cache[key]["stamp"].num(-1) == (double)stamp) classes = cache[key]["classes"];
            else {
                std::vector<char> buf(1 << 16);
                classes = v3_scan(path.c_str(), buf.data(), (int)buf.size()) >= 0 ? Json::parse(buf.data()) : Json::array();
            }
            Json entry; entry["stamp"] = (double)stamp; entry["classes"] = classes; keep[key] = entry;
            std::wstring base = path.substr(path.find_last_of(L"\\") + 1); base = base.substr(0, base.find_last_of(L'.'));
            for (auto &c : classes.a) {
                bool inst = c["sub"].str().find("Instrument") != std::string::npos, v2 = c["cid"].str() == "VST2";
                Json e;
                e["id"] = std::string(inst ? "vst3i" : "vst3f") + "|" + c["cid"].str() + "|" + key;
                e["name"] = (c["name"].str().empty() ? utf8(base) : c["name"].str()) + (v2 ? " (VST2)" : " (VST3)");
                e["maker"] = c["vendor"].str(); e["kind"] = inst ? "inst" : "fx";
                out.push(e);
            }
        }
    }
    writeFile(cachePath, keep.dump());
    return out;
}

Json catalogue() {
    Json out = pluginCatalogue();
    for (int i = 0; i < aw_count(); i++) {
        Json e; e["id"] = std::string("aw|") + aw_name(i); e["name"] = aw_name(i); e["maker"] = "Airwindows"; e["kind"] = "fx";
        e["category"] = aw_category(i); e["what"] = aw_what(i); e["collections"] = aw_collections(i); out.push(e);
    }
    Json w; w["id"] = "stratum|wave"; w["name"] = "STRATUM Wave"; w["maker"] = "STRATUM"; w["kind"] = "inst"; w["category"] = "Wavetable synth"; w["what"] = "STRATUM's own wavetable synthesizer."; w["collections"] = "Recommended"; out.push(w);
    Json t; t["id"] = "stratum|tune"; t["name"] = "STRATUM Tune"; t["maker"] = "STRATUM"; t["kind"] = "fx"; t["category"] = "Pitch correction"; t["what"] = "Pulls vocals and other single notes to the nearest note in the song's key."; t["collections"] = "Recommended"; out.push(t);
    std::sort(out.a.begin(), out.a.end(), [](const Json &a, const Json &b) {
        auto low = [](std::string s) { for (auto &c : s) c = (char)tolower((unsigned char)c); return s; };
        auto ka = low(a["maker"].str()) + "\x01" + low(a["name"].str()), kb = low(b["maker"].str()) + "\x01" + low(b["name"].str());
        return ka < kb;
    });
    return out;
}

std::unique_ptr<Unit> instantiate(const std::string &id, const std::string &state) {
    std::unique_ptr<Unit> u;
    if (id == "stratum|wave") u.reset(new WaveUnit());
    else if (id == "stratum|tune") u.reset(new TuneUnit());
    else if (id.rfind("aw|", 0) == 0) { void *fx = aw_create(id.substr(3).c_str(), rate); if (fx) u.reset(new AirwinUnit(fx)); }
    else if (id.rfind("vst3", 0) == 0) {
        size_t a = id.find('|'), b = id.find('|', a + 1);
        if (a != std::string::npos && b != std::string::npos) {
            char err[256] = {0};
            if (V3 *p = v3_load(wide(id.substr(b + 1)).c_str(), id.substr(a + 1, b - a - 1).c_str(), err, sizeof err)) u.reset(new PlugUnit(p));
        }
    }
    if (u) { u->setup(rate, MAXF); if (!state.empty()) u->setState(state); }
    return u;
}

Strip &strip(const std::string &id) { auto &s = strips[id]; if (!s) s.reset(new Strip()); return *s; }
Unit *unitOf(const std::string &track, int slot) {
    auto it = strips.find(track); if (it == strips.end()) return nullptr;
    Strip &s = *it->second;
    return slot < 0 ? s.inst.get() : (slot < (int)s.fx.size() ? s.fx[slot].get() : nullptr);
}

// ---------------------------------------------------------------- plugin windows
LRESULT CALLBACK editorProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_TIMER) { if (auto u = (Unit *)GetWindowLongPtrW(h, GWLP_USERDATA)) u->idle(); return 0; }
    if (m == WM_CLOSE) {
        if (auto u = (Unit *)GetWindowLongPtrW(h, GWLP_USERDATA)) u->closeEditor();
        for (auto &kv : strips) for (auto it = kv.second->windows.begin(); it != kv.second->windows.end();) { if (it->second == h) it = kv.second->windows.erase(it); else ++it; }
        DestroyWindow(h); return 0;
    }
    return DefWindowProcW(h, m, w, l);
}
void closeWindows(Strip &s) { for (auto &kv : s.windows) { KillTimer(kv.second, 1); SetWindowLongPtrW(kv.second, GWLP_USERDATA, 0); DestroyWindow(kv.second); } s.windows.clear(); }
void showEditor(const std::string &track, int slot, const std::string &title) {
    auto it = strips.find(track); if (it == strips.end()) return;
    Strip &s = *it->second;
    Unit *u = unitOf(track, slot); if (!u) return;
    if (s.windows.count(slot)) { ShowWindow(s.windows[slot], SW_SHOW); SetForegroundWindow(s.windows[slot]); return; }
    static bool reg = false;
    if (!reg) { WNDCLASSEXW wc = {sizeof wc}; wc.lpfnWndProc = editorProc; wc.hInstance = GetModuleHandleW(nullptr); wc.hCursor = LoadCursor(nullptr, IDC_ARROW); wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH); wc.lpszClassName = L"STRATUMPlugin"; wc.hIcon = LoadIconW(wc.hInstance, MAKEINTRESOURCEW(1)); RegisterClassExW(&wc); reg = true; }
    HWND h = CreateWindowExW(0, L"STRATUMPlugin", wide(title).c_str(), WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, CW_USEDEFAULT, CW_USEDEFAULT, 480, 320, mainWnd, nullptr, GetModuleHandleW(nullptr), nullptr);
    SetWindowLongPtrW(h, GWLP_USERDATA, (LONG_PTR)u);
    int w = 0, hh = 0;
    if (u->openEditor(h, &w, &hh)) { resizeEditor(h, std::max(w, 100), std::max(hh, 60)); SetTimer(h, 1, 30, nullptr); }
    else {
        resizeEditor(h, 380, 64);
        CreateWindowExW(0, L"STATIC", L"This plugin has no editor window. Its controls are in STRATUM's Devices panel.", WS_CHILD | WS_VISIBLE, 14, 14, 360, 40, h, nullptr, GetModuleHandleW(nullptr), nullptr);
    }
    ShowWindow(h, SW_SHOW);
    s.windows[slot] = h;
}

// ---------------------------------------------------------------- the page's requests
Json sync(const Json &tracks) {
    std::lock_guard<std::mutex> st(structure);
    Json failed = Json::array();
    std::set<std::string> wanted;
    for (auto &t : tracks.a) wanted.insert(t["id"].str());
    std::vector<std::unique_ptr<Strip>> gone;
    {
        std::lock_guard<std::mutex> g(graph);
        for (auto it = strips.begin(); it != strips.end();) {
            if (!wanted.count(it->first)) { closeWindows(*it->second); gone.push_back(std::move(it->second)); it = strips.erase(it); }
            else ++it;
        }
    }
    gone.clear();   // plugins are released outside the audio lock
    for (auto &t : tracks.a) {
        std::string id = t["id"].str(), instID = t["inst"].str();
        Strip *sp; { std::lock_guard<std::mutex> g(graph); sp = &strip(id); }
        Strip &s = *sp;
        s.vol = (float)t["vol"].num(0.8); s.pan = (float)t["pan"].num(0); s.mute = t["mute"].truthy();
        std::vector<std::string> fxIDs; for (auto &f : t["fx"].a) fxIDs.push_back(f["id"].str());
        if (s.instID == instID && s.fxIDs == fxIDs && (s.inst || s.bank)) continue;
        bool instChanged = s.instID != instID || (!s.inst && !s.bank);
        std::unique_ptr<Unit> inst;
        if (instChanged && !instID.empty()) { inst = instantiate(instID, t["state"].str()); if (!inst) { failed.push(instID); continue; } }
        std::vector<std::unique_ptr<Unit>> fx(fxIDs.size());
        std::vector<bool> reused(fxIDs.size(), false);
        for (size_t i = 0; i < fxIDs.size(); i++) {
            if (i < s.fxIDs.size() && s.fxIDs[i] == fxIDs[i]) { reused[i] = true; continue; }
            fx[i] = instantiate(fxIDs[i], t["fx"][i]["state"].str());
            if (!fx[i]) failed.push(fxIDs[i]);
        }
        std::vector<std::unique_ptr<Unit>> old;
        {
            std::lock_guard<std::mutex> g(graph);
            closeWindows(s);
            for (size_t i = 0; i < fxIDs.size(); i++) if (reused[i]) fx[i] = std::move(s.fx[i]);
            for (auto &f : s.fx) if (f) old.push_back(std::move(f));
            s.fx.clear(); s.fxIDs.clear();
            for (size_t i = 0; i < fx.size(); i++) if (fx[i]) { s.fx.push_back(std::move(fx[i])); s.fxIDs.push_back(fxIDs[i]); }
            if (instChanged) { if (s.inst) old.push_back(std::move(s.inst)); s.inst = std::move(inst); }
            if (instID.empty() && !s.bank) s.bank.reset(new VoiceBank());
            else if (!instID.empty()) s.bank.reset();
            s.instID = instID;
        }
        old.clear();
    }
    return failed;
}

void addEvent(Strip &s, const Event &e) { std::lock_guard<std::mutex> g(s.evLock); if (s.events.size() < 4000) s.events.push_back(e); }

Voice makeVoice(const Json &e, long long start) {
    Voice v;
    auto it = samples.find(e["key"].str());
    if (it == samples.end()) return v;
    double sr = rate;
    v.sample = it->second;
    v.step = e["rate"].num(1) * it->second->rate / sr;
    v.pos = std::max(0.0, e["off"].num(0) * it->second->rate);
    v.gain = (float)e["gain"].num(1);
    v.start = start;
    v.attack = (int)(e["att"].num(0) * sr);
    v.release = std::max(1, (int)(e["rel"].num(0.004) * sr));
    if (e.has("d")) v.hold = std::max((long long)v.attack, (long long)(e["d"].num() * sr));
    v.loop = e["loop"].truthy();
    v.active = true;
    return v;
}

void allOff() {
    std::lock_guard<std::mutex> g(graph);
    for (auto &kv : strips) {
        Strip &s = *kv.second;
        { std::lock_guard<std::mutex> e(s.evLock); s.events.clear(); }
        if (s.bank) s.bank->clear();
        if (s.inst) s.inst->allOff();
    }
}

// Renders `seconds` of audio from events [{t, p, v, at, d} or {t, key, at, ...}]; returns interleaved stereo floats.
// Live audio must already be paused (see auRender).
std::vector<float> renderOffline(const Json &events, double seconds) {
    allOff();
    double sr = rate;
    long long total = (long long)(seconds * sr);
    struct Ev { long long at; Strip *s; const Json *e; int on; };
    std::vector<Ev> evs;
    {
        for (auto &e : events.a) {
            auto it = strips.find(e["t"].str()); if (it == strips.end() || !e.has("at")) continue;
            long long at = (long long)(e["at"].num() * sr);
            if (e.has("key")) { evs.push_back({at, it->second.get(), &e, 2}); continue; }
            if (!e.has("p")) continue;
            evs.push_back({at, it->second.get(), &e, 1});
            evs.push_back({(long long)((e["at"].num() + std::max(0.02, e["d"].num(0.25))) * sr), it->second.get(), &e, 0});
        }
    }
    std::sort(evs.begin(), evs.end(), [](const Ev &a, const Ev &b) { return a.at < b.at; });
    std::vector<float> out; out.reserve((size_t)total * 2);
    std::vector<float> L(1024), R(1024);
    size_t next = 0;
    for (long long pos = 0; pos < total; pos += 1024) {
        int n = (int)std::min<long long>(1024, total - pos);
        transport.offlineBeat = std::max(0.0, (double)pos / sr - 0.05) * transport.bpm / 60;
        while (next < evs.size() && evs[next].at < pos + n) {
            Ev &e = evs[next++];
            if (e.on == 2) { if (e.s->bank) e.s->bank->add(makeVoice(*e.e, e.at)); }
            else { int p = std::max(0, std::min(127, (*e.e)["p"].integer(60))); addEvent(*e.s, {e.at, e.on, p, (float)(*e.e)["v"].num(0.8)}); }
        }
        renderBlock(pos, n, L.data(), R.data());
        for (int i = 0; i < n; i++) { out.push_back(L[i]); out.push_back(R[i]); }
    }
    transport.offlineBeat = -1;
    allOff();
    return out;
}

void reply(const Json &body, const Json &value) { if (body.has("req") && replyFn) replyFn(body["req"].integer(), value); }

} // namespace

void init(HWND main, std::function<void(int, const Json &)> r) {
    mainWnd = main; replyFn = std::move(r);
    audioThread = std::thread(audioMain);
}

void shutdown() {
    quit = true;
    if (audioThread.joinable()) audioThread.join();
    std::lock_guard<std::mutex> g(graph);
    for (auto &kv : strips) closeWindows(*kv.second);
    strips.clear();
}

float livePeak() { return peak; }

void op(const std::string &name, const Json &b) {
    std::string track = b["t"].str();
    if (name == "auList") return reply(b, catalogue());
    if (name == "auSync") return reply(b, sync(b["tracks"]));
    if (name == "auMix") {
        std::lock_guard<std::mutex> g(structure);
        for (auto &t : b["tracks"].a) { auto it = strips.find(t["id"].str()); if (it == strips.end()) continue; it->second->vol = (float)t["vol"].num(0.8); it->second->pan = (float)t["pan"].num(0); it->second->mute = t["mute"].truthy(); }
        master = (float)b["master"].num(1);
        return;
    }
    if (name == "auNote") {
        std::lock_guard<std::mutex> g(structure);
        auto it = strips.find(track); if (it == strips.end() || !it->second->inst) return;
        double sr = rate; long long start = sampleTime + (long long)(std::max(0.0, b["delay"].num(0)) * sr);
        int p = std::max(0, std::min(127, b["p"].integer(60)));
        addEvent(*it->second, {start, 1, p, (float)b["v"].num(0.8)});
        addEvent(*it->second, {start + (long long)(std::max(0.02, b["d"].num(0.25)) * sr), 0, p, 0});
        return;
    }
    if (name == "auOff") return allOff();
    if (name == "auPlay") {
        std::lock_guard<std::mutex> g(structure);
        auto it = strips.find(track); if (it == strips.end() || !it->second->bank) return;
        double delay = b["delay"].num(0);
        long long start = delay > 0.002 ? sampleTime + (long long)(delay * rate) : 0;
        Voice v = makeVoice(b, start); if (v.sample) it->second->bank->add(v);
        return;
    }
    if (name == "auSample") {
        auto d = b64decode(b["b64"].str());
        auto s = std::make_shared<Sample>(); s->rate = b["rate"].num(44100);
        size_t n = d.size() / 8; s->l.resize(n); s->r.resize(n);
        const float *f = (const float *)d.data();
        for (size_t i = 0; i < n; i++) { s->l[i] = f[2 * i]; s->r[i] = f[2 * i + 1]; }
        samples[b["key"].str()] = s;
        return;
    }
    if (name == "auKeep") {
        std::set<std::string> keep; for (auto &k : b["keys"].a) keep.insert(k.str());
        for (auto it = samples.begin(); it != samples.end();) { if (!keep.count(it->first)) it = samples.erase(it); else ++it; }
        return;
    }
    if (name == "auTransport") {
        transport.bpm = std::max(20.0, b["bpm"].num(120)); transport.playing = b["playing"].truthy();
        transport.beat0 = b["beat"].num(0); transport.t0 = nowSeconds() + b["delay"].num(0);
        return;
    }
    if (name == "auUI") { std::lock_guard<std::mutex> g(structure); return showEditor(track, b["slot"].integer(-1), b["title"].str("Plugin")); }
    if (name == "auStates") {
        std::lock_guard<std::mutex> g(structure);
        Json out = Json::object();
        for (auto &kv : strips) { Json e; e["inst"] = kv.second->inst ? kv.second->inst->state() : ""; Json fx = Json::array(); for (auto &f : kv.second->fx) fx.push(f->state()); e["fx"] = fx; out[kv.first] = e; }
        return reply(b, out);
    }
    if (name == "auParams") { std::lock_guard<std::mutex> g(structure); Unit *u = unitOf(track, b["slot"].integer(0)); return reply(b, u ? u->params() : Json::array()); }
    if (name == "auSetParam") { std::lock_guard<std::mutex> g(structure); Unit *u = unitOf(track, b["slot"].integer(0)); return reply(b, u ? Json(u->setParam(b["i"].integer(0), b["v"].num(0))) : Json("")); }
    if (name == "auWavePresets") { Json a = Json::array(); for (int i = 0; i < ws_preset_count(); i++) a.push(ws_preset_name(i)); return reply(b, a); }
    if (name == "auWavePreset") { std::lock_guard<std::mutex> g(structure); auto w = dynamic_cast<WaveUnit *>(unitOf(track, -1)); if (w) ws_preset(w->s, b["i"].integer(0)); return reply(b, w != nullptr); }
    if (name == "auWaveTable") {
        std::lock_guard<std::mutex> g(structure);
        auto w = dynamic_cast<WaveUnit *>(unitOf(track, -1)); auto d = b64decode(b["b64"].str());
        if (!w || d.size() < 2048 * 4) return reply(b, false);
        ws_load_table(w->s, b["osc"].integer(0), (const float *)d.data(), (int)(d.size() / (2048 * 4)), b["name"].str("Imported").c_str());
        return reply(b, true);
    }
    if (name == "auWaveFrame") {
        std::lock_guard<std::mutex> g(structure);
        auto w = dynamic_cast<WaveUnit *>(unitOf(track, -1)); Json out = Json::array();
        for (int osc = 0; osc < 2; osc++) { Json f = Json::array(); if (w) { float pts[128]; ws_frame(w->s, osc, pts, 128); for (float x : pts) f.push((double)x); } out.push(f); }
        return reply(b, out);
    }
    if (name == "auTuneMeter") {
        std::lock_guard<std::mutex> g(structure);
        auto t = dynamic_cast<TuneUnit *>(unitOf(track, b["slot"].integer(0))); Json out = Json::array();
        if (t) { out.push((double)tn_detected(t->t)); out.push((double)tn_target(t->t)); }
        return reply(b, out);
    }
    if (name == "auDebug") { Json o; o["tempoSeenByVST"] = (double)transport.bpm; o["livePeakSoFar"] = (double)peak; o["sampleRate"] = (double)rate; return reply(b, o); }
    if (name == "auRender") {
        if (b.has("bpm")) transport.bpm = std::max(20.0, b["bpm"].num());
        // Live audio pauses while the mixdown runs; mixdowns are made at the page's rate (44.1 kHz) whatever the sound card runs at.
        std::lock_guard<std::mutex> g(structure);
        offlineAck = false; offline = true;
        for (int i = 0; i < 200 && !offlineAck; i++) Sleep(5);
        double live = rate; rate = 44100;
        for (auto &kv : strips) { if (kv.second->inst) kv.second->inst->setup(44100, MAXF); for (auto &fx : kv.second->fx) fx->setup(44100, MAXF); }
        auto f = renderOffline(b["events"], b["seconds"].num(0));
        rate = live;
        for (auto &kv : strips) { if (kv.second->inst) kv.second->inst->setup(live, MAXF); for (auto &fx : kv.second->fx) fx->setup(live, MAXF); }
        offline = false;
        return reply(b, b64encode((const unsigned char *)f.data(), f.size() * 4));
    }
}

} // namespace engine
