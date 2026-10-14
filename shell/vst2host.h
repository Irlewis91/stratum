// VST2 side of the plugin host (vst2host.mm). Same shape as the v3_ calls in vst3host.h, which forward here for .vst bundles.
#ifndef STRATUM_VST2HOST_H
#define STRATUM_VST2HOST_H
typedef struct V2 V2;
int v2_scan(const char *path, char *json, int cap);
V2 *v2_load(const char *path, char *err, int err_len);
void v2_destroy(V2 *p);
int v2_is_instrument(V2 *p);
int v2_setup(V2 *p, double sample_rate, int max_frames);
void v2_note(V2 *p, int on, int pitch, float velocity, int sample_offset);
void v2_transport(V2 *p, double tempo, double beat, int playing);
void v2_process(V2 *p, const float *const *in, float *const *out, int frames);
int v2_open_view(V2 *p, void *nsview, int *width, int *height);
void v2_close_view(V2 *p);
int v2_get_state(V2 *p, unsigned char **data, int *len);
int v2_set_state(V2 *p, const unsigned char *data, int len);
#endif
