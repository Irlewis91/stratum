// STRATUM Tune: pitch correction. Finds the pitch of the incoming voice (YIN, on a half-rate copy), works out the nearest
// note in the chosen key and scale, glides toward it at the retune speed, and shifts the audio with a two-head delay
// whose window follows the voice's period.
#include "tune.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>

namespace {
constexpr double PI = 3.14159265358979323846;
enum { KEY, SCALE, SPEED, AMOUNT, MIX, NP };
const char *KEYS[] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
const char *SCALES[] = {"Chromatic", "Major", "Minor", "Harmonic minor", "Major Pentatonic", "Minor Pentatonic", "Blues", "Dorian", "Mixolydian"};
const int SCALE_SETS[9][12] = {
    {1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1}, {1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1}, {1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0},
    {1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1}, {1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0}, {1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0},
    {1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0}, {1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0}, {1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0},
};
struct Param { const char *name; int kind; int options; const char **labels; float def; };
const Param PARAMS[NP] = {
    {"Key", 1, 12, KEYS, 0}, {"Scale", 1, 9, SCALES, 1}, {"Retune speed", 0, 0, nullptr, 0.15f}, {"Amount", 0, 0, nullptr, 1}, {"Mix", 0, 0, nullptr, 1},
};
constexpr int RING = 16384, MASK = RING - 1, WIN = 1024, HOP = 128;   // analysis at half rate: WIN covers ~46 ms
}

struct Tune
{
    double sr = 44100;
    float p[NP];
    std::vector<float> ring[2], ana;   // delay lines, and the half-rate mono copy for analysis
    int w = 0, anaW = 0, sinceHop = 0;
    double shift = 0, target = 0, period = 400, win = 800, d = 0, detected = 0, goal = 0;
    float prevMono = 0;
    std::vector<float> diff;
    Tune() { for (int i = 0; i < NP; i++) p[i] = PARAMS[i].def; ring[0].assign(RING, 0); ring[1].assign(RING, 0); ana.assign(RING, 0); diff.assign(WIN / 2 + 1, 0); }

    // YIN on the newest WIN half-rate samples. Returns the period in full-rate samples, or 0 when there is no clear pitch.
    double yin()
    {
        const int half = WIN / 2, maxTau = std::min(half, (int)(sr / 2 / 70)), minTau = std::max(2, (int)(sr / 2 / 1100));
        const int start = anaW - WIN;
        double energy = 0;
        for (int i = 0; i < WIN; i++) { const float x = ana[(start + i) & MASK]; energy += x * x; }
        if (energy / WIN < 1e-6) return 0;
        diff[0] = 1;
        double run = 0;
        for (int tau = 1; tau <= maxTau; tau++)
        {
            double s = 0;
            for (int i = 0; i < half; i++) { const float a = ana[(start + i) & MASK] - ana[(start + i + tau) & MASK]; s += a * a; }
            run += s;
            diff[tau] = (float)(run > 0 ? s * tau / run : 1);
        }
        int best = 0;
        for (int tau = minTau; tau <= maxTau; tau++)
            if (diff[tau] < 0.15f) { while (tau + 1 <= maxTau && diff[tau + 1] < diff[tau]) tau++; best = tau; break; }
        if (!best) return 0;
        double t = best;
        if (best > 1 && best < maxTau) { const double a = diff[best - 1], b = diff[best], c = diff[best + 1], den = a - 2 * b + c; if (std::abs(den) > 1e-12) t += 0.5 * (a - c) / den; }
        return t * 2;
    }

    void analyse()
    {
        const double per = yin();
        const double hopTime = HOP * 2 / sr;
        if (per > 0)
        {
            period = per;
            const double midi = 69 + 12 * std::log2(sr / per / 440.0);
            const int key = (int)p[KEY], scale = (int)p[SCALE];
            double bestN = std::round(midi), bestD = 1e9;
            for (int n = (int)std::floor(midi) - 12; n <= (int)std::ceil(midi) + 12; n++)
                if (SCALE_SETS[scale][((n - key) % 12 + 12) % 12] && std::abs(n - midi) < bestD) { bestD = std::abs(n - midi); bestN = n; }
            detected = midi; goal = bestN;
            target = (bestN - midi) * p[AMOUNT];
        }
        else { detected = 0; goal = 0; target = 0; }
        const double tauS = p[SPEED] * 0.4;
        shift = tauS < 0.001 ? target : shift + (target - shift) * (1 - std::exp(-hopTime / tauS));
        win = std::max(441.0, std::min(3000.0, 2 * period));
    }

    void process(const float *const *in, float *const *out, int n)
    {
        for (int i = 0; i < n; i++)
        {
            const float l = in[0][i], r = in[1] ? in[1][i] : l, mono = 0.5f * (l + r);
            ring[0][w] = l; ring[1][w] = r;
            if (i % 2 == 0) { ana[anaW & MASK] = 0.5f * (mono + prevMono); anaW++; if (++sinceHop >= HOP) { sinceHop = 0; if (anaW > WIN) analyse(); } }
            prevMono = mono;
            const double ratio = std::pow(2.0, shift / 12);
            d += 1 - ratio;
            while (d < 0) d += win;
            while (d >= win) d -= win;
            const double d2 = std::fmod(d + win / 2, win);
            const double g1 = std::pow(std::sin(PI * d / win), 2), g2 = std::pow(std::sin(PI * d2 / win), 2);
            for (int c = 0; c < 2; c++)
            {
                auto tap = [&](double delay) { const double pos = w - delay - 2; const int i0 = (int)std::floor(pos); const double fr = pos - i0; const float a = ring[c][i0 & MASK], b = ring[c][(i0 + 1) & MASK]; return a + (b - a) * fr; };
                const double wet = g1 * tap(d) + g2 * tap(d2), dry = c ? r : l;
                out[c][i] = (float)(dry + (wet - dry) * p[MIX]);
            }
            w = (w + 1) & MASK;
        }
    }
};

extern "C" {
int tn_param_count(void) { return NP; }
const char *tn_param_name(int i) { return i >= 0 && i < NP ? PARAMS[i].name : ""; }
int tn_param_kind(int i) { return i >= 0 && i < NP ? PARAMS[i].kind : 0; }
int tn_param_options(int i) { return i >= 0 && i < NP ? PARAMS[i].options : 0; }
const char *tn_param_option(int i, int o) { return i >= 0 && i < NP && PARAMS[i].labels && o >= 0 && o < PARAMS[i].options ? PARAMS[i].labels[o] : ""; }
void *tn_create(double sample_rate) { auto t = new Tune(); t->sr = sample_rate; return t; }
void tn_destroy(void *t) { delete (Tune *)t; }
void tn_set_rate(void *t, double sample_rate) { ((Tune *)t)->sr = sample_rate; }
float tn_get(void *t, int i) { return i >= 0 && i < NP ? ((Tune *)t)->p[i] : 0; }
void tn_set(void *pt, int i, float v)
{
    if (i < 0 || i >= NP) return;
    auto t = (Tune *)pt;
    t->p[i] = PARAMS[i].kind == 1 ? std::max(0.f, std::min((float)PARAMS[i].options - 1, std::round(v))) : std::max(0.f, std::min(1.f, v));
}
void tn_display(void *pt, int i, char *text, int len)
{
    auto t = (Tune *)pt;
    if (i < 0 || i >= NP) { snprintf(text, len, "%s", ""); return; }
    const float v = t->p[i];
    if (PARAMS[i].kind == 1) snprintf(text, len, "%s", PARAMS[i].labels[(int)v]);
    else if (i == SPEED) { if (v < 0.0025f) snprintf(text, len, "Instant (robot)"); else snprintf(text, len, "%.0f ms", v * 400); }
    else snprintf(text, len, "%.0f%%", v * 100);
}
void tn_process(void *t, const float *const *in, float *const *out, int frames) { ((Tune *)t)->process(in, out, frames); }
float tn_detected(void *t) { return (float)((Tune *)t)->detected; }
float tn_target(void *t) { return (float)((Tune *)t)->goal; }
}
