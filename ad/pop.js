// "Golden Hour": a 124 BPM pop beat in C major, built as a STRATUM project from STRATUM's free (CC0) drum sounds and its
// own synths and effects. C – G – Am – F, a 4-bar intro, then the drop with four-on-the-floor drums and a pumping chord bed.
async function makePop() {
  const D = S.dsp, p = S.blankProject(); p.name = 'Golden Hour'; p.bpm = 124; p.root = 0; p.scale = 'Major';
  S.newScene(p, 'Song', 4); S.migrate(p);
  const lib = await IO.libList(), pick = (name) => lib.find((x) => x.name === name);
  const sample = async (name) => { const x = pick(name), ab = x && (await IO.libRead(x.path)); if (!ab) throw new Error('missing sound ' + name); return IO.addAudio(name + '.flac', ab); };
  const BARS = 17, reg = (t, notes) => t.regions.push({ id: S.uid(), start: 0, len: BARS * 4, off: 0, clip: { bars: BARS, notes } });
  const fx = (type, vals) => { const f = D.stock(type); Object.assign(f.blocks[0].vals, vals); return f; };
  const ROOT = [0, 7, 9, 5];   // C G Am F
  const TRIAD = [[60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65]];

  // ---- drums
  const dr = S.newTrack(p, 'drums', 'Drums'); dr.vol = 0.85;
  const kit = { 36: 'kick-1-A', 38: 'sdbkit-snare', 39: 'x0xproc1-clap', 42: 'x0xproc2-hatclsd', 46: 'x0xproc1-hatopen', 56: 'sdbkit-hatclsd' };
  dr.pads = {};
  for (const k in kit) { const rec = await sample(kit[k]); dr.pads[k] = { audio: rec.id, name: kit[k], tune: 0, gain: k == 42 ? 0.45 : k == 56 ? 0.4 : k == 46 ? 0.5 : 1 }; }
  const dn = [], hit = (b, q, v = 0.9, d = 0.1) => dn.push({ t: b, d, p: q, v });
  for (let bar = 0; bar < BARS; bar++) {
    const b0 = bar * 4;
    if (bar >= 4) {
      for (let k = 0; k < 4; k++) { hit(b0 + k, 36, 1); hit(b0 + k + 0.5, 46, 0.55, 0.25); }
      hit(b0 + 1, 39, 0.9); hit(b0 + 3, 39, 0.9); hit(b0 + 1, 38, 0.6); hit(b0 + 3, 38, 0.6);
      for (let s = 0; s < 16; s++) hit(b0 + s * 0.25, s % 2 ? 56 : 42, s % 4 === 2 ? 0.7 : 0.45);
      if (bar % 4 === 3) { hit(b0 + 3.5, 39, 0.7); hit(b0 + 3.75, 39, 0.8); }
    } else {
      if (bar >= 1) hit(b0 + 3, 39, 0.6);
      if (bar >= 2) for (let s = 0; s < 8; s++) hit(b0 + s * 0.5, 56, 0.35);
      if (bar === 3) for (let k = 0; k < 16; k++) hit(b0 + k * 0.25, 38, 0.2 + k * 0.045);   // build into the drop
    }
  }
  reg(dr, dn);

  // ---- bass: octave eighths on the root
  const bass = S.newTrack(p, 'synth', 'Bass'); bass.vol = 0.6;
  bass.inst = { wave: 'sawtooth', wave2: 'square', detune: 0.05, attack: 0, release: 0.08, cutoff: 0.32, res: 0.25 };
  const bn = [];
  for (let bar = 4; bar < BARS; bar++) { const r = 36 + ROOT[bar % 4] - (ROOT[bar % 4] > 6 ? 12 : 0); for (let e = 0; e < 8; e++) bn.push({ t: bar * 4 + e * 0.5, d: 0.4, p: e % 2 ? r + 12 : r, v: e % 2 ? 0.7 : 0.9 }); }
  reg(bass, bn);

  // ---- chords: a pumping bed, like a sidechained synth
  const ch = S.newTrack(p, 'synth', 'Chords'); ch.vol = 0.42;
  ch.inst = { wave: 'sawtooth', wave2: 'sawtooth', detune: 0.3, attack: 0.01, release: 0.3, cutoff: 0.55, res: 0.1 };
  ch.fx = [fx('pump', { depth: 0.75 }), fx('reverb', { size: 0.6, mix: 0.3 })];
  const cn = [];
  for (let bar = 0; bar < BARS; bar++) TRIAD[bar % 4].forEach((n) => { if (bar < 4) cn.push({ t: bar * 4, d: 3.9, p: n, v: 0.5 }); else for (let k = 0; k < 4; k++) cn.push({ t: bar * 4 + k, d: 0.9, p: n, v: 0.7 }); });
  reg(ch, cn);

  // ---- lead: the hook
  const lead = S.newTrack(p, 'synth', 'Lead'); lead.vol = 0.5;
  lead.inst = { wave: 'square', wave2: 'triangle', detune: 0.04, attack: 0.005, release: 0.18, cutoff: 0.8, res: 0.12 };
  lead.fx = [fx('delay', { time: 0.38, feedback: 0.28, mix: 0.2 }), fx('reverb', { size: 0.5, mix: 0.22 })];
  const HOOK = [[[0, 76], [0.5, 79], [1, 81], [1.75, 79], [2.5, 76], [3, 74]], [[0, 74], [0.5, 76], [1, 79], [2, 74], [2.5, 71], [3, 72]],
    [[0, 76], [0.5, 79], [1, 81], [1.75, 84], [2.5, 83], [3, 81]], [[0, 79], [0.75, 77], [1.5, 76], [2, 77], [2.5, 76], [3, 72]]];
  const ln = [];
  for (let bar = 0; bar < BARS; bar++) HOOK[bar % 4].forEach(([t, n], i, a) => ln.push({ t: bar * 4 + t, d: Math.min(0.45, (i + 1 < a.length ? a[i + 1][0] : 4) - t - 0.05), p: n, v: bar < 4 ? 0.45 : 0.75 }));
  reg(lead, ln);

  p.master = { vol: 0.85, drive: 0.25, glue: 0.5 };
  return p;
}
window.AD_BEAT = {
  make: makePop, bpm: 124, name: 'pop',
  at: { B: 2, C: 4, D: 5, E: 7, F: 10, G: 11.75, H: 13.75 }, liveBeats: 4,
  looks: ['Light Show', 'Bubble Bath', 'Sunburst'],
  theme: { ink: '#0c0618', a: '#ff5fc1', b: '#9b6bff', c: '#3be8ff', glow: 'rgba(255,95,193,.55)', ctaText: '#1a0612',
    wash: (h, a) => `rgba(${210 + h},70,${190 - h},${a})`, ring: (a) => `rgba(255,95,193,${a})` },
};
