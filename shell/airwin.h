// C interface to the Airwindows effects (airwin.cpp), used from Swift.
#ifndef STRATUM_AIRWIN_H
#define STRATUM_AIRWIN_H
#ifdef __cplusplus
extern "C" {
#endif
int aw_count(void);
// Catalogue entry i: name, category, a one-line description, and collections such as "Recommended" (comma separated).
const char *aw_name(int i);
const char *aw_category(int i);
const char *aw_what(int i);
const char *aw_collections(int i);
void *aw_create(const char *name, double sample_rate);
void aw_destroy(void *fx);
void aw_set_rate(void *fx, double sample_rate);
int aw_params(void *fx);
void aw_param_name(void *fx, int i, char *text, int len);
void aw_param_display(void *fx, int i, char *text, int len);   // value and unit as Airwindows shows them
float aw_get(void *fx, int i);
void aw_set(void *fx, int i, float value);
void aw_process(void *fx, float **in, float **out, int frames);
#ifdef __cplusplus
}
#endif
#endif
