// Share without the Mac app (Windows, phones, tablets, browsers): the same STRATUM-branded video, drawn on a canvas and
// recorded in real time with the mixdown as its soundtrack, then handed to the system share sheet or saved.
(function () {
  const S = window.S, IO = S.io, E = S.engine;
  const BG = '#0f1016', CREAM = '#ede9e0', AMBER = '#e39a12', LINK = 'github.com/Irlewis91/stratum';
  const SHAPES = { ig_post: [1080, 1350, '4x5'], facebook: [1080, 1350, '4x5'], threads: [1080, 1350, '4x5'], x: [1080, 1080, '1x1'] };
  const PAGES = { tiktok: 'https://www.tiktok.com/upload', ig_reel: 'https://www.instagram.com/', ig_post: 'https://www.instagram.com/', ig_story: 'https://www.instagram.com/',
    facebook: 'https://www.facebook.com/', youtube: 'https://studio.youtube.com/', x: 'https://x.com/compose/post', threads: 'https://www.threads.com/' };
  // Videos are made at half resolution (540 wide) so phones can record them smoothly; platforms scale them up cleanly.
  const HALF = 0.5;
  let mark = null;
  const loadMark = () => mark || (mark = new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'brand-wordmark.webp'; }));
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function wrap(g, text, maxW, lines) {
    const words = text.split(/\s+/), out = [];
    let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
    if (line) out.push(line);
    if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].replace(/.{0,2}$/, '…'); }
    return out;
  }

  // Same layout as the Mac app: the 9:16 design scaled by k, heights as fractions of the frame (measured from the top here).
  function base(title, artist, W, H, img) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), k = Math.min(W / 1080, H / 1920), top = (f) => H * (1 - f);
    g.fillStyle = BG; g.fillRect(0, 0, W, H);
    if (img) { const w = 620 * k, h = (w * img.height) / img.width; g.drawImage(img, (W - w) / 2, H * 0.12, w, h); }
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.font = `700 ${84 * k}px -apple-system, "Segoe UI", system-ui, sans-serif`; g.fillStyle = CREAM;
    wrap(g, title || 'Untitled', W - 180 * k, 2).forEach((l, i) => g.fillText(l, W / 2, top(1180 / 1920) - 210 * k + 10 * k + i * 96 * k));
    if (artist) { g.font = `500 ${46 * k}px -apple-system, "Segoe UI", system-ui, sans-serif`; g.fillStyle = AMBER; g.fillText(artist, W / 2, top(1110 / 1920) - 64 * k); }
    g.font = `600 ${30 * k}px -apple-system, "Segoe UI", system-ui, sans-serif`; g.fillStyle = AMBER;
    if ('letterSpacing' in g) g.letterSpacing = `${6 * k}px`;
    g.fillText('MADE WITH STRATUM', W / 2, top(200 / 1920) - 44 * k);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    g.font = `400 ${30 * k}px -apple-system, "Segoe UI", system-ui, sans-serif`; g.fillStyle = 'rgba(237,233,224,0.65)'; g.fillText(LINK, W / 2, top(150 / 1920) - 44 * k);
    return c;
  }

  function frame(g, bg, peaks, progress, time, W, H) {
    g.drawImage(bg, 0, 0);
    const k = Math.min(W / 1080, H / 1920), margin = Math.max(90 * k, 0.083 * W), n = Math.max(1, peaks.length), span = W - 2 * margin;
    const mid = H - (H * 760) / 1920, maxH = 300 * k, slot = span / n, bar = Math.max(2, slot * 0.62);
    peaks.forEach((p, i) => {
      const h = Math.max(6 * k, Math.min(1, Math.max(0, p)) * maxH), x = margin + i * slot + (slot - bar) / 2;
      g.fillStyle = (i + 0.5) / n <= progress ? AMBER : 'rgba(237,233,224,0.28)';
      g.beginPath(); if (g.roundRect) g.roundRect(x, mid - h / 2, bar, h, bar / 2); else g.rect(x, mid - h / 2, bar, h); g.fill();
    });
    const px = margin + span * Math.min(1, Math.max(0, progress));
    g.fillStyle = CREAM; g.fillRect(px - 2 * k, mid - maxH / 2 - 30 * k, 4 * k, maxH + 60 * k);
    g.font = `500 ${34 * k}px ui-monospace, Menlo, Consolas, monospace`; g.fillStyle = 'rgba(237,233,224,0.8)'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(time, W / 2, mid + maxH / 2 + 110 * k);
  }

  const pickType = () => ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';

  /** Records the branded video in real time. Resolves to { video: File|null, audio: File }. */
  IO.webShareRender = async (target, title, artist, buf, peaks, progress) => {
    const [W0, H0, label] = SHAPES[target] || [1080, 1920, '9x16'], W = Math.round(W0 * HALF), H = Math.round(H0 * HALF);
    const safe = (title || 'Untitled').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Untitled';
    const audio = new File([IO.wav(buf)], `${safe}.wav`, { type: 'audio/wav' });
    const type = pickType();
    const cv = document.createElement('canvas');
    if (!type || !cv.captureStream) return { video: null, audio };
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d'), bg = base(title, artist, W, H, await loadMark());
    frame(g, bg, peaks, 0, clock(0), W, H);
    const ctx = E.ensure(), dest = ctx.createMediaStreamDestination(), src = ctx.createBufferSource();
    src.buffer = buf; src.connect(dest);
    const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 160_000 }), parts = [];
    rec.ondataavailable = (e) => e.data && e.data.size && parts.push(e.data);
    const done = new Promise((res) => (rec.onstop = res));
    rec.start(1000);
    const t0 = ctx.currentTime + 0.05, dur = buf.duration;
    src.start(t0);
    await new Promise((res) => {
      const tick = () => {
        const t = Math.max(0, ctx.currentTime - t0), p = Math.min(1, t / dur);
        frame(g, bg, peaks, p, clock(t), W, H);
        if (progress) progress(p);
        if (t >= dur + 0.2) return res();
        setTimeout(tick, 1000 / 30);   // a timer, not animation frames, so it keeps going when the window is covered
      };
      tick();
    });
    rec.stop(); await done;
    try { src.disconnect(); } catch (e) {}
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    return { video: new File(parts, `${safe} ${label}.${ext}`, { type: type.split(';')[0] }), audio };
  };

  IO.webSharePage = (target) => PAGES[target];
})();
