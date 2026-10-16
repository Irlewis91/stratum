// STRATUM Wave: STRATUM's own wavetable synthesizer.
//   Two wavetable oscillators (morphing position, up to 8-voice unison with detune and stereo spread), a sub and noise,
//   a multimode filter with drive, key tracking and envelope, amp and mod envelopes, a tempo-syncable LFO, poly / mono /
//   legato with glide. Every table is stored as 11 band-limited copies (one per octave) so high notes do not alias.
#include "wavesynth.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <random>
#include <string>
#include <vector>

namespace {
constexpr int N = 2048, LEVELS = 11, VOICES = 16, UNI = 8, MAXEV = 256;
constexpr double PI = 3.14159265358979323846;

// ---- parameters ----
enum {
    A_TABLE, A_POS, A_OCT, A_SEMI, A_FINE, A_LEVEL, A_UNI, A_DET, A_SPREAD,
    B_TABLE, B_POS, B_OCT, B_SEMI, B_FINE, B_LEVEL, B_UNI, B_DET, B_SPREAD,
    SUB, NOISE, F_TYPE, F_CUT, F_RES, F_DRIVE, F_KEY, F_ENV,
    AMP_A, AMP_D, AMP_S, AMP_R, MOD_A, MOD_D, MOD_S, MOD_R, MOD_POS_A, MOD_POS_B,
    LFO_SHAPE, LFO_RATE, LFO_SYNC, LFO_CUT, LFO_POS, LFO_PITCH, LFO_AMP,
    MODE, GLIDE, VEL, MASTER, NP
};
const char *TABLES[] = {"Basic Shapes", "PWM", "Harmonic Sweep", "Formant", "Digital", "Hollow", "Sync Sweep", "Growl", "Organ", "Custom (imported)"};
constexpr int NTABLES = 9;   // built in; index NTABLES is the oscillator's own imported table
const char *OCTS[] = {"-3", "-2", "-1", "0", "+1", "+2", "+3"};
const char *SEMIS[] = {"-12", "-11", "-10", "-9", "-8", "-7", "-6", "-5", "-4", "-3", "-2", "-1", "0", "+1", "+2", "+3", "+4", "+5", "+6", "+7", "+8", "+9", "+10", "+11", "+12"};
const char *UNIS[] = {"1", "2", "3", "4", "5", "6", "7", "8"};
const char *FTYPES[] = {"Off", "Low-pass 12", "Low-pass 24", "High-pass", "Band-pass"};
const char *SHAPES[] = {"Sine", "Triangle", "Saw", "Square", "Random"};
const char *SYNCS[] = {"Free", "4 bars", "2 bars", "1 bar", "1/2", "1/4", "1/8", "1/16", "1/4 triplet", "1/8 triplet", "1/16 triplet"};
const double SYNC_BEATS[] = {0, 16, 8, 4, 2, 1, 0.5, 0.25, 2.0 / 3, 1.0 / 3, 1.0 / 6};
const char *MODES[] = {"Poly", "Mono", "Legato"};

struct Param { const char *name; int kind; int options; const char **labels; float def; };
const Param PARAMS[NP] = {
    {"Osc A · Wavetable", 1, NTABLES + 1, TABLES, 0}, {"Osc A · Position", 0, 0, nullptr, 0.66f}, {"Osc A · Octave", 1, 7, OCTS, 3},
    {"Osc A · Semitone", 1, 25, SEMIS, 12}, {"Osc A · Fine", 0, 0, nullptr, 0.5f}, {"Osc A · Level", 0, 0, nullptr, 0.8f},
    {"Osc A · Unison", 1, 8, UNIS, 0}, {"Osc A · Detune", 0, 0, nullptr, 0.25f}, {"Osc A · Spread", 0, 0, nullptr, 0.6f},
    {"Osc B · Wavetable", 1, NTABLES + 1, TABLES, 0}, {"Osc B · Position", 0, 0, nullptr, 0.2f}, {"Osc B · Octave", 1, 7, OCTS, 3},
    {"Osc B · Semitone", 1, 25, SEMIS, 12}, {"Osc B · Fine", 0, 0, nullptr, 0.5f}, {"Osc B · Level", 0, 0, nullptr, 0},
    {"Osc B · Unison", 1, 8, UNIS, 0}, {"Osc B · Detune", 0, 0, nullptr, 0.25f}, {"Osc B · Spread", 0, 0, nullptr, 0.6f},
    {"Sub & Noise · Sub", 0, 0, nullptr, 0}, {"Sub & Noise · Noise", 0, 0, nullptr, 0},
    {"Filter · Type", 1, 5, FTYPES, 2}, {"Filter · Cutoff", 0, 0, nullptr, 0.75f}, {"Filter · Resonance", 0, 0, nullptr, 0.15f},
    {"Filter · Drive", 0, 0, nullptr, 0}, {"Filter · Key track", 0, 0, nullptr, 0.3f}, {"Filter · Envelope", 0, 0, nullptr, 0.5f},
    {"Amp Envelope · Attack", 0, 0, nullptr, 0.1f}, {"Amp Envelope · Decay", 0, 0, nullptr, 0.5f}, {"Amp Envelope · Sustain", 0, 0, nullptr, 0.8f},
    {"Amp Envelope · Release", 0, 0, nullptr, 0.6f},
    {"Mod Envelope · Attack", 0, 0, nullptr, 0}, {"Mod Envelope · Decay", 0, 0, nullptr, 0.55f}, {"Mod Envelope · Sustain", 0, 0, nullptr, 0},
    {"Mod Envelope · Release", 0, 0, nullptr, 0.5f}, {"Mod Envelope · To position A", 0, 0, nullptr, 0.5f}, {"Mod Envelope · To position B", 0, 0, nullptr, 0.5f},
    {"LFO · Shape", 1, 5, SHAPES, 0}, {"LFO · Rate", 0, 0, nullptr, 0.5f}, {"LFO · Sync", 1, 11, SYNCS, 0}, {"LFO · To cutoff", 0, 0, nullptr, 0},
    {"LFO · To position", 0, 0, nullptr, 0}, {"LFO · To pitch", 0, 0, nullptr, 0}, {"LFO · To volume", 0, 0, nullptr, 0},
    {"Voice · Mode", 1, 3, MODES, 0}, {"Voice · Glide", 0, 0, nullptr, 0}, {"Voice · Velocity", 0, 0, nullptr, 0.5f}, {"Voice · Volume", 0, 0, nullptr, 0.7f},
};

double envTime(float v) { return 0.001 * std::pow(10000.0, v); }   // 1 ms .. 10 s
double cutoffHz(float v) { return 20.0 * std::pow(1000.0, v); }      // 20 Hz .. 20 kHz
double lfoHz(float v) { return 0.05 * std::pow(400.0, v); }          // 0.05 .. 20 Hz

// ---- band-limited tables ----
void fft(std::vector<std::complex<double>> &a, bool inverse)
{
    const int n = (int)a.size();
    for (int i = 1, j = 0; i < n; i++) { int bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) std::swap(a[i], a[j]); }
    for (int len = 2; len <= n; len <<= 1)
    {
        const double ang = 2 * PI / len * (inverse ? 1 : -1);
        const std::complex<double> wl(std::cos(ang), std::sin(ang));
        for (int i = 0; i < n; i += len)
        {
            std::complex<double> w(1);
            for (int j = 0; j < len / 2; j++) { auto u = a[i + j], v = a[i + j + len / 2] * w; a[i + j] = u + v; a[i + j + len / 2] = u - v; w *= wl; }
        }
    }
    if (inverse) for (auto &x : a) x /= n;
}

struct Table
{
    int frames = 0;
    std::vector<float> data;   // [frame][level][N + 1] (last sample repeats the first for interpolation)
    const float *at(int frame, int level) const { return data.data() + ((size_t)frame * LEVELS + level) * (N + 1); }
};

std::shared_ptr<Table> build(const std::vector<std::vector<double>> &cycles)
{
    auto t = std::make_shared<Table>();
    t->frames = (int)cycles.size();
    t->data.assign((size_t)t->frames * LEVELS * (N + 1), 0.f);
    std::vector<std::complex<double>> spec(N), tmp(N);
    for (int f = 0; f < t->frames; f++)
    {
        for (int i = 0; i < N; i++) spec[i] = cycles[f][i];
        fft(spec, false);
        spec[0] = 0;
        double peak = 0;
        for (int l = 0; l < LEVELS; l++)
        {
            const int maxH = std::max(1, (N / 2 - 1) >> l);
            for (int k = 0; k < N; k++) { int h = k <= N / 2 ? k : N - k; tmp[k] = h <= maxH ? spec[k] : 0.0; }
            fft(tmp, true);
            float *d = const_cast<float *>(t->at(f, l));
            for (int i = 0; i < N; i++) d[i] = (float)tmp[i].real();
            d[N] = d[0];
            if (l == 0) for (int i = 0; i < N; i++) peak = std::max(peak, std::abs((double)d[i]));
        }
        const float g = peak > 1e-9 ? (float)(1.0 / peak) : 0.f;   // every frame at the same peak, so morphing keeps its level
        for (int l = 0; l < LEVELS; l++) { float *d = const_cast<float *>(t->at(f, l)); for (int i = 0; i <= N; i++) d[i] *= g; }
    }
    return t;
}

// One cycle of built-in table `t` at morph point m (0..1).
std::vector<double> cycle(int t, double m)
{
    std::vector<double> c(N);
    auto add = [&](int h, double amp, double phase = 0) { for (int i = 0; i < N; i++) c[i] += amp * std::sin(2 * PI * h * i / N + phase); };
    for (int i = 0; i < N; i++)
    {
        const double x = (double)i / N;
        switch (t)
        {
            case 0: {   // sine -> triangle -> saw -> square
                const double sine = std::sin(2 * PI * x), tri = 1 - 4 * std::abs(x - 0.5) - 0.0, saw = 1 - 2 * x, sq = x < 0.5 ? 1 : -1;
                const double triS = x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
                (void)tri;
                const double s = m * 3;
                c[i] = s < 1 ? sine + (triS - sine) * s : s < 2 ? triS + (saw - triS) * (s - 1) : saw + (sq - saw) * (s - 2);
                break;
            }
            case 1: c[i] = x < 0.5 - 0.45 * m ? 1 : -1; break;                                                    // pulse width
            case 4: { const double steps = std::round(32 - 30 * m); const double s = 1 - 2 * x; c[i] = std::round(s * steps / 2) / (steps / 2); break; }   // stepped
            case 6: { const double r = 1 + 7 * m; c[i] = 1 - 2 * std::fmod(x * r, 1.0); break; }                    // hard sync
            case 7: { const double I = 8 * m; c[i] = std::sin(2 * PI * x + I * std::sin(2 * PI * x * 2)) * (1 - 0.3 * m) + 0.3 * m * std::tanh(4 * std::sin(2 * PI * x * 3)); break; }   // growl
            default: break;
        }
    }
    if (t == 2) { const int top = 1 + (int)std::round(m * m * 180); for (int h = 1; h <= top; h++) add(h, 1.0 / h); }
    if (t == 3)
    {
        // Vowel formants (as harmonics of a 110 Hz cycle): A E I O U.
        const double F1[] = {800, 400, 300, 450, 325}, F2[] = {1150, 1700, 2300, 800, 700};
        const double s = m * 4; const int v = std::min(3, (int)s); const double fr = s - v;
        const double f1 = (F1[v] + (F1[v + 1] - F1[v]) * fr) / 110, f2 = (F2[v] + (F2[v + 1] - F2[v]) * fr) / 110;
        for (int h = 1; h <= 60; h++) add(h, (std::exp(-std::pow((h - f1) / 1.6, 2)) + 0.6 * std::exp(-std::pow((h - f2) / 2.5, 2)) + 0.15 / h) / std::sqrt(h));
    }
    if (t == 5) { const int top = 1 + 2 * (int)std::round(m * 40); for (int h = 1; h <= top; h += 2) add(h, 1.0 / h); }
    if (t == 8)
    {
        const double bars[9] = {0.5, 1.5, 1, 2, 3, 4, 5, 6, 8};
        for (int b = 0; b < 9; b++) { const double lvl = std::max(0.0, std::min(1.0, m * 9 - b + 1)) * (b < 3 ? 1 : 0.6); const int h = (int)std::round(bars[b] * 2); if (lvl > 0) add(h, lvl); }
    }
    return c;
}

std::mutex tableLock;
std::shared_ptr<Table> builtIn[NTABLES];
std::shared_ptr<Table> tableFor(int t)
{
    std::lock_guard<std::mutex> g(tableLock);
    if (!builtIn[t]) { std::vector<std::vector<double>> cs; for (int f = 0; f < 32; f++) cs.push_back(cycle(t, f / 31.0)); builtIn[t] = build(cs); }
    return builtIn[t];
}

// ---- voices ----
struct Env
{
    int stage = 0;   // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
    double level = 0;
    void on() { stage = 1; }
    void off() { if (stage) stage = 4; }
    double step(double a, double d, double s, double r, double sr)
    {
        switch (stage)
        {
            case 1: level += 1.0 / std::max(1.0, a * sr); if (level >= 1) { level = 1; stage = 2; } break;
            case 2: level = s + (level - s) * std::exp(-4.6 / std::max(1.0, d * sr)); if (std::abs(level - s) < 1e-4) { level = s; stage = 3; } break;
            case 3: level = s; break;
            case 4: level *= std::exp(-4.6 / std::max(1.0, r * sr)); if (level < 1e-4) { level = 0; stage = 0; } break;
        }
        return level;
    }
};

struct Svf
{
    double ic1 = 0, ic2 = 0;
    double run(double v0, double g, double k, int mode)
    {
        const double a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
        const double v3 = v0 - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
        return mode == 0 ? v2 : mode == 1 ? v0 - k * v1 - v2 : v1;
    }
};

struct Voice
{
    bool active = false;
    int note = 0, age = 0;
    float vel = 1;
    double pitch = 60, target = 60;   // semitones, gliding toward target
    double phase[2][UNI] = {}, sub = 0;
    Env amp, mod;
    Svf f[2][2];
    double g = 0.5, k = 1.4;
    // Worked out every 16 samples: phase steps, table levels, pan gains and positions.
    double inc[2][UNI] = {}, gl[2][UNI] = {}, gr[2][UNI] = {}, pos[2] = {}, subInc = 0;
    int lev[2][UNI] = {};
};
}

struct WaveSynth
{
    double sr = 44100, bpm = 120, beat = 0, lfoPhase = 0, lfoHold = 0;
    float p[NP];
    std::shared_ptr<Table> table[2];
    std::shared_ptr<Table> custom[2];
    std::vector<float> customRaw[2];
    std::string customName[2];
    std::atomic<Table *> live[2];
    Voice v[VOICES];
    struct Ev { int offset, on, pitch; float vel; } ev[MAXEV];
    int nev = 0, ageCounter = 0;
    std::vector<int> held;
    std::minstd_rand rng{12345};
    std::uniform_real_distribution<float> uni{-1.f, 1.f};

    WaveSynth()
    {
        for (int i = 0; i < NP; i++) p[i] = PARAMS[i].def;
        for (int o = 0; o < 2; o++) { table[o] = tableFor(0); live[o] = table[o].get(); }
        held.reserve(128);
    }
    void pickTable(int o)
    {
        const int t = (int)p[o == 0 ? A_TABLE : B_TABLE];
        table[o] = t >= NTABLES ? (custom[o] ? custom[o] : tableFor(0)) : tableFor(t);
        live[o] = table[o].get();
    }
    void set(int i, float x)
    {
        if (i < 0 || i >= NP) return;
        if (PARAMS[i].kind == 1) x = std::max(0.f, std::min((float)PARAMS[i].options - 1, std::round(x)));
        else x = std::max(0.f, std::min(1.f, x));
        p[i] = x;
        if (i == A_TABLE) pickTable(0);
        if (i == B_TABLE) pickTable(1);
    }

    void start(int pitch, float vel)
    {
        const int mode = (int)p[MODE];
        if (mode > 0)
        {
            Voice &w = v[0];
            const bool legato = mode == 2 && w.active && w.amp.stage && w.amp.stage < 4;
            if (!w.active) { w.pitch = pitch; }
            w.target = pitch; w.note = pitch; w.vel = vel; w.active = true;
            if (p[GLIDE] <= 0.001f || (!legato && mode == 1 && w.amp.stage == 0)) w.pitch = pitch;
            if (!legato) { w.amp.on(); w.mod.on(); w.mod.level = 0; }
            return;
        }
        int pick = -1, oldest = -1;
        for (int i = 0; i < VOICES; i++) if (!v[i].active) { pick = i; break; }
        if (pick < 0) for (int i = 0; i < VOICES; i++) if (oldest < 0 || v[i].age < v[oldest].age) oldest = i;
        if (pick < 0) pick = oldest;
        Voice &w = v[pick];
        const bool fresh = !w.active;
        w = Voice();
        w.active = true; w.note = pitch; w.pitch = w.target = pitch; w.vel = vel; w.age = ++ageCounter;
        for (int o = 0; o < 2; o++) for (int u = 0; u < UNI; u++) w.phase[o][u] = u == 0 && fresh ? 0 : (uni(rng) + 1) * 0.5;
        w.amp.on(); w.mod.on();
    }
    void stop(int pitch)
    {
        if ((int)p[MODE] > 0)
        {
            held.erase(std::remove(held.begin(), held.end(), pitch), held.end());
            if (!held.empty()) { v[0].target = held.back(); v[0].note = held.back(); return; }
            if (v[0].note == pitch) { v[0].amp.off(); v[0].mod.off(); }
            return;
        }
        for (auto &w : v) if (w.active && w.note == pitch && w.amp.stage != 4) { w.amp.off(); w.mod.off(); }
    }

    double lfo(double ph)
    {
        switch ((int)p[LFO_SHAPE])
        {
            case 1: return 1 - 4 * std::abs(ph - 0.5);
            case 2: return 1 - 2 * ph;
            case 3: return ph < 0.5 ? 1 : -1;
            case 4: return lfoHold;
            default: return std::sin(2 * PI * ph);
        }
    }

    static float read(const Table *t, double pos, int level, double ph)
    {
        const double fp = pos * (t->frames - 1);
        const int f0 = (int)fp, f1 = std::min(t->frames - 1, f0 + 1);
        const double fr = fp - f0, x = ph * N;
        const int i = (int)x;
        const double xi = x - i;
        const float *a = t->at(f0, level), *b = t->at(f1, level);
        const double sa = a[i] + (a[i + 1] - a[i]) * xi, sb = b[i] + (b[i + 1] - b[i]) * xi;
        return (float)(sa + (sb - sa) * fr);
    }

    void render(float *L, float *R, int n)
    {
        const double ampA = envTime(p[AMP_A]), ampD = envTime(p[AMP_D]), ampS = p[AMP_S], ampR = envTime(p[AMP_R]);
        const double modA = envTime(p[MOD_A]), modD = envTime(p[MOD_D]), modS = p[MOD_S], modR = envTime(p[MOD_R]);
        const int sync = (int)p[LFO_SYNC];
        const double lfoInc = sync ? (bpm / 60.0) / (SYNC_BEATS[sync] * sr) : lfoHz(p[LFO_RATE]) / sr;
        const int ftype = (int)p[F_TYPE];
        const double glideCoef = p[GLIDE] > 0.001f ? std::exp(-1.0 / (p[GLIDE] * p[GLIDE] * 2.0 * sr)) : 0;
        const double master = p[MASTER] * 1.4 * 0.32;
        const Table *tab[2] = {live[0].load(), live[1].load()};
        const int uniN[2] = {(int)p[A_UNI] + 1, (int)p[B_UNI] + 1};
        const double lvl[2] = {p[A_LEVEL], p[B_LEVEL]}, det[2] = {p[A_DET] * 50, p[B_DET] * 50}, spread[2] = {p[A_SPREAD], p[B_SPREAD]};
        const double offs[2] = {((int)p[A_OCT] - 3) * 12 + ((int)p[A_SEMI] - 12) + (p[A_FINE] - 0.5) * 2, ((int)p[B_OCT] - 3) * 12 + ((int)p[B_SEMI] - 12) + (p[B_FINE] - 0.5) * 2};
        double lfoPh = sync ? std::fmod(beat / SYNC_BEATS[sync], 1.0) : lfoPhase;
        for (int s = 0; s < n; s++)
        {
            const double prev = lfoPh;
            lfoPh += lfoInc; if (lfoPh >= 1) lfoPh -= std::floor(lfoPh);
            if (lfoPh < prev) lfoHold = uni(rng);
            const double lv = lfo(lfoPh);
            double outL = 0, outR = 0;
            for (auto &w : v)
            {
                if (!w.active) continue;
                const double a = w.amp.step(ampA, ampD, ampS, ampR, sr), m = w.mod.step(modA, modD, modS, modR, sr);
                if (!w.amp.stage) { w.active = false; continue; }
                if (glideCoef > 0) w.pitch = w.target + (w.pitch - w.target) * glideCoef; else w.pitch = w.target;
                const double vib = lv * p[LFO_PITCH];
                if ((s & 15) == 0)
                {
                    for (int o = 0; o < 2; o++)
                    {
                        const int un = uniN[o];
                        const double g = lvl[o] / std::sqrt((double)un);
                        w.pos[o] = std::max(0.0, std::min(1.0, (o ? p[B_POS] : p[A_POS]) + (p[o ? MOD_POS_B : MOD_POS_A] - 0.5) * 2 * m + lv * p[LFO_POS] * 0.5));
                        for (int u = 0; u < un; u++)
                        {
                            const double spreadU = un > 1 ? (2.0 * u / (un - 1) - 1) : 0, pan = spreadU * spread[o];
                            const double f = 440 * std::pow(2.0, (w.pitch - 69 + offs[o] + vib + spreadU * det[o] / 100) / 12);
                            const double maxH = 0.45 * sr / std::max(1.0, f);
                            w.inc[o][u] = f / sr;
                            w.lev[o][u] = maxH >= N / 2 - 1 ? 0 : std::min(LEVELS - 1, (int)std::ceil(std::log2((N / 2 - 1) / std::max(1.0, maxH))));
                            w.gl[o][u] = g * std::sqrt(0.5 * (1 - pan)); w.gr[o][u] = g * std::sqrt(0.5 * (1 + pan));
                        }
                    }
                    w.subInc = 440 * std::pow(2.0, (w.pitch - 69 - 12 + vib) / 12) / sr;
                }
                double sl = 0, sr2 = 0;
                for (int o = 0; o < 2; o++)
                {
                    if (lvl[o] <= 0.0001 || !tab[o]) continue;
                    for (int u = 0, un = uniN[o]; u < un; u++)
                    {
                        const float x = read(tab[o], w.pos[o], w.lev[o][u], w.phase[o][u]);
                        w.phase[o][u] += w.inc[o][u]; if (w.phase[o][u] >= 1) w.phase[o][u] -= std::floor(w.phase[o][u]);
                        sl += x * w.gl[o][u]; sr2 += x * w.gr[o][u];
                    }
                }
                if (p[SUB] > 0.0001f)
                {
                    const double x = std::sin(2 * PI * w.sub) * p[SUB];
                    w.sub += w.subInc; if (w.sub >= 1) w.sub -= 1;
                    sl += x * 0.707; sr2 += x * 0.707;
                }
                if (p[NOISE] > 0.0001f) { sl += uni(rng) * p[NOISE] * 0.5; sr2 += uni(rng) * p[NOISE] * 0.5; }
                if (ftype)
                {
                    if ((s & 15) == 0)
                    {
                        double fc = cutoffHz(p[F_CUT]) * std::pow(2.0, (w.pitch - 60) / 12 * p[F_KEY] + (p[F_ENV] - 0.5) * 2 * 6 * m + lv * p[LFO_CUT] * 3);
                        fc = std::max(20.0, std::min(0.45 * sr, fc));
                        w.g = std::tan(PI * fc / sr); w.k = 2 - 1.95 * p[F_RES];
                    }
                    if (p[F_DRIVE] > 0.001f) { const double dg = 1 + p[F_DRIVE] * 9, nrm = 1 / std::tanh(dg); sl = std::tanh(sl * dg) * nrm; sr2 = std::tanh(sr2 * dg) * nrm; }
                    const int mode = ftype == 3 ? 1 : ftype == 4 ? 2 : 0;
                    sl = w.f[0][0].run(sl, w.g, w.k, mode); sr2 = w.f[1][0].run(sr2, w.g, w.k, mode);
                    if (ftype == 2) { sl = w.f[0][1].run(sl, w.g, 1.41, 0); sr2 = w.f[1][1].run(sr2, w.g, 1.41, 0); }
                }
                const double velG = 1 - p[VEL] + p[VEL] * w.vel, trem = 1 - p[LFO_AMP] * 0.5 * (1 + lv);
                outL += sl * a * velG * trem; outR += sr2 * a * velG * trem;
            }
            L[s] = (float)std::tanh(outL * master); R[s] = (float)std::tanh(outR * master);
            beat += bpm / 60.0 / sr;
        }
        lfoPhase = lfoPh;
    }

    void process(float *L, float *R, int frames)
    {
        std::stable_sort(ev, ev + nev, [](const Ev &a, const Ev &b) { return a.offset < b.offset; });
        int done = 0, e = 0;
        while (done < frames)
        {
            while (e < nev && ev[e].offset <= done)
            {
                if (ev[e].on) { if ((int)p[MODE] > 0) held.push_back(ev[e].pitch); start(ev[e].pitch, ev[e].vel); } else stop(ev[e].pitch);
                e++;
            }
            const int until = e < nev ? std::min(frames, std::max(done + 1, ev[e].offset)) : frames;
            render(L + done, R + done, until - done);
            done = until;
        }
        for (; e < nev; e++) { if (ev[e].on) start(ev[e].pitch, ev[e].vel); else stop(ev[e].pitch); }
        nev = 0;
    }
};

namespace {
// Factory presets: (parameter, value) pairs applied over the defaults. Indexed parameters take the option number.
struct Preset { const char *name; std::vector<std::pair<int, float>> set; };
const std::vector<Preset> &presets()
{
    static const std::vector<Preset> list = {
        {"Init", {}},
        {"Supersaw Lead", {{A_POS, 0.66f}, {A_UNI, 6}, {A_DET, 0.35f}, {A_SPREAD, 0.9f}, {B_POS, 0.66f}, {B_OCT, 4}, {B_UNI, 4}, {B_DET, 0.3f}, {B_LEVEL, 0.45f},
                           {F_CUT, 0.82f}, {F_RES, 0.1f}, {AMP_A, 0.15f}, {AMP_S, 0.9f}, {AMP_R, 0.62f}}},
        {"Reese Bass", {{A_POS, 0.66f}, {A_OCT, 2}, {A_UNI, 1}, {A_DET, 0.18f}, {B_POS, 0.66f}, {B_OCT, 2}, {B_FINE, 0.6f}, {B_LEVEL, 0.75f}, {SUB, 0.5f},
                        {F_CUT, 0.45f}, {F_RES, 0.25f}, {F_DRIVE, 0.4f}, {LFO_RATE, 0.25f}, {LFO_CUT, 0.15f}, {MODE, 1}, {GLIDE, 0.2f}, {AMP_R, 0.45f}}},
        {"Wobble Bass", {{A_TABLE, 7}, {A_POS, 0.5f}, {A_OCT, 2}, {SUB, 0.6f}, {F_CUT, 0.35f}, {F_RES, 0.45f}, {F_DRIVE, 0.5f}, {LFO_SYNC, 6}, {LFO_CUT, 0.75f},
                         {LFO_POS, 0.4f}, {MODE, 1}, {AMP_S, 1}, {AMP_R, 0.4f}}},
        {"Pluck", {{A_TABLE, 2}, {A_POS, 0.8f}, {B_TABLE, 1}, {B_POS, 0.3f}, {B_LEVEL, 0.4f}, {B_UNI, 2}, {F_TYPE, 1}, {F_CUT, 0.4f}, {F_RES, 0.2f}, {F_ENV, 0.92f},
                   {MOD_D, 0.45f}, {MOD_S, 0}, {MOD_R, 0.3f}, {AMP_A, 0}, {AMP_D, 0.55f}, {AMP_S, 0}, {AMP_R, 0.45f}}},
        {"Warm Pad", {{A_TABLE, 3}, {A_POS, 0.3f}, {A_UNI, 4}, {A_DET, 0.3f}, {A_SPREAD, 1}, {B_POS, 0.35f}, {B_OCT, 4}, {B_LEVEL, 0.4f}, {B_UNI, 2}, {F_CUT, 0.55f},
                      {AMP_A, 0.75f}, {AMP_D, 0.7f}, {AMP_S, 0.8f}, {AMP_R, 0.8f}, {MOD_A, 0.8f}, {MOD_S, 1}, {MOD_POS_A, 0.85f}, {LFO_SHAPE, 1}, {LFO_RATE, 0.2f}, {LFO_POS, 0.3f}}},
        {"Growl Bass", {{A_TABLE, 7}, {A_POS, 0.2f}, {A_OCT, 2}, {MOD_D, 0.6f}, {MOD_S, 0.3f}, {MOD_R, 0.3f}, {MOD_POS_A, 0.95f}, {F_CUT, 0.55f}, {F_RES, 0.35f},
                        {F_DRIVE, 0.6f}, {F_ENV, 0.85f}, {MODE, 1}, {GLIDE, 0.1f}, {SUB, 0.4f}}},
        {"Glass Keys", {{A_TABLE, 6}, {A_POS, 0.35f}, {B_TABLE, 8}, {B_POS, 0.5f}, {B_OCT, 4}, {B_LEVEL, 0.5f}, {F_TYPE, 1}, {F_CUT, 0.7f}, {F_KEY, 0.6f},
                        {AMP_A, 0.05f}, {AMP_D, 0.65f}, {AMP_S, 0.4f}, {AMP_R, 0.6f}}},
        {"Sub Bass", {{A_POS, 0}, {A_OCT, 2}, {A_LEVEL, 1}, {F_TYPE, 0}, {MODE, 1}, {GLIDE, 0.15f}, {AMP_R, 0.4f}}},
        {"Digital Lead", {{A_TABLE, 4}, {A_POS, 0.6f}, {A_UNI, 2}, {A_DET, 0.2f}, {LFO_SHAPE, 1}, {LFO_RATE, 0.55f}, {LFO_PITCH, 0.15f}, {F_CUT, 0.8f}, {F_RES, 0.3f},
                          {MODE, 2}, {GLIDE, 0.2f}}},
    };
    return list;
}
}

extern "C" {
int ws_param_count(void) { return NP; }
const char *ws_param_name(int i) { return i >= 0 && i < NP ? PARAMS[i].name : ""; }
int ws_param_kind(int i) { return i >= 0 && i < NP ? PARAMS[i].kind : 0; }
int ws_param_options(int i) { return i >= 0 && i < NP ? PARAMS[i].options : 0; }
const char *ws_param_option(int i, int o) { return i >= 0 && i < NP && PARAMS[i].labels && o >= 0 && o < PARAMS[i].options ? PARAMS[i].labels[o] : ""; }
float ws_param_default(int i) { return i >= 0 && i < NP ? PARAMS[i].def : 0; }
int ws_preset_count(void) { return (int)presets().size(); }
const char *ws_preset_name(int p) { return p >= 0 && p < ws_preset_count() ? presets()[p].name : ""; }
int ws_table_count(void) { return NTABLES; }

void *ws_create(double sample_rate) { auto s = new WaveSynth(); s->sr = sample_rate; return s; }
void ws_destroy(void *s) { delete (WaveSynth *)s; }
void ws_set_rate(void *s, double sample_rate) { ((WaveSynth *)s)->sr = sample_rate; }
float ws_get(void *s, int i) { return i >= 0 && i < NP ? ((WaveSynth *)s)->p[i] : 0; }
void ws_set(void *s, int i, float value) { ((WaveSynth *)s)->set(i, value); }
void ws_display(void *ps, int i, char *text, int len)
{
    auto s = (WaveSynth *)ps;
    if (i < 0 || i >= NP) { snprintf(text, len, "%s", ""); return; }
    const float v = s->p[i];
    if (PARAMS[i].kind == 1)
    {
        if ((i == A_TABLE || i == B_TABLE) && (int)v == NTABLES && s->custom[i == A_TABLE ? 0 : 1]) { snprintf(text, len, "%s", s->customName[i == A_TABLE ? 0 : 1].c_str()); return; }
        snprintf(text, len, "%s", PARAMS[i].labels[(int)v]);
        return;
    }
    switch (i)
    {
        case A_FINE: case B_FINE: snprintf(text, len, "%+.0f cents", (v - 0.5) * 200); break;
        case A_DET: case B_DET: snprintf(text, len, "%.0f cents", v * 50); break;
        case F_CUT: { const double hz = cutoffHz(v); if (hz >= 1000) snprintf(text, len, "%.1f kHz", hz / 1000); else snprintf(text, len, "%.0f Hz", hz); break; }
        case F_ENV: case MOD_POS_A: case MOD_POS_B: snprintf(text, len, "%+.0f%%", (v - 0.5) * 200); break;
        case AMP_A: case AMP_D: case AMP_R: case MOD_A: case MOD_D: case MOD_R: { const double t = envTime(v); if (t >= 1) snprintf(text, len, "%.2f s", t); else snprintf(text, len, "%.0f ms", t * 1000); break; }
        case LFO_RATE: if ((int)s->p[LFO_SYNC]) snprintf(text, len, "synced"); else snprintf(text, len, "%.2f Hz", lfoHz(v)); break;
        case LFO_PITCH: snprintf(text, len, "%.0f cents", v * 100); break;
        case GLIDE: snprintf(text, len, "%.0f ms", v * v * 2000); break;
        case MASTER: { const double g = v * 1.4; if (g < 0.001) snprintf(text, len, "-inf dB"); else snprintf(text, len, "%+.1f dB", 20 * std::log10(g)); break; }
        default: snprintf(text, len, "%.0f%%", v * 100);
    }
}
void ws_preset(void *ps, int p)
{
    auto s = (WaveSynth *)ps;
    if (p < 0 || p >= ws_preset_count()) return;
    for (int i = 0; i < NP; i++) s->set(i, PARAMS[i].def);
    for (auto &kv : presets()[p].set) s->set(kv.first, kv.second);
}
void ws_transport(void *s, double bpm, double beat) { ((WaveSynth *)s)->bpm = std::max(20.0, bpm); ((WaveSynth *)s)->beat = beat; }
void ws_note(void *ps, int on, int pitch, float velocity, int offset)
{
    auto s = (WaveSynth *)ps;
    if (s->nev >= MAXEV) return;
    s->ev[s->nev++] = {std::max(0, offset), on, std::max(0, std::min(127, pitch)), velocity};
}
void ws_all_off(void *ps) { auto s = (WaveSynth *)ps; for (auto &w : s->v) w = Voice(); s->held.clear(); s->nev = 0; }
void ws_process(void *s, float *left, float *right, int frames) { ((WaveSynth *)s)->process(left, right, frames); }
void ws_load_table(void *ps, int osc, const float *data, int frames, const char *name)
{
    auto s = (WaveSynth *)ps;
    if (osc < 0 || osc > 1 || frames < 1) return;
    frames = std::min(frames, 256);
    std::vector<std::vector<double>> cs(frames, std::vector<double>(N));
    for (int f = 0; f < frames; f++) for (int i = 0; i < N; i++) cs[f][i] = data[(size_t)f * N + i];
    s->custom[osc] = build(cs);
    s->customRaw[osc].assign(data, data + (size_t)frames * N);
    s->customName[osc] = name ? name : "Imported";
    s->set(osc == 0 ? A_TABLE : B_TABLE, NTABLES);
}
int ws_custom_table(void *ps, int osc, const float **data, const char **name)
{
    auto s = (WaveSynth *)ps;
    if (osc < 0 || osc > 1 || s->customRaw[osc].empty()) return 0;
    *data = s->customRaw[osc].data();
    *name = s->customName[osc].c_str();
    return (int)(s->customRaw[osc].size() / N);
}
void ws_frame(void *ps, int osc, float *out, int n)
{
    auto s = (WaveSynth *)ps;
    const Table *t = s->live[osc ? 1 : 0].load();
    const double pos = s->p[osc ? B_POS : A_POS];
    for (int i = 0; i < n; i++) out[i] = t ? WaveSynth::read(t, pos, 0, (double)i / n) : 0;
}
}
