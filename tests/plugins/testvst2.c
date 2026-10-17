// Two tiny VST2 plugins for STRATUM's self-checks, written against shell/vst2abi.h: "TestGain" (an effect that scales its
// input by its one control, Gain, x0..x2) and, built with -DTONE, "TestTone" (an instrument that plays a sine for each note).
#include "../../shell/vst2abi.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

typedef struct {
    V2Effect fx;
    V2HostCallback host;
    float gain;
    double rate, phase;
    int note;        // -1 when silent
    float vel;
} Plug;

static void set_param(V2Effect *e, int32_t i, float v) { if (i == 0) ((Plug *)e)->gain = v; }
static float get_param(V2Effect *e, int32_t i) { return i == 0 ? ((Plug *)e)->gain : 0; }

static void process(V2Effect *e, float **in, float **out, int32_t n) {
    Plug *p = (Plug *)e;
#ifdef TONE
    (void)in;
    for (int32_t i = 0; i < n; i++) {
        float s = 0;
        if (p->note >= 0) { s = (float)sin(p->phase) * 0.5f * p->vel * p->gain * 2; p->phase += 2 * 3.14159265358979 * 440.0 * pow(2.0, (p->note - 69) / 12.0) / p->rate; }
        out[0][i] = s; out[1][i] = s;
    }
#else
    for (int32_t i = 0; i < n; i++) { out[0][i] = in[0][i] * p->gain * 2; out[1][i] = in[1][i] * p->gain * 2; }
#endif
}

static void copy(void *ptr, const char *s, size_t cap) { if (ptr) { strncpy((char *)ptr, s, cap - 1); ((char *)ptr)[cap - 1] = 0; } }

static intptr_t dispatch(V2Effect *e, int32_t op, int32_t index, intptr_t value, void *ptr, float opt) {
    Plug *p = (Plug *)e;
    (void)value;
    switch (op) {
    case V2_CLOSE: free(p); return 1;
    case V2_SET_RATE: p->rate = opt > 0 ? opt : 44100; return 1;
    case 6: copy(ptr, "x", 8); return 1;                                   // control label
    case 7: { char t[16]; int pct = (int)(p->gain * 200 + 0.5); t[0] = (char)('0' + pct / 100 % 10); t[1] = '.'; t[2] = (char)('0' + pct / 10 % 10); t[3] = (char)('0' + pct % 10); t[4] = 0; copy(ptr, t, 8); return 1; }   // control value
    case 8: copy(ptr, "Gain", 8); return 1;                                // control name
#ifdef TONE
    case V2_NAME: copy(ptr, "TestTone", 32); return 1;
#else
    case V2_NAME: copy(ptr, "TestGain", 32); return 1;
#endif
    case V2_VENDOR: copy(ptr, "STRATUM Tests", 64); return 1;
    case V2_PRODUCT: copy(ptr, "STRATUM Test", 64); return 1;
    case V2_EVENTS: {
        V2Events *ev = (V2Events *)ptr;
        for (int32_t i = 0; ev && i < ev->count; i++) {
            V2MidiEvent *m = ev->events[i];
            if (!m || m->type != 1) continue;
            int status = m->midi[0] & 0xF0, key = m->midi[1] & 127, vel = m->midi[2] & 127;
            if (status == 0x90 && vel > 0) { p->note = key; p->vel = vel / 127.f; p->phase = 0; }
            else if ((status == 0x80 || status == 0x90) && key == p->note) p->note = -1;
        }
        return 1;
    }
    default: return 0;
    }
}

EXPORT V2Effect *VSTPluginMain(V2HostCallback host) {
    Plug *p = (Plug *)calloc(1, sizeof(Plug));
    p->host = host; p->gain = 0.5f; p->rate = 44100; p->note = -1;
    p->fx.magic = V2_MAGIC;
    p->fx.dispatch = dispatch;
    p->fx.setParam = set_param;
    p->fx.getParam = get_param;
    p->fx.numPrograms = 1; p->fx.numParams = 1;
#ifdef TONE
    p->fx.numInputs = 0; p->fx.numOutputs = 2; p->fx.flags = V2_FLAG_FLOAT | V2_FLAG_SYNTH; p->fx.uniqueID = 0x53745454;
#else
    p->fx.numInputs = 2; p->fx.numOutputs = 2; p->fx.flags = V2_FLAG_FLOAT; p->fx.uniqueID = 0x53745447;
#endif
    p->fx.process = process;
    p->fx.processOld = process;
    return &p->fx;
}
