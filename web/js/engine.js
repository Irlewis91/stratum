// STRATUM audio engine: mixer graph, instruments, look-ahead scheduler and offline rendering.
(function () {
  const S = window.S, D = S.dsp;
  const E = (S.engine = { ctx: null, graph: null, playing: false, mode: 'scene', sceneId: null, anchorT: 0, anchorB: 0, sched: 0, sources: new Set(), metro: false, timer: null });
  const curve = (ctx, k) => {
    const n = 2048, c = new Float32Array(n), w = ctx.createWaveShaper();
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    w.curve = c;
    return w;
  };
  E.lfoHz = D.expMap(0.05, 12);
  const noiseCache = new WeakMap();
  const noise = (ctx) => {
    let b = noiseCache.get(ctx);
    if (!b) {
      b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseCache.set(ctx, b);
    }
    return b;
  };

  E.ensure = () => {
    if (!E.ctx) {
      E.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      E.rebuild();
    }
    if (E.ctx.state === 'suspended') E.ctx.resume();
    return E.ctx;
  };

  // Build the whole mixer for a project on any context (live or offline).
  E.build = (ctx, proj) => {
    const g = { ctx, tracks: {}, lfos: [] }, m = (g.master = {});
    m.in = ctx.createGain(); m.drive = ctx.createGain(); m.shaper = curve(ctx, 1.2); m.shaper.oversample = '2x';
    m.makeup = ctx.createGain(); m.comp = ctx.createDynamicsCompressor(); m.vol = ctx.createGain();
    m.lim = ctx.createDynamicsCompressor(); m.an = ctx.createAnalyser(); m.an.fftSize = 1024;
    m.comp.attack.value = 0.02; m.comp.release.value = 0.2; m.comp.knee.value = 12;
    m.lim.threshold.value = -1; m.lim.knee.value = 0; m.lim.ratio.value = 20; m.lim.attack.value = 0.002; m.lim.release.value = 0.08;
    [m.in, m.drive, m.shaper, m.makeup, m.comp, m.vol, m.lim, m.an, ctx.destination].reduce((a, b) => (a.connect(b), b));
    g.lfos = proj.lfos.map((l) => {
      const osc = ctx.createOscillator();
      osc.type = l.shape; osc.start();
      return { osc, gains: [] };
    });
    for (const tr of proj.tracks) {
      const t = (g.tracks[tr.id] = { last: null, instParams: {} });
      t.input = ctx.createGain();
      // A track with plugin effects plays its samples in the Mac shell; `sink` collects them instead during a mixdown.
      t.input.plug = S.plug && S.plug.fxOn(tr) ? { tr, sink: null } : null;
      let node = t.input;
      if (tr.type === 'synth') {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        t.instParams.cutoff = { aps: [{ ap: f.frequency, fn: D.expMap(150, 16000) }] };
        t.instParams.res = { aps: [{ ap: f.Q, fn: D.lin(0.5, 14) }] };
        D.applyParam(ctx, t.instParams.cutoff, tr.inst.cutoff, false);
        D.applyParam(ctx, t.instParams.res, tr.inst.res, false);
        node.connect(f); node = f;
      }
      t.fx = tr.fx.map((pl) => D.instantiate(ctx, pl));
      for (const fx of t.fx) { node.connect(fx.in); node = fx.out; }
      t.sat = curve(ctx, 0.7); t.vol = ctx.createGain(); t.pan = ctx.createStereoPanner(); t.mute = ctx.createGain();
      t.an = ctx.createAnalyser(); t.an.fftSize = 512;
      [node, t.sat, t.vol, t.pan, t.mute, t.an, m.in].reduce((a, b) => (a.connect(b), b));
      for (const c of tr.cables) {
        const p = c.dev < 0 ? t.instParams[c.key] : t.fx[c.dev] && t.fx[c.dev].params[c.key], l = g.lfos[c.src];
        if (!p || !l) continue;
        for (const a of p.aps) {
          const gn = ctx.createGain(), range = a.fn(1) - a.fn(0);
          l.osc.connect(gn); gn.connect(a.ap);
          l.gains.push({ node: gn, range });
        }
      }
    }
    E.applyMix(g, proj);
    return g;
  };
  E.applyMix = (g, proj) => {
    g = g || E.graph; proj = proj || S.proj;
    if (!g) return;
    const anySolo = proj.tracks.some((t) => t.solo);
    for (const tr of proj.tracks) {
      const t = g.tracks[tr.id];
      if (!t) continue;
      t.vol.gain.value = tr.vol; t.pan.pan.value = tr.pan;
      t.mute.gain.value = tr.mute || (anySolo && !tr.solo) ? 0 : 1;
    }
    const m = g.master, d = 0.7 + proj.master.drive * 1.8;
    m.drive.gain.value = d; m.makeup.gain.value = 1.1 / Math.sqrt(d);
    m.comp.threshold.value = -24 * proj.master.glue; m.comp.ratio.value = 1 + 3 * proj.master.glue;
    m.vol.gain.value = proj.master.vol;
    if (S.plug && g === E.graph) S.plug.mix();
    proj.lfos.forEach((l, i) => {
      const gl = g.lfos[i];
      if (!gl) return;
      gl.osc.frequency.value = E.lfoHz(l.rate);
      if (gl.osc.type !== l.shape) gl.osc.type = l.shape;
      for (const x of gl.gains) x.node.gain.value = x.range * 0.5 * l.depth;
    });
  };
  E.rebuild = () => {
    if (S.plug) S.plug.sync();
    if (!E.ctx) return;
    if (E.graph) { try { E.graph.master.an.disconnect(); E.graph.lfos.forEach((l) => l.osc.stop()); } catch (e) {} }
    E.graph = E.build(E.ctx, S.proj);
  };

  const freq = (p, cents) => 440 * Math.pow(2, (p - 69 + (cents || 0) / 100) / 12);
  // One-shot or held playback of a loaded sample. With `hold` the note gets an attack/release envelope and stops.
  E.sample = (ctx, dest, buf, when, rate, gain, hold, att, rel, loop) => {
    const s = ctx.createBufferSource(), a = ctx.createGain();
    if (dest.plug) return S.plug.voice(dest.plug, hold == null ? { buf, rate, gain } : { buf, rate, gain, d: Math.max(hold, att), att, rel, loop }, when, ctx);
    s.buffer = buf; s.playbackRate.value = rate; s.loop = !!loop;
    s.connect(a); a.connect(dest); s.start(when);
    if (hold == null) { a.gain.value = gain; return; }
    const end = when + Math.max(hold, att);
    a.gain.setValueAtTime(0, when); a.gain.linearRampToValueAtTime(gain, when + att); a.gain.setTargetAtTime(0, end, rel / 4);
    s.stop(end + rel * 2 + 0.05);
  };
  E.synth = (ctx, dest, inst, n, when, dur, prev) => {
    const smp = inst.sample, rec = smp && S.buffers[smp.audio];
    if (rec) return E.sample(ctx, dest, rec.buf, when, freq(n.p, n.c) / freq(smp.root == null ? 60 : smp.root), 0.6 * (n.v == null ? 0.8 : n.v), dur, 0.003 + inst.attack * 0.5, 0.02 + inst.release * 1.2, smp.loop);
    if (dest.plug) return S.plug.synthNote(dest.plug, inst, n, when, dur, prev, ctx);
    const f = freq(n.p, n.c), a = ctx.createGain(), o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o1.type = inst.wave; o2.type = inst.wave2; o2.detune.value = inst.detune * 50; g2.gain.value = 0.6;
    for (const o of [o1, o2]) {
      if (n.g && prev != null) {
        o.frequency.setValueAtTime(freq(prev), when);
        o.frequency.exponentialRampToValueAtTime(f, when + Math.min(0.12, dur * 0.5));
      } else o.frequency.setValueAtTime(f, when);
    }
    const att = 0.003 + inst.attack * 0.5, rel = 0.02 + inst.release * 1.2, peak = 0.2 * (n.v == null ? 0.8 : n.v), end = when + Math.max(dur, att);
    a.gain.setValueAtTime(0, when);
    a.gain.linearRampToValueAtTime(peak, when + att);
    a.gain.setTargetAtTime(0, end, rel / 4);
    o1.connect(a); o2.connect(g2); g2.connect(a); a.connect(dest);
    o1.start(when); o2.start(when);
    o1.stop(end + rel * 2); o2.stop(end + rel * 2);
  };
  E.drum = (ctx, dest, pitch, vel, when, tr) => {
    const pad = tr && tr.pads && tr.pads[pitch], rec = pad && S.buffers[pad.audio];
    if (rec) return E.sample(ctx, dest, rec.buf, when, Math.pow(2, (pad.tune || 0) / 12), (vel == null ? 0.8 : vel) * (pad.gain == null ? 1 : pad.gain));
    const p = S.drumMap(pitch), v = vel == null ? 0.8 : vel;
    if (dest.plug) { const b = S.plug.drumBuf(p); if (b) S.plug.voice(dest.plug, { buf: b, gain: v }, when, ctx); return; }
    const a = ctx.createGain();
    a.connect(dest);
    const env = (peak, dec) => { a.gain.setValueAtTime(peak * v, when); a.gain.exponentialRampToValueAtTime(0.0008, when + dec); return when + dec + 0.02; };
    const osc = (type, f0, f1, dec, stopAt) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.setValueAtTime(f0, when);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, when + dec);
      o.connect(a); o.start(when); o.stop(stopAt);
    };
    const nz = (type, f, stopAt, q) => {
      const s = ctx.createBufferSource(), flt = ctx.createBiquadFilter();
      s.buffer = noise(ctx); flt.type = type; flt.frequency.value = f; if (q) flt.Q.value = q;
      s.connect(flt); flt.connect(a); s.start(when, Math.random() * 0.5); s.stop(stopAt);
    };
    if (p === 36) osc('sine', 150, 42, 0.13, env(1, 0.38));
    else if (p === 38) { const e = env(0.6, 0.2); nz('highpass', 1400, e); osc('triangle', 190, 140, 0.08, e); }
    else if (p === 39) nz('bandpass', 1300, env(0.7, 0.24), 1.2);
    else if (p === 42) nz('highpass', 7500, env(0.32, 0.05));
    else if (p === 46) nz('highpass', 7000, env(0.3, 0.32));
    else if (p === 45) osc('sine', 170, 80, 0.2, env(0.8, 0.3));
    else if (p === 37) { const e = env(0.4, 0.04); osc('square', 1700, 0, 0, e); }
    else { const e = env(0.25, 0.28); osc('square', 540, 0, 0, e); osc('square', 800, 0, 0, e); }
  };

  E.sceneById = (id) => S.proj.scenes.find((s) => s.id === id);
  E.songBeats = (proj) => S.songEnd(proj || S.proj);
  // Split an absolute beat range into pieces that each lie inside one pass of the looping scene.
  E.segments = (proj, sceneId, a, b) => {
    const out = [], eps = 1e-9, sc = proj.scenes.find((s) => s.id === sceneId) || proj.scenes[0], L = sc.bars * 4;
    for (let x = a; x < b - eps;) {
      const k = Math.floor(x / L + eps), end = Math.min(b, (k + 1) * L);
      out.push({ scene: sc, base: k * L, ls: x - k * L, le: end - k * L });
      x = end;
    }
    return out;
  };
  // Visit everything that sounds in [a, b). cb(track, kind, beat, note, info, clip, loopBeats); kind is 'note' or 'audio'.
  // info = {end: beat where the containing clip stops, rg: region (song mode), skip: beats already elapsed inside it}.
  E.walk = (proj, mode, sceneId, a, b, cb, first) => {
    const eps = 1e-9;
    const notes = (tr, clip, L, c0, c1, toAbs, info) => {
      for (let k = Math.floor(c0 / L + eps), k1 = Math.floor((c1 - eps) / L); k <= k1; k++)
        for (const n of clip.notes) {
          if (n.t >= L) continue;
          const ct = n.t + k * L;
          if (ct >= c0 - eps && ct < c1 - eps) cb(tr, 'note', toAbs(ct), n, info, clip, L);
        }
    };
    if (mode === 'scene') {
      for (const seg of E.segments(proj, sceneId, a, b)) {
        for (const tr of proj.tracks) {
          const clip = tr.clips[seg.scene.id];
          if (!clip) continue;
          const L = Math.max(1, clip.bars || seg.scene.bars) * 4, info = { end: seg.base + seg.scene.bars * 4, skip: 0 };
          if (clip.notes) notes(tr, clip, L, seg.ls, seg.le, (ct) => seg.base + ct, info);
          else if (clip.audio)
            for (let k = Math.floor(seg.ls / L + eps), k1 = Math.floor((seg.le - eps) / L); k <= k1; k++)
              if (k * L >= seg.ls - eps && k * L < seg.le - eps) cb(tr, 'audio', seg.base + k * L, null, { end: Math.min(info.end, seg.base + (k + 1) * L), skip: 0, once: true }, clip, L);
        }
      }
      return;
    }
    const total = E.noLoop ? Infinity : E.songBeats(proj);
    if (!total) return;
    for (let x = a; x < b - eps;) {
      const base = total === Infinity ? 0 : Math.floor(x / total + eps) * total, la = x - base, lb = Math.min(b - base, total);
      for (const tr of proj.tracks) {
        for (const rg of tr.regions) {
          const rs = rg.start, re = rg.start + rg.len;
          if (re <= la + eps || rs >= lb - eps) continue;
          const clip = rg.clip, L = Math.max(1, clip.bars || 1) * 4;
          if (clip.notes) {
            const w0 = Math.max(la, rs), w1 = Math.min(lb, re);
            notes(tr, clip, L, rg.off + (w0 - rs), rg.off + (w1 - rs), (ct) => base + rs + (ct - rg.off), { end: base + re, rg, skip: 0 });
          } else {
            const startsHere = rs >= la - eps, mid = first && x === a && rs < la - eps;
            if (startsHere || mid) cb(tr, 'audio', base + Math.max(rs, la), null, { end: base + re, rg, skip: mid ? la - rs : 0 }, clip, L);
          }
        }
      }
      x = base + lb;
    }
  };
  // Start one buffer slice with short fades so edits and comp joins do not click.
  const slice = (ctx, dest, buf, when, offset, dur, gain, live) => {
    if (dur <= 0.001 || offset >= buf.duration) return;
    const f = Math.min(0.004, dur / 4);
    if (dest.plug) return S.plug.voice(dest.plug, { buf, off: Math.max(0, offset), gain, d: dur - f, att: f, rel: f }, when, ctx);
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf;
    g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(gain, when + f);
    g.gain.setValueAtTime(gain, when + dur - f); g.gain.linearRampToValueAtTime(0, when + dur);
    src.connect(g); g.connect(dest);
    src.start(when, Math.max(0, offset), dur);
    if (live) { E.sources.add(src); src.onended = () => E.sources.delete(src); }
  };
  E.playAudio = (ctx, dest, proj, clip, info, when, L, live) => {
    const spb = 60 / proj.bpm, rg = info.rg, gain = clip.gain == null ? 1 : clip.gain, skip = info.skip || 0;
    const bufOf = (id, warp) => { const rec = S.buffers[id]; return rec ? (warp && rec.bpm ? D.warped(rec, proj.bpm) : rec.buf) : null; };
    if (rg && rg.takes && rg.takes.length) {
      // Recorded region: play each comp segment from the take it points at.
      for (const c of rg.comp || []) {
        const from = Math.max(c.from, skip), take = rg.takes[c.take];
        if (!take || c.to <= from) continue;
        const buf = bufOf(take.audio, true);
        if (!buf) continue;
        let offBeats = from - (take.shift || 0), startBeats = from - skip, durBeats = c.to - from;
        if (offBeats < 0) { startBeats -= offBeats; durBeats += offBeats; offBeats = 0; }
        slice(ctx, dest, buf, when + startBeats * spb, offBeats * spb, durBeats * spb, gain, live);
      }
      return;
    }
    const buf = bufOf(clip.audio, clip.warp);
    if (!buf) return;
    if (info.once) return slice(ctx, dest, buf, when, 0, (info.end - (info.abs || 0)) * spb, gain, live);
    // Free region: content loops every L beats, starting rg.off beats in.
    const c0 = rg.off + skip, c1 = rg.off + rg.len, eps = 1e-9;
    for (let k = Math.floor(c0 / L + eps), k1 = Math.floor((c1 - eps) / L), n = 0; k <= k1 && n < 2000; k++, n++) {
      const s0 = Math.max(c0, k * L), s1 = Math.min(c1, (k + 1) * L);
      slice(ctx, dest, buf, when + (s0 - c0) * spb, (s0 - k * L) * spb, (s1 - s0) * spb, gain, live);
    }
  };
  // ---- automation: volume and pan lanes on tracks and master volume, as points {t: song beat, v} joined by straight lines ----
  E.lanes = (g, proj) => {
    const out = [], has = (o, k) => o && o.auto && o.auto[k] && o.auto[k].length;
    for (const tr of proj.tracks) {
      const tg = g.tracks[tr.id];
      if (!tg) continue;
      if (has(tr, 'vol')) out.push([tg.vol.gain, tr.auto.vol]);
      if (has(tr, 'pan')) out.push([tg.pan.pan, tr.auto.pan]);
    }
    if (has(proj.master, 'vol')) out.push([g.master.vol.gain, proj.master.auto.vol]);
    return out;
  };
  E.autoAt = (pts, beat) => {
    if (beat <= pts[0].t) return pts[0].v;
    for (let i = 1; i < pts.length; i++) if (beat < pts[i].t) { const p = pts[i - 1], q = pts[i]; return p.v + ((q.v - p.v) * (beat - p.t)) / Math.max(1e-9, q.t - p.t); }
    return pts[pts.length - 1].v;
  };
  E.automate = (g, proj, a, b, toTime, first) => {
    const L = E.noLoop ? Infinity : E.songBeats(proj);
    for (const [param, pts] of E.lanes(g, proj)) {
      if (first) { param.cancelScheduledValues(0); param.setValueAtTime(E.autoAt(pts, L === Infinity ? a : a % L), Math.max(0, toTime(a))); }
      for (let k = L === Infinity ? 0 : Math.floor(a / L), k1 = L === Infinity ? 0 : Math.floor((b - 1e-9) / L); k <= k1; k++) {
        const base = L === Infinity ? 0 : k * L;
        if (base > a && base < b) param.setValueAtTime(pts[0].v, toTime(base));   // the song has looped
        for (const p of pts) { const t = base + p.t; if (t > a && t <= b && (L === Infinity || p.t <= L)) param.linearRampToValueAtTime(p.v, toTime(t)); }
      }
    }
  };
  E.scheduleRange = (ctx, g, proj, mode, sceneId, a, b, toTime, live, first) => {
    const spb = 60 / proj.bpm;
    if (mode === 'song') E.automate(g, proj, a, b, toTime, first);
    E.walk(proj, mode, sceneId, a, b, (tr, kind, beat, n, info, clip, L) => {
      const tg = g.tracks[tr.id];
      if (!tg) return;
      const when = toTime(beat);
      if (kind === 'note') {
        const dur = Math.min(n.d, info.end - beat) * spb;
        if (S.plug && S.plug.on(tr)) {
          // Plugin tracks sound in the Mac shell: live notes are sent with their delay, offline ones are collected for the mixdown.
          if (live) S.plug.note(tr, n.p, n.v, when - ctx.currentTime + (ctx.outputLatency || 0), Math.max(0.03, dur));
          else g.plugEvents.push({ t: tr.id, p: n.p, v: n.v == null ? 0.8 : n.v, at: when, d: Math.max(0.03, dur) });
          return;
        }
        if (tr.type === 'drums') E.drum(ctx, tg.input, n.p, n.v, when, tr);
        else if (tr.type === 'synth') { E.synth(ctx, tg.input, tr.inst, n, when, Math.max(0.03, dur), tg.last); tg.last = n.p; }
        return;
      }
      info.abs = beat;
      E.playAudio(ctx, tg.input, proj, clip, info, when, L, live);
    }, first);
  };

  E.beatAt = (t) => E.anchorB + ((t - E.anchorT) * S.proj.bpm) / 60;
  E.tick = () => {
    if (!E.playing) return;
    const ctx = E.ctx, proj = S.proj, spb = 60 / proj.bpm, to = E.beatAt(ctx.currentTime) + 0.15 / spb;
    if (to <= E.sched) return;
    const toTime = (b) => E.anchorT + (b - E.anchorB) * spb;
    E.scheduleRange(ctx, E.graph, proj, E.mode, E.sceneId, E.sched, to, toTime, true, E.first);
    E.first = false;
    if (E.metro) {
      for (let b = Math.ceil(E.sched - 1e-9); b < to; b++) {
        const o = ctx.createOscillator(), g = ctx.createGain(), w = toTime(b);
        o.frequency.value = b % 4 ? 1000 : 1500;
        g.gain.setValueAtTime(0.25, w); g.gain.exponentialRampToValueAtTime(0.001, w + 0.05);
        o.connect(g); g.connect(ctx.destination); o.start(w); o.stop(w + 0.06);
      }
    }
    E.sched = to;
  };
  E.play = (fromBeat) => {
    E.ensure();
    E.stop();
    E.anchorT = E.ctx.currentTime + 0.06; E.anchorB = fromBeat || 0; E.sched = E.anchorB; E.playing = true; E.first = true;
    for (const id in E.graph.tracks) E.graph.tracks[id].last = null;
    if (S.plug) S.plug.transport(true, E.anchorB, 0.06);
    E.timer = setInterval(E.tick, 25);
    E.tick();
  };
  E.stop = () => {
    E.playing = false;
    clearInterval(E.timer);
    E.sources.forEach((s) => { try { s.stop(); } catch (e) {} });
    E.sources.clear();
    if (S.plug) { S.plug.allOff(); S.plug.transport(false, 0, 0); }
    if (E.graph && E.ctx) { for (const [param] of E.lanes(E.graph, S.proj)) param.cancelScheduledValues(0); E.applyMix(); }
  };
  E.setBpm = (v) => {
    if (E.playing) { const now = E.ctx.currentTime, b = E.beatAt(now); S.proj.bpm = v; E.anchorT = now; E.anchorB = b; if (S.plug) S.plug.transport(true, b, 0); }
    else S.proj.bpm = v;
  };
  E.position = () => {
    if (!E.playing) return null;
    const b = Math.max(0, E.beatAt(E.ctx.currentTime));
    if (E.mode === 'scene') { const seg = E.segments(S.proj, E.sceneId, b, b + 0.01)[0]; return seg ? { abs: b, scene: seg.scene, local: seg.ls } : null; }
    const total = E.noLoop ? Infinity : E.songBeats();
    return total ? { abs: b, song: total === Infinity ? b : b % total, local: total === Infinity ? b : b % total } : null;
  };

  // Play one note immediately (keyboard, piano-roll audition).
  E.audition = (tr, p, v) => {
    E.ensure();
    const tg = E.graph.tracks[tr.id];
    if (!tg) return;
    const when = E.ctx.currentTime + 0.005;
    if (S.plug && S.plug.on(tr)) return S.plug.note(tr, p, v, 0, 0.3);
    if (tr.type === 'drums') E.drum(E.ctx, tg.input, p, v, when, tr);
    else if (tr.type === 'synth') E.synth(E.ctx, tg.input, tr.inst, { p, v }, when, 0.3, null);
  };

  E.render = async (proj, mode, sceneId, beats) => {
    const spb = 60 / proj.bpm, sr = 44100, ctx = new OfflineAudioContext(2, Math.ceil((beats * spb + 2) * sr), sr), g = E.build(ctx, proj);
    g.plugEvents = [];
    const pending = [];
    for (const id in g.tracks) if (g.tracks[id].input.plug) { g.tracks[id].input.plug.sink = g.plugEvents; g.tracks[id].input.plug.pending = pending; }
    E.scheduleRange(ctx, g, proj, mode, sceneId, 0, beats, (b) => 0.05 + b * spb, false, true);
    E.plugEvents = g.plugEvents;
    const out = await ctx.startRendering();
    await Promise.all(pending);
    return out;
  };
  E.peak = (an) => {
    E._pk = E._pk || {};
    const d = E._pk[an.fftSize] || (E._pk[an.fftSize] = new Float32Array(an.fftSize));
    an.getFloatTimeDomainData(d);
    let m = 0;
    for (let i = 0; i < d.length; i += 2) { const v = Math.abs(d[i]); if (v > m) m = v; }
    return m;
  };
})();
