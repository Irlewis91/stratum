// The binary interface of VST2 plugins as STRATUM uses it. Written for STRATUM from the publicly documented layout;
// it contains no Steinberg SDK code. Only the parts a host needs to load, play, edit and save a plugin are described.
#ifndef STRATUM_VST2ABI_H
#define STRATUM_VST2ABI_H
#include <stdint.h>

typedef struct V2Effect V2Effect;
typedef intptr_t (*V2HostCallback)(V2Effect *fx, int32_t op, int32_t index, intptr_t value, void *ptr, float opt);

struct V2Effect {
    int32_t magic;                      // 'VstP'
    intptr_t (*dispatch)(V2Effect *fx, int32_t op, int32_t index, intptr_t value, void *ptr, float opt);
    void (*processOld)(V2Effect *fx, float **in, float **out, int32_t frames);
    void (*setParam)(V2Effect *fx, int32_t index, float value);
    float (*getParam)(V2Effect *fx, int32_t index);
    int32_t numPrograms, numParams, numInputs, numOutputs, flags;
    void *hostA, *hostB;
    int32_t delay, unusedA, unusedB;
    float ioRatio;
    void *object, *user;
    int32_t uniqueID, version;
    void (*process)(V2Effect *fx, float **in, float **out, int32_t frames);
    void (*processDouble)(V2Effect *fx, double **in, double **out, int32_t frames);
    char future[56];
};

enum { V2_MAGIC = 0x56737450 };
enum { V2_FLAG_EDITOR = 1 << 0, V2_FLAG_FLOAT = 1 << 4, V2_FLAG_CHUNKS = 1 << 5, V2_FLAG_SYNTH = 1 << 8 };
// Calls into the plugin.
enum {
    V2_OPEN = 0, V2_CLOSE = 1, V2_SET_RATE = 10, V2_SET_BLOCK = 11, V2_RESUME = 12, V2_EDIT_RECT = 13, V2_EDIT_OPEN = 14,
    V2_EDIT_CLOSE = 15, V2_EDIT_IDLE = 19, V2_GET_CHUNK = 23, V2_SET_CHUNK = 24, V2_EVENTS = 25, V2_NAME = 45,
    V2_VENDOR = 47, V2_PRODUCT = 48, V2_START = 71, V2_STOP = 72
};
// Calls from the plugin to the host.
enum {
    V2H_AUTOMATE = 0, V2H_VERSION = 1, V2H_TIME = 7, V2H_RESIZE = 15, V2H_RATE = 16, V2H_BLOCK = 17, V2H_LEVEL = 23,
    V2H_VENDOR = 32, V2H_PRODUCT = 33, V2H_VENDOR_VERSION = 34, V2H_CAN_DO = 37
};

typedef struct { int16_t top, left, bottom, right; } V2Rect;

typedef struct {
    int32_t type, size, offset, flags, noteLength, noteOffset;   // type 1 = MIDI
    char midi[4];
    char detune, offVelocity, r1, r2;
} V2MidiEvent;

typedef struct { int32_t count; intptr_t reserved; V2MidiEvent *events[256]; } V2Events;

typedef struct {
    double samplePos, sampleRate, nanoSeconds, ppqPos, tempo, barStart, cycleStart, cycleEnd;
    int32_t sigNum, sigDen, smpteOffset, smpteRate, samplesToClock, flags;
} V2Time;
enum { V2T_PLAYING = 1 << 1, V2T_PPQ = 1 << 9, V2T_TEMPO = 1 << 10, V2T_SIG = 1 << 13 };

#endif
