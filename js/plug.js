// STRATUM plugin bridge: plugins (Audio Units on the Mac, VST3 and VST2 on both), STRATUM Wave, Tune and Airwindows,
// hosted by the Mac app or the Windows app.
// A track with `plugin: {id, name, maker, state, fx: [{id, name, state}]}` sends its notes to the shell instead of the built-in sounds.
(function () {
  const S = window.S, E = S.engine, IO = S.io, PL = (S.plug = {});
  const native = () => IO.host();
  const waits = {};
  let seq = 0;
  const ask = (msg) => new Promise((res) => { if (!native()) return res(null); const id = ++seq; waits[id] = res; native().postMessage({ ...msg, req: id }); });
  PL.ask = ask;
  PL.cb = (id, v) => { const f = waits[id]; delete waits[id]; if (f) f(v); };
  PL.available = () => !!native();
  PL.on = (t) => !!(t && t.plugin && t.type !== 'audio' && native());
  // Tracks that play their own audio (clips, drum pads, a loaded sample) move into the shell's engine once they have plugin effects.
  PL.fxOn = (t) => !!(t && !t.plugin && t.pfx && t.pfx.length && native());
  PL.native = (t) => PL.on(t) || PL.fxOn(t);
  PL.fxList = (t) => (t.plugin ? t.plugin.fx || (t.plugin.fx = []) : t.pfx || (t.pfx = []));
  // Audio the shell needs is sent once per buffer and then referred to by key.
  const keys = new Map();
  let keyN = 0;
  PL.keyOf = (buf) => {
    let k = keys.get(buf);
    if (k) return k;
    k = 'b' + ++keyN; keys.set(buf, k);
    const n = buf.length, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, f = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { f[2 * i] = L[i]; f[2 * i + 1] = R[i]; }
    const u = new Uint8Array(f.buffer);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    native().postMessage({ op: 'auSample', key: k, rate: buf.sampleRate, b64: btoa(s) });
    return k;
  };
  // The built-in drum sounds, rendered once so a drum track with plugin effects can play them as samples.
  const drums = {};
  PL.drumBuf = (p) => {
    if (drums[p] === undefined) {
      drums[p] = null;
      const c = new OfflineAudioContext(2, 44100, 44100);
      E.drum(c, c.destination, p, 1, 0.001);
      c.startRendering().then((b) => { drums[p] = b; });
    }
    return drums[p];
  };
  // Send ahead everything a track will play, so the first bar is not held up by transfers.
  PL.preload = (proj) => {
    for (const t of proj.tracks.filter(PL.fxOn)) {
      const clips = [...Object.values(t.clips), ...t.regions.map((r) => r.clip)], ids = [];
      for (const c of clips) if (c && c.audio) ids.push([c.audio, c.warp]);
      for (const r of t.regions) for (const tk of r.takes || []) ids.push([tk.audio, true]);
      for (const [id, warp] of ids) { const rec = S.buffers[id]; if (rec) PL.keyOf(warp && rec.bpm ? S.dsp.warped(rec, proj.bpm) : rec.buf); }
      for (const k in t.pads || {}) { const rec = S.buffers[t.pads[k].audio]; if (rec) PL.keyOf(rec.buf); }
      if (t.type === 'drums') S.DRUMS.forEach((d) => PL.drumBuf(d.p));
      if (t.inst && t.inst.sample && S.buffers[t.inst.sample.audio]) PL.keyOf(S.buffers[t.inst.sample.audio].buf);
    }
  };
  // Start a sample on a native track: live it goes to the shell with its delay, offline it joins the mixdown events.
  PL.voice = (plug, o, when, ctx) => {
    const m = { t: plug.tr.id, key: PL.keyOf(o.buf), off: o.off || 0, gain: o.gain == null ? 1 : o.gain, rate: o.rate || 1, att: o.att || 0, rel: o.rel || 0.004, loop: !!o.loop };
    if (o.d != null) m.d = o.d;
    if (plug.sink) plug.sink.push({ ...m, at: when });
    else native().postMessage({ ...m, op: 'auPlay', delay: Math.max(0, when - ctx.currentTime + (ctx.outputLatency || 0)) });
  };
  // Built-in synth notes on a native track: each distinct note is rendered once with the track's oscillators, envelope and
  // filter, kept, and then played as a sample. Notes still rendering during a mixdown are awaited through `plug.pending`.
  const notes = new Map();
  PL.synthNote = (plug, inst, n, when, dur, prev, ctx) => {
    const d = Math.max(0.04, Math.round(dur * 50) / 50), glide = n.g && prev != null ? prev : null;
    const key = JSON.stringify([inst.wave, inst.wave2, inst.detune, inst.attack, inst.release, inst.cutoff, inst.res, n.p, n.c || 0, d, glide]);
    let e = notes.get(key);
    if (!e) {
      const tail = 0.02 + inst.release * 1.2, c = new OfflineAudioContext(2, Math.ceil((d + tail * 2 + 0.15) * 44100), 44100), f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = S.dsp.expMap(150, 16000)(inst.cutoff); f.Q.value = S.dsp.lin(0.5, 14)(inst.res);
      f.connect(c.destination);
      E.synth(c, f, { ...inst, sample: null }, { p: n.p, c: n.c, g: n.g, v: 1 }, 0, d, glide);
      if (notes.size > 600) notes.clear();
      e = c.startRendering();
      notes.set(key, e);
      e.then((b) => { if (notes.get(key) === e) notes.set(key, b); });
    }
    const go = (buf) => PL.voice(plug, { buf, gain: n.v == null ? 0.8 : n.v }, when, ctx);
    if (e instanceof AudioBuffer) return go(e);
    const p = e.then(go);
    if (plug.sink && plug.pending) plug.pending.push(p);
  };
  PL.transport = (playing, beat, delay) => { if (native() && S.proj) native().postMessage({ op: 'auTransport', bpm: S.proj.bpm, playing, beat: beat || 0, delay: delay || 0 }); };
  PL.list = async () => PL._list || (PL._list = (await ask({ op: 'auList' })) || []);
  const mixOf = (proj) => {
    const anySolo = proj.tracks.some((t) => t.solo);
    return proj.tracks.filter(PL.native).map((t) => ({ id: t.id, vol: t.vol, pan: t.pan, mute: !!(t.mute || (anySolo && !t.solo)) }));
  };
  // Load, swap or unload plugins so the shell matches the project. Safe to call after every structural change.
  PL.sync = async () => {
    if (!native() || !S.proj) return;
    if (PL._proj !== S.proj) { PL._proj = S.proj; keys.clear(); native().postMessage({ op: 'auKeep', keys: [] }); }
    const mix = mixOf(S.proj), tracks = S.proj.tracks.filter(PL.native).map((t, i) => ({ ...mix[i], inst: t.plugin ? t.plugin.id : '', state: t.plugin ? t.plugin.state || '' : '', fx: PL.fxList(t).map((f) => ({ id: f.id, state: f.state || '' })) }));
    PL.preload(S.proj);
    const key = JSON.stringify(tracks.map((t) => [t.id, t.inst, t.fx.map((f) => f.id)]));
    if (key === PL._key) return PL.mix();
    PL._key = key;
    const failed = await ask({ op: 'auSync', tracks });
    if (failed && failed.length) S.ui.toast(`Some plugins on this project are not installed on this ${IO.platform === 'windows' ? 'PC' : 'Mac'} and were skipped.`, true);
  };
  PL.mix = () => { if (native() && S.proj) native().postMessage({ op: 'auMix', tracks: mixOf(S.proj), master: S.proj.master.vol }); };
  PL.note = (t, p, v, delay, dur) => native().postMessage({ op: 'auNote', t: t.id, p, v: v == null ? 0.8 : v, delay: Math.max(0, delay), d: dur });
  PL.params = (t, slot) => ask({ op: 'auParams', t: t.id, slot });
  PL.setParam = (t, slot, i, v) => ask({ op: 'auSetParam', t: t.id, slot, i, v });
  PL.allOff = () => { if (native()) native().postMessage({ op: 'auOff' }); };
  PL.show = (t, slot) => native() && native().postMessage({ op: 'auUI', t: t.id, slot, title: (slot < 0 ? t.plugin.name : PL.fxList(t)[slot].name) + ' — ' + t.name });
  // Copy each plugin's current settings into the project so they are saved with it.
  PL.capture = async () => {
    const st = S.proj.tracks.some(PL.native) ? await ask({ op: 'auStates' }) : null;
    if (!st) return;
    for (const t of S.proj.tracks) {
      const s = PL.native(t) && st[t.id];
      if (!s) continue;
      if (t.plugin) t.plugin.state = s.inst || t.plugin.state || '';
      PL.fxList(t).forEach((f, i) => { f.state = (s.fx && s.fx[i]) || f.state || ''; });
    }
  };
  // Add the plugin tracks to an offline mixdown. `events` come from E.render; the shell renders them through the same plugins.
  PL.mixInto = async (buf, events) => {
    if (!native() || !events || !events.length) return buf;
    const b64 = await ask({ op: 'auRender', events, seconds: buf.duration, bpm: S.proj.bpm });
    if (!b64) return buf;
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const f = new Float32Array(bytes.buffer), L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, n = Math.min(L.length, f.length >> 1);
    for (let i = 0; i < n; i++) { L[i] += f[2 * i]; if (R !== L) R[i] += f[2 * i + 1]; else L[i] = (L[i] + f[2 * i + 1]) * 0.5; }
    return buf;
  };
})();
