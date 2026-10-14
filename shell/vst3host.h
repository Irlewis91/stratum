// C interface to the VST3 host (vst3host.mm), used from Swift.
#ifndef STRATUM_VST3HOST_H
#define STRATUM_VST3HOST_H
#ifdef __cplusplus
extern "C" {
#endif
typedef struct V3 V3;
// Writes a JSON array of the audio plugins inside a .vst3 bundle: [{"cid","name","vendor","sub"}]. Returns the count, or -1.
int v3_scan(const char *path, char *json, int cap);
V3 *v3_load(const char *path, const char *cid, char *err, int err_len);
void v3_destroy(V3 *p);
int v3_is_instrument(V3 *p);
// Call before rendering and whenever the sample rate or largest block changes.
int v3_setup(V3 *p, double sample_rate, int max_frames);
// Audio thread only. Notes queue for the next v3_process call; `in` may be NULL for instruments.
void v3_note(V3 *p, int on, int pitch, float velocity, int sample_offset);
void v3_process(V3 *p, const float *const *in, float *const *out, int frames);
// Editor: attaches the plugin's view to an NSView. Returns 0 when the plugin has no editor.
int v3_open_view(V3 *p, void *nsview, int *width, int *height);
void v3_close_view(V3 *p);
// State blobs are malloc'd; release with v3_free.
int v3_get_state(V3 *p, unsigned char **data, int *len);
int v3_set_state(V3 *p, const unsigned char *data, int len);
void v3_free(void *data);
#ifdef __cplusplus
}
#endif
#endif
