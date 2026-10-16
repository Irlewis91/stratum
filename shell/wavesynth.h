// C interface to STRATUM Wave (wavesynth.cpp), STRATUM's own wavetable synthesizer, used from Swift.
#ifndef STRATUM_WAVESYNTH_H
#define STRATUM_WAVESYNTH_H
#ifdef __cplusplus
extern "C" {
#endif
// Parameter catalogue. Indexed parameters (kind 1) hold a whole number 0..options-1; the rest run from 0 to 1.
int ws_param_count(void);
const char *ws_param_name(int i);
int ws_param_kind(int i);
int ws_param_options(int i);
const char *ws_param_option(int i, int option);
float ws_param_default(int i);
int ws_preset_count(void);
const char *ws_preset_name(int p);
int ws_table_count(void);

void *ws_create(double sample_rate);
void ws_destroy(void *s);
void ws_set_rate(void *s, double sample_rate);
float ws_get(void *s, int i);
void ws_set(void *s, int i, float value);
void ws_display(void *s, int i, char *text, int len);
void ws_preset(void *s, int p);
// Song tempo and position (quarter notes) for tempo-synced LFOs.
void ws_transport(void *s, double bpm, double beat);
// Audio thread: queue a note for the next ws_process call, then render `frames` stereo samples.
void ws_note(void *s, int on, int pitch, float velocity, int offset);
void ws_all_off(void *s);
void ws_process(void *s, float *left, float *right, int frames);
// Custom wavetable for oscillator 0 or 1: `frames` single cycles of 2048 samples each (frames * 2048 floats).
void ws_load_table(void *s, int osc, const float *data, int frames, const char *name);
// The custom table currently held by an oscillator (for saving): returns frame count; data is frames * 2048 floats.
int ws_custom_table(void *s, int osc, const float **data, const char **name);
// The waveform an oscillator is playing right now, as `n` points for display.
void ws_frame(void *s, int osc, float *out, int n);
#ifdef __cplusplus
}
#endif
#endif
