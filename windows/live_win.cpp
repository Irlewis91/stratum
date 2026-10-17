// STRATUM for Windows: Go live. Streams the STRATUM window (with an optional camera box beside it) and the sound the PC
// plays (with an optional microphone) as 1280x720, 30 fps H.264 and AAC over RTMP, like shell/live.swift on the Mac.
// Uses Windows' own Media Foundation encoders, WASAPI loopback and Credential Manager (for remembered stream keys).
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include "live_win.h"
#include "rtmp_win.h"
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mftransform.h>
#include <mferror.h>
#include <codecapi.h>
#include <wmcodecdsp.h>
#include <strmif.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <wincred.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <thread>
#include <vector>

namespace live {
namespace {

const int W = 1280, H = 720, FPS = 30;
template <class T> void release(T *&p) { if (p) { p->Release(); p = nullptr; } }
std::wstring wide(const std::string &s) { int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0); std::wstring w(n, L'\0'); if (n) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n); return w; }
std::string utf8(const std::wstring &w) { int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr); std::string s(n, '\0'); if (n) WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr); return s; }
double now() { static LARGE_INTEGER f = [] { LARGE_INTEGER x; QueryPerformanceFrequency(&x); return x; }(); LARGE_INTEGER c; QueryPerformanceCounter(&c); return (double)c.QuadPart / f.QuadPart; }

// ---------------------------------------------------------------- H.264 (Annex B from the encoder -> FLV video tags)
struct Nal { const uint8_t *p; size_t n; int type; };
std::vector<Nal> nals(const uint8_t *d, size_t n) {
    std::vector<Nal> out; size_t i = 0, start = (size_t)-1;
    auto close = [&](size_t end) { if (start != (size_t)-1 && end > start) { size_t e = end; while (e > start && d[e - 1] == 0) e--; out.push_back({d + start, e - start, d[start] & 31}); } };
    while (i + 3 <= n) {
        if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1) { close(i); i += 3; start = i; }
        else i++;
    }
    close(n);
    return out;
}

class Video {
public:
    IMFTransform *enc = nullptr;
    bool providesSamples = false;
    DWORD outSize = 0;
    std::vector<uint8_t> sps, pps;
    bool sentHeader = false;

    std::string open() {
        if (FAILED(CoCreateInstance(CLSID_CMSH264EncoderMFT, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&enc)))) return "Windows' H.264 video encoder is not available.";
        IMFMediaType *out = nullptr, *in = nullptr;
        MFCreateMediaType(&out);
        out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video); out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
        out->SetUINT32(MF_MT_AVG_BITRATE, 4500000); MFSetAttributeSize(out, MF_MT_FRAME_SIZE, W, H); MFSetAttributeRatio(out, MF_MT_FRAME_RATE, FPS, 1);
        MFSetAttributeRatio(out, MF_MT_PIXEL_ASPECT_RATIO, 1, 1); out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive); out->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main);
        HRESULT hr = enc->SetOutputType(0, out, 0);
        MFCreateMediaType(&in);
        in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video); in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
        MFSetAttributeSize(in, MF_MT_FRAME_SIZE, W, H); MFSetAttributeRatio(in, MF_MT_FRAME_RATE, FPS, 1); MFSetAttributeRatio(in, MF_MT_PIXEL_ASPECT_RATIO, 1, 1); in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        if (SUCCEEDED(hr)) hr = enc->SetInputType(0, in, 0);
        release(out); release(in);
        if (FAILED(hr)) return "The video encoder refused the stream settings.";
        ICodecAPI *api = nullptr;
        if (SUCCEEDED(enc->QueryInterface(IID_PPV_ARGS(&api)))) {
            VARIANT v; VariantInit(&v);
            v.vt = VT_UI4; v.ulVal = FPS * 2; api->SetValue(&CODECAPI_AVEncMPVGOPSize, &v);                   // a keyframe every 2 seconds
            v.vt = VT_UI4; v.ulVal = 0; api->SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &v);             // no frame reordering
            v.vt = VT_UI4; v.ulVal = eAVEncCommonRateControlMode_CBR; api->SetValue(&CODECAPI_AVEncCommonRateControlMode, &v);
            v.vt = VT_BOOL; v.boolVal = VARIANT_TRUE; api->SetValue(&CODECAPI_AVLowLatencyMode, &v);
            api->Release();
        }
        MFT_OUTPUT_STREAM_INFO info{}; enc->GetOutputStreamInfo(0, &info);
        providesSamples = (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0; outSize = std::max<DWORD>(info.cbSize, W * H);
        enc->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0); enc->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        return "";
    }
    void close() { if (enc) { enc->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0); } release(enc); }

    void encode(const std::vector<uint8_t> &nv12, long long frame, Rtmp &rtmp) {
        IMFMediaBuffer *buf = nullptr; IMFSample *s = nullptr;
        if (FAILED(MFCreateMemoryBuffer((DWORD)nv12.size(), &buf))) return;
        BYTE *p = nullptr; buf->Lock(&p, nullptr, nullptr); memcpy(p, nv12.data(), nv12.size()); buf->Unlock(); buf->SetCurrentLength((DWORD)nv12.size());
        MFCreateSample(&s); s->AddBuffer(buf); s->SetSampleTime(frame * 10000000LL / FPS); s->SetSampleDuration(10000000LL / FPS);
        HRESULT hr = enc->ProcessInput(0, s, 0);
        release(s); release(buf);
        if (FAILED(hr) && hr != MF_E_NOTACCEPTING) return;
        drain(rtmp);
    }
private:
    void drain(Rtmp &rtmp) {
        for (;;) {
            MFT_OUTPUT_DATA_BUFFER ob{}; DWORD status = 0;
            IMFSample *mine = nullptr; IMFMediaBuffer *mb = nullptr;
            if (!providesSamples) { MFCreateSample(&mine); MFCreateMemoryBuffer(outSize, &mb); mine->AddBuffer(mb); ob.pSample = mine; }
            HRESULT hr = enc->ProcessOutput(0, 1, &ob, &status);
            if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
                IMFMediaType *t = nullptr; if (SUCCEEDED(enc->GetOutputAvailableType(0, 0, &t))) { enc->SetOutputType(0, t, 0); t->Release(); }
                release(mb); release(mine); release(ob.pEvents); continue;
            }
            if (FAILED(hr)) { release(mb); release(mine); release(ob.pEvents); break; }
            IMFSample *out = ob.pSample;
            LONGLONG t = 0; out->GetSampleTime(&t);
            IMFMediaBuffer *cb = nullptr;
            if (SUCCEEDED(out->ConvertToContiguousBuffer(&cb))) {
                BYTE *d = nullptr; DWORD len = 0; cb->Lock(&d, nullptr, &len);
                send(d, len, (uint32_t)(t / 10000), rtmp);
                cb->Unlock(); cb->Release();
            }
            if (providesSamples) out->Release();
            release(mb); release(mine); release(ob.pEvents);
        }
    }
    void send(const uint8_t *d, size_t n, uint32_t ms, Rtmp &rtmp) {
        auto list = nals(d, n);
        bool key = false;
        for (auto &x : list) { if (x.type == 7) sps.assign(x.p, x.p + x.n); if (x.type == 8) pps.assign(x.p, x.p + x.n); if (x.type == 5) key = true; }
        if (!sentHeader && key && sps.size() > 3 && !pps.empty()) {
            std::vector<uint8_t> h = {0x17, 0, 0, 0, 0, 1, sps[1], sps[2], sps[3], 0xFF, 0xE1, (uint8_t)(sps.size() >> 8), (uint8_t)sps.size()};
            h.insert(h.end(), sps.begin(), sps.end()); h.push_back(1); h.push_back((uint8_t)(pps.size() >> 8)); h.push_back((uint8_t)pps.size()); h.insert(h.end(), pps.begin(), pps.end());
            rtmp.video(h, 0); sentHeader = true;
        }
        if (!sentHeader) return;
        std::vector<uint8_t> body = {(uint8_t)(key ? 0x17 : 0x27), 1, 0, 0, 0};
        for (auto &x : list) {
            if (x.type == 7 || x.type == 8 || x.type == 9) continue;   // parameter sets travel in the header; access unit delimiters are not needed
            body.push_back((uint8_t)(x.n >> 24)); body.push_back((uint8_t)(x.n >> 16)); body.push_back((uint8_t)(x.n >> 8)); body.push_back((uint8_t)x.n);
            body.insert(body.end(), x.p, x.p + x.n);
        }
        if (body.size() > 5) rtmp.video(body, ms);
    }
};

// BGRA (top-down, W x H) to NV12, BT.601 limited range.
void toNV12(const uint8_t *bgra, std::vector<uint8_t> &out) {
    out.resize((size_t)W * H * 3 / 2);
    uint8_t *y = out.data(), *uv = out.data() + (size_t)W * H;
    for (int j = 0; j < H; j++) {
        const uint8_t *row = bgra + (size_t)j * W * 4;
        for (int i = 0; i < W; i++) { int b = row[i * 4], g = row[i * 4 + 1], r = row[i * 4 + 2]; y[(size_t)j * W + i] = (uint8_t)std::min(255, ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16); }
    }
    for (int j = 0; j < H; j += 2) for (int i = 0; i < W; i += 2) {
        int r = 0, g = 0, b = 0;
        for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) { const uint8_t *p = bgra + ((size_t)(j + dy) * W + i + dx) * 4; b += p[0]; g += p[1]; r += p[2]; }
        r /= 4; g /= 4; b /= 4;
        uv[(size_t)(j / 2) * W + i] = (uint8_t)std::max(0, std::min(255, ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128));
        uv[(size_t)(j / 2) * W + i + 1] = (uint8_t)std::max(0, std::min(255, ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128));
    }
}

// ---------------------------------------------------------------- camera (Media Foundation)
class Camera {
public:
    std::mutex lock; std::vector<uint8_t> frame; int fw = 0, fh = 0; bool bottomUp = false; std::atomic<bool> on{false};
    void start() { running = true; worker = std::thread([this] { run(); }); }
    void stop() { running = false; if (worker.joinable()) worker.join(); on = false; }
private:
    std::atomic<bool> running{false}; std::thread worker;
    void run() {
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        IMFAttributes *a = nullptr; IMFActivate **devs = nullptr; UINT32 n = 0; IMFMediaSource *src = nullptr; IMFSourceReader *reader = nullptr;
        MFCreateAttributes(&a, 1); a->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
        if (SUCCEEDED(MFEnumDeviceSources(a, &devs, &n)) && n > 0 && SUCCEEDED(devs[0]->ActivateObject(IID_PPV_ARGS(&src)))) {
            IMFAttributes *ra = nullptr; MFCreateAttributes(&ra, 1); ra->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
            MFCreateSourceReaderFromMediaSource(src, ra, &reader); release(ra);
        }
        for (UINT32 i = 0; i < n; i++) devs[i]->Release();
        CoTaskMemFree(devs); release(a);
        if (reader) {
            IMFMediaType *t = nullptr; MFCreateMediaType(&t);
            t->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video); t->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
            if (SUCCEEDED(reader->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, t))) {
                IMFMediaType *cur = nullptr; UINT32 w = 0, h = 0;
                if (SUCCEEDED(reader->GetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, &cur))) {
                    MFGetAttributeSize(cur, MF_MT_FRAME_SIZE, &w, &h);
                    UINT32 stride = 0;   // a negative stride means the picture arrives bottom row first
                    if (SUCCEEDED(cur->GetUINT32(MF_MT_DEFAULT_STRIDE, &stride))) bottomUp = (INT32)stride < 0;
                    cur->Release();
                }
                while (running && w && h) {
                    DWORD stream = 0, flags = 0; LONGLONG ts = 0; IMFSample *s = nullptr;
                    if (FAILED(reader->ReadSample((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &stream, &flags, &ts, &s)) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) break;
                    if (!s) continue;
                    IMFMediaBuffer *b = nullptr;
                    if (SUCCEEDED(s->ConvertToContiguousBuffer(&b))) {
                        BYTE *d = nullptr; DWORD len = 0; b->Lock(&d, nullptr, &len);
                        if (len >= w * h * 4) { std::lock_guard<std::mutex> g(lock); frame.assign(d, d + w * h * 4); fw = (int)w; fh = (int)h; on = true; }
                        b->Unlock(); b->Release();
                    }
                    s->Release();
                }
            }
            release(t);
        }
        release(reader); if (src) { src->Shutdown(); release(src); }
        CoUninitialize();
    }
};

// ---------------------------------------------------------------- audio: loopback (and microphone) -> AAC
class Audio {
public:
    std::string source = "silent";
    void start(bool mic, Rtmp *r, double t0) { rtmp = r; start0 = t0; useMic = mic; running = true; worker = std::thread([this] { run(); }); }
    void stop() { running = false; if (worker.joinable()) worker.join(); }
private:
    Rtmp *rtmp = nullptr; double start0 = 0; bool useMic = false;
    std::atomic<bool> running{false}; std::thread worker;
    IMFTransform *aac = nullptr; bool sentHeader = false; long long sent = 0; DWORD outSize = 8192; bool aacProvides = false;
    std::vector<float> fifoL, fifoR;

    struct Capture {
        IAudioClient *client = nullptr; IAudioCaptureClient *cap = nullptr; WAVEFORMATEX *fmt = nullptr; bool isFloat = false; double pos = 0;
        std::vector<float> l, r;   // resampled to 48 kHz, waiting to be mixed
        bool open(EDataFlow flow) {
            IMMDeviceEnumerator *en = nullptr; IMMDevice *dev = nullptr;
            HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
            if (SUCCEEDED(hr)) hr = en->GetDefaultAudioEndpoint(flow, eConsole, &dev);
            if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void **)&client);
            if (SUCCEEDED(hr)) hr = client->GetMixFormat(&fmt);
            if (SUCCEEDED(hr)) hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flow == eRender ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0, 2000000, 0, fmt, nullptr);
            if (SUCCEEDED(hr)) hr = client->GetService(IID_PPV_ARGS(&cap));
            if (SUCCEEDED(hr)) hr = client->Start();
            release(dev); release(en);
            if (SUCCEEDED(hr)) isFloat = fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT || (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE && ((WAVEFORMATEXTENSIBLE *)fmt)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
            return SUCCEEDED(hr);
        }
        void close() { if (client) client->Stop(); release(cap); release(client); if (fmt) CoTaskMemFree(fmt); fmt = nullptr; }
        // Reads what has arrived, converting to stereo floats at 48 kHz.
        void read() {
            UINT32 packet = 0;
            while (cap && SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet) {
                BYTE *d = nullptr; UINT32 frames = 0; DWORD flags = 0;
                if (FAILED(cap->GetBuffer(&d, &frames, &flags, nullptr, nullptr))) break;
                int ch = fmt->nChannels, bits = fmt->wBitsPerSample;
                double step = fmt->nSamplesPerSec / 48000.0;
                auto at = [&](UINT32 i, int c) -> float {
                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) return 0;
                    size_t k = (size_t)i * ch + std::min(c, ch - 1);
                    if (isFloat) return ((float *)d)[k];
                    if (bits == 16) return ((int16_t *)d)[k] / 32768.f;
                    return ((int32_t *)d)[k] / 2147483648.f;
                };
                for (; pos < frames; pos += step) { UINT32 i = (UINT32)pos; l.push_back(at(i, 0)); r.push_back(at(i, 1)); }
                pos -= frames;
                cap->ReleaseBuffer(frames);
            }
        }
    };

    bool openAAC() {
        if (FAILED(CoCreateInstance(CLSID_AACMFTEncoder, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&aac)))) return false;
        IMFMediaType *in = nullptr, *out = nullptr;
        MFCreateMediaType(&in);
        in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio); in->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
        in->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16); in->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000); in->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
        in->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 4); in->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 48000 * 4);
        MFCreateMediaType(&out);
        out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio); out->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
        out->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16); out->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000); out->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
        out->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 20000); out->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE, 0);   // 160 kbps, raw AAC frames
        HRESULT hr = aac->SetInputType(0, in, 0);
        if (SUCCEEDED(hr)) hr = aac->SetOutputType(0, out, 0);
        if (FAILED(hr)) { hr = aac->SetOutputType(0, out, 0); if (SUCCEEDED(hr)) hr = aac->SetInputType(0, in, 0); }
        release(in); release(out);
        if (FAILED(hr)) { release(aac); return false; }
        MFT_OUTPUT_STREAM_INFO info{}; aac->GetOutputStreamInfo(0, &info);
        aacProvides = (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0; outSize = std::max<DWORD>(info.cbSize, 8192);
        aac->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
        return true;
    }
    void encode(const float *l, const float *r, int n) {
        IMFMediaBuffer *b = nullptr; IMFSample *s = nullptr;
        if (FAILED(MFCreateMemoryBuffer(n * 4, &b))) return;
        BYTE *p = nullptr; b->Lock(&p, nullptr, nullptr);
        int16_t *pcm = (int16_t *)p;
        for (int i = 0; i < n; i++) { pcm[2 * i] = (int16_t)(std::max(-1.f, std::min(1.f, l[i])) * 32767); pcm[2 * i + 1] = (int16_t)(std::max(-1.f, std::min(1.f, r[i])) * 32767); }
        b->Unlock(); b->SetCurrentLength(n * 4);
        MFCreateSample(&s); s->AddBuffer(b); s->SetSampleTime(sent * 10000000LL / 48000); s->SetSampleDuration((LONGLONG)n * 10000000LL / 48000);
        sent += n;
        aac->ProcessInput(0, s, 0);
        release(s); release(b);
        for (;;) {
            MFT_OUTPUT_DATA_BUFFER ob{}; DWORD status = 0; IMFSample *mine = nullptr; IMFMediaBuffer *mb = nullptr;
            if (!aacProvides) { MFCreateSample(&mine); MFCreateMemoryBuffer(outSize, &mb); mine->AddBuffer(mb); ob.pSample = mine; }
            HRESULT hr = aac->ProcessOutput(0, 1, &ob, &status);
            if (FAILED(hr)) { release(mb); release(mine); release(ob.pEvents); break; }
            LONGLONG t = 0; ob.pSample->GetSampleTime(&t);
            IMFMediaBuffer *cb = nullptr;
            if (SUCCEEDED(ob.pSample->ConvertToContiguousBuffer(&cb))) {
                BYTE *d = nullptr; DWORD len = 0; cb->Lock(&d, nullptr, &len);
                if (!sentHeader) { rtmp->audio({0xAF, 0, 0x11, 0x90}, 0); sentHeader = true; }   // AAC-LC, 48 kHz, stereo
                std::vector<uint8_t> body = {0xAF, 1}; body.insert(body.end(), d, d + len);
                rtmp->audio(body, (uint32_t)(audioStart * 1000 + t / 10000));
                cb->Unlock(); cb->Release();
            }
            if (aacProvides) ob.pSample->Release();
            release(mb); release(mine); release(ob.pEvents);
        }
    }
    double audioStart = 0;
    void run() {
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (!openAAC()) { CoUninitialize(); return; }
        Capture sys, mic;
        bool haveSys = sys.open(eRender), haveMic = useMic && mic.open(eCapture);
        source = haveSys ? (haveMic ? "PC sound + microphone" : "PC sound") : (haveMic ? "microphone" : "silent");
        audioStart = now() - start0;
        long long produced = 0;
        while (running) {
            Sleep(10);
            if (haveSys) sys.read();
            if (haveMic) mic.read();
            // How much to encode: what has arrived from the PC (or the microphone), or silence to keep the stream going.
            size_t ready = haveSys ? sys.l.size() : haveMic ? mic.l.size() : 0;
            if (!haveSys && !haveMic) { long long due = (long long)((now() - start0 - audioStart) * 48000); ready = (size_t)std::max(0LL, due - produced); sys.l.resize(ready, 0); sys.r.resize(ready, 0); }
            for (size_t i = 0; i < ready; i++) {
                float l = (haveSys || (!haveSys && !haveMic)) ? sys.l[i] : 0, r = (haveSys || (!haveSys && !haveMic)) ? sys.r[i] : 0;
                if (haveMic && i < mic.l.size()) { l += mic.l[i]; r += mic.r[i]; }
                fifoL.push_back(l); fifoR.push_back(r);
            }
            if (haveSys || !haveMic) { sys.l.erase(sys.l.begin(), sys.l.begin() + std::min(ready, sys.l.size())); sys.r.erase(sys.r.begin(), sys.r.begin() + std::min(ready, sys.r.size())); }
            if (haveMic) { size_t k = std::min(ready, mic.l.size()); mic.l.erase(mic.l.begin(), mic.l.begin() + k); mic.r.erase(mic.r.begin(), mic.r.begin() + k); if (mic.l.size() > 48000 / 4) { mic.l.clear(); mic.r.clear(); } }
            produced += (long long)ready;
            while (fifoL.size() >= 1024) { encode(fifoL.data(), fifoR.data(), 1024); fifoL.erase(fifoL.begin(), fifoL.begin() + 1024); fifoR.erase(fifoR.begin(), fifoR.begin() + 1024); }
        }
        sys.close(); mic.close();
        if (aac) aac->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        release(aac);
        CoUninitialize();
    }
};

// ---------------------------------------------------------------- the session
class Session {
public:
    Rtmp rtmp; Video video; Audio audio; Camera camera;
    HWND window = nullptr;
    std::atomic<bool> running{false};
    double t0 = 0;
    std::thread videoThread;
    std::string message;

    std::string start(HWND w, const std::string &url, const std::string &key, bool cam, bool mic) {
        window = w;
        MFStartup(MF_VERSION);
        std::string e = rtmp.connect(url, key);
        if (!e.empty()) return e;
        e = video.open();
        if (!e.empty()) { rtmp.close(); return e; }
        rtmp.metadata(W, H, FPS, 4500, 160);
        t0 = now(); running = true;
        audio.start(mic, &rtmp, t0);
        if (cam) camera.start();
        videoThread = std::thread([this] { videoLoop(); });
        return "";
    }
    void stop() {
        running = false;
        if (videoThread.joinable()) videoThread.join();
        audio.stop(); camera.stop(); video.close(); rtmp.close();
        MFShutdown();
    }
private:
    // The window (and camera) composed onto a 1280x720 frame 30 times a second. With the camera on, the window shrinks a
    // little to leave a column on the right, and the camera box sits at the bottom of it, so nothing is covered.
    void videoLoop() {
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        HDC screen = GetDC(nullptr);
        BITMAPINFO bi{}; bi.bmiHeader.biSize = sizeof bi.bmiHeader; bi.bmiHeader.biWidth = W; bi.bmiHeader.biHeight = -H; bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32;
        void *bits = nullptr; HBITMAP canvas = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
        HDC dc = CreateCompatibleDC(screen); HGDIOBJ old = SelectObject(dc, canvas);
        HDC wdc = CreateCompatibleDC(screen); HBITMAP wbmp = nullptr; int ww = 0, wh = 0;
        HBRUSH bg = CreateSolidBrush(RGB(0x0f, 0x10, 0x16)), amber = CreateSolidBrush(RGB(0xe3, 0x9a, 0x12));
        std::vector<uint8_t> nv12;
        long long frame = 0;
        while (running && !rtmp.problem().size()) {
            double due = t0 + (double)frame / FPS, wait = due - now();
            if (wait > 0) Sleep((DWORD)(wait * 1000));
            RECT rc; GetClientRect(window, &rc);
            int cw = rc.right - rc.left, ch = rc.bottom - rc.top;
            if (cw > 0 && ch > 0) {
                if (cw != ww || ch != wh) { if (wbmp) DeleteObject(wbmp); wbmp = CreateCompatibleBitmap(screen, cw, ch); ww = cw; wh = ch; SelectObject(wdc, wbmp); }
                PrintWindow(window, wdc, PW_CLIENTONLY | 2 /* PW_RENDERFULLCONTENT */);
            }
            RECT all{0, 0, W, H}; FillRect(dc, &all, bg);
            bool cam = camera.on;
            const int pad = 12, bw = cam ? (int)(W * 0.17) : 0, bh = bw * 9 / 16;
            int aw = W - (cam ? bw + pad * 3 : pad * 2), ah = H;
            if (ww > 0 && wh > 0) {
                double s = std::min((double)aw / ww, (double)ah / wh);
                int dw = (int)(ww * s), dh = (int)(wh * s), dx = cam ? pad : (W - dw) / 2, dy = (H - dh) / 2;
                SetStretchBltMode(dc, HALFTONE); SetBrushOrgEx(dc, 0, 0, nullptr);
                StretchBlt(dc, dx, dy, dw, dh, wdc, 0, 0, ww, wh, SRCCOPY);
            }
            if (cam) {
                std::lock_guard<std::mutex> g(camera.lock);
                if (camera.fw > 0) {
                    int x = W - bw - pad, y = H - bh - pad - 3;
                    RECT fr{x - 2, y - 2, x + bw + 2, y + bh + 2}; FillRect(dc, &fr, amber);
                    BITMAPINFO ci{}; ci.bmiHeader.biSize = sizeof ci.bmiHeader; ci.bmiHeader.biWidth = camera.fw; ci.bmiHeader.biHeight = camera.bottomUp ? camera.fh : -camera.fh; ci.bmiHeader.biPlanes = 1; ci.bmiHeader.biBitCount = 32;
                    // Fill the box, cropping the camera picture to 16:9, mirrored like a selfie view.
                    double s = std::max((double)bw / camera.fw, (double)bh / camera.fh);
                    int sw = (int)(bw / s), sh = (int)(bh / s), sx = (camera.fw - sw) / 2, sy = (camera.fh - sh) / 2;
                    SetStretchBltMode(dc, HALFTONE);
                    StretchDIBits(dc, x + bw - 1, y, -bw, bh, sx, sy, sw, sh, camera.frame.data(), &ci, DIB_RGB_COLORS, SRCCOPY);
                }
            }
            GdiFlush();
            toNV12((const uint8_t *)bits, nv12);
            video.encode(nv12, frame, rtmp);
            frame++;
            if (frame % 30 == 0 && rtmp.problem().size()) break;
        }
        SelectObject(dc, old); DeleteObject(canvas); DeleteDC(dc); if (wbmp) DeleteObject(wbmp); DeleteDC(wdc);
        DeleteObject(bg); DeleteObject(amber); ReleaseDC(nullptr, screen);
        CoUninitialize();
    }
};

std::mutex sessionLock;
Session *session = nullptr;

std::wstring credName(const std::string &platform) { return L"STRATUM Live/" + wide(platform); }
} // namespace

std::string start(HWND w, const std::string &url, const std::string &key, bool camera, bool mic) {
    stop();
    auto s = new Session();
    std::string e = s->start(w, url, key, camera, mic);
    if (!e.empty()) { s->stop(); delete s; return e; }
    std::lock_guard<std::mutex> g(sessionLock); session = s;
    return "";
}

void stop() {
    Session *s;
    { std::lock_guard<std::mutex> g(sessionLock); s = session; session = nullptr; }
    if (s) { s->stop(); delete s; }
}

Json status() {
    std::lock_guard<std::mutex> g(sessionLock);
    Json o;
    if (!session) { o["state"] = "idle"; return o; }
    double secs = now() - session->t0;
    std::string p = session->rtmp.problem();
    o["state"] = session->rtmp.live() && p.empty() ? "live" : "failed";
    o["seconds"] = secs; o["kbps"] = secs > 1 ? session->rtmp.bytesSent() * 8.0 / 1000 / secs : 0.0;
    o["audio"] = session->audio.source; o["camera"] = (bool)session->camera.on; o["message"] = p;
    return o;
}

void saveKey(const std::string &platform, const std::string &url, const std::string &key) {
    Json j; j["url"] = url; j["key"] = key; std::string blob = j.dump();
    std::wstring target = credName(platform), user = wide(platform);
    CREDENTIALW c{}; c.Type = CRED_TYPE_GENERIC; c.TargetName = (LPWSTR)target.c_str(); c.UserName = (LPWSTR)user.c_str();
    c.CredentialBlobSize = (DWORD)blob.size(); c.CredentialBlob = (LPBYTE)blob.data(); c.Persist = CRED_PERSIST_LOCAL_MACHINE;
    CredWriteW(&c, 0);
}

Json loadKey(const std::string &platform) {
    PCREDENTIALW c = nullptr;
    if (!CredReadW(credName(platform).c_str(), CRED_TYPE_GENERIC, 0, &c) || !c) return Json::object();
    Json j = Json::parse(std::string((const char *)c->CredentialBlob, c->CredentialBlobSize));
    CredFree(c);
    return j.type == Json::Object ? j : Json::object();
}

} // namespace live
