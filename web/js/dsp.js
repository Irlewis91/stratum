// STRATUM DSP: effect building blocks, the Prompt-to-Plugin builder, tempo warping and analysis.
(function () {
  const S = window.S, D = (S.dsp = {});
  const expMap = (a, b) => (v) => a * Math.pow(b / a, v);
  const lin = (a, b) => (v) => a + (b - a) * v;
  D.expMap = expMap; D.lin = lin;
  const shaper = (ctx, fn, over) => {
    const n = 2048, c = new Float32Array(n), w = ctx.createWaveShaper();
    for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
    w.curve = c;
    if (over) w.oversample = over;
    return w;
  };
  const lfo = (ctx, hz) => { const o = ctx.createOscillator(); o.frequency.value = hz; o.start(); return o; };
  // Dry path plus a wet branch; returns the nodes the caller wires its processor between.
  const wetDry = (ctx) => {
    const i = ctx.createGain(), o = ctx.createGain(), wet = ctx.createGain();
    i.connect(o); wet.connect(o);
    return { i, o, wet };
  };

  // Each block: params {key: [label, default]} and make(ctx) -> {in, out, aps:{key:[{ap, fn}]}, set:{key: fn}}
  D.BLOCKS = {
    highpass: {
      label: 'High-pass', params: { cutoff: ['Cutoff', 0.35] },
      make(ctx) { const f = ctx.createBiquadFilter(); f.type = 'highpass';
        return { in: f, out: f, aps: { cutoff: [{ ap: f.frequency, fn: expMap(20, 4000) }] } }; },
    },
    comp: {
      label: 'Compressor', params: { amount: ['Amount', 0.45] },
      make(ctx) { const c = ctx.createDynamicsCompressor(), g = ctx.createGain(); c.attack.value = 0.01; c.release.value = 0.15; c.connect(g);
        return { in: c, out: g, aps: { amount: [{ ap: c.threshold, fn: lin(-6, -40) }, { ap: c.ratio, fn: lin(2, 12) }, { ap: g.gain, fn: lin(1, 2.4) }] } }; },
    },
    sat: {
      label: 'Saturation', params: { drive: ['Drive', 0.45], tone: ['Tone', 0.7] },
      make(ctx) { const pre = ctx.createGain(), sh = shaper(ctx, (x) => Math.tanh(2 * x), '4x'), tone = ctx.createBiquadFilter(), post = ctx.createGain();
        tone.type = 'lowpass'; pre.connect(sh); sh.connect(tone); tone.connect(post);
        return { in: pre, out: post, aps: { drive: [{ ap: pre.gain, fn: lin(0.5, 4) }, { ap: post.gain, fn: (v) => Math.pow(1 + 7 * v, -0.7) }], tone: [{ ap: tone.frequency, fn: expMap(700, 18000) }] } }; },
    },
    crush: {
      label: 'Bit Crusher', params: { amount: ['Crush', 0.45] },
      make(ctx) { const sh = ctx.createWaveShaper(), lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; sh.connect(lp);
        const set = (v) => { const L = Math.pow(2, 11 - v * 9), n = 4096, c = new Float32Array(n);
          for (let i = 0; i < n; i++) c[i] = Math.round(((i / (n - 1)) * 2 - 1) * L) / L; sh.curve = c; };
        return { in: sh, out: lp, aps: { amount: [{ ap: lp.frequency, fn: expMap(18000, 1800) }] }, set: { amount: set } }; },
    },
    wobble: {
      label: 'Tape Wobble', params: { rate: ['Rate', 0.3], depth: ['Depth', 0.35] },
      make(ctx) { const d = ctx.createDelay(0.1), o = lfo(ctx, 1), g = ctx.createGain(); d.delayTime.value = 0.012; o.connect(g); g.connect(d.delayTime);
        return { in: d, out: d, aps: { rate: [{ ap: o.frequency, fn: expMap(0.3, 8) }], depth: [{ ap: g.gain, fn: lin(0, 0.004) }] } }; },
    },
    lowpass: {
      label: 'Low-pass', params: { cutoff: ['Cutoff', 0.55], res: ['Resonance', 0.15] },
      make(ctx) { const f = ctx.createBiquadFilter(); f.type = 'lowpass';
        return { in: f, out: f, aps: { cutoff: [{ ap: f.frequency, fn: expMap(120, 18000) }], res: [{ ap: f.Q, fn: lin(0.5, 14) }] } }; },
    },
    tilt: {
      label: 'Tone', params: { bright: ['Bright', 0.7] },
      make(ctx) { const f = ctx.createBiquadFilter(); f.type = 'highshelf'; f.frequency.value = 3000;
        return { in: f, out: f, aps: { bright: [{ ap: f.gain, fn: lin(-12, 12) }] } }; },
    },
    chorus: {
      label: 'Chorus', params: { rate: ['Rate', 0.3], depth: ['Depth', 0.5], mix: ['Mix', 0.5] },
      make(ctx) { const w = wetDry(ctx), d = ctx.createDelay(0.1), o = lfo(ctx, 1), g = ctx.createGain(); d.delayTime.value = 0.018;
        w.i.connect(d); d.connect(w.wet); o.connect(g); g.connect(d.delayTime);
        return { in: w.i, out: w.o, aps: { rate: [{ ap: o.frequency, fn: expMap(0.1, 6) }], depth: [{ ap: g.gain, fn: lin(0, 0.006) }], mix: [{ ap: w.wet.gain, fn: lin(0, 1) }] } }; },
    },
    phaser: {
      label: 'Phaser', params: { rate: ['Rate', 0.3], depth: ['Depth', 0.6], mix: ['Mix', 0.6] },
      make(ctx) { const w = wetDry(ctx), o = lfo(ctx, 0.5), g = ctx.createGain(); let n = w.i; o.connect(g);
        for (let k = 0; k < 4; k++) { const a = ctx.createBiquadFilter(); a.type = 'allpass'; a.frequency.value = 900 + k * 350; g.connect(a.frequency); n.connect(a); n = a; }
        n.connect(w.wet);
        return { in: w.i, out: w.o, aps: { rate: [{ ap: o.frequency, fn: expMap(0.05, 4) }], depth: [{ ap: g.gain, fn: lin(0, 800) }], mix: [{ ap: w.wet.gain, fn: lin(0, 1) }] } }; },
    },
    tremolo: {
      label: 'Tremolo', params: { rate: ['Rate', 0.45], depth: ['Depth', 0.6] },
      make(ctx) { const a = ctx.createGain(), o = lfo(ctx, 4), g = ctx.createGain(); a.gain.value = 0.7; o.connect(g); g.connect(a.gain);
        return { in: a, out: a, aps: { rate: [{ ap: o.frequency, fn: expMap(0.5, 16) }], depth: [{ ap: g.gain, fn: lin(0, 0.65) }] } }; },
    },
    delay: {
      label: 'Delay', params: { time: ['Time', 0.4], feedback: ['Feedback', 0.4], mix: ['Mix', 0.35] },
      make(ctx) { const w = wetDry(ctx), d = ctx.createDelay(1.5), fb = ctx.createGain(); w.i.connect(d); d.connect(fb); fb.connect(d); d.connect(w.wet);
        return { in: w.i, out: w.o, aps: { time: [{ ap: d.delayTime, fn: lin(0.05, 0.8) }], feedback: [{ ap: fb.gain, fn: lin(0, 0.85) }], mix: [{ ap: w.wet.gain, fn: lin(0, 0.9) }] } }; },
    },
    reverb: {
      label: 'Reverb', params: { size: ['Size', 0.5], mix: ['Mix', 0.3] },
      make(ctx) { const w = wetDry(ctx), c = ctx.createConvolver(); w.i.connect(c); c.connect(w.wet);
        const set = (v) => { const sr = ctx.sampleRate, len = Math.floor(sr * (0.3 + v * 4)), b = ctx.createBuffer(2, len, sr);
          for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5); }
          c.buffer = b; };
        return { in: w.i, out: w.o, aps: { mix: [{ ap: w.wet.gain, fn: lin(0, 0.8) }] }, set: { size: set } }; },
    },
    noise: {
      label: 'Dust & Hiss', params: { level: ['Level', 0.35] },
      make(ctx) { const thru = ctx.createGain(), lvl = ctx.createGain(), sr = ctx.sampleRate, b = ctx.createBuffer(1, sr * 2, sr), d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.25 + (Math.random() < 0.0004 ? (Math.random() * 2 - 1) * 4 : 0);
        const s = ctx.createBufferSource(), hp = ctx.createBiquadFilter(); s.buffer = b; s.loop = true; hp.type = 'highpass'; hp.frequency.value = 1200;
        s.connect(hp); hp.connect(lvl); lvl.connect(thru); s.start();
        return { in: thru, out: thru, aps: { level: [{ ap: lvl.gain, fn: lin(0, 0.06) }] } }; },
    },
  };
  D.ORDER = ['highpass', 'comp', 'sat', 'crush', 'wobble', 'lowpass', 'tilt', 'chorus', 'phaser', 'tremolo', 'delay', 'reverb', 'noise'];

  D.applyParam = (ctx, p, v, live) => {
    for (const a of p.aps) {
      if (live) a.ap.setTargetAtTime(a.fn(v), ctx.currentTime, 0.015);
      else a.ap.value = a.fn(v);
    }
    if (p.set) p.set(v);
  };

  // Turn a stored plugin description into live nodes, ending in a brick-wall safety stage.
  D.instantiate = (ctx, pl) => {
    const input = ctx.createGain(), params = {};
    let node = input;
    pl.blocks.forEach((b, i) => {
      const def = D.BLOCKS[b.type];
      if (!def) return;
      const inst = def.make(ctx);
      node.connect(inst.in);
      node = inst.out;
      for (const k in def.params) {
        const p = { aps: (inst.aps && inst.aps[k]) || [], set: inst.set && inst.set[k] };
        params[i + '.' + k] = p;
        D.applyParam(ctx, p, b.vals[k], false);
      }
    });
    const lim = ctx.createDynamicsCompressor(), clip = shaper(ctx, (x) => x);
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.05;
    node.connect(lim); lim.connect(clip);
    return { in: input, out: clip, params, setParam(key, v) { if (params[key]) D.applyParam(ctx, params[key], v, true); } };
  };

  D.stock = (type) => {
    const def = D.BLOCKS[type], vals = {};
    for (const k in def.params) vals[k] = def.params[k][1];
    return { id: S.uid(), name: def.label, prompt: '', blocks: [{ type, vals }] };
  };

  // Prompt-to-Plugin: keyword rules choose blocks, modifier words scale their settings.
  const RULES = [
    [/telephone|radio|thin|high[- ]?pass|hpf|low[- ]?cut/, 'highpass', { cutoff: 0.55 }],
    [/compress|punch|glue|squash|pump|tight/, 'comp', {}],
    [/distort|fuzz|crunch|dirty|grit|overdrive/, 'sat', { drive: 0.85, tone: 0.6 }],
    [/satur|warm|tube|tape|analog|vintage|drive/, 'sat', {}],
    [/bit ?crush|lo-?fi|8-?bit|crush|digital|retro/, 'crush', {}],
    [/wow|flutter|wobbl|warbl|tape|lo-?fi|detun|seasick/, 'wobble', {}],
    [/telephone|radio|low[- ]?pass|lpf|dark|muffl|dull|filter|underwater|dusty/, 'lowpass', {}],
    [/bright|air|crisp|sparkl|shin|presence/, 'tilt', { bright: 0.8 }],
    [/chorus|ensemble|thick|lush|wide/, 'chorus', {}],
    [/phaser|phase|swirl|jet/, 'phaser', {}],
    [/tremolo|pulse|stutter|chop/, 'tremolo', {}],
    [/delay|echo|repeat|dub|slapback/, 'delay', {}],
    [/reverb|room|hall|space|ambient|shimmer|wash|cathedral|plate|cave/, 'reverb', {}],
    [/dust|vinyl|crackle|hiss|noise|lo-?fi/, 'noise', {}],
  ];
  D.fromPrompt = (text) => {
    const t = text.toLowerCase(), found = {};
    for (const [re, type, vals] of RULES) if (re.test(t) && !found[type]) found[type] = vals;
    let matched = true;
    if (!Object.keys(found).length) { found.sat = { drive: 0.3 }; found.tilt = { bright: 0.55 }; matched = false; }
    const amt = /heavy|extreme|massive|aggressive|lots|crushing|intense/.test(t) ? 1.45 : /subtle|gentle|slight|light|touch|hint/.test(t) ? 0.6 : 1;
    const spd = /slow|lazy/.test(t) ? 0.55 : /fast|rapid|quick/.test(t) ? 1.6 : 1;
    const size = /long|huge|big|giant|endless|cathedral/.test(t) ? 1.6 : /short|small|tight|slapback/.test(t) ? 0.5 : 1;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const blocks = D.ORDER.filter((k) => found[k]).map((type) => {
      const def = D.BLOCKS[type], vals = {};
      for (const k in def.params) {
        let v = found[type][k] != null ? found[type][k] : def.params[k][1];
        if (k === 'rate') v *= spd;
        else if (k === 'size' || k === 'time') v *= size;
        else if (k !== 'cutoff' && k !== 'tone' && k !== 'bright' && k !== 'res') v *= amt;
        vals[k] = clamp(v);
      }
      return { type, vals };
    });
    if (/telephone|radio/.test(t)) blocks.forEach((b) => { if (b.type === 'lowpass') b.vals.cutoff = 0.42; });
    if (/dark|muffl|underwater/.test(t)) blocks.forEach((b) => { if (b.type === 'lowpass') b.vals.cutoff = 0.35; });
    const name = text.trim().split(/\s+/).filter((w) => !/^(a|an|the|with|and|build|make|me|of|module|plugin|knob|integrated)$/i.test(w))
      .slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Custom';
    return { id: S.uid(), name, prompt: text, blocks, matched };
  };

  // WSOLA time-stretch (pitch preserved). ratio > 1 makes the audio longer.
  D.stretch = (buf, ratio) => {
    if (Math.abs(ratio - 1) < 0.004) return buf;
    const sr = buf.sampleRate, nCh = buf.numberOfChannels, inLen = buf.length, outLen = Math.max(1, Math.floor(inLen * ratio));
    const W = Math.floor(sr * 0.06) & ~1, Hs = W >> 1, Ha = Hs / ratio, search = Math.floor(sr * 0.012);
    const win = new Float32Array(W);
    for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W);
    const chans = [];
    for (let c = 0; c < nCh; c++) chans.push(buf.getChannelData(c));
    const mono = nCh > 1 ? chans[0].map((v, i) => (v + chans[1][i]) * 0.5) : chans[0];
    const outs = chans.map(() => new Float32Array(outLen + W));
    let prev = 0;
    for (let j = 0; j * Hs < outLen; j++) {
      let pos = Math.round(j * Ha);
      const tgt = prev + Hs;
      if (j > 0 && tgt + W < inLen) {
        let best = 0, bestC = -Infinity;
        for (let d = -search; d <= search; d += 4) {
          const p = pos + d;
          if (p < 0 || p + W >= inLen) continue;
          let c = 0;
          for (let i = 0; i < W; i += 8) c += mono[p + i] * mono[tgt + i];
          if (c > bestC) { bestC = c; best = d; }
        }
        pos += best;
      }
      if (pos < 0) pos = 0;
      const o = j * Hs;
      for (let c = 0; c < nCh; c++) {
        const src = chans[c], dst = outs[c];
        for (let i = 0; i < W && pos + i < inLen; i++) dst[o + i] += src[pos + i] * win[i];
      }
      prev = pos;
    }
    const out = new AudioBuffer({ length: outLen, numberOfChannels: nCh, sampleRate: sr });
    outs.forEach((d, c) => out.copyToChannel(d.subarray(0, outLen), c));
    return out;
  };
  D.warped = (rec, bpm) => {
    const key = Math.round(bpm * 100);
    if (!rec.warpCache || rec.warpCache.key !== key) rec.warpCache = { key, buf: D.stretch(rec.buf, rec.bpm / bpm) };
    return rec.warpCache.buf;
  };

  // Tempo estimate from the autocorrelation of the onset envelope (70-180 BPM).
  D.detectBpm = (buf) => {
    const d = buf.getChannelData(0), hop = 512, sr = buf.sampleRate, n = Math.min(Math.floor(d.length / hop), Math.floor((sr * 60) / hop));
    if (n < 200) return 0;
    const env = new Float32Array(n);
    let last = 0;
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (let k = 0; k < hop; k += 4) { const v = d[i * hop + k]; e += v * v; }
      env[i] = Math.max(0, e - last);
      last = e;
    }
    let best = 0, bestV = 0;
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const lag = (60 / bpm) * (sr / hop);
      let v = 0;
      for (let i = 0; i + lag * 2 < n; i++) v += env[i] * (env[Math.round(i + lag)] + 0.5 * env[Math.round(i + lag * 2)]);
      if (v > bestV) { bestV = v; best = bpm; }
    }
    return bestV > 0 ? Math.round(best) : 0;
  };

  // Frequency / mid-side band split into four parts. This is filtering, not AI stem separation.
  D.bandSplit = async (buf) => {
    const run = (wire) => {
      const ctx = new OfflineAudioContext(2, buf.length, buf.sampleRate), src = ctx.createBufferSource();
      src.buffer = buf;
      wire(ctx, src).connect(ctx.destination);
      src.start();
      return ctx.startRendering();
    };
    const bq = (ctx, type, f) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = 0.7; return b; };
    const chain = (src, ...nodes) => nodes.reduce((a, b) => (a.connect(b), b), src);
    const ms = (ctx, src, side) => {
      const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      src.connect(sp);
      [[0, 0, 0.5], [1, 0, side ? -0.5 : 0.5], [0, 1, side ? -0.5 : 0.5], [1, 1, 0.5]].forEach(([from, to, gain]) => {
        const g = ctx.createGain(); g.gain.value = gain; sp.connect(g, from); g.connect(mg, 0, to);
      });
      return mg;
    };
    return [
      ['Low', await run((c, s) => chain(s, bq(c, 'lowpass', 180), bq(c, 'lowpass', 180)))],
      ['Centre mid', await run((c, s) => chain(ms(c, s, false), bq(c, 'highpass', 250), bq(c, 'lowpass', 4000)))],
      ['Sides', await run((c, s) => chain(ms(c, s, true), bq(c, 'highpass', 200)))],
      ['High', await run((c, s) => chain(s, bq(c, 'highpass', 4500), bq(c, 'highpass', 4500)))],
    ];
  };
})();
