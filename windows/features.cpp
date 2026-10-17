// STRATUM for Windows: stem separation (HT-Demucs through ONNX Runtime, as on the Mac), Record from another app
// (Windows audio loopback), and share delivery (Videos › STRATUM, the Windows share sheet and upload pages).
#include "features.h"
#include "../shell/stems.h"
#include "live_win.h"
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <shlobj.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <wrl/implements.h>
#include <wrl/ftm.h>
#include <shobjidl_core.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.ApplicationModel.DataTransfer.h>
#include <algorithm>
#include <atomic>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

namespace features {
namespace {

HWND mainWnd = nullptr;
std::function<void(const std::wstring &)> runJs;
std::function<void(int, const Json &)> replyFn;

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
std::wstring exeDir() { wchar_t p[MAX_PATH]; GetModuleFileNameW(nullptr, p, MAX_PATH); std::wstring s(p); return s.substr(0, s.find_last_of(L"\\/")); }
bool exists(const std::wstring &p) { return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }
std::wstring jsString(const std::string &s) { Json j(s); return wide(j.dump()); }   // a quoted, escaped JavaScript string
void reply(const Json &b, const Json &v) { if (b.has("req") && replyFn) replyFn(b["req"].integer(), v); }

// 16-bit stereo WAV, as the Mac app's Recorder.wav.
std::vector<unsigned char> wav16(const float *l, const float *r, size_t n, int rate) {
    std::vector<unsigned char> d(44 + n * 4);
    auto u32 = [&](size_t at, uint32_t v) { memcpy(&d[at], &v, 4); };
    auto u16 = [&](size_t at, uint16_t v) { memcpy(&d[at], &v, 2); };
    memcpy(&d[0], "RIFF", 4); u32(4, (uint32_t)(36 + n * 4)); memcpy(&d[8], "WAVEfmt ", 8);
    u32(16, 16); u16(20, 1); u16(22, 2); u32(24, (uint32_t)rate); u32(28, (uint32_t)rate * 4); u16(32, 4); u16(34, 16);
    memcpy(&d[36], "data", 4); u32(40, (uint32_t)(n * 4));
    for (size_t i = 0; i < n; i++) {
        int16_t a = (int16_t)(std::max(-1.f, std::min(1.f, l[i])) * 32767), b = (int16_t)(std::max(-1.f, std::min(1.f, r[i])) * 32767);
        memcpy(&d[44 + i * 4], &a, 2); memcpy(&d[46 + i * 4], &b, 2);
    }
    return d;
}

// ---------------------------------------------------------------- stems
void separate(const std::string &b64) {
    std::wstring lib = exeDir() + L"\\onnxruntime.dll", model = exeDir() + L"\\models\\htdemucs.onnx";
    auto fail = [](const std::string &m) { runJs(L"S.io.stemsFailed(" + jsString(m) + L")"); };
    if (!exists(lib) || !exists(model)) return fail("This build does not include the stem separation model.");
    auto wav = std::make_shared<std::vector<unsigned char>>(b64decode(b64));
    if (wav->size() <= 48) return fail("The audio could not be read.");
    std::thread([wav, lib, model, fail] {
        size_t n = (wav->size() - 44) / 4;
        std::vector<float> L(n), R(n), out(n * 8);
        const int16_t *pcm = (const int16_t *)(wav->data() + 44);
        for (size_t i = 0; i < n; i++) { L[i] = pcm[2 * i] / 32768.f; R[i] = pcm[2 * i + 1] / 32768.f; }
        char err[512] = {0};
        stratum_progress progress = [](float f, void *) { runJs(L"S.io.stemProgress(" + std::to_wstring(f) + L")"); };
        if (stratum_separate(utf8(lib).c_str(), utf8(model).c_str(), L.data(), R.data(), (long)n, out.data(), progress, nullptr, err, sizeof err)) return fail(err);
        for (int s = 0; s < 4; s++) {
            auto w = wav16(&out[(size_t)(s * 2) * n], &out[(size_t)(s * 2 + 1) * n], n, 44100);
            runJs(L"S.io.stemResult(" + std::to_wstring(s) + L", '" + wide(b64encode(w.data(), w.size())) + L"')");
        }
        runJs(L"S.io.stemsDone()");
    }).detach();
}

// ---------------------------------------------------------------- Record from another app
// Windows 11 (and Windows 10 builds from 20348) can record one app's sound; older Windows 10 records everything the PC plays.
bool perAppSupported() {
    typedef LONG(WINAPI * RtlGetVersionFn)(OSVERSIONINFOW *);
    auto fn = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    OSVERSIONINFOW v{sizeof v};
    return fn && fn(&v) == 0 && v.dwBuildNumber >= 20348;
}

struct Activation : Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT hr = E_FAIL;
    IAudioClient *client = nullptr;
    ~Activation() { CloseHandle(done); }
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation *op) override {
        IUnknown *unk = nullptr; HRESULT r = E_FAIL;
        if (SUCCEEDED(op->GetActivateResult(&r, &unk)) && SUCCEEDED(r) && unk) { hr = unk->QueryInterface(IID_PPV_ARGS(&client)); unk->Release(); }
        else hr = FAILED(r) ? r : E_FAIL;
        SetEvent(done);
        return S_OK;
    }
};

class Capture {
public:
    std::string appName;
    double seconds() { std::lock_guard<std::mutex> g(lock); return rate ? (double)left.size() / rate : 0; }
    std::string start(const std::string &id, const std::string &name) {
        stop();
        { std::lock_guard<std::mutex> g(lock); left.clear(); right.clear(); }
        appName = name; running = true; error.clear();
        HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        worker = std::thread([this, id, ready] { run(id, ready); });
        WaitForSingleObject(ready, 5000); CloseHandle(ready);
        if (!error.empty()) { running = false; if (worker.joinable()) worker.join(); }
        return error;
    }
    void stop() { running = false; if (worker.joinable()) worker.join(); }
    // The recording as a WAV with silence trimmed from both ends; empty if nothing was heard.
    std::vector<unsigned char> take() {
        stop();
        std::lock_guard<std::mutex> g(lock);
        auto loud = [&](size_t i) { return std::max(std::fabs(left[i]), std::fabs(right[i])) > 0.003f; };
        size_t first = 0, last = left.size();
        while (first < left.size() && !loud(first)) first++;
        if (first >= left.size()) return {};
        while (last > first && !loud(last - 1)) last--;
        size_t a = first > (size_t)(rate * 0.005) ? first - (size_t)(rate * 0.005) : 0, b = std::min(left.size(), last + (size_t)(rate * 0.05));
        return wav16(&left[a], &right[a], b - a, rate);
    }
private:
    std::mutex lock;
    std::vector<float> left, right;
    int rate = 0;
    std::atomic<bool> running{false};
    std::thread worker;
    std::string error;

    void run(const std::string &id, HANDLE ready) {
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        IAudioClient *client = nullptr;
        WAVEFORMATEX *fmt = nullptr, pcm{};
        bool perApp = id != "system";
        HRESULT hr = E_FAIL;
        if (perApp) {
            // One app (and the processes it starts) through the process loopback device.
            AUDIOCLIENT_ACTIVATION_PARAMS params{};
            params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
            params.ProcessLoopbackParams.TargetProcessId = (DWORD)strtoul(id.c_str(), nullptr, 10);
            params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
            PROPVARIANT pv{}; pv.vt = VT_BLOB; pv.blob.cbSize = sizeof params; pv.blob.pBlobData = (BYTE *)&params;
            auto handler = Microsoft::WRL::Make<Activation>();
            IActivateAudioInterfaceAsyncOperation *op = nullptr;
            hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler.Get(), &op);
            if (SUCCEEDED(hr)) { WaitForSingleObject(handler->done, 5000); hr = handler->hr; client = handler->client; if (op) op->Release(); }
            pcm.wFormatTag = WAVE_FORMAT_PCM; pcm.nChannels = 2; pcm.nSamplesPerSec = 44100; pcm.wBitsPerSample = 16;
            pcm.nBlockAlign = 4; pcm.nAvgBytesPerSec = 44100 * 4;
            if (SUCCEEDED(hr)) hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000, 0, &pcm, nullptr);
            fmt = &pcm;
        } else {
            // Everything the PC plays, from the default output.
            IMMDeviceEnumerator *en = nullptr; IMMDevice *dev = nullptr;
            hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
            if (SUCCEEDED(hr)) hr = en->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
            if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void **)&client);
            if (SUCCEEDED(hr)) hr = client->GetMixFormat(&fmt);
            if (SUCCEEDED(hr)) hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000, 0, fmt, nullptr);
            if (dev) dev->Release(); if (en) en->Release();
        }
        IAudioCaptureClient *cap = nullptr;
        if (SUCCEEDED(hr)) hr = client->GetService(IID_PPV_ARGS(&cap));
        if (SUCCEEDED(hr)) hr = client->Start();
        if (FAILED(hr)) {
            char t[200]; snprintf(t, sizeof t, "Windows did not let STRATUM record %s (error 0x%08X).", perApp ? "that app" : "the PC's sound", (unsigned)hr);
            error = t; SetEvent(ready);
            if (cap) cap->Release(); if (client) client->Release(); if (!perApp && fmt) CoTaskMemFree(fmt);
            CoUninitialize(); return;
        }
        rate = (int)fmt->nSamplesPerSec;
        bool isFloat = fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT || (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE && ((WAVEFORMATEXTENSIBLE *)fmt)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
        int ch = fmt->nChannels, bits = fmt->wBitsPerSample;
        SetEvent(ready);
        while (running) {
            Sleep(10);
            UINT32 packet = 0;
            while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet) {
                BYTE *data = nullptr; UINT32 frames = 0; DWORD flags = 0;
                if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
                std::lock_guard<std::mutex> g(lock);
                if (left.size() < (size_t)rate * 600) {   // ten minutes at most
                    for (UINT32 i = 0; i < frames; i++) {
                        float l = 0, r = 0;
                        if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
                            auto at = [&](int c) -> float {
                                size_t k = (size_t)i * ch + std::min(c, ch - 1);
                                if (isFloat) return ((float *)data)[k];
                                if (bits == 16) return ((int16_t *)data)[k] / 32768.f;
                                return ((int32_t *)data)[k] / 2147483648.f;
                            };
                            l = at(0); r = at(1);
                        }
                        left.push_back(l); right.push_back(r);
                    }
                }
                cap->ReleaseBuffer(frames);
            }
        }
        client->Stop();
        cap->Release(); client->Release();
        if (!perApp && fmt) CoTaskMemFree(fmt);
        CoUninitialize();
    }
} capture;

std::wstring describe(const std::wstring &exe) {
    DWORD h = 0, n = GetFileVersionInfoSizeW(exe.c_str(), &h);
    if (n) {
        std::vector<BYTE> v(n);
        if (GetFileVersionInfoW(exe.c_str(), 0, n, v.data())) {
            struct { WORD lang, cp; } *tr = nullptr; UINT len = 0;
            if (VerQueryValueW(v.data(), L"\\VarFileInfo\\Translation", (void **)&tr, &len) && len >= 4) {
                wchar_t key[64]; swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\FileDescription", tr->lang, tr->cp);
                wchar_t *desc = nullptr; UINT dl = 0;
                if (VerQueryValueW(v.data(), key, (void **)&desc, &dl) && dl > 1) return desc;
            }
        }
    }
    std::wstring base = exe.substr(exe.find_last_of(L"\\/") + 1);
    return base.substr(0, base.find_last_of(L'.'));
}

// Apps with a window on screen, by name.
Json apps() {
    struct Ctx { std::map<DWORD, std::wstring> pids; } ctx;
    EnumWindows([](HWND h, LPARAM p) -> BOOL {
        if (!IsWindowVisible(h) || GetWindowTextLengthW(h) == 0 || GetWindow(h, GW_OWNER)) return TRUE;
        DWORD pid = 0; GetWindowThreadProcessId(h, &pid);
        if (pid == GetCurrentProcessId()) return TRUE;
        auto *c = (Ctx *)p;
        if (c->pids.count(pid)) return TRUE;
        HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!proc) return TRUE;
        wchar_t path[MAX_PATH]; DWORD n = MAX_PATH;
        if (QueryFullProcessImageNameW(proc, 0, path, &n)) c->pids[pid] = path;
        CloseHandle(proc);
        return TRUE;
    }, (LPARAM)&ctx);
    std::map<std::wstring, DWORD> byName;
    for (auto &kv : ctx.pids) { std::wstring low = kv.second; for (auto &c : low) c = towlower(c); if (low.find(L"\\windows\\") != std::wstring::npos && low.find(L"explorer.exe") == std::wstring::npos) continue; byName.emplace(describe(kv.second), kv.first); }
    Json out = Json::array();
    if (perAppSupported())
        for (auto &kv : byName) { Json e; e["id"] = std::to_string(kv.second); e["name"] = utf8(kv.first); out.push(e); }
    Json all; all["id"] = "system"; all["name"] = perAppSupported() ? "Everything this PC plays" : "Everything this PC plays (Windows 10 can't record one app on its own)";
    out.push(all);
    return out;
}

// ---------------------------------------------------------------- sharing
const std::map<std::string, std::string> uploadPages = {
    {"tiktok", "https://www.tiktok.com/upload"}, {"ig_reel", "https://www.instagram.com/"}, {"ig_post", "https://www.instagram.com/"},
    {"facebook", "https://www.facebook.com/"}, {"youtube", "https://studio.youtube.com/"}, {"x", "https://x.com/compose/post"}, {"threads", "https://www.threads.com/"}};
const std::map<std::string, std::string> shapes = {{"ig_post", "4x5"}, {"facebook", "4x5"}, {"threads", "4x5"}, {"x", "1x1"}};

void shareDone(bool ok, const std::string &msg) { runJs(std::wstring(L"S.ui.shareDone(") + (ok ? L"true" : L"false") + L", " + jsString(msg) + L")"); }
void showInExplorer(const std::wstring &file) { ShellExecuteW(nullptr, L"open", L"explorer.exe", (L"/select,\"" + file + L"\"").c_str(), nullptr, SW_SHOWNORMAL); }

winrt::event_token shareToken{};
winrt::Windows::ApplicationModel::DataTransfer::DataTransferManager shareManager{nullptr};
// The Windows share sheet (Mail, Outlook, Nearby Share, Phone Link and other apps) with one file.
bool shareSheet(const std::wstring &file, const std::string &title, const std::string &text) {
    using namespace winrt::Windows::ApplicationModel::DataTransfer;
    try {
        auto interop = winrt::get_activation_factory<DataTransferManager, IDataTransferManagerInterop>();
        if (!shareManager) {
            winrt::check_hresult(interop->GetForWindow(mainWnd, winrt::guid_of<DataTransferManager>(), winrt::put_abi(shareManager)));
        }
        if (shareToken) shareManager.DataRequested(shareToken);
        winrt::hstring path(file), t(wide(title)), body(wide(text));
        shareToken = shareManager.DataRequested([path, t, body](DataTransferManager const &, DataRequestedEventArgs const &args) {
            auto req = args.Request();
            req.Data().Properties().Title(t);
            req.Data().SetText(body);
            auto deferral = req.GetDeferral();
            winrt::Windows::Storage::StorageFile::GetFileFromPathAsync(path).Completed([req, deferral](auto const &op, auto) {
                try {
                    auto items = winrt::single_threaded_vector<winrt::Windows::Storage::IStorageItem>();
                    items.Append(op.GetResults());
                    req.Data().SetStorageItems(items);
                } catch (...) {}
                deferral.Complete();
            });
        });
        winrt::check_hresult(interop->ShowShareUIForWindow(mainWnd));
        return true;
    } catch (...) { return false; }
}

std::wstring videosDir() {
    PWSTR p = nullptr; std::wstring d;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Videos, 0, nullptr, &p))) d = std::wstring(p) + L"\\STRATUM";
    CoTaskMemFree(p);
    SHCreateDirectoryExW(nullptr, d.c_str(), nullptr);
    return d;
}
bool writeAll(const std::wstring &path, const std::vector<unsigned char> &d) {
    HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;
    DWORD n = 0; BOOL ok = WriteFile(f, d.data(), (DWORD)d.size(), &n, nullptr); CloseHandle(f);
    return ok && n == d.size();
}

// A share video made in the page: saved in Videos › STRATUM, then sent on like the Mac app does.
void shareFiles(const Json &b) {
    auto video = b64decode(b["video"].str()), audio = b64decode(b["audio"].str());
    std::string title = b["title"].str("Untitled"), artist = b["artist"].str(), target = b["target"].str("save"), ext;
    for (char c : b["ext"].str("mp4")) if (isalnum((unsigned char)c)) ext += c;
    std::string safe;
    for (char c : title) safe += strchr("\\/:*?\"<>|", c) ? '-' : c;
    auto shape = shapes.count(target) ? shapes.at(target) : std::string("9x16");
    std::wstring dir = videosDir(), v = dir + L"\\" + wide(safe + " " + shape + "." + ext), a = dir + L"\\" + wide(safe + ".wav");
    if (video.empty() || !writeAll(v, video) || !writeAll(a, audio)) return shareDone(false, "Could not save the video in Videos › STRATUM.");
    std::string line = "\xE2\x80\x9C" + title + "\xE2\x80\x9D" + (artist.empty() ? "" : " by " + artist) + " \xE2\x80\x94 made with STRATUM. https://github.com/Irlewis91/stratum/releases/latest";
    if (target == "messages" || target == "airdrop" || target == "more" || target == "mail") {
        if (shareSheet(target == "mail" ? a : v, title + " \xE2\x80\x94 made with STRATUM", line)) return shareDone(true, "Choose where to send your track.");
        showInExplorer(v);
        return shareDone(false, "The Windows share menu is not available here. Your video and audio are in Videos › STRATUM.");
    }
    if (target == "ig_story") { showInExplorer(v); return shareDone(true, "Instagram Stories are posted from the phone app: send the selected video to your phone (Phone Link or Nearby Share), then in Instagram tap + › Story."); }
    showInExplorer(v);
    auto page = uploadPages.find(target);
    if (page != uploadPages.end()) { ShellExecuteW(nullptr, L"open", wide(page->second).c_str(), nullptr, nullptr, SW_SHOWNORMAL); return shareDone(true, "The upload page is open and your video is selected in File Explorer \xE2\x80\x94 drag it in to post."); }
    shareDone(true, "Saved in Videos › STRATUM: " + utf8(v.substr(v.find_last_of(L'\\') + 1)) + " and " + safe + ".wav.");
}

// ---------------------------------------------------------------- opening files, and finding missing samples
// Files go to the page one at a time; the page asks for the next once it has taken each one in.
struct Pending { std::string name, b64, path; };
std::vector<Pending> openQueue, foundQueue;
bool readAll(const std::wstring &path, std::vector<unsigned char> &out) {
    HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size{}; GetFileSizeEx(f, &size);
    if (size.QuadPart > 400000000) { CloseHandle(f); return false; }
    out.resize((size_t)size.QuadPart); DWORD n = 0;
    BOOL ok = out.empty() || ReadFile(f, out.data(), (DWORD)out.size(), &n, nullptr);
    CloseHandle(f);
    return ok && n == out.size();
}
std::wstring baseName(const std::wstring &p) { size_t k = p.find_last_of(L"\\/"); return k == std::wstring::npos ? p : p.substr(k + 1); }
void openNext() {
    if (openQueue.empty()) { runJs(L"S.ui.openDone()"); return; }
    Pending p = openQueue.front(); openQueue.erase(openQueue.begin());
    runJs(L"S.io.nativeOpen(" + jsString(p.name) + L", '" + wide(p.b64) + L"', " + jsString(p.path) + L").catch((e) => S.ui.toast('Could not open ' + " + jsString(p.name) + L" + ': ' + (e.message || e), true)).then(() => window.chrome.webview.postMessage({ op: 'openNext' }))");
}
void openDialog(bool many) {
    IFileOpenDialog *dlg = nullptr;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) return;
    FILEOPENDIALOGOPTIONS o = 0; dlg->GetOptions(&o); dlg->SetOptions(o | FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM | (many ? FOS_ALLOWMULTISELECT : 0));
    dlg->SetTitle(many ? L"Choose one or more sound files" : L"Open a STRATUM project, or import MIDI, Ableton .als, FL Studio .flp, a zipped project or loop package, a Reason song or an audio file");
    openQueue.clear();
    if (SUCCEEDED(dlg->Show(mainWnd))) {
        IShellItemArray *items = nullptr;
        if (SUCCEEDED(dlg->GetResults(&items))) {
            DWORD n = 0; items->GetCount(&n);
            for (DWORD i = 0; i < n; i++) {
                IShellItem *it = nullptr; PWSTR path = nullptr;
                if (SUCCEEDED(items->GetItemAt(i, &it)) && SUCCEEDED(it->GetDisplayName(SIGDN_FILESYSPATH, &path))) {
                    std::vector<unsigned char> d;
                    if (readAll(path, d)) openQueue.push_back({utf8(baseName(path)), b64encode(d.data(), d.size()), utf8(path)});
                    else runJs(L"S.ui.toast(" + jsString("Could not read " + utf8(baseName(path)) + " (files over 400 MB can't be imported).") + L", true)");
                    CoTaskMemFree(path);
                }
                if (it) it->Release();
            }
            items->Release();
        }
    }
    dlg->Release();
    openNext();
}
void foundNext() {
    if (foundQueue.empty()) { runJs(L"S.io.foundDone()"); return; }
    Pending p = foundQueue.front(); foundQueue.erase(foundQueue.begin());
    runJs(L"S.io.found(" + jsString(p.name) + L", '" + wide(p.b64) + L"').then(() => window.chrome.webview.postMessage({ op: 'foundNext' }))");
}
// Looks for the sound files a project refers to: where the project says they are, and beside the project file.
void findFiles(const Json &paths, const std::string &nearUtf8) {
    foundQueue.clear();
    std::wstring nearP = wide(nearUtf8), dir, stem;
    if (!nearP.empty()) { size_t k = nearP.find_last_of(L"\\/"); dir = nearP.substr(0, k); stem = nearP.substr(k + 1); stem = stem.substr(0, stem.find_last_of(L'.')); }
    wchar_t prof[MAX_PATH] = {0}; GetEnvironmentVariableW(L"USERPROFILE", prof, MAX_PATH);
    for (auto &pj : paths.a) {
        std::wstring p = wide(pj.str()), name = p;
        for (auto &c : name) if (c == L'/') c = L'\\';
        name = baseName(name);
        std::vector<std::wstring> tries;
        std::wstring fl = p; size_t at = fl.find(L"%FLStudioUserData%");
        if (at != std::wstring::npos) fl.replace(at, 18, std::wstring(prof) + L"\\Documents\\Image-Line\\FL Studio");
        tries.push_back(fl);
        if (!dir.empty()) { tries.push_back(dir + L"\\" + name); tries.push_back(dir + L"\\Samples\\" + name); tries.push_back(dir + L"\\" + stem + L"\\Samples\\" + name); tries.push_back(dir + L"\\" + stem + L"\\" + name); }
        for (auto &t : tries) {
            DWORD a = GetFileAttributesW(t.c_str());
            if (a == INVALID_FILE_ATTRIBUTES || (a & FILE_ATTRIBUTE_DIRECTORY)) continue;
            std::vector<unsigned char> d;
            if (readAll(t, d)) foundQueue.push_back({utf8(name), b64encode(d.data(), d.size()), utf8(t)});
            break;
        }
    }
    foundNext();
}

} // namespace

void init(HWND main, std::function<void(const std::wstring &)> js, std::function<void(int, const Json &)> r) { mainWnd = main; runJs = std::move(js); replyFn = std::move(r); }
void shutdown() { capture.stop(); live::stop(); }

bool op(const std::string &name, const Json &b) {
    if (name == "stems") { separate(b["b64"].str()); return true; }
    if (name == "capApps") { Json o; o["apps"] = apps(); reply(b, o); return true; }
    if (name == "capStart") {
        std::string id = b["app"].str(), label = id == "system" ? "your PC" : "";
        if (label.empty()) for (auto &a : apps().a) if (a["id"].str() == id) label = a["name"].str();
        std::string err = capture.start(id, label);
        Json o; if (err.empty()) o["ok"] = true; else o["error"] = err;
        reply(b, o); return true;
    }
    if (name == "capLevel") { Json o; o["seconds"] = capture.seconds(); reply(b, o); return true; }
    if (name == "capStop") {
        auto w = capture.take();
        Json o;
        if (w.empty()) o["error"] = "Nothing was heard from " + (capture.appName.empty() ? std::string("that app") : capture.appName) + ". Play the sound while recording.";
        else { o["name"] = (capture.appName.empty() ? std::string("Recording") : capture.appName) + " recording.wav"; o["b64"] = b64encode(w.data(), w.size()); }
        reply(b, o); return true;
    }
    if (name == "shareFiles") { shareFiles(b); return true; }
    if (name == "open") { openDialog(b["many"].truthy()); return true; }
    if (name == "openNext") { openNext(); return true; }
    if (name == "findFiles") { findFiles(b["paths"], b["near"].str()); return true; }
    if (name == "foundNext") { foundNext(); return true; }
    if (name == "liveStart") {
        if (b["remember"].truthy()) live::saveKey(b["platform"].str("custom"), b["url"].str(), b["key"].str());
        // Connecting can take several seconds, so it happens off the window's thread; the answer goes back through the page.
        int req = b["req"].integer();
        std::string url = b["url"].str(), key = b["key"].str(); bool cam = b["camera"].truthy(), mic = b["mic"].truthy();
        std::thread([=] {
            std::string e = live::start(mainWnd, url, key, cam, mic);
            Json o; if (e.empty()) o["ok"] = true; else o["error"] = e;
            runJs(L"S.plug.cb(" + std::to_wstring(req) + L", " + wide(o.dump()) + L")");
        }).detach();
        return true;
    }
    if (name == "liveStop") { live::stop(); Json o; o["ok"] = true; reply(b, o); return true; }
    if (name == "liveStatus") { reply(b, live::status()); return true; }
    if (name == "liveKey") { reply(b, live::loadKey(b["platform"].str())); return true; }
    return false;
}

} // namespace features
