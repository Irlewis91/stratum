// STRATUM for Windows: VST3 plugins (through Steinberg's VST3 SDK hosting classes, MIT licence) and VST2 plugins (through
// the interface description in shell/vst2abi.h), behind the C calls in plughost.h. Follows shell/vst3host.mm and
// shell/vst2host.mm on the Mac.
#define NOMINMAX
#include <windows.h>
#include "plughost.h"
#include "../shell/vst2abi.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "public.sdk/source/common/memorystream.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/gui/iplugview.h"
#include <algorithm>
#include <cmath>
#include <map>
#include <mutex>
#include <string>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {
std::string utf8(const wchar_t *w) {
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    std::string s(n > 0 ? n - 1 : 0, '\0');
    if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
    return s;
}
bool isVST2(const wchar_t *path) { size_t n = wcslen(path); return n > 4 && _wcsicmp(path + n - 4, L".dll") == 0; }
std::string esc(const std::string &s) {
    std::string o;
    for (unsigned char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += (char)c; } else if (c >= 32) o += (char)c; }
    return o;
}
void copyOut(const std::string &s, char *out, int len) { if (out && len > 0) { size_t n = std::min(s.size(), (size_t)len - 1); memcpy(out, s.data(), n); out[n] = 0; } }

std::map<std::string, VST3::Hosting::Module::Ptr> &modules() { static std::map<std::string, VST3::Hosting::Module::Ptr> m; return m; }
VST3::Hosting::Module::Ptr moduleFor(const std::string &path, std::string &err) {
    auto &m = modules();
    auto it = m.find(path);
    if (it != m.end()) return it->second;
    static HostApplication *host = nullptr;
    if (!host) { host = new HostApplication(); PluginContextFactory::instance().setPluginContext(host); }
    auto mod = VST3::Hosting::Module::create(path, err);
    if (mod) m[path] = mod;
    return mod;
}

// ---------------------------------------------------------------- VST2
enum { V2_GET_PARAM_LABEL = 6, V2_GET_PARAM_DISPLAY = 7, V2_GET_PARAM_NAME = 8 };
struct V2 {
    HMODULE dll = nullptr;
    V2Effect *fx = nullptr;
    HWND host = nullptr;
    void (*onResize)(void *, int, int) = nullptr;
    double sr = 48000;
    int block = 1024;
    bool active = false;
    V2Time time{};
    std::vector<V2MidiEvent> queue;
    V2Events events{};
    std::vector<std::vector<float>> inData, outData;
    std::vector<float *> inPtrs, outPtrs;
};
std::mutex &v2lock() { static std::mutex m; return m; }
std::map<V2Effect *, V2 *> &v2table() { static std::map<V2Effect *, V2 *> t; return t; }
V2 *v2owner(V2Effect *fx) { std::lock_guard<std::mutex> g(v2lock()); auto it = v2table().find(fx); return it == v2table().end() ? nullptr : it->second; }

intptr_t v2callback(V2Effect *fx, int32_t op, int32_t index, intptr_t value, void *ptr, float) {
    V2 *p = fx ? v2owner(fx) : nullptr;
    switch (op) {
    case V2H_VERSION: return 2400;
    case V2H_TIME: return p ? (intptr_t)&p->time : 0;
    case V2H_RATE: return p ? (intptr_t)p->sr : 48000;
    case V2H_BLOCK: return p ? p->block : 1024;
    case V2H_LEVEL: return 0;
    case V2H_VENDOR: if (ptr) strcpy((char *)ptr, "STRATUM"); return 1;
    case V2H_PRODUCT: if (ptr) strcpy((char *)ptr, "STRATUM"); return 1;
    case V2H_VENDOR_VERSION: return 1000;
    case V2H_CAN_DO: {
        const char *s = (const char *)ptr;
        return s && (!strcmp(s, "sendVstEvents") || !strcmp(s, "sendVstMidiEvent") || !strcmp(s, "sendVstTimeInfo") || !strcmp(s, "sizeWindow")) ? 1 : 0;
    }
    case V2H_RESIZE: if (p && p->host && p->onResize) { p->onResize(p->host, index, (int)value); return 1; } return 0;
    default: return 0;
    }
}
typedef V2Effect *(*EntryPoint)(V2HostCallback);
V2Effect *v2instantiate(const wchar_t *path, HMODULE *out, std::string &err) {
    HMODULE dll = LoadLibraryW(path);
    if (!dll) { err = "The plugin could not be loaded (it may be 32-bit, or need files it cannot find)"; return nullptr; }
    auto entry = (EntryPoint)GetProcAddress(dll, "VSTPluginMain");
    if (!entry) entry = (EntryPoint)GetProcAddress(dll, "main");
    V2Effect *fx = entry ? entry(v2callback) : nullptr;
    if (!fx || fx->magic != V2_MAGIC) { err = "This file is not a VST2 plugin"; return nullptr; }   // the DLL stays loaded: unloading plugin code is not safe
    *out = dll;
    return fx;
}
void v2stop(V2 *p) { if (!p->active) return; p->fx->dispatch(p->fx, V2_STOP, 0, 0, nullptr, 0); p->fx->dispatch(p->fx, V2_RESUME, 0, 0, nullptr, 0); p->active = false; }
}

// ---------------------------------------------------------------- VST3
struct V3;
struct Handler : IComponentHandler, IPlugFrame {
    V3 *owner = nullptr;
    tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
    tresult PLUGIN_API performEdit(ParamID id, ParamValue v) override;
    tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
    tresult PLUGIN_API restartComponent(int32) override { return kResultOk; }
    tresult PLUGIN_API resizeView(IPlugView *view, ViewRect *r) override;
    tresult PLUGIN_API queryInterface(const TUID iid, void **obj) override {
        if (FUnknownPrivate::iidEqual(iid, IComponentHandler::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) { *obj = static_cast<IComponentHandler *>(this); return kResultOk; }
        if (FUnknownPrivate::iidEqual(iid, IPlugFrame::iid)) { *obj = static_cast<IPlugFrame *>(this); return kResultOk; }
        *obj = nullptr; return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return 1; }
    uint32 PLUGIN_API release() override { return 1; }
};
struct Bus { int channels = 0; std::vector<std::vector<float>> data; std::vector<float *> ptrs; };
struct V3 {
    V2 *v2 = nullptr;
    VST3::Hosting::Module::Ptr module;
    IPtr<PlugProvider> provider;
    IPtr<IComponent> comp;
    IPtr<IEditController> ctrl;
    FUnknownPtr<IAudioProcessor> proc{nullptr};
    IPtr<IPlugView> view;
    HWND host = nullptr;
    void (*onResize)(void *, int, int) = nullptr;
    Handler handler;
    EventList events{512};
    EventList outEvents{64};
    ParameterChanges inParams{64};
    ParameterChanges outParams{64};
    std::mutex lock;
    std::vector<std::pair<ParamID, ParamValue>> pending;
    std::vector<Bus> ins, outs;
    std::vector<AudioBusBuffers> inBufs, outBufs;
    std::vector<ParamID> paramIds;
    bool instrument = false, active = false;
    double sr = 48000;
    int block = 0;
    int64 pos = 0;
    double tempo = 120, beat = 0;
    bool playing = true;
};
tresult PLUGIN_API Handler::performEdit(ParamID id, ParamValue v) { std::lock_guard<std::mutex> g(owner->lock); owner->pending.emplace_back(id, v); return kResultOk; }
tresult PLUGIN_API Handler::resizeView(IPlugView *view, ViewRect *r) {
    if (!view || !r || !owner->host) return kInvalidArgument;
    if (owner->onResize) owner->onResize(owner->host, r->getWidth(), r->getHeight());
    view->onSize(r);
    return kResultOk;
}

static void v3stop(V3 *p) { if (!p->active) return; p->proc->setProcessing(false); p->comp->setActive(false); p->active = false; }
static void layout(V3 *p, BusDirection dir, std::vector<Bus> &buses, std::vector<AudioBusBuffers> &bufs) {
    int n = p->comp->getBusCount(kAudio, dir);
    buses.assign(n, Bus()); bufs.assign(n, AudioBusBuffers());
    for (int i = 0; i < n; i++) {
        SpeakerArrangement arr = 0;
        p->proc->getBusArrangement(dir, i, arr);
        Bus &b = buses[i];
        b.channels = SpeakerArr::getChannelCount(arr);
        b.data.assign(b.channels, std::vector<float>(p->block, 0.f));
        b.ptrs.resize(b.channels);
        for (int c = 0; c < b.channels; c++) b.ptrs[c] = b.data[c].data();
        bufs[i].numChannels = b.channels; bufs[i].silenceFlags = 0; bufs[i].channelBuffers32 = b.ptrs.data();
        p->comp->activateBus(kAudio, dir, i, i == 0);
    }
}

extern "C" {

int v3_scan(const wchar_t *path, char *json, int cap) {
    std::string out;
    if (isVST2(path)) {
        HMODULE dll = nullptr; std::string err;
        V2Effect *fx = v2instantiate(path, &dll, err);
        if (!fx) return -1;
        char name[256] = {0}, vendor[256] = {0};
        fx->dispatch(fx, V2_OPEN, 0, 0, nullptr, 0);
        fx->dispatch(fx, V2_NAME, 0, 0, name, 0);
        if (!name[0]) fx->dispatch(fx, V2_PRODUCT, 0, 0, name, 0);
        fx->dispatch(fx, V2_VENDOR, 0, 0, vendor, 0);
        bool synth = fx->flags & V2_FLAG_SYNTH;
        fx->dispatch(fx, V2_CLOSE, 0, 0, nullptr, 0);
        out = std::string("[{\"cid\":\"VST2\",\"name\":\"") + esc(name) + "\",\"vendor\":\"" + esc(vendor) + "\",\"sub\":\"" + (synth ? "Instrument" : "Fx") + "\"}]";
    } else {
        std::string err;
        auto mod = moduleFor(utf8(path), err);
        if (!mod) return -1;
        out = "[";
        int n = 0;
        for (auto &ci : mod->getFactory().classInfos()) {
            if (ci.category() != kVstAudioEffectClass) continue;
            out += std::string(n++ ? "," : "") + "{\"cid\":\"" + ci.ID().toString() + "\",\"name\":\"" + esc(ci.name()) + "\",\"vendor\":\"" + esc(ci.vendor()) + "\",\"sub\":\"" + esc(ci.subCategoriesString()) + "\"}";
        }
        out += "]";
    }
    if ((int)out.size() + 1 > cap) return -1;
    memcpy(json, out.c_str(), out.size() + 1);
    return 1;
}

V3 *v3_load(const wchar_t *path, const char *cid, char *err, int err_len) {
    auto fail = [&](const std::string &m) -> V3 * { copyOut(m, err, err_len); return nullptr; };
    if (isVST2(path)) {
        std::string e;
        auto v2 = new V2();
        v2->fx = v2instantiate(path, &v2->dll, e);
        if (!v2->fx) { delete v2; return fail(e); }
        { std::lock_guard<std::mutex> g(v2lock()); v2table()[v2->fx] = v2; }
        v2->queue.reserve(256);
        v2->fx->dispatch(v2->fx, V2_OPEN, 0, 0, nullptr, 0);
        auto p = new V3(); p->v2 = v2; p->instrument = (v2->fx->flags & V2_FLAG_SYNTH) != 0;
        return p;
    }
    std::string e;
    auto mod = moduleFor(utf8(path), e);
    if (!mod) return fail("Could not load the plugin: " + e);
    auto &factory = mod->getFactory();
    for (auto &ci : factory.classInfos()) {
        if (ci.category() != kVstAudioEffectClass || ci.ID().toString() != cid) continue;
        auto p = new V3();
        p->module = mod;
        p->handler.owner = p;
        p->provider = owned(new PlugProvider(factory, ci, true));
        if (!p->provider->initialize()) { p->provider = nullptr; delete p; return fail("The plugin failed to start"); }
        p->comp = p->provider->getComponentPtr();
        p->ctrl = p->provider->getControllerPtr();
        p->proc = FUnknownPtr<IAudioProcessor>(p->comp);
        if (!p->comp || !p->proc) { delete p; return fail("The plugin has no audio processor"); }
        if (p->ctrl) {
            p->ctrl->setComponentHandler(&p->handler);
            for (int i = 0, n = p->ctrl->getParameterCount(); i < n; i++) {
                ParameterInfo info{};
                if (p->ctrl->getParameterInfo(i, info) != kResultOk) continue;
                if (info.flags & (ParameterInfo::kIsReadOnly | ParameterInfo::kIsHidden | ParameterInfo::kIsProgramChange)) continue;
                p->paramIds.push_back(info.id);
            }
        }
        p->instrument = ci.subCategoriesString().find("Instrument") != std::string::npos;
        return p;
    }
    return fail("That plugin was not found in the file");
}

void v3_destroy(V3 *p) {
    if (!p) return;
    v3_close_view(p);
    if (p->v2) {
        v2stop(p->v2);
        p->v2->fx->dispatch(p->v2->fx, V2_CLOSE, 0, 0, nullptr, 0);
        { std::lock_guard<std::mutex> g(v2lock()); v2table().erase(p->v2->fx); }
        delete p->v2; delete p; return;
    }
    v3stop(p);
    if (p->ctrl) p->ctrl->setComponentHandler(nullptr);
    p->proc = FUnknownPtr<IAudioProcessor>(nullptr);
    p->comp = nullptr; p->ctrl = nullptr; p->provider = nullptr;
    delete p;
}

int v3_is_instrument(V3 *p) { return p && p->instrument; }

int v3_setup(V3 *p, double sample_rate, int max_frames) {
    if (!p) return 0;
    if (p->v2) {
        V2 *q = p->v2;
        if (!q->fx->process) return 0;
        v2stop(q);
        q->sr = sample_rate; q->block = max_frames > 0 ? max_frames : 1024;
        q->time = V2Time{}; q->time.sampleRate = sample_rate; q->time.tempo = 120; q->time.sigNum = 4; q->time.sigDen = 4;
        q->time.flags = V2T_PLAYING | V2T_TEMPO | V2T_SIG | V2T_PPQ;
        int nIn = std::max(0, (int)q->fx->numInputs), nOut = std::max(0, (int)q->fx->numOutputs);
        q->inData.assign(nIn, std::vector<float>(q->block, 0.f)); q->outData.assign(nOut, std::vector<float>(q->block, 0.f));
        q->inPtrs.resize(nIn); q->outPtrs.resize(nOut);
        for (int i = 0; i < nIn; i++) q->inPtrs[i] = q->inData[i].data();
        for (int i = 0; i < nOut; i++) q->outPtrs[i] = q->outData[i].data();
        q->fx->dispatch(q->fx, V2_SET_RATE, 0, 0, nullptr, (float)sample_rate);
        q->fx->dispatch(q->fx, V2_SET_BLOCK, 0, q->block, nullptr, 0);
        q->fx->dispatch(q->fx, V2_RESUME, 0, 1, nullptr, 0);
        q->fx->dispatch(q->fx, V2_START, 0, 0, nullptr, 0);
        q->active = true;
        return 1;
    }
    v3stop(p);
    p->sr = sample_rate; p->block = max_frames > 0 ? max_frames : 1024;
    ProcessSetup setup{kRealtime, kSample32, p->block, sample_rate};
    if (p->proc->setupProcessing(setup) != kResultOk) return 0;
    int nIn = p->comp->getBusCount(kAudio, kInput), nOut = p->comp->getBusCount(kAudio, kOutput);
    std::vector<SpeakerArrangement> inArr(nIn), outArr(nOut);
    for (int i = 0; i < nIn; i++) { p->proc->getBusArrangement(kInput, i, inArr[i]); if (i == 0) inArr[i] = SpeakerArr::kStereo; }
    for (int i = 0; i < nOut; i++) { p->proc->getBusArrangement(kOutput, i, outArr[i]); if (i == 0) outArr[i] = SpeakerArr::kStereo; }
    p->proc->setBusArrangements(nIn ? inArr.data() : nullptr, nIn, nOut ? outArr.data() : nullptr, nOut);
    layout(p, kInput, p->ins, p->inBufs);
    layout(p, kOutput, p->outs, p->outBufs);
    if (p->comp->getBusCount(kEvent, kInput) > 0) p->comp->activateBus(kEvent, kInput, 0, true);
    if (p->comp->setActive(true) != kResultOk) return 0;
    p->proc->setProcessing(true);
    p->active = true;
    return 1;
}

void v3_note(V3 *p, int on, int pitch, float velocity, int sample_offset) {
    if (!p) return;
    if (p->v2) {
        V2 *q = p->v2;
        if (q->queue.size() >= 256) return;
        V2MidiEvent e{};
        e.type = 1; e.size = (int32_t)sizeof(V2MidiEvent); e.offset = sample_offset < 0 ? 0 : sample_offset;
        e.midi[0] = (char)(on ? 0x90 : 0x80); e.midi[1] = (char)(pitch & 127); e.midi[2] = (char)(on ? std::max(1, std::min(127, (int)(velocity * 127))) : 0);
        q->queue.push_back(e);
        return;
    }
    Event e{};
    e.busIndex = 0; e.sampleOffset = sample_offset < 0 ? 0 : sample_offset; e.flags = Event::kIsLive;
    if (on) { e.type = Event::kNoteOnEvent; e.noteOn.channel = 0; e.noteOn.pitch = (int16)pitch; e.noteOn.velocity = velocity; e.noteOn.noteId = -1; }
    else { e.type = Event::kNoteOffEvent; e.noteOff.channel = 0; e.noteOff.pitch = (int16)pitch; e.noteOff.velocity = 0; e.noteOff.noteId = -1; }
    p->events.addEvent(e);
}

void v3_transport(V3 *p, double tempo, double beat, int playing) {
    if (!p) return;
    if (p->v2) { V2 *q = p->v2; q->time.tempo = tempo; q->time.ppqPos = beat; q->time.barStart = floor(beat / 4) * 4; q->time.flags = (playing ? V2T_PLAYING : 0) | V2T_TEMPO | V2T_SIG | V2T_PPQ; return; }
    p->tempo = tempo; p->beat = beat; p->playing = playing != 0;
}

void v3_process(V3 *p, const float *const *in, float *const *out, int frames) {
    if (p && p->v2) {
        V2 *q = p->v2;
        if (!q->active) { for (int c = 0; c < 2; c++) memset(out[c], 0, sizeof(float) * frames); return; }
        for (int done = 0; done < frames;) {
            int n = std::min(frames - done, q->block);
            if (done == 0 && !q->queue.empty()) {
                q->events.count = (int32_t)q->queue.size(); q->events.reserved = 0;
                for (size_t i = 0; i < q->queue.size(); i++) { q->queue[i].offset = std::min(q->queue[i].offset, n - 1); q->events.events[i] = &q->queue[i]; }
                q->fx->dispatch(q->fx, V2_EVENTS, 0, 0, &q->events, 0);
            }
            for (auto &ch : q->inData) std::fill(ch.begin(), ch.begin() + n, 0.f);
            if (in) for (size_t c = 0; c < q->inData.size() && c < 2; c++) memcpy(q->inData[c].data(), in[c] + done, sizeof(float) * n);
            for (auto &ch : q->outData) std::fill(ch.begin(), ch.begin() + n, 0.f);
            q->fx->process(q->fx, q->inPtrs.data(), q->outPtrs.data(), n);
            q->queue.clear();
            q->time.samplePos += n;
            for (int c = 0; c < 2; c++) {
                if (q->outData.empty()) memset(out[c] + done, 0, sizeof(float) * n);
                else memcpy(out[c] + done, q->outData[std::min((size_t)c, q->outData.size() - 1)].data(), sizeof(float) * n);
            }
            done += n;
        }
        return;
    }
    if (!p || !p->active) { for (int c = 0; c < 2; c++) memset(out[c], 0, sizeof(float) * frames); return; }
    if (p->lock.try_lock()) {
        for (auto &e : p->pending) { int32 qi = 0, pi = 0; if (auto q = p->inParams.addParameterData(e.first, qi)) q->addPoint(0, e.second, pi); }
        p->pending.clear();
        p->lock.unlock();
    }
    for (int done = 0; done < frames;) {
        int n = std::min(frames - done, p->block);
        for (auto &b : p->ins) for (auto &ch : b.data) std::fill(ch.begin(), ch.begin() + n, 0.f);
        if (in && !p->ins.empty()) for (int c = 0; c < p->ins[0].channels && c < 2; c++) memcpy(p->ins[0].data[c].data(), in[c] + done, sizeof(float) * n);
        for (size_t i = 0; i < p->outBufs.size(); i++) p->outBufs[i].silenceFlags = 0;
        ProcessContext ctx{};
        ctx.state = (p->playing ? ProcessContext::kPlaying : 0) | ProcessContext::kTempoValid | ProcessContext::kTimeSigValid | ProcessContext::kProjectTimeMusicValid | ProcessContext::kBarPositionValid;
        ctx.projectTimeMusic = p->beat + (double)done / p->sr * p->tempo / 60.0; ctx.barPositionMusic = floor(ctx.projectTimeMusic / 4) * 4;
        ctx.sampleRate = p->sr; ctx.projectTimeSamples = p->pos; ctx.tempo = p->tempo; ctx.timeSigNumerator = 4; ctx.timeSigDenominator = 4;
        ProcessData d{};
        d.processMode = kRealtime; d.symbolicSampleSize = kSample32; d.numSamples = n;
        d.numInputs = (int32)p->inBufs.size(); d.inputs = p->inBufs.empty() ? nullptr : p->inBufs.data();
        d.numOutputs = (int32)p->outBufs.size(); d.outputs = p->outBufs.empty() ? nullptr : p->outBufs.data();
        d.inputEvents = &p->events; d.outputEvents = &p->outEvents;
        d.inputParameterChanges = &p->inParams; d.outputParameterChanges = &p->outParams;
        d.processContext = &ctx;
        p->proc->process(d);
        p->events.clear(); p->outEvents.clear(); p->inParams.clearQueue(); p->outParams.clearQueue();
        p->pos += n;
        for (int c = 0; c < 2; c++) {
            if (p->outs.empty() || p->outs[0].channels == 0) memset(out[c] + done, 0, sizeof(float) * n);
            else memcpy(out[c] + done, p->outs[0].data[std::min(c, p->outs[0].channels - 1)].data(), sizeof(float) * n);
        }
        done += n;
    }
}

int v3_open_view(V3 *p, void *hwnd, int *width, int *height, void (*on_resize)(void *, int, int)) {
    if (!p) return 0;
    v3_close_view(p);
    if (p->v2) {
        V2 *q = p->v2;
        if (!(q->fx->flags & V2_FLAG_EDITOR)) return 0;
        q->host = (HWND)hwnd; q->onResize = on_resize;
        V2Rect *r = nullptr;
        q->fx->dispatch(q->fx, V2_EDIT_RECT, 0, 0, &r, 0);
        q->fx->dispatch(q->fx, V2_EDIT_OPEN, 0, 0, hwnd, 0);
        q->fx->dispatch(q->fx, V2_EDIT_RECT, 0, 0, &r, 0);
        if (width) *width = r ? r->right - r->left : 480;
        if (height) *height = r ? r->bottom - r->top : 320;
        return 1;
    }
    if (!p->ctrl) return 0;
    p->view = owned(p->ctrl->createView(ViewType::kEditor));
    if (!p->view || p->view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) { p->view = nullptr; return 0; }
    p->host = (HWND)hwnd; p->onResize = on_resize;
    p->view->setFrame(&p->handler);
    ViewRect r{};
    p->view->getSize(&r);
    if (width) *width = r.getWidth();
    if (height) *height = r.getHeight();
    if (p->view->attached(hwnd, kPlatformTypeHWND) != kResultOk) { p->view->setFrame(nullptr); p->view = nullptr; p->host = nullptr; return 0; }
    return 1;
}

void v3_close_view(V3 *p) {
    if (!p) return;
    if (p->v2) { if (p->v2->host) { p->v2->fx->dispatch(p->v2->fx, V2_EDIT_CLOSE, 0, 0, nullptr, 0); p->v2->host = nullptr; } return; }
    if (!p->view) return;
    p->view->setFrame(nullptr);
    p->view->removed();
    p->view = nullptr; p->host = nullptr;
}

void v3_idle(V3 *p) { if (p && p->v2 && p->v2->host) p->v2->fx->dispatch(p->v2->fx, V2_EDIT_IDLE, 0, 0, nullptr, 0); }

int v3_get_state(V3 *p, unsigned char **data, int *len) {
    if (!p) return 0;
    if (p->v2) {
        V2 *q = p->v2;
        if (q->fx->flags & V2_FLAG_CHUNKS) {
            void *chunk = nullptr;
            intptr_t n = q->fx->dispatch(q->fx, V2_GET_CHUNK, 0, 0, &chunk, 0);
            if (n > 0 && chunk) { auto buf = (unsigned char *)malloc((size_t)n + 1); buf[0] = 'C'; memcpy(buf + 1, chunk, (size_t)n); *data = buf; *len = (int)n + 1; return 1; }
        }
        int n = std::max(0, (int)q->fx->numParams);
        auto buf = (unsigned char *)malloc(1 + sizeof(float) * (size_t)n);
        buf[0] = 'P';
        for (int i = 0; i < n; i++) { float v = q->fx->getParam ? q->fx->getParam(q->fx, i) : 0; memcpy(buf + 1 + sizeof(float) * (size_t)i, &v, sizeof(float)); }
        *data = buf; *len = 1 + (int)sizeof(float) * n;
        return 1;
    }
    MemoryStream cs, es;
    p->comp->getState(&cs);
    if (p->ctrl) p->ctrl->getState(&es);
    uint32_t cl = (uint32_t)cs.getSize(), el = (uint32_t)es.getSize();
    auto buf = (unsigned char *)malloc(4 + cl + el);
    memcpy(buf, &cl, 4); memcpy(buf + 4, cs.getData(), cl); memcpy(buf + 4 + cl, es.getData(), el);
    *data = buf; *len = (int)(4 + cl + el);
    return 1;
}

int v3_set_state(V3 *p, const unsigned char *data, int len) {
    if (!p || len < 1) return 0;
    if (p->v2) {
        V2 *q = p->v2;
        if (data[0] == 'C') { q->fx->dispatch(q->fx, V2_SET_CHUNK, 0, len - 1, (void *)(data + 1), 0); return 1; }
        if (data[0] != 'P' || !q->fx->setParam) return 0;
        int n = std::min((int)q->fx->numParams, (len - 1) / (int)sizeof(float));
        for (int i = 0; i < n; i++) { float v; memcpy(&v, data + 1 + sizeof(float) * (size_t)i, sizeof(float)); q->fx->setParam(q->fx, i, v); }
        return 1;
    }
    if (len < 4) return 0;
    uint32_t cl; memcpy(&cl, data, 4);
    if ((int64_t)cl + 4 > len) return 0;
    MemoryStream cs((void *)(data + 4), cl), cs2((void *)(data + 4), cl), es((void *)(data + 4 + cl), len - 4 - cl);
    p->comp->setState(&cs);
    if (p->ctrl) { p->ctrl->setComponentState(&cs2); if (len - 4 - (int)cl > 0) p->ctrl->setState(&es); }
    return 1;
}

void v3_free(void *data) { free(data); }

int v3_param_count(V3 *p) {
    if (!p) return 0;
    if (p->v2) return std::max(0, (int)p->v2->fx->numParams);
    return (int)p->paramIds.size();
}

int v3_param_info(V3 *p, int index, unsigned *id, char *name, int name_len, int *steps) {
    if (!p) return 0;
    if (p->v2) {
        char t[256] = {0};
        p->v2->fx->dispatch(p->v2->fx, V2_GET_PARAM_NAME, index, 0, t, 0);
        if (id) *id = (unsigned)index;
        copyOut(t[0] ? t : ("Parameter " + std::to_string(index + 1)).c_str(), name, name_len);
        if (steps) *steps = 0;
        return 1;
    }
    if (index < 0 || index >= (int)p->paramIds.size() || !p->ctrl) return 0;
    for (int i = 0, n = p->ctrl->getParameterCount(); i < n; i++) {
        ParameterInfo info{};
        if (p->ctrl->getParameterInfo(i, info) != kResultOk || info.id != p->paramIds[index]) continue;
        if (id) *id = info.id;
        copyOut(VST3::StringConvert::convert(info.title), name, name_len);
        if (steps) *steps = info.stepCount;
        return 1;
    }
    return 0;
}

double v3_param_get(V3 *p, unsigned id) {
    if (!p) return 0;
    if (p->v2) return p->v2->fx->getParam ? p->v2->fx->getParam(p->v2->fx, (int32_t)id) : 0;
    return p->ctrl ? p->ctrl->getParamNormalized(id) : 0;
}

void v3_param_set(V3 *p, unsigned id, double value) {
    if (!p) return;
    value = std::max(0.0, std::min(1.0, value));
    if (p->v2) { if (p->v2->fx->setParam) p->v2->fx->setParam(p->v2->fx, (int32_t)id, (float)value); return; }
    if (p->ctrl) p->ctrl->setParamNormalized(id, value);
    std::lock_guard<std::mutex> g(p->lock);
    p->pending.emplace_back(id, value);
}

void v3_param_text(V3 *p, unsigned id, double value, char *text, int len) {
    if (!p) { copyOut("", text, len); return; }
    if (p->v2) {
        char v[64] = {0}, u[64] = {0};
        p->v2->fx->dispatch(p->v2->fx, V2_GET_PARAM_DISPLAY, (int32_t)id, 0, v, 0);
        p->v2->fx->dispatch(p->v2->fx, V2_GET_PARAM_LABEL, (int32_t)id, 0, u, 0);
        copyOut(std::string(v) + (u[0] ? std::string(" ") + u : ""), text, len);
        return;
    }
    String128 s{};
    if (p->ctrl && p->ctrl->getParamStringByValue(id, value, s) == kResultOk) copyOut(VST3::StringConvert::convert(s), text, len);
    else { char t[32]; snprintf(t, sizeof t, "%.0f%%", value * 100); copyOut(t, text, len); }
}

}
