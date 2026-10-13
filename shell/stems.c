// Stem separation: HT-Demucs (4-stem ONNX export) run segment by segment with overlap-add.
// ONNX Runtime is loaded at run time so the app still launches where the library is absent.
#include "stems.h"
#include "onnxruntime_c_api.h"
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SEG 343980 /* 7.8 s at 44.1 kHz: the model's fixed input length */
#define STEMS 4

static void set_err(char *err, int n, const char *msg) {
    if (err && n > 0) snprintf(err, (size_t)n, "%s", msg ? msg : "unknown error");
}

int stratum_separate(const char *runtime_lib, const char *model_path, const float *left, const float *right, long n,
                     float *out, stratum_progress progress, void *ctx, char *err, int err_len) {
    void *lib = dlopen(runtime_lib, RTLD_NOW | RTLD_LOCAL);
    if (!lib) { set_err(err, err_len, dlerror()); return 1; }
    const OrtApiBase *(*get_base)(void) = (const OrtApiBase *(*)(void))dlsym(lib, "OrtGetApiBase");
    if (!get_base) { set_err(err, err_len, "ONNX Runtime entry point not found"); return 1; }
    const OrtApi *g = get_base()->GetApi(ORT_API_VERSION);
    if (!g) { set_err(err, err_len, "ONNX Runtime version is too old"); return 1; }

    OrtEnv *env = NULL; OrtSessionOptions *opts = NULL; OrtSession *sess = NULL; OrtMemoryInfo *mem = NULL;
    OrtValue *tin = NULL, *tout = NULL; OrtStatus *st = NULL;
    const long overlap = SEG / 4, stride = SEG - overlap;
    float *in = calloc((size_t)2 * SEG, sizeof(float)), *win = malloc(sizeof(float) * SEG), *wsum = calloc((size_t)n, sizeof(float));
    int rc = 1;
    if (!in || !win || !wsum) { set_err(err, err_len, "out of memory"); goto done; }
    for (long i = 0; i < SEG; i++) win[i] = 1.0f;
    for (long i = 0; i < overlap; i++) { float f = (float)i / (float)(overlap - 1); win[i] = f; win[SEG - 1 - i] = f; }
    memset(out, 0, sizeof(float) * (size_t)STEMS * 2 * (size_t)n);

#define CHECK(call) do { st = (call); if (st) { set_err(err, err_len, g->GetErrorMessage(st)); g->ReleaseStatus(st); goto done; } } while (0)
    CHECK(g->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "stratum", &env));
    CHECK(g->CreateSessionOptions(&opts));
    CHECK(g->SetSessionGraphOptimizationLevel(opts, ORT_ENABLE_ALL));
    CHECK(g->CreateSession(env, model_path, opts, &sess));
    CHECK(g->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &mem));

    long chunks = (n + stride - 1) / stride;
    if (chunks < 1) chunks = 1;
    const char *in_names[] = {"mix"}, *out_names[] = {"stems"};
    const int64_t shape[3] = {1, 2, SEG};
    for (long c = 0; c < chunks; c++) {
        long start = c * stride, end = start + SEG < n ? start + SEG : n, len = end - start;
        if (len <= 0) break;
        memset(in, 0, sizeof(float) * 2 * SEG);
        memcpy(in, left + start, sizeof(float) * (size_t)len);
        memcpy(in + SEG, right + start, sizeof(float) * (size_t)len);
        CHECK(g->CreateTensorWithDataAsOrtValue(mem, in, sizeof(float) * 2 * SEG, shape, 3, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &tin));
        CHECK(g->Run(sess, NULL, in_names, (const OrtValue *const *)&tin, 1, out_names, 1, &tout));
        float *res = NULL; /* shape (1, 4, 2, SEG) */
        CHECK(g->GetTensorMutableData(tout, (void **)&res));
        for (int k = 0; k < STEMS * 2; k++) {
            const float *src = res + (size_t)k * SEG;
            float *dst = out + (size_t)k * (size_t)n + start;
            for (long i = 0; i < len; i++) dst[i] += src[i] * win[i];
        }
        for (long i = 0; i < len; i++) wsum[start + i] += win[i];
        g->ReleaseValue(tin); tin = NULL;
        g->ReleaseValue(tout); tout = NULL;
        if (progress) progress((float)(c + 1) / (float)chunks, ctx);
    }
    for (int k = 0; k < STEMS * 2; k++) {
        float *dst = out + (size_t)k * (size_t)n;
        for (long i = 0; i < n; i++) dst[i] /= wsum[i] > 1e-8f ? wsum[i] : 1e-8f;
    }
    rc = 0;

done:
    if (tin) g->ReleaseValue(tin);
    if (tout) g->ReleaseValue(tout);
    if (mem) g->ReleaseMemoryInfo(mem);
    if (sess) g->ReleaseSession(sess);
    if (opts) g->ReleaseSessionOptions(opts);
    if (env) g->ReleaseEnv(env);
    free(in); free(win); free(wsum);
    return rc;
}
