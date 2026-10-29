// "Night Shift": a 140 BPM trap beat in F minor, built as a STRATUM project. Drums are STRATUM's free (CC0) library
// sounds, the 808 is synthesised here and played by STRATUM's sampler, the bells and pad are STRATUM's own synth with its
// reverb and delay. 18 bars: a 4-bar intro, then the drop.
async function makeTrap() {
  const D = S.dsp, p = S.blankProject(); p.name = 'Night Shift'; p.bpm = 140; p.root = 5; p.scale = 'Minor';
  S.newScene(p, 'Beat', 4); S.migrate(p);
  const lib = await IO.libList(), pick = (name) => lib.find((x) => x.name === name);
  const sample = async (name) => { const x = pick(name), ab = x && (await IO.libRead(x.path)); if (!ab) throw new Error('missing sound ' + name); return IO.addAudio(name + '.flac', ab); };
  const BARS = 18, reg = (t, notes) => t.regions.push({ id: S.uid(), start: 0, len: BARS * 4, off: 0, clip: { bars: BARS, notes } });
  const fx = (type, vals) => { const f = D.stock(type); Object.assign(f.blocks[0].vals, vals); return f; };

  // ---- drums
  const dr = S.newTrack(p, 'drums', 'Drums'); dr.vol = 0.9;
  const kit = { 36: 'x0xproc1-kick', 38: 'x0xproc1-snare', 39: 'x0xproc1-clap', 42: 'x0xproc1-hatclsd', 46: 'x0xproc1-hatopen', 37: '455640__uberproduktion__fd808a-rimshot' };
  dr.pads = {};
  for (const k in kit) { const rec = await sample(kit[k]); dr.pads[k] = { audio: rec.id, name: kit[k], tune: 0, gain: k == 42 ? 0.55 : k == 46 ? 0.5 : k == 37 ? 0.5 : 1 }; }
  const dn = [], hit = (b, p2, v = 0.9, d = 0.1) => dn.push({ t: b, d, p: p2, v });
  const KICKS = [[0, 0.75, 1.5, 3.25], [0, 1.75, 3, 3.5], [0, 0.75, 2.5, 3.25], [0, 1.5, 1.75, 3.5]];
  for (let bar = 0; bar < BARS; bar++) {
    const b0 = bar * 4, drop = bar >= 4;
    if (drop) {
      for (const k of KICKS[bar % 4]) hit(b0 + k, 36, 1);
      hit(b0 + 2, 38, 0.95); hit(b0 + 2, 39, 0.85);
      if (bar % 2) hit(b0 + 3.75, 38, 0.35);
      // hi-hats: eighths, with a different roll in each bar of four
      const v = bar % 4, hats = [];
      for (let s = 0; s < 8; s++) hats.push(s * 0.5);
      if (v === 0) hats.push(3.25, 3.75);
      if (v === 1) { for (let k = 0; k < 6; k++) hats.push(2 + k / 6); }
      if (v === 2) { for (let k = 0; k < 8; k++) hats.push(3 + k / 8); }
      if (v === 3) { for (let k = 0; k < 3; k++) hats.push(1 + k / 3); hats.push(2.75); }
      [...new Set(hats.map((h) => +h.toFixed(4)))].forEach((h) => hit(b0 + h, 42, 0.55 + 0.35 * ((h * 2) % 1 === 0 ? 1 : 0.4)));
      if (v === 3) hit(b0 + 3.5, 46, 0.6, 0.4);
      if (bar % 2 === 0) hit(b0 + 1.25, 37, 0.45);
    } else if (bar >= 2) {
      for (let s = 0; s < 8; s++) hit(b0 + s * 0.5, 42, bar === 2 ? 0.35 : 0.5);
      if (bar === 3) { for (let k = 0; k < 12; k++) hit(b0 + 2 + k * (1.5 / 12), 38, 0.25 + k * 0.05); }   // roll into the drop
    }
  }
  reg(dr, dn);

  // ---- 808: a synthesised sub with a pitch drop and some grit, in STRATUM's sampler
  const ctx = E.ensure(), sr = 44100, len = Math.round(sr * 2.6), b808 = ctx.createBuffer(1, len, sr), d8 = b808.getChannelData(0);
  const f0 = 440 * Math.pow(2, (36 - 69) / 12);
  for (let i = 0, ph = 0; i < len; i++) {
    const t = i / sr, f = f0 * (1 + 1.2 * Math.exp(-t / 0.018)), env = Math.min(1, t / 0.002) * Math.exp(-t / 1.1);
    ph += (2 * Math.PI * f) / sr;
    d8[i] = Math.tanh(2.2 * Math.sin(ph) * env) * 0.85;
  }
  const id808 = S.uid(), rec808 = (S.buffers[id808] = { id: id808, name: '808', buf: b808, bpm: 0 });
  const bass = S.newTrack(p, 'synth', '808'); bass.vol = 0.85;
  bass.inst = { ...bass.inst, attack: 0, release: 0.12, sample: { audio: rec808.id, name: '808', root: 36, loop: false } };
  const ROOTS = [29, 29, 25, 25, 34, 34, 24, 24];   // F, Db, Bb, C (bars of two)
  const bn = [];
  for (let bar = 4; bar < BARS; bar++) {
    const ks = KICKS[bar % 4], root = ROOTS[(bar - 4) % 8];
    ks.forEach((k, i) => { const next = i + 1 < ks.length ? ks[i + 1] : 4; bn.push({ t: bar * 4 + k, d: Math.max(0.2, next - k - 0.05), p: (i === ks.length - 1 && bar % 2) ? root + 12 : root, v: 0.95 }); });
  }
  reg(bass, bn);

  // ---- bells: the hook
  const bell = S.newTrack(p, 'synth', 'Bells'); bell.vol = 0.5;
  bell.inst = { wave: 'sine', wave2: 'triangle', detune: 0.02, attack: 0, release: 0.45, cutoff: 0.85, res: 0.05 };
  bell.fx = [fx('delay', { time: 0.35, feedback: 0.3, mix: 0.22 }), fx('reverb', { size: 0.75, mix: 0.35 })];
  const HOOK = [[0, 84], [0.75, 80], [1.5, 77], [2, 79], [2.5, 80], [3, 75], [3.5, 77]];
  const HOOK2 = [[0, 82], [0.75, 80], [1.5, 77], [2, 73], [2.5, 75], [3, 72], [3.25, 73], [3.5, 75]];
  const ln = [];
  for (let bar = 0; bar < BARS; bar++) (bar % 2 ? HOOK2 : HOOK).forEach(([t, n]) => ln.push({ t: bar * 4 + t, d: 0.4, p: n, v: bar < 4 ? 0.55 : 0.7 }));
  reg(bell, ln);

  // ---- pad: dark chords underneath
  const pad = S.newTrack(p, 'synth', 'Pad'); pad.vol = 0.28;
  pad.inst = { wave: 'sawtooth', wave2: 'sawtooth', detune: 0.25, attack: 0.5, release: 0.9, cutoff: 0.25, res: 0.1 };
  pad.fx = [fx('reverb', { size: 0.85, mix: 0.45 })];
  const CH = [[53, 56, 60], [49, 53, 56], [46, 49, 53], [48, 52, 55]], pn = [];
  for (let k = 0; k < BARS / 2; k++) CH[k % 4].forEach((n) => pn.push({ t: k * 8, d: 7.8, p: n, v: 0.6 }));
  reg(pad, pn);

  p.master = { vol: 0.85, drive: 0.35, glue: 0.45 };
  return p;
}

window.AD_BEAT = {
  make: makeTrap, bpm: 140, name: 'trap',
  at: { B: 2, C: 4, D: 5, E: 7, F: 10, G: 12.5, H: 15 }, liveBeats: 5,
  looks: ['Prism', 'Hyperdrive', 'Liquid Glow'],
  theme: { ink: '#07080d', a: '#ffa62b', b: '#ff6a3d', c: '#5ce1c6', glow: 'rgba(255,140,40,.55)', ctaText: '#140d00',
    wash: (h, a) => `rgba(255,${120 + h},50,${a})`, ring: (a) => `rgba(255,166,43,${a})` },
};
