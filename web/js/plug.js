// STRATUM plugin bridge: Audio Unit instruments and effects hosted by the Mac shell.
// A track with `plugin: {id, name, maker, state, fx: [{id, name, state}]}` sends its notes to the shell instead of the built-in sounds.
(function () {
  const S = window.S, E = S.engine, IO = S.io, PL = (S.plug = {});
  const native = () => IO.native();
  const waits = {};
  let seq = 0;
  const ask = (msg) => new Promise((res) => { if (!native()) return res(null); const id = ++seq; waits[id] = res; native().postMessage({ ...msg, req: id }); });
  PL.cb = (id, v) => { const f = waits[id]; delete waits[id]; if (f) f(v); };
  PL.available = () => !!native();
  PL.on = (t) => !!(t && t.plugin && t.type !== 'audio' && native());
  PL.list = async () => PL._list || (PL._list = (await ask({ op: 'auList' })) || []);
  const mixOf = (proj) => {
    const anySolo = proj.tracks.some((t) => t.solo);
    return proj.tracks.filter(PL.on).map((t) => ({ id: t.id, vol: t.vol, pan: t.pan, mute: !!(t.mute || (anySolo && !t.solo)) }));
  };
  // Load, swap or unload plugins so the shell matches the project. Safe to call after every structural change.
  PL.sync = async () => {
    if (!native() || !S.proj) return;
    const mix = mixOf(S.proj), tracks = S.proj.tracks.filter(PL.on).map((t, i) => ({ ...mix[i], inst: t.plugin.id, state: t.plugin.state || '', fx: (t.plugin.fx || []).map((f) => ({ id: f.id, state: f.state || '' })) }));
    const key = JSON.stringify(tracks.map((t) => [t.id, t.inst, t.fx.map((f) => f.id)]));
    if (key === PL._key) return PL.mix();
    PL._key = key;
    const failed = await ask({ op: 'auSync', tracks });
    if (failed && failed.length) S.ui.toast('Some plugins on this project are not installed on this Mac and were skipped.', true);
  };
  PL.mix = () => { if (native() && S.proj) native().postMessage({ op: 'auMix', tracks: mixOf(S.proj), master: S.proj.master.vol }); };
  PL.note = (t, p, v, delay, dur) => native().postMessage({ op: 'auNote', t: t.id, p, v: v == null ? 0.8 : v, delay: Math.max(0, delay), d: dur });
  PL.allOff = () => { if (native()) native().postMessage({ op: 'auOff' }); };
  PL.show = (t, slot) => native() && native().postMessage({ op: 'auUI', t: t.id, slot, title: (slot < 0 ? t.plugin.name : t.plugin.fx[slot].name) + ' — ' + t.name });
  // Copy each plugin's current settings into the project so they are saved with it.
  PL.capture = async () => {
    const st = S.proj.tracks.some(PL.on) ? await ask({ op: 'auStates' }) : null;
    if (!st) return;
    for (const t of S.proj.tracks) {
      const s = PL.on(t) && st[t.id];
      if (!s) continue;
      t.plugin.state = s.inst || t.plugin.state || '';
      (t.plugin.fx || []).forEach((f, i) => { f.state = (s.fx && s.fx[i]) || f.state || ''; });
    }
  };
  // Add the plugin tracks to an offline mixdown. `events` come from E.render; the shell renders them through the same plugins.
  PL.mixInto = async (buf, events) => {
    if (!native() || !events || !events.length) return buf;
    const b64 = await ask({ op: 'auRender', events, seconds: buf.duration });
    if (!b64) return buf;
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const f = new Float32Array(bytes.buffer), L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, n = Math.min(L.length, f.length >> 1);
    for (let i = 0; i < n; i++) { L[i] += f[2 * i]; if (R !== L) R[i] += f[2 * i + 1]; else L[i] = (L[i] + f[2 * i + 1]) * 0.5; }
    return buf;
  };
})();
