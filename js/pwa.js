// The web app on phones, tablets and computers: works offline once opened, and can be installed to the home screen.
(function () {
  const S = window.S, IO = S.io, U = S.ui;
  if (IO.platform !== 'web' || !/^https?:$/.test(location.protocol)) return;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const btn = document.getElementById('installBtn');
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let prompt = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); prompt = e; if (btn) btn.hidden = false; });
  addEventListener('appinstalled', () => { if (btn) btn.hidden = true; U.toast('STRATUM is installed. Open it from your home screen or apps.'); });
  if (btn && ios && !standalone) btn.hidden = false;
  S.ui.install = async () => {
    if (prompt) { prompt.prompt(); const r = await prompt.userChoice; prompt = null; if (r.outcome === 'accepted' && btn) btn.hidden = true; return; }
    U.showPop(`<h3>Install STRATUM</h3>` + (ios
      ? `<ol><li>Tap the <b>Share</b> button in Safari (the square with an arrow).</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol><p class="hint">STRATUM then opens full screen from its icon and works offline. On iPhone, turn the ringer switch on (or the volume up) — iOS mutes web audio while the phone is on silent.</p>`
      : `<p>Open your browser's menu and choose <b>Install app</b> or <b>Add to Home screen</b>.</p>`) + `<button data-act="closePop">OK</button>`);
  };
})();
