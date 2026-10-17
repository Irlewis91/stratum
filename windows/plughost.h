// STRATUM for Windows: the C calls of the VST3 and VST2 hosts (vst3host_win.cpp, vst2host_win.cpp). The same shape as
// shell/vst3host.h on the Mac, with plugin editors placed in a Windows window and plugin controls for the Devices panel.
#pragma once
#ifdef __cplusplus
extern "C" {
#endif
typedef struct V3 V3;
// Writes a JSON array of the audio plugins in a .vst3 or VST2 .dll file: [{"cid","name","vendor","sub"}]. Returns the count, or -1.
int v3_scan(const wchar_t *path, char *json, int cap);
V3 *v3_load(const wchar_t *path, const char *cid, char *err, int err_len);
void v3_destroy(V3 *p);
int v3_is_instrument(V3 *p);
int v3_setup(V3 *p, double sample_rate, int max_frames);
void v3_note(V3 *p, int on, int pitch, float velocity, int sample_offset);
void v3_transport(V3 *p, double tempo, double beat, int playing);
void v3_process(V3 *p, const float *const *in, float *const *out, int frames);
// Editor: attaches the plugin's own window to `hwnd`. Returns 0 when the plugin has no editor. `on_resize` is called with
// the size the plugin asks for.
int v3_open_view(V3 *p, void *hwnd, int *width, int *height, void (*on_resize)(void *hwnd, int w, int h));
void v3_close_view(V3 *p);
void v3_idle(V3 *p);
int v3_get_state(V3 *p, unsigned char **data, int *len);
int v3_set_state(V3 *p, const unsigned char *data, int len);
void v3_free(void *data);
// Controls: count, then per index a stable id, name, 0..1 value, display text, and (for stepped controls) the step count.
int v3_param_count(V3 *p);
int v3_param_info(V3 *p, int index, unsigned *id, char *name, int name_len, int *steps);
double v3_param_get(V3 *p, unsigned id);
void v3_param_set(V3 *p, unsigned id, double value);
void v3_param_text(V3 *p, unsigned id, double value, char *text, int len);
#ifdef __cplusplus
}
#endif
