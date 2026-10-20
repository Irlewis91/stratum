// Share without the Mac app (Windows, phones, tablets, browsers): the same STRATUM-branded video, drawn on a canvas and
// recorded in real time with the mixdown as its soundtrack, then handed to the system share sheet or saved.
(function () {
  const S = window.S, IO = S.io, E = S.engine;
  const BG = '#0f1016', CREAM = '#ede9e0', AMBER = '#e39a12', LINK = 'github.com/Irlewis91/stratum';
  const SHAPES = { ig_post: [1080, 1350, '4x5'], facebook: [1080, 1350, '4x5'], threads: [1080, 1350, '4x5'], x: [1080, 1080, '1x1'] };
  const PAGES = { tiktok: 'https://www.tiktok.com/upload', ig_reel: 'https://www.instagram.com/', ig_post: 'https://www.instagram.com/', ig_story: 'https://www.instagram.com/',
    facebook: 'https://www.facebook.com/', youtube: 'https://studio.youtube.com/', x: 'https://x.com/compose/post', threads: 'https://www.threads.com/' };
  // Recorded in real time (when the browser can't make the full-quality video), videos are half size, 540 wide, so phones
  // keep up.
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

  const pickType = () => ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';

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

  // ---------------------------------------------------------------- full-quality video, made frame by frame
  // Where the browser has WebCodecs (the Mac and Windows apps, current Chrome, Edge and Safari), the video is drawn one
  // frame at a time at full 1080-wide size and encoded as High-profile H.264 with AAC sound, then packed into an MP4 here.
  // No frame can be dropped, and it usually takes less time than the track lasts.
  const FPS = 30;
  const VIDEO_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42E028'];

  // Stands in for a Web Audio AnalyserNode, read from the mixdown at any moment: the same window, smoothing and decibel
  // range as the real one, so Visuals look the same as when the track plays live.
  class BufferAnalyser {
    constructor(buf, fftSize = 1024) {
      this.buf = buf; this.fftSize = fftSize; this.frequencyBinCount = fftSize / 2; this.context = { sampleRate: buf.sampleRate };
      this.smoothingTimeConstant = 0.8; this.minDecibels = -100; this.maxDecibels = -30;
      this.L = buf.getChannelData(0); this.R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : this.L;
      this.td = new Float32Array(fftSize); this.mag = new Float32Array(fftSize / 2); this.re = new Float32Array(fftSize); this.im = new Float32Array(fftSize);
      this.win = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) { const x = i / fftSize; this.win[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x); }
      this.rev = new Uint32Array(fftSize);
      for (let i = 0, bits = Math.log2(fftSize); i < fftSize; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    }
    // Moves the analyser to `t` seconds: the last fftSize samples before t, mixed to mono, and the smoothed spectrum.
    at(t) {
      const n = this.fftSize, end = Math.round(t * this.buf.sampleRate), re = this.re, im = this.im;
      for (let i = 0; i < n; i++) { const k = end - n + i, v = k >= 0 && k < this.L.length ? (this.L[k] + this.R[k]) / 2 : 0; this.td[i] = v; re[this.rev[i]] = v * this.win[i]; im[this.rev[i]] = 0; }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2, step = (-2 * Math.PI) / size;
        for (let s = 0; s < n; s += size) for (let j = 0; j < half; j++) {
          const wr = Math.cos(step * j), wi = Math.sin(step * j), a = s + j, b = a + half;
          const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
      const tau = this.smoothingTimeConstant;
      for (let i = 0; i < n / 2; i++) this.mag[i] = tau * this.mag[i] + (1 - tau) * (Math.hypot(re[i], im[i]) / n);
    }
    getByteTimeDomainData(out) { for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(128 * (1 + this.td[i])))); }
    getByteFrequencyData(out) {
      const lo = this.minDecibels, span = this.maxDecibels - lo;
      for (let i = 0; i < out.length; i++) { const db = 20 * Math.log10(this.mag[i] || 1e-12); out[i] = Math.max(0, Math.min(255, Math.floor((255 * (db - lo)) / span))); }
    }
  }

  // The AAC AudioSpecificConfig. Chrome's encoder gives it directly; Safari's gives a whole MPEG-4 ES descriptor (what an
  // esds box holds), so the config is dug out of its DecoderSpecificInfo (tag 5).
  function audioConfig(d) {
    if (d[0] !== 0x03) return d;
    const sizeAt = (o) => { let n = 0, k = 0; while (k < 4) { const b = d[o + k++]; n = (n << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return [n, o + k]; };
    try {
      let [, o] = sizeAt(1);                       // ES_Descriptor
      const flags = d[o + 2]; o += 3;
      if (flags & 0x80) o += 2;                     // depends on another stream
      if (flags & 0x40) o += 1 + d[o];              // URL
      if (flags & 0x20) o += 2;                     // OCR stream
      if (d[o] !== 0x04) return d;
      [, o] = sizeAt(o + 1); o += 13;               // DecoderConfigDescriptor's fixed fields
      if (d[o] !== 0x05) return d;
      const [n, at] = sizeAt(o + 1);
      return d.slice(at, at + n);
    } catch (e) { return d; }
  }

  // A plain MP4 (moov first, so it plays while downloading) holding one H.264 track and one AAC track.
  function muxMp4(v, a) {
    const enc = new TextEncoder(), parts = [];
    const box = (type, ...kids) => {
      const body = kids.flat(Infinity), size = 8 + body.reduce((s, k) => s + k.length, 0), head = new Uint8Array(8);
      new DataView(head.buffer).setUint32(0, size); head.set(enc.encode(type), 4);
      return [head, ...body];
    };
    const u = (bits, ...vals) => { const out = new Uint8Array(vals.length * (bits / 8)), d = new DataView(out.buffer); vals.forEach((x, i) => (bits === 32 ? d.setUint32(i * 4, x) : bits === 16 ? d.setUint16(i * 2, x) : d.setUint8(i, x))); return out; };
    const full = (type, ver, flags, ...kids) => box(type, u(32, (ver << 24) | flags), ...kids);
    const len = (x) => x.flat(Infinity).reduce((s, k) => s + k.length, 0);
    const matrix = u(32, 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
    const timescale = 1000, durMs = Math.round(Math.max(v.duration, a ? a.duration : 0) * 1000);
    const stbl = (entry, t, offsets) => {
      const kids = [full('stsd', 0, 0, u(32, 1), entry)];
      // time-to-sample: runs of equal durations
      const runs = []; for (const d of t.durs) { const r = runs[runs.length - 1]; if (r && r[1] === d) r[0]++; else runs.push([1, d]); }
      kids.push(full('stts', 0, 0, u(32, runs.length), ...runs.map(([c, d]) => u(32, c, d))));
      if (t.keys) kids.push(full('stss', 0, 0, u(32, t.keys.length), u(32, ...t.keys)));
      // Encoders that reorder frames: each frame's display time relative to its decode time (signed, version 1).
      if (t.cts && t.cts.some((x) => x)) {
        const cr = []; for (const x of t.cts) { const r = cr[cr.length - 1]; if (r && r[1] === x) r[0]++; else cr.push([1, x]); }
        kids.push(full('ctts', 1, 0, u(32, cr.length), ...cr.map(([c, x]) => u(32, c, x >>> 0))));
      }
      kids.push(full('stsc', 0, 0, u(32, 1), u(32, 1, 1, 1)));
      kids.push(full('stsz', 0, 0, u(32, 0, t.sizes.length), u(32, ...t.sizes)));
      kids.push(full('stco', 0, 0, u(32, offsets.length), u(32, ...offsets)));
      return box('stbl', ...kids);
    };
    const trak = (id, t, offsets) => {
      const isV = t.kind === 'video', mediaDur = t.durs.reduce((s, d) => s + d, 0);
      const tkhd = full('tkhd', 0, 3, u(32, 0, 0, id, 0, durMs, 0, 0), u(16, 0, 0, isV ? 0 : 0x100, 0), matrix, u(32, isV ? t.w << 16 : 0, isV ? t.h << 16 : 0));
      const mdhd = full('mdhd', 0, 0, u(32, 0, 0, t.timescale, mediaDur), u(16, 0x55c4, 0));
      const hdlr = full('hdlr', 0, 0, u(32, 0), enc.encode(isV ? 'vide' : 'soun'), u(32, 0, 0, 0), enc.encode(isV ? 'VideoHandler\0' : 'SoundHandler\0'));
      const head = isV ? full('vmhd', 0, 1, u(16, 0, 0, 0, 0)) : full('smhd', 0, 0, u(16, 0, 0));
      const dinf = box('dinf', full('dref', 0, 0, u(32, 1), full('url ', 0, 1)));
      let entry;
      if (isV) {
        entry = box('avc1', u(8, 0, 0, 0, 0, 0, 0), u(16, 1, 0, 0), u(32, 0, 0, 0), u(16, t.w, t.h), u(32, 0x480000, 0x480000, 0), u(16, 1), new Uint8Array(32), u(16, 0x18, 0xffff),
          box('avcC', t.config), box('pasp', u(32, 1, 1)));
      } else {
        // esds: an MPEG-4 descriptor wrapping the AAC AudioSpecificConfig
        const asc = audioConfig(t.config), desc = (tag, body) => { const b = body.flat(Infinity), n = b.reduce((s, k) => s + k.length, 0); return [u(8, tag, 0x80, 0x80, 0x80, n), ...b]; };
        const dcd = desc(0x04, [u(8, 0x40, 0x15, 0, 0, 0), u(32, t.bitrate, t.bitrate), desc(0x05, [asc])]);
        const es = desc(0x03, [u(16, 1), u(8, 0), dcd, desc(0x06, [u(8, 2)])]);
        entry = box('mp4a', u(8, 0, 0, 0, 0, 0, 0), u(16, 1), u(32, 0, 0), u(16, t.channels, 16, 0, 0), u(32, t.timescale * 65536), full('esds', 0, 0, es));
      }
      return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', head, dinf, stbl(entry, t, offsets))));
    };
    const tracks = [v, ...(a ? [a] : [])];
    // Samples go into the mdat interleaved by time, about half a second at a time, so players read smoothly.
    const order = [], pos = tracks.map(() => 0);
    while (tracks.some((t, i) => pos[i] < t.sizes.length)) {
      let best = -1, bestT = Infinity;
      tracks.forEach((t, i) => { if (pos[i] < t.sizes.length && t.times[pos[i]] < bestT) { bestT = t.times[pos[i]]; best = i; } });
      const t = tracks[best], stop = t.times[pos[best]] + 0.5;
      while (pos[best] < t.sizes.length && t.times[pos[best]] < stop) order.push([best, pos[best]++]);
    }
    const build = (offs) => box('moov', full('mvhd', 0, 0, u(32, 0, 0, timescale, durMs, 0x10000), u(16, 0x100, 0), u(32, 0, 0), matrix, new Uint8Array(24), u(32, tracks.length + 1)),
      ...tracks.map((t, i) => trak(i + 1, t, offs[i])));
    const ftyp = box('ftyp', enc.encode('isom'), u(32, 0x200), enc.encode('isomiso2avc1mp41'));
    const zero = tracks.map((t) => new Array(t.sizes.length).fill(0)), moovLen = len(build(zero));
    let at = len(ftyp) + moovLen + 8;
    const offs = tracks.map((t) => new Array(t.sizes.length));
    for (const [ti, si] of order) { offs[ti][si] = at; at += tracks[ti].sizes[si]; }
    const mdatSize = at - (len(ftyp) + moovLen), head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, mdatSize); head.set(enc.encode('mdat'), 4);
    return new Blob([...ftyp, ...build(offs).flat(Infinity), head, ...order.map(([ti, si]) => tracks[ti].data[si])], { type: 'video/mp4' });
  }

  IO.canRenderOffline = async (W, H) => {
    if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
    for (const codec of VIDEO_CODECS) {
      try { if ((await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: 12e6, framerate: FPS, avc: { format: 'avc' } })).supported) return codec; } catch (e) {}
    }
    return null;
  };

  // `draw(g, t, dt)` paints the frame for time t. Resolves to an MP4 Blob, or throws so the caller can fall back.
  IO.renderOffline = async (codec, W, H, buf, draw, progress) => {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'), frames = Math.max(1, Math.ceil(buf.duration * FPS)), bitrate = Math.round(14e6 * (W * H) / (1080 * 1920));
    const v = { kind: 'video', w: W, h: H, timescale: FPS * 100, durs: [], sizes: [], times: [], keys: [], cts: [], data: [], config: null, duration: frames / FPS };
    let failed = null;
    const ve = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !v.config) v.config = new Uint8Array(meta.decoderConfig.description.buffer || meta.decoderConfig.description);
        const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
        const i = v.data.length;
        v.data.push(d); v.sizes.push(d.length); v.durs.push(100); v.times.push(i / FPS); v.cts.push(Math.round((chunk.timestamp * FPS * 100) / 1e6) - i * 100);
        if (chunk.type === 'key') v.keys.push(v.data.length);
      },
      error: (e) => { failed = e; },
    });
    ve.configure({ codec, width: W, height: H, bitrate, framerate: FPS, bitrateMode: 'variable', latencyMode: 'realtime', avc: { format: 'avc' } });   // Safari's 'quality' mode stalls at this size
    // Sound: AAC at 256 kbps, fed in 1024-sample blocks.
    const sr = buf.sampleRate, ch = Math.min(2, buf.numberOfChannels);
    const a = { kind: 'audio', channels: ch, timescale: sr, bitrate: 256000, durs: [], sizes: [], times: [], data: [], config: null, duration: buf.duration };
    const ae = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !a.config) a.config = new Uint8Array(meta.decoderConfig.description.buffer || meta.decoderConfig.description);
        const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
        a.data.push(d); a.sizes.push(d.length); a.durs.push(1024); a.times.push(chunk.timestamp / 1e6);
      },
      error: (e) => { failed = e; },
    });
    // Constant bitrate: in its default mode Safari's AAC encoder drops to about 60 kbps on quiet passages.
    const acfg = { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate: 256000, bitrateMode: 'constant' };
    let aok = false; try { aok = (await AudioEncoder.isConfigSupported(acfg)).supported; } catch (e) {}
    if (!aok) delete acfg.bitrateMode;
    ae.configure(acfg);
    for (let at = 0; at < buf.length; at += 1024) {
      const n = Math.min(1024, buf.length - at), planes = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) planes.set(buf.getChannelData(c).subarray(at, at + n), c * n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((at / sr) * 1e6), data: planes });
      ae.encode(ad); ad.close();
    }
    const flushA = ae.flush();
    for (let i = 0; i < frames; i++) {
      if (failed) throw failed;
      draw(g, i / FPS, 1 / FPS);
      const vf = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      ve.encode(vf, { keyFrame: i % (FPS * 2) === 0 }); vf.close();
      if (ve.encodeQueueSize > 6) await new Promise((r) => { const w = () => (ve.encodeQueueSize > 2 && !failed ? setTimeout(w, 2) : r()); w(); });
      if (progress && i % 15 === 0) { progress(i / frames); await new Promise((r) => setTimeout(r, 0)); }
    }
    await ve.flush(); await flushA; ve.close(); ae.close();
    if (failed) throw failed;
    if (!v.config || !a.config || !v.data.length) throw new Error('the encoder gave no output');
    if (progress) progress(1);
    return muxMp4(v, a);
  };

  // A hidden STRATUM Visuals renderer for the chosen look, listening to `an` (a live analyser or a BufferAnalyser).
  async function visualsFor(look, W, H, an) {
    if (!look || look === 'classic' || !S.vis) return null;
    const vc = document.createElement('canvas'); vc.width = W; vc.height = H;
    const P = look === 'current' && S.proj.visuals ? S.proj.visuals.tiles[0] : S.vis.FACTORY[look] || Object.values(S.vis.FACTORY)[0];
    const vis = { r: new S.vis.Renderer(vc), a: new S.vis.Analyzer(an), an, tiles: [{ P: JSON.parse(JSON.stringify(P)), st: {} }], cv: vc, last: 0 };
    const im = S.proj.visuals && S.proj.visuals.image;
    if (im) await new Promise((res) => { const i = new Image(); i.onload = () => { vis.r.setImage(i); res(); }; i.onerror = res; i.src = im; });
    return vis;
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
    // Full quality first: every frame drawn at full size, then encoded. Falls back to recording in real time.
    const FW = W0, FH = H0, codec = await IO.canRenderOffline(FW, FH);
    if (codec) {
      try {
        const fbg = base(title, artist, FW, FH, mark0), vis = await visualsFor(look, FW, FH, new BufferAnalyser(buf));
        const blob = await IO.renderOffline(codec, FW, FH, buf, (fg, t, dt) => {
          if (vis) { vis.an.at(t); vis.a.read(t, 1, (t * (S.proj.bpm || 120)) / 60); vis.r.render(vis.a, vis.tiles, [1, 1], {}, dt); fg.drawImage(vis.cv, 0, 0, FW, FH); brandOver(fg, FW, FH, title, artist, mark0); }
          else frame(fg, fbg, peaks, Math.min(1, t / buf.duration), clock(t), FW, FH);
        }, progress);
        return { video: new File([blob], `${safe} ${label}.mp4`, { type: 'video/mp4' }), audio };
      } catch (e) { console.warn('Full-quality video failed, recording in real time instead:', e); }
    }
    cv.width = W; cv.height = H;
    frame(g, bg, peaks, 0, clock(0), W, H);
    const ctx = E.ensure(), dest = ctx.createMediaStreamDestination(), src = ctx.createBufferSource();
    src.buffer = buf; src.connect(dest);
    // Visuals look: a hidden STRATUM Visuals renderer listening to the same audio.
    let vis = null;
    if (look && look !== 'classic' && S.vis) { const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an); vis = await visualsFor(look, W, H, an); }
    const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 192_000 }), parts = [];
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
