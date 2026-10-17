// C interface to STRATUM Tune (tune.cpp), STRATUM's own pitch correction, used from Swift.
#ifndef STRATUM_TUNE_H
#define STRATUM_TUNE_H
#ifdef __cplusplus
extern "C" {
#endif
int tn_param_count(void);
const char *tn_param_name(int i);
int tn_param_kind(int i);            // 1 = indexed (whole number 0..options-1), 0 = 0..1
int tn_param_options(int i);
const char *tn_param_option(int i, int option);
void *tn_create(double sample_rate);
void tn_destroy(void *t);
void tn_set_rate(void *t, double sample_rate);
float tn_get(void *t, int i);
void tn_set(void *t, int i, float value);
void tn_display(void *t, int i, char *text, int len);
void tn_process(void *t, const float *const *in, float *const *out, int frames);
// Last detected pitch (MIDI note number, 0 when nothing pitched) and the note it is being corrected to.
float tn_detected(void *t);
float tn_target(void *t);
#ifdef __cplusplus
}
#endif
#endif
