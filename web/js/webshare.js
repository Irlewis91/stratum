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
  const loadMark = () => mark || (mark = new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = window.STRATUM_WORDMARK || 'brand-wordmark.webp'; }));
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

  // Browsers record MP4 in fragments and leave its length at zero, which some apps and sites read as hours long. This
  // writes the real length into the file (and adds the "fragment duration" box), without touching the video itself.
  IO.fixMp4 = (u8, seconds) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), tag = (o) => String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
    const kids = (start, end) => { const out = []; for (let o = start; o + 8 <= end;) { let size = dv.getUint32(o); if (size === 0) size = end - o; if (size < 8) break; out.push({ o, size, t: tag(o) }); o += size; } return out; };
    const top = kids(0, u8.length), moov = top.find((b) => b.t === 'moov');
    if (!moov || !top.some((b) => b.t === 'moof')) return u8;
    const mk = kids(moov.o + 8, moov.o + moov.size), mvhd = mk.find((b) => b.t === 'mvhd'); if (!mvhd) return u8;
    const v1 = (b) => u8[b.o + 8] === 1, setDur = (b, at0, at1, val) => (v1(b) ? (dv.setUint32(b.o + at1, Math.floor(val / 2 ** 32)), dv.setUint32(b.o + at1 + 4, val >>> 0)) : dv.setUint32(b.o + at0, val));
    // In this format the header's own lengths cover only samples stored in the header (none), so they must be 0, not
    // "unknown" (all ones, which some players add as ~83 days); the real total goes in the fragment-duration box.
    const movTs = dv.getUint32(mvhd.o + (v1(mvhd) ? 28 : 20)), movDur = Math.round(seconds * movTs);
    setDur(mvhd, 24, 32, 0);
    for (const trak of mk.filter((b) => b.t === 'trak')) {
      const tk = kids(trak.o + 8, trak.o + trak.size), tkhd = tk.find((b) => b.t === 'tkhd'), mdia = tk.find((b) => b.t === 'mdia');
      if (tkhd) setDur(tkhd, 28, 36, 0);
      const mdhd = mdia && kids(mdia.o + 8, mdia.o + mdia.size).find((b) => b.t === 'mdhd');
      if (mdhd) setDur(mdhd, 24, 32, 0);
    }
    const mvex = mk.find((b) => b.t === 'mvex');
    if (!mvex || kids(mvex.o + 8, mvex.o + mvex.size).some((b) => b.t === 'mehd')) return u8;
    // Fragments here point at their data relative to themselves, so the 16 new bytes don't move anything they refer to.
    const tfhd = (() => { for (let i = moov.o + moov.size; i < u8.length - 8; i++) if (u8[i] === 0x74 && u8[i + 1] === 0x66 && u8[i + 2] === 0x68 && u8[i + 3] === 0x64) return i - 4; return -1; })();
    if (tfhd < 0 || dv.getUint32(tfhd + 8) & 1) return u8;
    const mehd = new Uint8Array(16), mv = new DataView(mehd.buffer);
    mv.setUint32(0, 16); mehd.set([0x6d, 0x65, 0x68, 0x64], 4); mv.setUint32(12, movDur);
    const out = new Uint8Array(u8.length + 16);
    out.set(u8.subarray(0, mvex.o + 8)); out.set(mehd, mvex.o + 8); out.set(u8.subarray(mvex.o + 8), mvex.o + 24);
    const od = new DataView(out.buffer); od.setUint32(moov.o, moov.size + 16); od.setUint32(mvex.o, mvex.size + 16);
    return out;
  };

  const pickType = () => ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';

  /** Records the branded video in real time. Resolves to { video: File|null, audio: File }. */
  // A video made from STRATUM Visuals: the visual fills the frame, with the title and STRATUM branding over it.
  function brandOver(g, W, H, title, artist, img) {
    const k = Math.min(W / 1080, H / 1920), grad = g.createLinearGradient(0, H * 0.62, 0, H);
    grad.addColorStop(0, 'rgba(15,16,22,0)'); grad.addColorStop(1, 'rgba(15,16,22,0.85)'); g.fillStyle = grad; g.fillRect(0, H * 0.62, W, H * 0.38);
    if (img) { const w = 380 * k, h = (w * img.height) / img.width; g.globalAlpha = 0.9; g.drawImage(img, (W - w) / 2, H * 0.05, w, h); g.globalAlpha = 1; }
    g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 12 * k;
    g.font = `700 ${78 * k}px -apple-system, "Segoe UI", system-ui, sans-serif`; g.fillStyle = CREAM;
    wrap(g, title || 'Untitled', W - 160 * k, 2).forEach((l, i, a) => g.fillText(l, W / 2, H - 300 * k - (a.length - 1 - i) * 90 * k));
    if (artist) { g.font = `500 ${44 * k}px -apple-system, "Segoe UI", system-ui, sans-serif`; g.fillStyle = AMBER; g.fillText(artist, W / 2, H - 230 * k); }
    g.font = `600 ${28 * k}px -apple-system, "Segoe UI", system-ui, sans-serif`; g.fillStyle = AMBER; g.fillText('MADE WITH STRATUM', W / 2, H - 140 * k);
    g.font = `400 ${28 * k}px -apple-system, "Segoe UI", system-ui, sans-serif`; g.fillStyle = 'rgba(237,233,224,0.75)'; g.fillText(LINK, W / 2, H - 95 * k);
    g.shadowBlur = 0;
  }

  IO.webShareRender = async (target, title, artist, buf, peaks, progress, look) => {
    const [W0, H0, label] = SHAPES[target] || [1080, 1920, '9x16'], W = Math.round(W0 * HALF), H = Math.round(H0 * HALF);
    const safe = (title || 'Untitled').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Untitled';
    const audio = new File([IO.wav(buf)], `${safe}.wav`, { type: 'audio/wav' });
    const type = pickType();
    const cv = document.createElement('canvas');
    if (!type || !cv.captureStream) return { video: null, audio };
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d'), mark0 = await loadMark(), bg = base(title, artist, W, H, mark0);
    frame(g, bg, peaks, 0, clock(0), W, H);
    const ctx = E.ensure(), dest = ctx.createMediaStreamDestination(), src = ctx.createBufferSource();
    src.buffer = buf; src.connect(dest);
    // Visuals look: a hidden STRATUM Visuals renderer listening to the same audio.
    let vis = null;
    if (look && look !== 'classic' && S.vis) {
      const vc = document.createElement('canvas'); vc.width = W; vc.height = H;
      const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const P = look === 'current' && S.proj.visuals ? S.proj.visuals.tiles[0] : S.vis.FACTORY[look] || Object.values(S.vis.FACTORY)[0];
      vis = { r: new S.vis.Renderer(vc), a: new S.vis.Analyzer(an), tiles: [{ P: JSON.parse(JSON.stringify(P)), st: {} }], cv: vc, last: 0 };
      const im = S.proj.visuals && S.proj.visuals.image;
      if (im) await new Promise((res) => { const i = new Image(); i.onload = () => { vis.r.setImage(i); res(); }; i.onerror = res; i.src = im; });
    }
    const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 160_000 }), parts = [];
    rec.ondataavailable = (e) => e.data && e.data.size && parts.push(e.data);
    const done = new Promise((res) => (rec.onstop = res));
    rec.start();
    const t0 = ctx.currentTime + 0.05, dur = buf.duration;
    src.start(t0);
    await new Promise((res) => {
      const tick = () => {
        const t = Math.max(0, ctx.currentTime - t0), p = Math.min(1, t / dur);
        if (vis) {
          vis.a.read(ctx.currentTime, 1, (t * (S.proj.bpm || 120)) / 60);
          vis.r.render(vis.a, vis.tiles, [1, 1], {}, Math.max(0.001, t - vis.last)); vis.last = t;
          g.drawImage(vis.cv, 0, 0, W, H); brandOver(g, W, H, title, artist, mark0);
        } else frame(g, bg, peaks, p, clock(t), W, H);
        if (progress) progress(p);
        if (t >= dur + 0.2) return res();
        setTimeout(tick, 1000 / 30);   // a timer, not animation frames, so it keeps going when the window is covered
      };
      tick();
    });
    rec.stop(); await done;
    try { src.disconnect(); } catch (e) {}
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    let blob = new Blob(parts);
    if (ext === 'mp4') { try { blob = new Blob([IO.fixMp4(new Uint8Array(await blob.arrayBuffer()), dur)]); } catch (e) {} }
    return { video: new File([blob], `${safe} ${label}.${ext}`, { type: type.split(';')[0] }), audio };
  };

  IO.webSharePage = (target) => PAGES[target];
})();
