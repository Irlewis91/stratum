// Stem separation bridge: runs the bundled HT-Demucs model through ONNX Runtime.
#ifndef STRATUM_STEMS_H
#define STRATUM_STEMS_H

typedef void (*stratum_progress)(float fraction, void *ctx);

// Splits a 44.1 kHz stereo mix of n frames into four stems (drums, bass, other, vocals).
// `out` receives 4 stems x 2 channels x n frames, planar: sample i of stem s, channel c is out[(s * 2 + c) * n + i].
// Returns 0 on success; on failure writes a message into err.
int stratum_separate(const char *runtime_lib, const char *model_path, const float *left, const float *right, long n,
                     float *out, stratum_progress progress, void *ctx, char *err, int err_len);

#endif
