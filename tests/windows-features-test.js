// Windows self-check for the app's other native features (run by the Windows build workflow): Go live to a local test
// server, Record from another app (the PC's own sound while STRATUM plays), stem separation (when the model is present)
// and saving a share video. The results are written to the file in STRATUM_TEST_OUT.
if (location.host === 'app.stratum') addEventListener('load', () => setTimeout(async () => {
  const out = {}, ask = S.plug.ask, wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: String((e && e.stack) || e) }; } };
  S.ui.toast = () => {};
  await step('live', async () => {
    const r = await ask({ op: 'liveStart', platform: 'custom', url: 'rtmp://127.0.0.1:19350/app', key: 'stratum-test', camera: false, mic: false, remember: true });
    if (!r || r.error) return { start: r };
    S.vis.open({ hideBar: true }); S.vis.applyPreset('Hyperdrive', true); S.ui.act('play');
    await wait(7000);
    const st = await ask({ op: 'liveStatus' });
    S.engine.stop(); S.vis.close();
    await ask({ op: 'liveStop' });
    return { start: r, status: st, savedKey: await ask({ op: 'liveKey', platform: 'custom' }) };
  });
  await step('capture', async () => {
    const apps = await ask({ op: 'capApps' });
    const r = await ask({ op: 'capStart', app: 'system' });
    if (!r || r.error) return { apps: apps && apps.apps.length, start: r };
    S.ui.act('play');
    await wait(3000);
    S.engine.stop();
    const level = await ask({ op: 'capLevel' }), res = await ask({ op: 'capStop' });
    return { apps: apps.apps.map((a) => a.name).slice(0, 8), seconds: level.seconds, name: res.name, bytes: res.b64 ? res.b64.length : 0, error: res.error };
  });
  await step('stems', async () => {
    const ctx = S.engine.ensure(), b = await S.engine.render(S.proj, 'scene', S.proj.scenes[0].id, 8);
    const t0 = Date.now(), parts = await S.io.separate(b);
    const rms = (x) => { const d = x.getChannelData(0); let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return +Math.sqrt(s / d.length).toFixed(4); };
    return { seconds: +b.duration.toFixed(1), took: (Date.now() - t0) / 1000, stems: parts.map(rms) };
  });
  await step('share', async () => {
    const msg = await new Promise((res) => { S.ui.shareDone = (ok, m) => res([ok, m]); S.ui.act('share'); document.querySelector('#shLook').value = 'Hyperdrive'; document.querySelector('#shClip').value = '15'; document.querySelector('[data-act=shareGo][data-target=save]').click(); setTimeout(() => res(['timeout']), 60000); });
    return { msg };
  });
  window.chrome.webview.postMessage({ op: 'testResult', text: JSON.stringify(out) });
}, 2500));
