// Windows self-check for the native engine (run by the Windows build workflow, with the test plugins on STRATUM_VST3_PATH):
// the plugin list, STRATUM Wave, a VST3 instrument and effect, VST2 instrument and effect, an Airwindows effect, Tune,
// plugin controls and saved settings, and live playback. The results are written to the file in STRATUM_TEST_OUT.
if (location.host === 'app.stratum') addEventListener('load', () => setTimeout(async () => {
  const done = (r) => { window.chrome.webview.postMessage({ op: 'testResult', text: JSON.stringify(r) }); document.title = 'ENGINETEST done'; };
  const out = {};
  try {
    S.ui.toast = () => {};
    const ctx = S.engine.ensure(), list = await S.plug.list();
    const find = (kind, re) => list.find((p) => p.kind === kind && p.id.startsWith('vst3') && re.test(p.name));
    out.catalogue = { total: list.length, airwindows: list.filter((p) => p.id.startsWith('aw|')).length, vst: list.filter((p) => p.id.startsWith('vst3')).map((p) => p.name) };
    const rms = (d, a, b) => { let s = 0; for (let i = Math.floor(a * 44100); i < b * 44100 && i < d.length; i++) s += d[i] * d[i]; return +Math.sqrt(s / ((b - a) * 44100)).toFixed(4); };
    const zc = (d, a, b) => { let z = 0; for (let i = Math.floor(a * 44100) + 1; i < b * 44100 && i < d.length; i++) if (d[i - 1] <= 0 && d[i] > 0) z++; return Math.round(z / (b - a)); };
    // One synth track playing an A (440 Hz) for 2 beats, through `inst` (or the built-in synth) and `fx`.
    const trial = async (inst, fx) => {
      const p = S.blankProject(); p.bpm = 120; if (!p.scenes.length) S.newScene(p, 'A', 1);
      const t = S.newTrack(p, 'synth', 'Test'); t.vol = 1;
      if (inst) t.plugin = { id: inst.id, name: inst.name, maker: inst.maker, state: '', fx: fx ? [{ id: fx.id, name: fx.name, state: '' }] : [] };
      else if (fx) t.pfx = [{ id: fx.id, name: fx.name, state: '' }];
      t.regions.push({ id: S.uid(), start: 0, len: 4, off: 0, clip: { bars: 1, notes: [{ t: 0, d: 2, p: 69, v: 1 }] } });
      S.ui.imported({ proj: p, report: '' }); S.engine.rebuild();
      await new Promise((r) => setTimeout(r, 1500));
      const b = await S.engine.render(S.proj, 'song', S.proj.scenes[0].id, 4);
      await S.plug.mixInto(b, S.engine.plugEvents);
      const d = b.getChannelData(0);
      return { held: rms(d, 0.2, 0.8), after: rms(d, 1.6, 1.9), hz: zc(d, 0.2, 0.8) };
    };
    const wave = list.find((p) => p.id === 'stratum|wave'), tune = list.find((p) => p.id === 'stratum|tune');
    out.wave = await trial(wave);
    const T = S.proj.tracks[0];
    out.wavePresets = (await S.plug.ask({ op: 'auWavePresets' })).length;
    out.waveControls = (await S.plug.params(T, -1)).length;
    // Live: a note through the Windows audio output (or the silent stand-in when the machine has no sound device).
    S.engine.audition(T, 69, 1);
    await new Promise((r) => setTimeout(r, 700));
    out.live = await S.plug.ask({ op: 'auDebug' });
    const v3i = find('inst', /jx10|dx10|piano/i), v3f = find('fx', /delay|overdrive/i), v2i = find('inst', /testtone/i), v2f = find('fx', /testgain/i);
    if (v3i) out.vst3inst = { name: v3i.name, ...(await trial(v3i)) };
    if (v3i && v3f) out.vst3fx = { name: v3f.name, ...(await trial(v3i, v3f)) };
    if (v2i) out.vst2inst = { name: v2i.name, ...(await trial(v2i)) };
    if (v2i && v2f) {
      out.vst2fx = { name: v2f.name, ...(await trial(v2i, v2f)) };
      const c = await S.plug.params(S.proj.tracks[0], 0);
      out.vst2controls = c.map((x) => x.name + '=' + x.text);
      out.vst2set = await S.plug.setParam(S.proj.tracks[0], 0, c[0].i, 1);
      const b = await S.engine.render(S.proj, 'song', S.proj.scenes[0].id, 4); await S.plug.mixInto(b, S.engine.plugEvents);
      out.vst2fxAtFull = rms(b.getChannelData(0), 0.2, 0.8);
      await S.plug.capture();
      out.states = { inst: S.proj.tracks[0].plugin.state.slice(0, 3), fx: S.proj.tracks[0].plugin.fx[0].state.slice(0, 3) };
    }
    const aw = list.find((p) => p.id === 'aw|Galactic') || list.find((p) => p.id.startsWith('aw|'));
    out.airwindows = { name: aw && aw.name, ...(await trial(null, aw)) };
    out.airwindowsControls = (await S.plug.params(S.proj.tracks[0], 0)).length;
    out.tune = { ...(await trial(wave, tune)), controls: (await S.plug.params(S.proj.tracks[0], 0)).length };
    if (v3i) { out.vst3controls = (await trial(v3i)) && (await S.plug.params(S.proj.tracks[0], -1)).length; }
  } catch (e) { out.error = String((e && e.stack) || e); }
  done(out);
}, 2500));
