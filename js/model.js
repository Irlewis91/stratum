// STRATUM data model: project, tracks, scenes, clips, and the chord-following session players.
(function () {
  const S = (window.S = {});
  S.VERSION = '0.1.0';
  S.uid = () => Math.random().toString(36).slice(2, 9);
  S.NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  S.SCALES = {
    Major: [0, 2, 4, 5, 7, 9, 11],
    Minor: [0, 2, 3, 5, 7, 8, 10],
    Dorian: [0, 2, 3, 5, 7, 9, 10],
    Mixolydian: [0, 2, 4, 5, 7, 9, 10],
    'Minor Pentatonic': [0, 3, 5, 7, 10],
    'Major Pentatonic': [0, 2, 4, 7, 9],
    Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  S.DRUMS = [
    { p: 36, n: 'Kick' }, { p: 38, n: 'Snare' }, { p: 39, n: 'Clap' }, { p: 42, n: 'Hat' },
    { p: 46, n: 'Open Hat' }, { p: 45, n: 'Tom' }, { p: 37, n: 'Rim' }, { p: 56, n: 'Cowbell' },
  ];
  // Map any incoming drum pitch (General MIDI or drum-rack) onto the eight built-in sounds.
  S.drumMap = (p) => {
    if (S.DRUMS.some((d) => d.p === p)) return p;
    if (p === 35) return 36;
    if (p === 40) return 38;
    if (p === 44) return 42;
    if ([41, 43, 47, 48, 50].includes(p)) return 45;
    if (p > 50) return p % 2 ? 46 : 42;
    return p < 37 ? 36 : 38;
  };
  // Rows of a drum track: the eight built-in sounds (renamed when a sample is loaded) plus any extra sample pads.
  S.drumRows = (t) => {
    const pads = (t && t.pads) || {}, rows = S.DRUMS.map((d) => ({ p: d.p, n: pads[d.p] ? pads[d.p].name : d.n, base: d.n }));
    Object.keys(pads).map(Number).filter((p) => !S.DRUMS.some((d) => d.p === p)).sort((a, b) => a - b).forEach((p) => rows.push({ p, n: pads[p].name, extra: true }));
    return rows;
  };
  // Guess which built-in pad a sample file belongs on from its name; 0 when nothing matches.
  S.drumGuess = (name) => {
    const w = (re) => new RegExp('(^|[^a-z])(' + re + ')', 'i').test(name);
    return w('kick|bd|808') ? 36 : w('snare|sd|snr') ? 38 : w('clap') ? 39 : w('open ?hat|ohh?') ? 46 : w('hi-?hat|hat|hh') ? 42 : w('tom') ? 45 : w('rim') ? 37 : w('perc|cowbell') ? 56 : 0;
  };
  S.COLORS = ['#ff8a3d', '#4fc3f7', '#b388ff', '#69db7c', '#ffd43b', '#ff6b9d', '#38d9a9', '#e599f7'];
  S.noteName = (p) => S.NOTES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
  S.inScale = (p, proj) => S.SCALES[proj.scale].includes((((p - proj.root) % 12) + 12) % 12);
  S.snapToScale = (p, proj) => {
    for (let d = 0; d < 12; d++) {
      if (S.inScale(p - d, proj)) return p - d;
      if (S.inScale(p + d, proj)) return p + d;
    }
    return p;
  };
  // Pitch of a 1-based scale degree in a given octave; degrees past the scale length wrap upward.
  S.degree = (proj, deg, oct) => {
    const sc = S.SCALES[proj.scale], n = sc.length, i = deg - 1;
    return 12 * (oct + 1) + proj.root + sc[((i % n) + n) % n] + 12 * Math.floor(i / n);
  };

  S.buffers = {}; // id -> {id, name, buf: AudioBuffer, bpm, warpCache}
  S.undo = [];
  S.snap = () => {
    S.undo.push(JSON.stringify(S.proj));
    if (S.undo.length > 60) S.undo.shift();
  };

  S.newInst = () => ({ wave: 'sawtooth', wave2: 'square', detune: 0.15, attack: 0.02, release: 0.2, cutoff: 0.6, res: 0.15 });
  S.newTrack = (proj, type, name) => {
    const i = proj.tracks.length;
    const t = {
      id: S.uid(), name: name || { synth: 'Synth', drums: 'Drums', audio: 'Audio' }[type] + ' ' + (i + 1),
      type, color: S.COLORS[i % S.COLORS.length], vol: 0.8, pan: 0, mute: false, solo: false,
      fx: [], cables: [], clips: {}, regions: [], player: null,
    };
    if (type === 'synth') {
      t.inst = { wave: 'sawtooth', wave2: 'square', detune: 0.15, attack: 0.02, release: 0.2, cutoff: 0.6, res: 0.15 };
    }
    proj.tracks.push(t);
    return t;
  };
  S.newScene = (proj, name, bars) => {
    const s = { id: S.uid(), name: name || 'Scene ' + (proj.scenes.length + 1), bars: bars || 1, chords: [1] };
    proj.scenes.push(s);
    return s;
  };
  S.blankProject = () => ({
    name: 'Untitled', bpm: 120, root: 0, scale: 'Minor', scenes: [], sections: [], tracks: [],
    lfos: [{ rate: 0.35, depth: 0.5, shape: 'sine' }, { rate: 0.6, depth: 0.5, shape: 'triangle' }],
    master: { vol: 0.8, drive: 0.25, glue: 0.3 },
  });

  // Session players: write a part for one track that follows the scene's chord progression.
  S.generate = (proj, track, scene) => {
    const kind = track.player;
    if (!kind) return;
    const ch = scene.chords && scene.chords.length ? scene.chords : [1];
    const notes = [];
    const add = (t, d, p, v) => notes.push({ t, d, p, v: v == null ? 0.8 : v });
    for (let b = 0; b < scene.bars; b++) {
      const deg = ch[b % ch.length], o = b * 4;
      if (kind === 'drums') {
        add(o, 0.25, 36, 0.95); add(o + 2.5, 0.25, 36, 0.85);
        if (b % 2) add(o + 3.5, 0.25, 36, 0.7);
        add(o + 1, 0.25, 38, 0.9); add(o + 3, 0.25, 38, 0.9);
        for (let i = 0; i < 8; i++) add(o + i * 0.5, 0.25, 42, i % 2 ? 0.5 : 0.75);
        if (b % 4 === 3) add(o + 3.75, 0.25, 46, 0.7);
      } else if (kind === 'bass') {
        const r = S.degree(proj, deg, 1);
        [[0, 0.75], [0.75, 0.5], [1.5, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5]].forEach(([t, d], i) =>
          add(o + t, d, i === 4 ? r + 12 : r, i ? 0.75 : 0.95));
      } else if (kind === 'chords') {
        [0, 2, 4].forEach((k) => add(o, 3.75, S.degree(proj, deg + k, 3), 0.6));
      } else if (kind === 'arp') {
        const tones = [0, 2, 4, 7, 4, 2];
        for (let i = 0; i < 16; i++) add(o + i * 0.25, 0.25, S.degree(proj, deg + tones[i % 6], 4), i % 4 ? 0.55 : 0.8);
      }
    }
    track.clips[scene.id] = { bars: scene.bars, notes };
  };
  S.regenPlayers = (proj, scene) => {
    for (const s of scene ? [scene] : proj.scenes)
      for (const t of proj.tracks) if (t.player && t.clips[s.id] && t.clips[s.id].notes) S.generate(proj, t, s);
  };

  // ---- song timeline: freely placed regions per track, plus named sections on the arranger bar ----
  S.songEnd = (proj) => {
    let e = 0;
    for (const s of proj.sections || []) e = Math.max(e, s.start + s.len);
    for (const t of proj.tracks) for (const r of t.regions || []) e = Math.max(e, r.start + r.len);
    return e;
  };
  // Copy a scene onto the end of the song as one region per track and mark it as a section.
  S.stamp = (proj, scene, reps) => {
    const at = Math.ceil(S.songEnd(proj) / 4) * 4, len = scene.bars * 4 * (reps || 1);
    for (const t of proj.tracks) {
      const c = t.clips[scene.id];
      if (!c) continue;
      const clip = JSON.parse(JSON.stringify(c));
      clip.bars = Math.max(1, clip.bars || scene.bars);
      t.regions.push({ id: S.uid(), start: at, len, off: 0, clip });
    }
    proj.sections.push({ id: S.uid(), name: scene.name + (reps > 1 ? ' ×' + reps : ''), start: at, len });
    return at;
  };
  // Bring projects saved or imported in the older block-based form up to the region model.
  S.migrate = (proj) => {
    proj.sections = proj.sections || [];
    for (const t of proj.tracks) t.regions = t.regions || [];
    for (const b of proj.arrangement || []) {
      const sc = proj.scenes.find((x) => x.id === b.scene);
      if (sc) S.stamp(proj, sc, b.reps || 1);
    }
    delete proj.arrangement;
    return proj;
  };
  // Assign [from, to) of a recorded region to one take, keeping the rest of the comp.
  S.paintComp = (rg, from, to, take) => {
    from = Math.max(0, from); to = Math.min(rg.len, to);
    if (to - from < 1e-6) return;
    const out = [];
    for (const c of rg.comp || []) {
      if (c.from < from) out.push({ from: c.from, to: Math.min(c.to, from), take: c.take });
      if (c.to > to) out.push({ from: Math.max(c.from, to), to: c.to, take: c.take });
    }
    out.push({ from, to, take });
    out.sort((a, b) => a.from - b.from);
    rg.comp = out.filter((c) => c.to - c.from > 1e-6).reduce((acc, c) => {
      const last = acc[acc.length - 1];
      if (last && last.take === c.take && Math.abs(last.to - c.from) < 1e-6) last.to = c.to; else acc.push(c);
      return acc;
    }, []);
  };
  // Cut one region in two at an absolute beat.
  S.splitRegion = (track, rg, at) => {
    const cut = at - rg.start;
    if (cut <= 1e-6 || cut >= rg.len - 1e-6) return null;
    const right = JSON.parse(JSON.stringify(rg)), L = Math.max(1, rg.clip.bars || 1) * 4;
    right.id = S.uid(); right.start = at; right.len = rg.len - cut;
    if (rg.takes) {
      right.takes.forEach((t) => (t.shift -= cut));
      right.comp = rg.comp.filter((c) => c.to > cut).map((c) => ({ from: Math.max(0, c.from - cut), to: c.to - cut, take: c.take }));
      rg.comp = rg.comp.filter((c) => c.from < cut).map((c) => ({ from: c.from, to: Math.min(cut, c.to), take: c.take }));
    } else right.off = (rg.off + cut) % L;
    rg.len = cut;
    track.regions.push(right);
    return right;
  };

  S.demoProject = () => {
    const p = S.blankProject();
    p.name = 'Demo';
    p.bpm = 112;
    p.root = 9; // A minor
    const a = S.newScene(p, 'Intro', 4), b = S.newScene(p, 'Groove', 4);
    a.chords = [1, 6, 3, 7];
    b.chords = [1, 6, 3, 7];
    const dr = S.newTrack(p, 'drums', 'Drums'); dr.player = 'drums';
    const bs = S.newTrack(p, 'synth', 'Bass'); bs.player = 'bass';
    Object.assign(bs.inst, { wave: 'sawtooth', wave2: 'square', cutoff: 0.38, res: 0.3, release: 0.1 });
    const ky = S.newTrack(p, 'synth', 'Keys'); ky.player = 'chords';
    Object.assign(ky.inst, { wave: 'triangle', wave2: 'sawtooth', cutoff: 0.55, attack: 0.08, release: 0.4 });
    const ld = S.newTrack(p, 'synth', 'Arp'); ld.player = 'arp';
    Object.assign(ld.inst, { wave: 'square', wave2: 'sawtooth', cutoff: 0.7, release: 0.12 });
    ld.vol = 0.55;
    S.generate(p, bs, a); S.generate(p, ky, a);
    for (const t of p.tracks) S.generate(p, t, b);
    S.stamp(p, a, 1); S.stamp(p, b, 2);
    return p;
  };

  // Build a project from flat imported data (used by the MIDI / .als / .flp readers).
  S.fromFlat = (f) => {
    const p = S.blankProject();
    p.name = f.name || 'Imported';
    p.bpm = Math.min(300, Math.max(30, f.bpm || 120));
    p.scale = 'Chromatic';
    const scenes = f.scenes.map((s) => S.newScene(p, s.name, Math.max(1, Math.ceil(s.bars))));
    for (const ft of f.tracks) {
      const t = S.newTrack(p, ft.type || 'synth', ft.name);
      if (ft.vol != null) t.vol = Math.min(1.25, Math.max(0, ft.vol));
      if (ft.pan != null) t.pan = Math.min(1, Math.max(-1, ft.pan));
      for (const k in ft.clips || {}) {
        const c = ft.clips[k], sc = scenes[k];
        if (!sc || !c.notes.length) continue;
        c.notes.sort((x, y) => x.t - y.t);
        t.clips[sc.id] = { bars: Math.max(1, Math.ceil(c.bars || sc.bars)), notes: c.notes };
      }
    }
    p.arrangement = (f.arrangement || scenes.map((_, i) => ({ scene: i, reps: 1 })))
      .filter((b) => scenes[b.scene]).map((b) => ({ scene: scenes[b.scene].id, reps: b.reps || 1 }));
    if (!p.scenes.length) S.newScene(p, 'Scene 1', 1);
    return S.migrate(p);
  };
})();
