// STRATUM motion ad: 30 seconds, 1080x1920, drawn frame by frame inside STRATUM and encoded by its own video maker.
// Run with: STRATUM --js-test ad/build/ad-run.js (made by ad/make.py, which embeds the screenshots).
const IMG = window.AD_IMAGES, W = 1080, H = 1920, BPM = S.proj.bpm, SPB = 60 / BPM, BAR = SPB * 4, DROP = BAR * 4;
const CTA = window.AD_CTA || 'discord.gg/PtpChEj8Gc';
const INK = '#07080d', CREAM = '#f2ede2', AMBER = '#ffa62b', EMBER = '#ff6a3d', TEAL = '#5ce1c6', DIM = 'rgba(242,237,226,.6)';
const FONT = (w, s) => `${w} ${s}px -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif`;
const clamp = (x) => Math.max(0, Math.min(1, x)), prog = (t, a, d) => clamp((t - a) / d);
const eo = (x) => 1 - Math.pow(1 - clamp(x), 3), eio = (x) => (x = clamp(x), x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const back = (x) => { x = clamp(x); const c = 1.70158; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };

// ---- soundtrack: the demo song (made in STRATUM), then its groove again, 30 seconds with a fade
const proj = S.proj, groove = proj.scenes[1] || proj.scenes[0];
const a1 = await E.render(proj, 'song', proj.scenes[0].id, 48), a2 = await E.render(proj, 'scene', groove.id, 8);
const SR = a1.sampleRate, N = Math.round(30 * SR), buf = E.ensure().createBuffer(2, N, SR);
for (let c = 0; c < 2; c++) {
  const o = buf.getChannelData(c), x = a1.getChannelData(Math.min(c, a1.numberOfChannels - 1)), y = a2.getChannelData(Math.min(c, a2.numberOfChannels - 1));
  const n1 = Math.min(x.length, Math.round(48 * SPB * SR));
  o.set(x.subarray(0, n1));
  // the scene render starts again from its top, so carry on seamlessly
  for (let i = n1, k = 0; i < N; i++, k++) o[i] = k < y.length ? y[k] : 0;
  const fade = Math.round(1.6 * SR);
  for (let i = N - fade; i < N; i++) o[i] *= (N - i) / fade;
}
// mix level: bring the demo up to a healthy loudness
let pk = 0; for (let c = 0; c < 2; c++) for (const v of buf.getChannelData(c)) pk = Math.max(pk, Math.abs(v));
const gain = pk > 0 ? Math.min(4, 0.89 / pk) : 1; for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= gain; }
const env = []; { const L = buf.getChannelData(0), step = Math.round(SR / 60); for (let i = 0; i < L.length; i += step) { let m = 0; for (let k = i; k < Math.min(L.length, i + step); k++) m = Math.max(m, Math.abs(L[k])); env.push(m); } }

// ---- images
const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image ' + src.slice(0, 30))); i.src = src; });
const im = {}; for (const k in IMG) im[k] = await load(IMG[k]);
const mark = await load(window.STRATUM_WORDMARK);

// ---- analysis and Visuals
const an = new IO.BufferAnalyser(buf), spec = new Uint8Array(512);
const vcv = document.createElement('canvas'); vcv.width = W; vcv.height = H;
const vr = new S.vis.Renderer(vcv), va = new S.vis.Analyzer(an);
const look = (name) => [{ P: JSON.parse(JSON.stringify(S.vis.FACTORY[name])), st: {} }];
const LOOK_F = look('Prism'), LOOK_G = look('Hyperdrive'), LOOK_H = look('Liquid Glow');

// ---- drawing helpers
function text(g, s, x, y, size, o = {}) {
  g.save(); g.globalAlpha = o.a == null ? 1 : o.a; g.font = FONT(o.w || 800, size); g.fillStyle = o.c || CREAM; g.textAlign = o.align || 'center'; g.textBaseline = 'alphabetic';
  if ('letterSpacing' in g && o.ls) g.letterSpacing = o.ls + 'px';
  if (o.glow) { g.shadowColor = o.glow; g.shadowBlur = 40; }
  g.fillText(s, x, y); g.restore();
}
function rr(g, x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); }
function cover(g, img, x, y, w, h, fx = 0.5, fy = 0.5, zoom = 1) {
  const s = Math.max(w / img.width, h / img.height) * zoom, iw = img.width * s, ih = img.height * s;
  g.drawImage(img, x + (w - iw) * fx, y + (h - ih) * fy, iw, ih);
}
function frameShot(g, img, x, y, w, h, r, o = {}) {
  g.save(); g.globalAlpha = o.a == null ? 1 : o.a;
  g.shadowColor = o.glow || 'rgba(255,138,61,.45)'; g.shadowBlur = 70; g.fillStyle = '#000'; rr(g, x, y, w, h, r); g.fill(); g.shadowBlur = 0;
  rr(g, x, y, w, h, r); g.clip(); cover(g, img, x, y, w, h, o.fx == null ? 0.5 : o.fx, o.fy == null ? 0.5 : o.fy, o.zoom || 1);
  g.restore();
  g.save(); g.globalAlpha = (o.a == null ? 1 : o.a) * 0.9; g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 3; rr(g, x, y, w, h, r); g.stroke(); g.restore();
}
function bg(g, t, hue = 0) {
  g.fillStyle = INK; g.fillRect(0, 0, W, H);
  const lvl = va.f.level || 0, gx = W * (0.5 + 0.25 * Math.sin(t * 0.4)), gy = H * (0.3 + 0.1 * Math.cos(t * 0.3));
  let gr = g.createRadialGradient(gx, gy, 0, gx, gy, 1100); gr.addColorStop(0, `rgba(255,${120 + hue},50,${0.20 + lvl * 0.25})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  gr = g.createRadialGradient(W * 0.1, H * 0.95, 0, W * 0.1, H * 0.95, 900); gr.addColorStop(0, 'rgba(92,225,198,.10)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
}
// thin spectrum along the bottom, the beat made visible
function eq(g, y, h, a = 1, n = 48) {
  an.getByteFrequencyData(spec); g.save(); g.globalAlpha = a;
  const bw = W / n;
  for (let i = 0; i < n; i++) {
    const bin = Math.floor(2 + Math.pow(i / n, 1.7) * 180), v = spec[bin] / 255, hh = Math.max(4, v * v * h);
    const gr = g.createLinearGradient(0, y - hh, 0, y); gr.addColorStop(0, AMBER); gr.addColorStop(1, EMBER);
    g.fillStyle = gr; rr(g, i * bw + bw * 0.2, y - hh, bw * 0.6, hh, bw * 0.3); g.fill();
  }
  g.restore();
}
function chip(g, label, sub, x, y, w, a, c) {
  g.save(); g.globalAlpha = a; g.fillStyle = 'rgba(25,29,41,.92)'; rr(g, x, y, w, 132, 66); g.fill();
  g.strokeStyle = c; g.lineWidth = 3; rr(g, x, y, w, 132, 66); g.stroke();
  g.fillStyle = c; g.beginPath(); g.arc(x + 66, y + 66, 22, 0, 7); g.fill();
  g.font = FONT(700, 46); g.fillStyle = CREAM; g.textAlign = 'left'; g.fillText(label, x + 112, y + 62);
  g.font = FONT(500, 32); g.fillStyle = DIM; g.fillText(sub, x + 112, y + 104);
  g.restore();
}
function flash(g, t, at, d = 0.35) { const k = prog(t, at, d); if (k > 0 && k < 1) { g.fillStyle = `rgba(255,240,220,${(1 - k) * 0.85})`; g.fillRect(0, 0, W, H); } }

// ---- the scenes
function sceneA(g, t) {           // 0 - 4.29: the problem
  bg(g, t, -40);
  const lines = [['Your studio', 0.25], ['lives on', 0.25 + SPB], ['one computer.', 0.25 + SPB * 2]];
  lines.forEach(([s, at], i) => { const k = eo(prog(t, at, 0.45)); text(g, s, W / 2, 760 + i * 150 - (1 - k) * 60, 120, { a: k }); });
  // strike through "one computer."
  const sk = eio(prog(t, 2.2, 0.45));
  if (sk > 0) { g.save(); g.strokeStyle = EMBER; g.lineWidth = 14; g.lineCap = 'round'; g.beginPath(); g.moveTo(180, 1016); g.lineTo(180 + 720 * sk, 1016); g.stroke(); g.restore(); }
  const k2 = back(prog(t, 2.95, 0.5));
  text(g, 'Your music doesn’t.', W / 2, 1300, 96 * (0.6 + 0.4 * k2), { a: clamp(k2), c: AMBER, glow: 'rgba(255,140,40,.6)' });
  eq(g, H - 80, 140, 0.8);
}
function sceneB(g, t) {           // 4.29 - 8.57: every device
  const t0 = BAR * 2, u = t - t0; bg(g, t, -20);
  text(g, 'One studio.', W / 2, 270, 104, { a: eo(prog(u, 0, 0.4)) });
  text(g, 'Every device.', W / 2, 390, 104, { a: eo(prog(u, 0.3, 0.4)), c: AMBER });
  const words = ['Mac', 'Windows', 'iPhone', 'iPad', 'Android', 'Browser'];
  g.save(); g.font = FONT(700, 40); const gap = 34, ws = words.map((w) => g.measureText(w).width), total = ws.reduce((x, y) => x + y, 0) + gap * 5; g.restore();
  let wx = (W - total) / 2;
  words.forEach((w, i) => { const k = back(prog(u, 0.6 + i * SPB * 0.5, 0.3)); text(g, w, wx + ws[i] / 2, 490 - (1 - clamp(k)) * 20, 40, { a: clamp(k), w: 700, c: i % 2 ? CREAM : AMBER }); wx += ws[i] + gap; });
  // laptop
  const lk = eo(prog(u, 0.2, 0.6)), lx = 70, ly = 590 + (1 - lk) * 120, lw = 940, lh = 588;
  frameShot(g, im.strata, lx, ly, lw, lh, 22, { a: lk });
  g.save(); g.globalAlpha = lk; g.fillStyle = '#2a2e3d'; rr(g, lx - 40, ly + lh + 6, lw + 80, 26, 13); g.fill(); g.restore();
  // tablet
  const tk = back(prog(u, 0.9, 0.55)), tx = 110, ty = 1270 + (1 - clamp(tk)) * 600, tw = 520, th = 560;
  g.save(); g.globalAlpha = clamp(tk); g.fillStyle = '#1e2130'; rr(g, tx - 16, ty - 16, tw + 32, th + 32, 40); g.fill(); g.restore();
  frameShot(g, im.session, tx, ty, tw, th, 28, { a: clamp(tk), fx: 0.1, fy: 0.25, zoom: 1.3 });
  // phone
  const pk = back(prog(u, 1.3, 0.55)), px = 690, py = 1240 + (1 - clamp(pk)) * 600, pw = 290, ph = 560;
  g.save(); g.globalAlpha = clamp(pk); g.fillStyle = '#1e2130'; rr(g, px - 14, py - 14, pw + 28, ph + 28, 50); g.fill(); g.restore();
  frameShot(g, im.pattern, px, py, pw, ph, 40, { a: clamp(pk), fx: 0.05, fy: 0.25, zoom: 1.6 });
}
function sceneC(g, t) {           // 8.57 - 9.64: the drop, the name
  const u = t - DROP; bg(g, t, 10);
  const k = back(prog(u, 0, 0.35)), s = 2.2 - 1.2 * clamp(k);
  // shockwave rings on the beat
  for (let r = 0; r < 3; r++) { const rk = prog(u, r * SPB * 0.5, 0.9); if (rk > 0 && rk < 1) { g.save(); g.strokeStyle = `rgba(255,166,43,${(1 - rk) * 0.7})`; g.lineWidth = 10 * (1 - rk) + 2; g.beginPath(); g.arc(W / 2, H / 2, 120 + rk * 900, 0, 7); g.stroke(); g.restore(); } }
  const mw = 860 * s, mh = (mw * mark.height) / mark.width;
  g.save(); g.globalAlpha = clamp(k * 1.5); g.shadowColor = 'rgba(255,150,40,.7)'; g.shadowBlur = 60; g.drawImage(mark, (W - mw) / 2, H / 2 - mh / 2, mw, mh); g.restore();
  text(g, 'The studio that goes where you go.', W / 2, H / 2 + 230, 50, { a: eo(prog(u, 0.45, 0.4)), w: 600, c: DIM });
  eq(g, H - 80, 220, 1);
  flash(g, t, DROP, 0.4);
}
function sceneD(g, t) {           // 9.64 - 12.86: bring your old projects
  const t0 = DROP + SPB * 2, u = t - t0; bg(g, t, 0);
  text(g, 'Open the projects', W / 2, 270, 92, { a: eo(prog(u, 0, 0.35)) });
  text(g, 'you already made.', W / 2, 380, 92, { a: eo(prog(u, 0.15, 0.35)), c: AMBER });
  const files = [['beat.flp', 'FL Studio', '#ff8c2b'], ['set.als', 'Ableton Live', '#9fa6b8'], ['song.logicx', 'Logic Pro', '#5aa9ff'], ['track.reason', 'Reason', '#e2524f']];
  files.forEach(([f, n, c], i) => {
    const at = 0.25 + i * SPB, k = back(prog(u, at, 0.4)), from = i % 2 ? 1 : -1;
    const settle = eio(prog(u, 2.3, 0.6)), y0 = 520 + i * 160, x = 140 + from * (1 - clamp(k)) * 900, y = y0 - settle * 360 - i * settle * 70;
    chip(g, f, n, x, y, 800, clamp(k) * (1 - settle * 0.85), c);
  });
  const sk = eo(prog(u, 2.25, 0.6));
  frameShot(g, im.arrange, 70, 1180 - (1 - sk) * 400 - sk * 380, 940, 588, 22, { a: sk, glow: 'rgba(90,169,255,.5)' });
  text(g, 'Tracks, notes, tempo, audio and your samples.', W / 2, 1520 - (1 - sk) * 80, 44, { a: sk, w: 600, c: DIM });
  eq(g, H - 80, 140, 0.7);
}
function sceneE(g, t) {           // 12.86 - 17.14: five layouts
  const t0 = DROP + SPB * 8, u = t - t0; bg(g, t, 20);
  const skins = [['pattern', 'Pattern'], ['session', 'Session'], ['arrange', 'Arrange'], ['mixedit', 'Mix / Edit']];
  const i = Math.min(3, Math.floor(u / SPB));
  if (u < SPB * 4) {
    text(g, 'Work the way you think.', W / 2, 270, 82, { a: eo(prog(u, 0, 0.3)) });
    const [k, name] = skins[i], kk = eo(prog(u, i * SPB, 0.18)), zz = 1 + 0.04 * prog(u, i * SPB, SPB);
    frameShot(g, im[k], 40, 560 + (1 - kk) * 30, 1000, 625, 26, { a: 1, zoom: zz });
    frameShot(g, im[k], 40, 1215 + (1 - kk) * 30, 1000, 330, 22, { a: 0.9, fx: 0.2, fy: 0.35, zoom: 2.2 });
    text(g, name, W / 2, 1700, 110, { a: kk, c: AMBER, glow: 'rgba(255,140,40,.5)' });
    text(g, `${i + 1} of 5 layouts \u00b7 switch without stopping`, W / 2, 1790, 40, { a: 0.8, w: 600, c: DIM });
    { const fk = prog(t, t0 + i * SPB, 0.12); if (fk > 0 && fk < 1) { g.fillStyle = `rgba(255,240,220,${(1 - fk) * 0.25})`; g.fillRect(0, 0, W, H); } }
  } else {
    const v = u - SPB * 4, k = back(prog(v, 0, 0.45));
    text(g, '+ Strata', W / 2, 300, 120 * (0.7 + 0.3 * clamp(k)), { a: clamp(k), c: AMBER, glow: 'rgba(255,140,40,.6)' });
    text(g, 'Only in STRATUM.', W / 2, 400, 64, { a: eo(prog(v, 0.25, 0.4)), w: 700 });
    frameShot(g, im.strata, 40, 520, 1000, 625, 26, { a: eo(prog(v, 0.1, 0.4)) });
    frameShot(g, im.strata, 240, 1200, 600, 560, 26, { a: eo(prog(v, 0.35, 0.4)), fx: 0.97, fy: 0.12, zoom: 2.1, glow: 'rgba(124,255,80,.45)' });
    text(g, 'Your song as layers. A live stage beside it.', W / 2, 1840, 42, { a: eo(prog(v, 0.5, 0.4)), w: 600, c: CREAM });
    flash(g, t, t0 + SPB * 4, 0.3);
  }
}
function visFrame(g, t, dt, tiles, x, y, w, h) {
  va.read(t, 1, (t * BPM) / 60); vr.render(va, tiles, [1, 1], {}, dt); g.drawImage(vcv, x, y, w, h);
}
function sceneF(g, t, dt) {        // 17.14 - 21.43: visuals and one-click video
  const t0 = DROP + SPB * 16, u = t - t0;
  visFrame(g, t, dt, LOOK_F, 0, 0, W, H);
  const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(7,8,13,.7)'); gr.addColorStop(0.3, 'rgba(7,8,13,0)'); gr.addColorStop(0.7, 'rgba(7,8,13,0)'); gr.addColorStop(1, 'rgba(7,8,13,.85)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  text(g, 'Your beat', W / 2, 260, 110, { a: eo(prog(u, 0.1, 0.35)) });
  text(g, 'becomes the video.', W / 2, 380, 96, { a: eo(prog(u, 0.3, 0.35)), c: AMBER, glow: 'rgba(0,0,0,.8)' });
  const tags = ['44 audio-reactive modes', '1080p in one click', 'TikTok · Reels · Shorts'];
  tags.forEach((s, i) => { const k = back(prog(u, 1.4 + i * SPB, 0.35)); g.save(); g.globalAlpha = clamp(k); g.font = FONT(700, 44); const w = g.measureText(s).width + 80; g.fillStyle = 'rgba(7,8,13,.75)'; rr(g, (W - w) / 2, 1500 + i * 110, w, 84, 42); g.fill(); g.restore(); text(g, s, W / 2, 1556 + i * 110, 44, { a: clamp(k), w: 700 }); });
  flash(g, t, t0, 0.3);
}
function sceneG(g, t, dt) {        // 21.43 - 25.71: go live, then stems
  const t0 = DROP + SPB * 24, u = t - t0; bg(g, t, -10);
  if (u < SPB * 4) {
    text(g, 'Go live', W / 2, 250, 120, { a: eo(prog(u, 0, 0.3)) });
    text(g, 'right from the studio.', W / 2, 350, 64, { a: eo(prog(u, 0.2, 0.3)), c: AMBER });
    const x = 150, y = 430, w = 780, h = 1180;
    g.save(); g.fillStyle = '#1e2130'; rr(g, x - 18, y - 18, w + 36, h + 36, 70); g.fill(); rr(g, x, y, w, h, 54); g.clip();
    visFrame(g, t, dt, LOOK_G, x, y, w, h); g.restore();
    // LIVE badge, viewers, camera box
    const pulse = 0.75 + 0.25 * Math.sin(t * 8);
    g.save(); g.fillStyle = `rgba(230,40,60,${pulse})`; rr(g, x + 40, y + 40, 150, 64, 14); g.fill(); g.restore();
    text(g, 'LIVE', x + 115, y + 87, 38, { w: 800 });
    const viewers = Math.floor(120 + Math.pow(prog(u, 0, SPB * 4), 1.5) * 4800);
    g.save(); g.fillStyle = 'rgba(0,0,0,.55)'; rr(g, x + 205, y + 40, 230, 64, 14); g.fill(); g.restore();
    text(g, '● ' + viewers.toLocaleString('en-US'), x + 320, y + 87, 34, { w: 700 });
    g.save(); g.fillStyle = 'rgba(15,17,25,.9)'; rr(g, x + w - 250, y + h - 330, 210, 290, 26); g.fill(); g.fillStyle = '#3a3f52'; g.beginPath(); g.arc(x + w - 145, y + h - 230, 52, 0, 7); g.fill(); rr(g, x + w - 225, y + h - 160, 160, 110, 50); g.fill(); g.restore();
    text(g, 'Twitch · YouTube · Instagram · TikTok', W / 2, 1760, 44, { a: eo(prog(u, 0.6, 0.4)), w: 600, c: DIM });
    flash(g, t, t0, 0.25);
  } else {
    const v = u - SPB * 4;
    text(g, 'Split any song', W / 2, 260, 100, { a: eo(prog(v, 0, 0.3)) });
    text(g, 'into stems.', W / 2, 370, 100, { a: eo(prog(v, 0.15, 0.3)), c: AMBER });
    const stems = [['Drums', EMBER], ['Bass', '#5aa9ff'], ['Vocals', '#c77dff'], ['Other', TEAL]], sep = eio(prog(v, 0.3, 0.8));
    stems.forEach(([n, c], i) => {
      const yc = 1000 + (i - 1.5) * 280 * sep, amp = 110;
      g.save(); g.globalAlpha = 0.35 + 0.65 * sep; g.fillStyle = c;
      for (let x = 80; x < W - 80; x += 10) {
        const e = env[Math.max(0, Math.floor((t - 1.2 + (x - 80) / 900 * 2.4) * 60))] || 0, w2 = 0.35 + 0.65 * Math.abs(Math.sin(x * (0.013 + i * 0.007) + i * 1.7));
        const hh = Math.max(4, e * amp * w2 * (1.4 - i * 0.15)); rr(g, x, yc - hh, 6, hh * 2, 3); g.fill();
      }
      g.restore();
      text(g, n, 90, yc - 120 * sep, 40, { a: sep, w: 700, align: 'left', c: c });
    });
    text(g, 'On your computer. Nothing uploaded.', W / 2, 1720, 44, { a: eo(prog(v, 0.8, 0.4)), w: 600, c: DIM });
  }
}
function sceneH(g, t, dt) {        // 25.71 - 30: end card
  const t0 = DROP + SPB * 32, u = t - t0;
  visFrame(g, t, dt, LOOK_H, 0, 0, W, H);
  g.fillStyle = 'rgba(7,8,13,.78)'; g.fillRect(0, 0, W, H);
  const k = back(prog(u, 0, 0.45)), mw = 820 * (0.85 + 0.15 * clamp(k)), mh = (mw * mark.height) / mark.width;
  g.save(); g.globalAlpha = clamp(k); g.drawImage(mark, (W - mw) / 2, 560, mw, mh); g.restore();
  text(g, 'Free during the alpha.', W / 2, 900, 76, { a: eo(prog(u, 0.35, 0.4)) });
  text(g, 'Mac · Windows · iPhone · iPad · Android', W / 2, 990, 44, { a: eo(prog(u, 0.55, 0.4)), w: 600, c: DIM });
  const ck = back(prog(u, 0.9, 0.45));
  g.save(); g.globalAlpha = clamp(ck); g.shadowColor = 'rgba(255,140,40,.7)'; g.shadowBlur = 50; g.fillStyle = AMBER; const bw = 760 * (0.8 + 0.2 * clamp(ck)); rr(g, (W - bw) / 2, 1140, bw, 140, 70); g.fill(); g.restore();
  text(g, 'Join the Discord to download', W / 2, 1230, 50, { a: clamp(ck), c: '#140d00', w: 800 });
  text(g, CTA, W / 2, 1360, 46, { a: eo(prog(u, 1.2, 0.4)), w: 600, c: CREAM });
  eq(g, H - 60, 260, 0.9, 40);
}

const SCENES = [[0, sceneA], [BAR * 2, sceneB], [DROP, sceneC], [DROP + SPB * 2, sceneD], [DROP + SPB * 8, sceneE], [DROP + SPB * 16, sceneF], [DROP + SPB * 24, sceneG], [DROP + SPB * 32, sceneH]];
const draw = (g, t, dt) => {
  an.at(t); if (!(t >= DROP + SPB * 16 && t < DROP + SPB * 24) && !(t >= DROP + SPB * 24 && t < DROP + SPB * 28) && t < DROP + SPB * 32) va.read(t, 1, (t * BPM) / 60);
  let f = SCENES[0][1]; for (const [at, fn] of SCENES) if (t >= at) f = fn;
  f(g, t, dt);
  // film grain, very light
  g.save(); g.globalAlpha = 0.035; for (let i = 0; i < 90; i++) { g.fillStyle = i % 2 ? '#fff' : '#000'; g.fillRect((i * 7919 + t * 1e4) % W, (i * 104729 + t * 7e3) % H, 3, 3); } g.restore();
};

if (window.AD_STILLS) {   // a few stills for checking the layout
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'), out = {};
  for (const ts of window.AD_STILLS) { for (let x = Math.max(0, ts - 1); x <= ts; x += 1 / 30) draw(g, x, 1 / 30); out[ts] = cv.toDataURL('image/jpeg', 0.8); }
  return JSON.stringify(out);
}
const codec = await IO.canRenderOffline(W, H);
if (!codec) throw new Error('no encoder');
const t0 = performance.now(), blob = await IO.renderOffline(codec, W, H, buf, draw);
const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
return JSON.stringify({ secs: +((performance.now() - t0) / 1000).toFixed(1), mb: +(u8.length / 1048576).toFixed(1), b64: btoa(s) });
