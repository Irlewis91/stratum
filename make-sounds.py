#!/usr/bin/env python3
"""Makes STRATUM's own sounds from scratch: 808s, electronic drums, synth basses, leads, pads, keys and effects.
Nothing here is sampled. The output folder is <out>/<category>/<name>.wav; a note in a name (C2) is the pitch it plays at."""
import os, sys, wave
import numpy as np

SR = 44100
out = sys.argv[1]
rng = np.random.default_rng(808)


def hz(note): return 440 * 2 ** ((note - 69) / 12)
def t(sec): return np.arange(int(SR * sec)) / SR
def env(x, a=0.002, r=0.01):
    n, na, nr = len(x), int(a * SR), int(r * SR)
    e = np.ones(n); e[:na] = np.linspace(0, 1, na); e[-nr:] *= np.linspace(1, 0, nr)
    return x * e
def osc(freq):  # sine from a frequency curve
    return np.sin(2 * np.pi * np.cumsum(freq) / SR)
def saw(freq):
    ph = np.cumsum(freq) / SR
    return 2 * (ph % 1) - 1
def square(freq): return np.sign(np.sin(2 * np.pi * np.cumsum(freq) / SR))
def lowpass(x, cut):  # one-pole, cutoff may be a curve
    c = np.broadcast_to(1 - np.exp(-2 * np.pi * np.asarray(cut) / SR), x.shape)
    y, s = np.zeros_like(x), 0.0
    for i in range(len(x)):
        s += c[i] * (x[i] - s); y[i] = s
    return y
def highpass(x, cut): return x - lowpass(x, cut)
def noise(sec): return rng.uniform(-1, 1, int(SR * sec))
def save(cat, name, x, stereo=None):
    x = np.asarray(x, float)
    x = x / max(1e-9, np.max(np.abs(x))) * 0.89
    if stereo is None: frames = np.column_stack([x, x])
    else:
        y = np.asarray(stereo, float); y = y / max(1e-9, np.max(np.abs(y))) * 0.89
        frames = np.column_stack([x, y])
    os.makedirs(os.path.join(out, cat), exist_ok=True)
    with wave.open(os.path.join(out, cat, name + ".wav"), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((frames * 32767).astype("<i2").tobytes())


def e808(sec=2.2, decay=0.9, punch=1.0, drive=1.0, note=36, glide=0.0):
    tt = t(sec); f = hz(note) * (1 + punch * 2.5 * np.exp(-tt / 0.018))
    if glide: f = f * 2 ** (glide * np.clip(tt - 0.35, 0, 0.4) / 0.4 / 12)
    x = osc(f) * np.exp(-tt / decay)
    return env(np.tanh(x * drive) / np.tanh(drive), 0.0005, 0.03)

save("808s", "808 Long C2", e808(3.2, 1.5))
save("808s", "808 Short C2", e808(0.9, 0.28))
save("808s", "808 Punch C2", e808(1.6, 0.6, punch=2.2, drive=1.6))
save("808s", "808 Distorted C2", e808(2.2, 0.9, drive=5))
save("808s", "808 Hard Clip C2", e808(1.8, 0.8, punch=1.5, drive=12))
save("808s", "808 Drill Slide C2", e808(1.6, 0.9, drive=2.5, glide=-5))
save("808s", "808 Glide Up C2", e808(1.6, 0.9, drive=2, glide=7))
save("808s", "808 Soft Sub C2", e808(2.6, 1.1, punch=0.3))
save("808s", "808 Boom Bap C2", lowpass(e808(1.2, 0.4, punch=1.4, drive=2), 900))
save("808s", "808 Reggaeton C2", e808(0.7, 0.2, punch=1.6, drive=2))

def kick(sec, f0, f1, tau, decay, click=0.3, drive=1.5):
    tt = t(sec); x = osc(f1 + (f0 - f1) * np.exp(-tt / tau)) * np.exp(-tt / decay)
    c = highpass(noise(sec), 2000) * np.exp(-tt / 0.003) * click
    return env(np.tanh((x + c) * drive), 0.0003, 0.01)

for name, a in {"House Kick": (0.45, 220, 52, 0.03, 0.14), "Techno Kick": (0.55, 260, 46, 0.025, 0.2, 0.4, 3), "Trance Kick": (0.4, 320, 55, 0.02, 0.12, 0.5, 2.5), "DnB Kick": (0.3, 300, 62, 0.02, 0.09, 0.5, 2),
                "Hardstyle Kick": (0.6, 400, 50, 0.04, 0.2, 0.3, 8), "Trap Kick": (0.4, 240, 50, 0.025, 0.14, 0.6, 2.5), "Boom Bap Kick": (0.35, 170, 58, 0.03, 0.12, 0.2, 1.8), "Afro Kick": (0.35, 190, 70, 0.03, 0.1, 0.15, 1.3), "Soft Lo-fi Kick": (0.35, 130, 55, 0.04, 0.12, 0.05, 1.1)}.items():
    x = kick(*a); save("Kicks", name, lowpass(x, 5000) if "Lo-fi" in name else x)

def hat(sec, decay, cut=8000):
    tt = t(sec); return env(highpass(noise(sec), cut) * np.exp(-tt / decay), 0.0002, 0.005)
for name, a in {"Closed Hat Tight": (0.07, 0.012), "Closed Hat": (0.12, 0.03), "Closed Hat Dark": (0.12, 0.03, 5000), "Open Hat": (0.5, 0.14), "Open Hat Long": (0.9, 0.3), "Trap Hat": (0.09, 0.018, 9500), "Shaker Tick": (0.08, 0.02, 6000)}.items():
    save("Hats", name, hat(*a))
for name, a in {"Crash Noise": (2.5, 0.8, 5000), "Ride Noise": (1.5, 0.5, 7000)}.items():
    save("Cymbals", name, hat(*a))

def clap(sec=0.4, cut=1200, tail=0.1):
    tt = t(sec); n = highpass(lowpass(noise(sec), 5000), cut); e = np.exp(-tt / tail)
    for d in (0.0, 0.011, 0.022): e = np.maximum(e, (tt >= d) * np.exp(-np.maximum(tt - d, 0) / 0.006) * 1.2)
    return env(n * e, 0.0002, 0.01)
save("Claps", "Electronic Clap", clap()); save("Claps", "House Clap", clap(0.5, 1000, 0.14)); save("Claps", "Trap Clap", clap(0.35, 1500, 0.08)); save("Claps", "Gospel Snap Clap", clap(0.25, 2000, 0.05))

def snare(sec, f, decay, cut=1800, body=0.5):
    tt = t(sec); b = osc(f * (1 + 0.5 * np.exp(-tt / 0.01))) * np.exp(-tt / 0.06) * body
    return env(np.tanh(b + highpass(noise(sec), cut) * np.exp(-tt / decay)), 0.0002, 0.01)
for name, a in {"Electronic Snare": (0.3, 190, 0.09), "Trap Snare": (0.35, 210, 0.11, 2200), "Drill Snare": (0.25, 240, 0.07, 2500), "DnB Snare": (0.25, 230, 0.08, 1500, 0.8), "Rim Tick": (0.06, 900, 0.008, 3000, 1.0)}.items():
    save("Snares", name, snare(*a))

N = 48  # C3
def stack(f, voices=7, spread=0.012, wave_=saw):
    return sum(wave_(f * (1 + spread * (i - voices // 2) / (voices // 2))) for i in range(voices)) / voices

tt = t(2.0); f = np.full_like(tt, hz(36))
save("Bass", "Reese Bass C2", env(lowpass(stack(f, 4, 0.008), 900), 0.005, 0.05))
save("Bass", "Sub Sine C2", env(osc(f), 0.005, 0.05))
save("Bass", "Wobble Bass C2", env(lowpass(saw(f), 300 + 2400 * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * tt))), 0.005, 0.05))
save("Bass", "Growl Bass C2", env(np.tanh(4 * lowpass(square(f), 500 + 1800 * (0.5 + 0.5 * np.sin(2 * np.pi * 8 * tt)))), 0.005, 0.05))
tt = t(0.5); f = np.full_like(tt, hz(36))
save("Bass", "Acid Bass C2", env(np.tanh(3 * lowpass(saw(f), 200 + 4500 * np.exp(-tt / 0.09))), 0.002, 0.03))
save("Bass", "Pluck Bass C2", env(lowpass(saw(f), 150 + 2500 * np.exp(-tt / 0.05)) * np.exp(-tt / 0.3), 0.002, 0.03))
save("Bass", "FM Bass C2", env(osc(f + 200 * np.exp(-tt / 0.1) * np.sin(2 * np.pi * 2 * f * tt)), 0.002, 0.03))

tt = t(3.0); f = np.full_like(tt, hz(N))
save("Synths", "Supersaw Lead C3", env(stack(f, 7, 0.012), 0.01, 0.1), env(stack(f * 1.001, 7, 0.014), 0.01, 0.1))
save("Synths", "Square Lead C3", env(lowpass(square(f), 3000), 0.005, 0.1))
save("Synths", "Chiptune Lead C3", env(square(f), 0.001, 0.02))
save("Synths", "Synthwave Brass C3", env(lowpass(stack(f, 4, 0.006), 600 + 3000 * (1 - np.exp(-tt / 0.2))), 0.04, 0.2))
tt = t(0.7); f = np.full_like(tt, hz(N))
save("Synths", "Pluck C3", env(lowpass(stack(f, 3, 0.005), 400 + 6000 * np.exp(-tt / 0.07)) * np.exp(-tt / 0.25), 0.001, 0.03))
save("Synths", "Trance Stab C3", env(sum(stack(f * r, 5, 0.01) for r in (1, 1.2, 1.5)) * np.exp(-tt / 0.2), 0.001, 0.03))
save("Synths", "House Chord Stab C3", env(lowpass(sum(saw(f * r) for r in (1, 1.189, 1.498, 1.782)), 2500) * np.exp(-tt / 0.15), 0.001, 0.03))
save("Synths", "Bell Pluck C3", env(osc(f * 2 + 300 * np.exp(-tt / 0.2) * np.sin(2 * np.pi * 7 * f * tt)) * np.exp(-tt / 0.3), 0.001, 0.03))

tt = t(6.0); f = np.full_like(tt, hz(N))
lfo = 0.5 + 0.5 * np.sin(2 * np.pi * 0.2 * tt)
save("Pads", "Warm Pad C3", env(lowpass(stack(f, 5, 0.006), 700 + 500 * lfo), 0.8, 1.2), env(lowpass(stack(f * 1.002, 5, 0.007), 700 + 500 * (1 - lfo)), 0.8, 1.2))
save("Pads", "Dark Pad C3", env(lowpass(stack(f / 2, 5, 0.008), 350 + 200 * lfo), 1.2, 1.5))
save("Pads", "Airy Pad C3", env(lowpass(stack(f, 3, 0.004), 1500) * 0.6 + highpass(noise(6), 5000) * 0.05, 1.0, 1.5))
save("Pads", "Vapor Pad C3", env(lowpass(sum(stack(f * r, 3, 0.01) for r in (1, 1.26, 1.5)), 1100 + 500 * lfo), 0.7, 1.5))

tt = t(3.0); f = np.full_like(tt, hz(60))
save("Piano and Keys", "Electric Piano FM C4", env(osc(f + 1.4 * f * np.exp(-tt / 0.35) * np.sin(2 * np.pi * f * tt) * 0.8) * np.exp(-tt / 1.1) + 0.2 * osc(f * 14) * np.exp(-tt / 0.03), 0.001, 0.08))
save("Piano and Keys", "Soft Keys C4", env(lowpass(osc(f) + 0.4 * osc(2 * f) + 0.15 * osc(3 * f), 2500) * np.exp(-tt / 0.9), 0.003, 0.08))
tt = t(0.8); f = np.full_like(tt, hz(60))
save("Piano and Keys", "Funk Clav C4", env(highpass(lowpass(square(f), 600 + 4500 * np.exp(-tt / 0.06)), 300) * np.exp(-tt / 0.25), 0.001, 0.02))
tt = t(3.0); f = np.full_like(tt, hz(60))
tone = sum(a * osc(f * r) for r, a in ((0.5, 0.8), (1, 1), (1.5, 0.5), (2, 0.7), (3, 0.3), (4, 0.2)))
save("Organ", "Gospel Drawbar Organ C4", env(tone * (1 + 0.15 * np.sin(2 * np.pi * 6 * tt)), 0.005, 0.03))
save("Organ", "Reggae Bubble Organ C4", env(tone[:int(0.25 * SR)], 0.003, 0.05))

tt = t(0.8); f = hz(36) * (1 + 0.6 * np.exp(-tt / 0.03))
save("World", "Amapiano Log Drum C2", env(np.tanh(2.5 * (osc(f) + 0.5 * osc(f * 2.76) * np.exp(-tt / 0.05))) * np.exp(-tt / 0.3), 0.001, 0.03))
tt = t(0.8); f = hz(48) * (1 + 0.3 * np.exp(-tt / 0.02))
save("World", "Amapiano Log Drum High C3", env((osc(f) + 0.6 * osc(f * 2.76) * np.exp(-tt / 0.04)) * np.exp(-tt / 0.2), 0.001, 0.03))

tt = t(6.0)
save("FX", "White Noise Riser", env(lowpass(noise(6), 200 + 12000 * (tt / 6) ** 2) * (tt / 6) ** 1.5, 0.01, 0.02))
save("FX", "White Noise Downlifter", env(lowpass(noise(6), 200 + 12000 * (1 - tt / 6) ** 2) * (1 - tt / 6) ** 1.5, 0.01, 0.2))
save("FX", "Synth Riser", env(saw(100 * 2 ** (4 * tt / 6)) * (tt / 6), 0.01, 0.02))
tt = t(3.0)
save("FX", "Impact Boom", env(np.tanh(3 * osc(30 + 120 * np.exp(-tt / 0.06))) * np.exp(-tt / 0.9), 0.001, 0.1))
tt = t(6.0)
crackle = (rng.uniform(0, 1, len(tt)) > 0.9995) * rng.uniform(-1, 1, len(tt))
save("FX", "Vinyl Crackle Loop", lowpass(crackle, 7000) * 6 + highpass(noise(6), 1500) * 0.01)
save("FX", "Tape Hiss Loop", highpass(noise(6), 3000) * 0.2)
print("made", sum(len(f) for _, _, f in os.walk(out)), "sounds")
