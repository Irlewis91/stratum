// STRATUM file I/O: native project files, audio, MIDI, Ableton .als, FL Studio .flp, DAWproject.
(function () {
  const S = window.S, E = S.engine, D = S.dsp, IO = (S.io = {});
  const enc = new TextEncoder();
  const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const native = () => window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.stratum;

  IO.saveFile = (name, data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    if (native()) return native().postMessage({ op: 'save', name, b64: b64(bytes) });
    // Phones and tablets: offer the share sheet (AirDrop, iCloud Drive / Files, Google Drive, email…) as well as a plain download.
    const file = typeof File === 'function' ? new File([bytes], name) : null;
    const safeName = name.replace(/[<>&"]/g, ''), canShare = file && navigator.canShare && navigator.canShare({ files: [file] });
    if (file && matchMedia('(pointer: coarse)').matches && canShare && !IO._sharing) {
      IO._pending = file;
      return S.ui.showPop(`<h3>Save “${safeName}”</h3><p class="hint">Send it to your computer with AirDrop, or keep it in iCloud Drive, Files or Google Drive, then open it in STRATUM on any device.</p>` +
        `<p><button data-act="saveShare" class="primary">Share or save to Files…</button> <button data-act="saveDownload">Download</button></p><button data-act="closePop">Cancel</button>`);
    }
    // Windows and computer browsers: choose the folder (a OneDrive, Google Drive or Dropbox folder carries it to your phone),
    // or use the Windows share menu.
    if (file && window.showSaveFilePicker && !IO._sharing) {
      IO._pending = file;
      return S.ui.showPop(`<h3>Save “${safeName}”</h3><p class="hint">To open it on your phone or tablet, save it in your OneDrive, Google Drive, Dropbox or iCloud Drive folder, then open it from STRATUM on the phone.</p>` +
        `<p><button data-act="savePick" class="primary">Save to a folder…</button>${canShare ? ' <button data-act="saveShare">Share…</button>' : ''} <button data-act="saveDownload">Save to Downloads</button></p><button data-act="closePop">Cancel</button>`);
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes]));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  IO.sharePending = async () => { const f = IO._pending; if (!f) return; try { await navigator.share({ files: [f], title: f.name }); S.ui.toast('Saved.'); } catch (e) { if (e.name !== 'AbortError') S.ui.toast('Could not share: ' + (e.message || e), true); } };
  IO.pickPending = async () => {
    const f = IO._pending; if (!f) return;
    try {
      const ext = (f.name.match(/\.[^.]+$/) || ['.stratum'])[0];
      const h = await window.showSaveFilePicker({ suggestedName: f.name, types: [{ description: 'STRATUM file', accept: { 'application/octet-stream': [ext] } }] });
      const w = await h.createWritable(); await w.write(f); await w.close();
      S.ui.toast(`Saved ${h.name}.`);
    } catch (e) { if (e.name !== 'AbortError') S.ui.toast('Could not save: ' + (e.message || e), true); }
  };
  IO.downloadPending = async () => { const f = IO._pending; if (!f) return; IO._sharing = true; IO.saveFile(f.name, new Uint8Array(await f.arrayBuffer())); IO._sharing = false; };
  // `many` lets the picker return several files (used to load a set of drum sounds at once).
  IO.open = (many) => {
    const inp = document.getElementById('file');
    if (IO.host()) IO.host().postMessage({ op: 'open', many: !!many });
    else { inp.multiple = !!many; inp.click(); }
  };
  // A .logicx package opened from the Mac app: the shell sends the files inside it.
  IO.nativeLogic = async (name, files) => {
    const map = {};
    for (const k in files) map[k] = unb64(files[k]).buffer;
    try { const res = await IO.logicIn(map, name.replace(/\.logicx$/i, '')); S.ui.imported(res); if (res.proj.wantPlugins && res.proj.wantPlugins.length) await IO.matchPlugins(); }
    catch (e) { S.ui.toast('Could not open ' + name + ': ' + (e.message || e), true); }
  };
  IO.nativeOpen = (name, data, path) => { IO.lastPath = path || ''; return IO.importBytes(name, unb64(data).buffer); };

  // ---- samples a project refers to but does not contain (FL Studio projects point at files on disk) ----
  // proj.wanted: [{t: track id, kind: 'inst' | 'clip', path, file, pitch?, items?: [{t, len}]}]
  IO.attach = (proj, w, rec) => {
    const t = proj.tracks.find((x) => x.id === w.t), nm = w.file.replace(/\.[^.]+$/, '');
    if (!t) return;
    if (w.kind === 'clip') {
      const beats = (rec.buf.duration * proj.bpm) / 60, bars = Math.max(1, Math.ceil(beats / 4));
      for (const it of w.items || []) t.regions.push({ id: S.uid(), start: it.t, len: Math.max(0.25, Math.min(it.len || beats, beats)), off: 0, clip: { audio: rec.id, warp: false, bars, gain: 1 } });
    } else if (t.type === 'drums') { t.pads = t.pads || {}; t.pads[w.pitch || 36] = { audio: rec.id, name: nm, tune: 0, gain: 1 }; }
    else if (t.inst) t.inst.sample = { audio: rec.id, name: nm, root: 60, loop: false };
  };
  // Offer a file to the open project: used when its name matches a missing sample. Resolves true when it was used.
  IO.offer = async (name, ab) => {
    const proj = S.proj, base = name.split(/[\\/]/).pop().toLowerCase(), ws = (proj.wanted || []).filter((w) => w.file.toLowerCase() === base);
    if (!ws.length) return false;
    const rec = await IO.addAudio(base === name.toLowerCase() ? name : name.split(/[\\/]/).pop(), ab);
    ws.forEach((w) => IO.attach(proj, w, rec));
    proj.wanted = proj.wanted.filter((w) => !ws.includes(w));
    return true;
  };
  // After an import, ask the Mac or Windows app to look for the missing files where the project says they are and beside the project file.
  IO.seek = () => new Promise((res) => {
    const w = (S.proj && S.proj.wanted) || [];
    if (!w.length || !IO.host()) return res(0);
    let n = 0;
    IO.found = async (name, data) => { if (await IO.offer(name, unb64(data).buffer)) n++; };
    IO.foundDone = () => { try { S.ui.wantedDone(n); } catch (e) { S.ui.toast('Samples: ' + (e.message || e), true); } res(n); };
    IO.host().postMessage({ op: 'findFiles', paths: [...new Set(w.map((x) => x.path))], near: IO.lastPath || '' });
  });
  // VST instruments an imported project used: put the same plugin on the track when it is installed on this Mac.
  IO.matchPlugins = async () => {
    const proj = S.proj, want = proj.wantPlugins || [];
    if (!want.length || !S.plug.available()) return;
    const list = (await S.plug.list()).filter((p) => p.kind === 'inst'), clean = (s) => s.replace(/ \((VST2|VST3)\)$/, '').toLowerCase().trim(), found = [], missing = [];
    for (const w of want) {
      const t = proj.tracks.find((x) => x.id === w.t), hit = list.find((p) => clean(p.name) === clean(w.name));
      if (t && hit) { t.plugin = { id: hit.id, name: hit.name, maker: hit.maker, state: '', fx: [] }; found.push(hit.name); } else missing.push(w.name);
    }
    proj.wantPlugins = want.filter((w) => missing.includes(w.name));
    S.engine.rebuild(); S.ui.refresh();
    S.ui.followUp((found.length ? `Loaded the installed plugin for: ${[...new Set(found)].join(', ')} (with its default sound; the settings saved in the original project are not transferred). ` : '') + (missing.length ? `Not installed on this Mac, so playing on a built-in sound: ${[...new Set(missing)].join(', ')}.` : ''), !found.length);
  };
  // ---- Apple binary property lists (used by Logic's MetaData.plist) ----
  IO.bplist = (ab) => {
    const v = new DataView(ab), u8 = new Uint8Array(ab), n = u8.length;
    if (String.fromCharCode(...u8.subarray(0, 8)) !== 'bplist00') return null;
    const offSize = u8[n - 26], refSize = u8[n - 25], count = Number(v.getBigUint64(n - 24)), top = Number(v.getBigUint64(n - 16)), table = Number(v.getBigUint64(n - 8));
    const int = (o, size) => { let x = 0; for (let i = 0; i < size; i++) x = x * 256 + u8[o + i]; return x; };
    const offs = []; for (let i = 0; i < count; i++) offs.push(int(table + i * offSize, offSize));
    const obj = (k, depth) => {
      if (depth > 32) return null;
      let o = offs[k]; const m = u8[o], hi = m >> 4;
      let len = m & 15; o++;
      if ((hi === 5 || hi === 6 || hi === 10 || hi === 13 || hi === 4) && len === 15) { const im = u8[o], sz = 1 << (im & 15); len = int(o + 1, sz); o += 1 + sz; }
      switch (hi) {
        case 0: return m === 9 ? true : m === 8 ? false : null;
        case 1: return int(o, 1 << (m & 15));
        case 2: return (m & 15) === 3 ? v.getFloat64(o) : v.getFloat32(o);
        case 5: return String.fromCharCode(...u8.subarray(o, o + len));
        case 6: { let t = ''; for (let i = 0; i < len; i++) t += String.fromCharCode(v.getUint16(o + 2 * i)); return t; }
        case 10: { const a = []; for (let i = 0; i < len; i++) a.push(obj(int(o + i * refSize, refSize), depth + 1)); return a; }
        case 13: { const d = {}; for (let i = 0; i < len; i++) d[obj(int(o + i * refSize, refSize), depth + 1)] = obj(int(o + (len + i) * refSize, refSize), depth + 1); return d; }
        default: return null;
      }
    };
    return obj(top, 0);
  };

  // ---- Logic Pro project (.logicx package, or a zip of one) ----
  // ProjectData is a chain of chunks: a reversed four-letter tag, a 36-byte header (the chunk's id at byte 10, its length
  // at byte 28) and the body. MSeq chunks are regions and folders (name, length); EvSq chunks hold their events in
  // 16-byte records; Envi chunks are channel strips (track names); AuCU chunks are plugin settings, including the sample
  // each Quick Sampler plays. The song's arrangement is the event list whose records place regions: position, channel
  // strip, row and the region whose notes play. Positions are in ticks, 960 to the quarter note; inside a region the
  // first beat is tick 38400, and on the arrangement bar 1 is tick 34560.
  IO.logicIn = async (files, name) => {
    const key = Object.keys(files).find((k) => /(^|\/)ProjectData$/.test(k));
    if (!key) throw new Error('No ProjectData found in this Logic project');
    const ab = files[key], v = new DataView(ab), u8 = new Uint8Array(ab), TPQ = 960, REGION0 = 38400, SONG0 = 34560;
    const ascii = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
    const chunks = [];
    for (let o = 24; o + 36 <= u8.length;) {
      const n = Number(v.getBigUint64(o + 28, true));
      chunks.push({ tag: ascii(o, 4).split('').reverse().join(''), id: v.getUint32(o + 10, true), b: o + 36, n });
      if (n > u8.length) break;
      o += 36 + n;
    }
    const meta = files[key.replace(/ProjectData$/, 'MetaData.plist')], md = (meta && IO.bplist(meta)) || {};
    const text = (o, end) => { const n = v.getUint16(o, true); return o + 2 + n <= end ? new TextDecoder().decode(u8.subarray(o + 2, o + 2 + n)).replace(/\0+$/, '') : ''; };
    const strips = {}, seqs = {}, events = {}, samples = [], plugins = [], zoneRoot = {}, sampleCh = {};
    for (const c of chunks) {
      const end = c.b + c.n;
      if (c.tag === 'Envi') { const m = ascii(c.b, Math.min(c.n, 400)).match(/[\x20-\x7e]{3,}/); strips[c.id] = m ? m[0] : ''; }
      if (c.tag === 'MSeq' && c.n > 80) {
        const nm = text(c.b + 16, end), at = c.b + 18 + nm.length + (nm.length & 1) + 60;
        seqs[c.id] = { name: nm, len: at + 4 <= end ? v.getUint32(at, true) : 0 };
      }
      if (c.tag === 'EvSq') (events[c.id] = events[c.id] || []).push(c);
      if (c.tag === 'AuCU' && c.n >= 8) {
        const kind = v.getUint32(c.b - 18, true);
        const s = ascii(c.b, Math.min(c.n, 260)).match(/[\x20-\x7e]{3,}/g) || [];
        const chan = v.getUint32(c.b - 22, true);
        if (kind === 6 && s[0]) { samples.push(s[0]); sampleCh[s[0]] = chan; }
        // Quick Sampler keeps its playback settings as EXS-style zones; the "Classic Zone" record holds the root key
        // (byte 1 of its data) and fine tune in cents (byte 2).
        if (kind === 2) {
          const tag = 'TBOSClassic Zone';
          for (let o = c.b; o + 72 < end; o++) {
            if (u8[o] !== 0x54 || ascii(o, tag.length) !== tag) continue;
            zoneRoot[chan] = { root: u8[o + 69], cents: v.getInt8(o + 70) };
            break;
          }
        }
        if (kind === 2 && s[0] && s[0] !== '#default.pst') plugins.push(s[0]); else if (kind === 2 && s[1]) plugins.push(s[1]);
      }
    }
    // Notes of a region: groups of 16-byte records; a note's first record has status 0x9n and the next record 0x89 at byte 7.
    const notesOf = (id) => {
      const out = [];
      for (const c of events[id] || []) for (let o = c.b; o + 32 <= c.b + c.n; o += 16) {
        if ((u8[o] & 0xf0) !== 0x90 || u8[o + 13] || u8[o + 14] || u8[o + 23] !== 0x89) continue;
        const vel = u8[o + 11], pitch = u8[o + 12];
        if (pitch > 127 || vel < 1 || vel > 127) continue;
        out.push({ t: (v.getUint32(o + 4, true) - REGION0) / TPQ, d: Math.max(0.05, v.getUint32(o + 28, true) / TPQ), p: pitch, v: vel / 127 });
      }
      return out;
    };
    // The arrangement: 80-byte records of type 0x20 (MIDI region) or 0x24 (audio region).
    const placed = [];
    for (const id in events) for (const c of events[id]) for (let o = c.b; o + 48 <= c.b + c.n; o += 16) {
      if ((u8[o] !== 0x20 && u8[o] !== 0x24) || u8[o + 1] || u8[o + 23] !== 0x89 || v.getUint32(o + 28, true) !== 0x3fffffff) continue;
      placed.push({ audio: u8[o] === 0x24, pos: v.getUint32(o + 4, true), strip: v.getUint32(o + 16, true), row: v.getUint16(o + 20, true), seq: v.getUint32(o + 32, true) });
    }
    if (!placed.length) throw new Error('No arrangement found in this Logic project');
    const bpm = md.BeatsPerMinute || 120, p = S.blankProject();
    p.name = name; p.bpm = Math.min(300, Math.max(30, bpm));
    const keyIdx = S.NOTES ? S.NOTES.indexOf(md.SongKey) : -1;
    if (keyIdx >= 0) p.root = keyIdx;
    if (md.SongGenderKey) p.scale = md.SongGenderKey === 'minor' ? 'Minor' : 'Major';
    if (!p.scenes.length) S.newScene(p, 'Scene 1', 1);
    S.migrate(p);
    // Sound files bundled with the project.
    const media = Object.keys(files).filter((k) => /\.(wav|aif|aiff|caf|mp3|m4a)$/i.test(k));
    const stem = (k) => k.split('/').pop().replace(/\.[^.]+$/, '');
    const sampleFiles = media.filter((k) => /\/Samples\//.test(k) || /^Samples\//.test(k));
    const usedFiles = new Set(), ctx = E.ensure();
    const load = async (k) => { usedFiles.add(k); const buf = await ctx.decodeAudioData(files[k].slice(0)); const id = S.uid(); S.buffers[id] = { id, name: stem(k), buf, bpm: 0 }; return S.buffers[id]; };
    const rows = [...new Set(placed.map((r) => r.strip))].sort((a, b) => Math.min(...placed.filter((r) => r.strip === a).map((r) => r.row)) - Math.min(...placed.filter((r) => r.strip === b).map((r) => r.row)));
    const tracks = {}, report = { midi: 0, notes: 0, audio: 0, samplers: 0, missing: [] };
    for (const sid of rows) {
      const nm = strips[sid] || 'Track', mine = placed.filter((r) => r.strip === sid), audio = mine.some((r) => r.audio);
      const t = S.newTrack(p, audio ? 'audio' : 'synth', nm);
      tracks[sid] = t;
      if (!audio && samples.includes(nm)) t.wantSample = nm;
      for (const r of mine) {
        const start = (r.pos - SONG0) / TPQ;
        if (audio !== r.audio) continue;
        if (r.audio) {
          const f = media.find((k) => stem(k) === nm) || media.find((k) => stem(k).startsWith(nm));
          if (!f) { report.missing.push(nm); continue; }
          const rec = S.buffers[t.audioId] || (await load(f)); t.audioId = rec.id;
          const beats = (rec.buf.duration * p.bpm) / 60;
          t.regions.push({ id: S.uid(), start, len: beats, off: 0, clip: { audio: rec.id, warp: false, bars: Math.max(1, Math.ceil(beats / 4)), gain: 1 } });
          report.audio++;
          continue;
        }
        const notes = notesOf(r.seq), sq = seqs[r.seq] || {};
        const len = sq.len > 0 ? sq.len / TPQ : Math.max(4, Math.ceil(Math.max(0, ...notes.map((n) => n.t + n.d)) / 4) * 4);
        const inside = notes.filter((n) => n.t >= 0 && n.t < len);
        if (!inside.length) continue;
        t.regions.push({ id: S.uid(), start, len, off: 0, clip: { bars: Math.max(1, Math.ceil(len / 4)), notes: inside } });
        report.midi++; report.notes += inside.length;
      }
    }
    // Quick Sampler tracks play their sample; a sample file whose name differs from its sampler goes to the one left over.
    const free = sampleFiles.filter((k) => !samples.includes(stem(k)));
    for (const t of Object.values(tracks)) {
      if (!t.wantSample) continue;
      const f = sampleFiles.find((k) => stem(k) === t.wantSample) || free.shift();
      delete t.wantSample;
      if (!f) { report.missing.push(t.name); continue; }
      const rec = await load(f);
      const z = zoneRoot[sampleCh[t.name]] || { root: 60, cents: 0 };
      t.inst.sample = { audio: rec.id, name: rec.name, root: z.root > 0 && z.root < 128 ? z.root : 60, cents: z.cents || 0, loop: false };
      if (z.root !== 60 || z.cents) report.retuned = (report.retuned || 0) + 1;
      report.samplers++;
    }
    // A track Logic bounced in place ("<name>_bip") already carries the real sound, so its MIDI original is muted.
    const bounced = [];
    for (const t of Object.values(tracks)) if (t.type === 'synth' && !t.inst.sample && Object.values(tracks).some((o) => o.type === 'audio' && o.regions.length && o.name.startsWith(t.name + '_b'))) { t.mute = true; bounced.push(t.name); }
    p.tracks = p.tracks.filter((t) => t.regions.length);
    const synthLeft = p.tracks.filter((t) => t.type === 'synth' && !t.inst.sample).map((t) => t.name);
    const others = [...new Set(plugins.filter((x) => x && x !== 'Q-Sampler' && x !== 'Klopfgeist'))];
    if (others.length && synthLeft.length) p.wantPlugins = synthLeft.map((n) => ({ t: p.tracks.find((t) => t.name === n).id, name: others[0], maker: '' }));
    S.migrate(p);
    return {
      proj: p,
      report: `Logic Pro project: ${p.tracks.length} tracks, ${report.midi} MIDI regions with ${report.notes} notes, ${report.audio} audio regions, tempo ${+p.bpm.toFixed(2)}` + (md.SongKey ? `, key ${md.SongKey} ${md.SongGenderKey || ''}` : '') + '. ' +
        (report.samplers ? `${report.samplers} Quick Sampler tracks play their own samples. ` : '') +
        (bounced.length ? `${bounced.join(', ')} ${bounced.length > 1 ? 'were' : 'was'} bounced to audio in Logic, so the MIDI ${bounced.length > 1 ? 'tracks are' : 'track is'} muted and the bounce plays. ` : '') +
        (others.length ? `Logic plugins (${others.join(', ')}) are not recreated. ` : '') + (report.missing.length ? `Missing sound files: ${report.missing.join(', ')}. ` : '') +
        'Mixer levels, effects and automation are not read.',
    };
  };
  // Minimal zip reader (stored and deflated entries) for FL Studio "zipped loop packages".
  IO.unzip = async (ab) => {
    const v = new DataView(ab), u8 = new Uint8Array(ab), out = [];
    let e = u8.length - 22;
    while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('Not a zip file');
    let o = v.getUint32(e + 16, true);
    for (let i = v.getUint16(e + 10, true); i > 0 && v.getUint32(o, true) === 0x02014b50; i--) {
      const method = v.getUint16(o + 10, true), csize = v.getUint32(o + 20, true), nl = v.getUint16(o + 28, true), xl = v.getUint16(o + 30, true), cl = v.getUint16(o + 32, true), lo = v.getUint32(o + 42, true);
      const name = new TextDecoder().decode(u8.subarray(o + 46, o + 46 + nl)), start = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true), raw = u8.subarray(start, start + csize);
      if (!name.endsWith('/')) out.push({ name, data: method === 0 ? raw.slice().buffer : method === 8 ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer() : null });
      o += 46 + nl + xl + cl;
    }
    return out.filter((f) => f.data);
  };
  IO.native = native;
  // The native engine: the Mac app, or the Windows app (which answers the same plugin messages).
  const winBridge = window.STRATUM_PLATFORM === 'windows' && window.chrome && window.chrome.webview ? { postMessage: (m) => window.chrome.webview.postMessage(m) } : null;
  IO.host = () => native() || winBridge;
  // Which version is running: the Mac app, the Windows app, or the web app (phones, tablets and browsers).
  IO.platform = native() ? 'mac' : window.STRATUM_PLATFORM === 'windows' ? 'windows' : 'web';
  IO.macOnly = (what) => `${what} is in the STRATUM Mac and Windows apps. It isn't in the web and mobile version yet.`;
  // AI stem separation runs in the Mac shell. Resolves with four AudioBuffers: drums, bass, other, vocals.
  IO.separate = async (buf, onProgress) => {
    if (!IO.host()) throw new Error(IO.macOnly('Stem separation'));
    if (buf.duration > 900) throw new Error('Audio longer than 15 minutes cannot be separated');
    const off = new OfflineAudioContext(2, Math.ceil(buf.duration * 44100), 44100), src = off.createBufferSource();
    src.buffer = buf; src.connect(off.destination); src.start();
    const mix = await off.startRendering(), ctx = E.ensure();
    return new Promise((resolve, reject) => {
      const parts = [];
      IO._stem = {
        result: (i, data) => { parts[i] = ctx.decodeAudioData(unb64(data).buffer); },
        done: () => Promise.all(parts).then(resolve, reject),
        fail: (m) => reject(new Error(m)),
        progress: onProgress || (() => {}),
      };
      IO.host().postMessage({ op: 'stems', b64: b64(IO.wav(mix)) });
    });
  };
  IO.stemResult = (i, data) => IO._stem && IO._stem.result(i, data);
  IO.stemsDone = () => IO._stem && IO._stem.done();
  IO.stemsFailed = (m) => IO._stem && IO._stem.fail(m);
  IO.stemProgress = (f) => IO._stem && IO._stem.progress(f);
  // Called by the Mac shell when a recording pass has been captured.
  IO.recorded = async (data, inputLatency) => {
    try {
      const ctx = E.ensure(), buf = await ctx.decodeAudioData(unb64(data).buffer), id = S.uid();
      S.buffers[id] = { id, name: 'Recording', buf, bpm: S.proj.bpm };
      S.ui.recorded(S.buffers[id], inputLatency || 0);
    } catch (e) { S.ui.toast('The recording could not be read: ' + (e.message || e), true); }
  };

  // Recording without the Mac app: the browser's own microphone access (Windows, phones, tablets, browsers).
  IO.webRec = {
    async start(monitor) {
      const ctx = E.ensure();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 2, 2), sink = ctx.createGain(), L = [], R = [];
        sink.gain.value = 0;
        proc.onaudioprocess = (e) => {
          const a = e.inputBuffer;
          L.push(new Float32Array(a.getChannelData(0)));
          R.push(new Float32Array(a.getChannelData(Math.min(1, a.numberOfChannels - 1))));
        };
        src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
        if (monitor) src.connect(ctx.destination);
        IO.webRec.cur = { stream, src, proc, sink, L, R };
        S.ui.recStarted();
      } catch (e) {
        S.ui.recFailed(e && e.name === 'NotAllowedError' ? 'microphone access was not allowed. Allow it in your browser or system settings and try again' : 'no microphone was found (' + (e.message || e) + ')');
      }
    },
    stop() {
      const r = IO.webRec.cur; if (!r) return;
      IO.webRec.cur = null;
      r.stream.getTracks().forEach((t) => t.stop());
      try { r.src.disconnect(); r.proc.disconnect(); r.sink.disconnect(); } catch (e) {}
      const ctx = E.ensure(), n = r.L.reduce((a, b) => a + b.length, 0);
      if (!n) return S.ui.toast('Nothing was recorded.', true);
      const buf = ctx.createBuffer(2, n, ctx.sampleRate);
      let o = 0;
      for (let i = 0; i < r.L.length; i++) { buf.getChannelData(0).set(r.L[i], o); buf.getChannelData(1).set(r.R[i], o); o += r.L[i].length; }
      const id = S.uid();
      S.buffers[id] = { id, name: 'Recording', buf, bpm: S.proj.bpm };
      S.ui.recorded(S.buffers[id], (ctx.baseLatency || 0) + (ctx.outputLatency || 0));
    },
  };

  IO.wav = (buf) => {
    const nCh = Math.min(2, buf.numberOfChannels), n = buf.length, out = new DataView(new ArrayBuffer(44 + n * nCh * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * nCh * 2, true); str(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
    out.setUint16(22, nCh, true); out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * nCh * 2, true);
    out.setUint16(32, nCh * 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * nCh * 2, true);
    const ch = []; for (let c = 0; c < nCh; c++) ch.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) { const v = Math.max(-1, Math.min(1, ch[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
    return new Uint8Array(out.buffer);
  };

  // The whole project as one .stratum file: notes, mix and every piece of audio it uses.
  IO.projectJSON = async () => {
    if (S.plug) await S.plug.capture();
    const used = new Set();
    for (const t of S.proj.tracks) {
      for (const k in t.pads || {}) used.add(t.pads[k].audio);
      if (t.inst && t.inst.sample) used.add(t.inst.sample.audio);
      for (const k in t.clips) if (t.clips[k].audio) used.add(t.clips[k].audio);
      for (const r of t.regions) { if (r.clip.audio) used.add(r.clip.audio); for (const tk of r.takes || []) used.add(tk.audio); }
    }
    const buffers = {};
    used.forEach((id) => { const r = S.buffers[id]; if (r) buffers[id] = { name: r.name, bpm: r.bpm, wav: b64(IO.wav(r.buf)) }; });
    return JSON.stringify({ stratum: 1, proj: S.proj, buffers });
  };
  IO.saveProject = async () => IO.saveFile((S.proj.name || 'Untitled') + '.stratum', await IO.projectJSON());
  IO.loadProject = async (text) => {
    const j = JSON.parse(text);
    if (!j.stratum || !j.proj) throw new Error('Not a STRATUM project file');
    const ctx = E.ensure();
    for (const id in j.buffers || {}) {
      const b = j.buffers[id];
      S.buffers[id] = { id, name: b.name, bpm: b.bpm, buf: await ctx.decodeAudioData(unb64(b.wav).buffer) };
    }
    return S.migrate(j.proj);
  };

  IO.addAudio = async (name, ab) => {
    const ctx = E.ensure(), buf = await ctx.decodeAudioData(ab), id = S.uid(), bpm = D.detectBpm(buf);
    S.buffers[id] = { id, name, buf, bpm };
    return S.buffers[id];
  };
  // Clip length in bars once the audio is warped to the project tempo.
  IO.audioBars = (rec, warp) => {
    const beats = rec.buf.duration * ((warp && rec.bpm ? rec.bpm : S.proj.bpm) / 60);
    return Math.max(1, Math.round(beats / 4));
  };

  // ---- MIDI ----
  IO.midiOut = (proj) => {
    const PPQ = 480, total = E.songBeats(proj), mode = total ? 'song' : 'scene', beats = total || proj.scenes[0].bars * 4, per = new Map();
    E.walk(proj, mode, proj.scenes[0].id, 0, beats, (tr, kind, beat, n) => {
      if (kind !== 'note') return;
      if (!per.has(tr)) per.set(tr, []);
      per.get(tr).push({ t: beat, d: n.d, p: tr.type === 'drums' ? S.drumMap(n.p) : n.p, v: n.v == null ? 0.8 : n.v });
    });
    const vlq = (v) => { const o = [v & 0x7f]; while ((v >>= 7)) o.unshift((v & 0x7f) | 0x80); return o; };
    const chunk = (id, body) => [...enc.encode(id), (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
    const meta = (type, bytes) => [0, 0xff, type, ...vlq(bytes.length), ...bytes];
    const us = Math.round(60000000 / proj.bpm);
    const tracks = [[...meta(0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]), ...meta(0x58, [4, 2, 24, 8]), 0, 0xff, 0x2f, 0]];
    let chn = 0;
    for (const tr of proj.tracks) {
      const notes = per.get(tr);
      if (!notes) continue;
      const ch = tr.type === 'drums' ? 9 : chn++ % 9, ev = [];
      for (const n of notes) {
        const a = Math.round(n.t * PPQ), z = Math.max(a + 1, Math.round((n.t + n.d) * PPQ));
        ev.push([a, 1, 0x90 | ch, n.p, Math.max(1, Math.round(n.v * 127))], [z, 0, 0x80 | ch, n.p, 0]);
      }
      ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      const body = [...meta(0x03, [...enc.encode(tr.name)])];
      let last = 0;
      for (const e of ev) { body.push(...vlq(e[0] - last), e[2], e[3], e[4]); last = e[0]; }
      body.push(0, 0xff, 0x2f, 0);
      tracks.push(body);
    }
    const head = chunk('MThd', [0, 1, (tracks.length >> 8) & 255, tracks.length & 255, PPQ >> 8, PPQ & 255]);
    return new Uint8Array([...head, ...tracks.flatMap((t) => chunk('MTrk', t))]);
  };
  IO.midiIn = (ab, name) => {
    const v = new DataView(ab);
    const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    if (tag(0) !== 'MThd') throw new Error('Not a MIDI file');
    const nTracks = v.getUint16(10), ppq = v.getUint16(12) & 0x7fff;
    let o = 8 + v.getUint32(4), bpm = 0;
    const tracks = [];
    for (let k = 0; k < nTracks && o < v.byteLength; k++) {
      const len = v.getUint32(o + 4), end = o + 8 + len;
      let p = o + 8, tick = 0, status = 0, tname = '', drums = false;
      const open = {}, notes = [];
      const vl = () => { let x = 0, b; do { b = v.getUint8(p++); x = (x << 7) | (b & 0x7f); } while (b & 0x80); return x; };
      while (p < end) {
        tick += vl();
        let b = v.getUint8(p);
        if (b & 0x80) { status = b; p++; }
        if (status === 0xff) {
          const type = v.getUint8(p++), l = vl();
          if (type === 0x51 && !bpm) bpm = 60000000 / ((v.getUint8(p) << 16) | (v.getUint8(p + 1) << 8) | v.getUint8(p + 2));
          if (type === 0x03) tname = new TextDecoder().decode(new Uint8Array(ab, p, l));
          p += l;
        } else if (status === 0xf0 || status === 0xf7) p += vl();
        else {
          const hi = status & 0xf0, ch = status & 15, d1 = v.getUint8(p++), d2 = hi === 0xc0 || hi === 0xd0 ? 0 : v.getUint8(p++);
          const key = ch + ':' + d1;
          if (hi === 0x90 && d2 > 0) { open[key] = { t: tick, v: d2 / 127 }; if (ch === 9) drums = true; }
          else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
            const s = open[key];
            if (s) { notes.push({ t: s.t / ppq, d: Math.max(0.05, (tick - s.t) / ppq), p: d1, v: s.v }); delete open[key]; }
          }
        }
      }
      o = end;
      if (notes.length) tracks.push({ name: tname || 'Track ' + (tracks.length + 1), type: drums ? 'drums' : 'synth', notes });
    }
    const bars = Math.max(1, ...tracks.map((t) => Math.ceil(Math.max(...t.notes.map((n) => n.t + n.d)) / 4)));
    return {
      proj: S.fromFlat({ name, bpm: bpm || 120, scenes: [{ name: 'Imported', bars }], tracks: tracks.map((t) => ({ name: t.name, type: t.type, clips: { 0: { bars, notes: t.notes } } })) }),
      report: `MIDI: ${tracks.length} tracks, ${bars} bars at ${Math.round(bpm || 120)} BPM.`,
    };
  };

  // ---- Ableton Live set (.als is gzip-compressed XML) ----
  IO.gunzip = async (ab) => {
    if (typeof DecompressionStream === 'undefined') throw new Error('This macOS version cannot decompress .als files (needs macOS 13.3 or newer)');
    return new Response(new Blob([ab]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  };
  IO.alsIn = (xml, name) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror') || !doc.querySelector('LiveSet')) throw new Error('Not a readable Ableton Live set');
    const num = (el, sel, def) => { const x = el && el.querySelector(sel); const v = x ? parseFloat(x.getAttribute('Value')) : NaN; return isNaN(v) ? def : v; };
    const bpm = num(doc, 'Tempo > Manual', 120);
    const clipNotes = (clip, from, len, loop) => {
      const raw = [];
      clip.querySelectorAll('KeyTracks > KeyTrack').forEach((kt) => {
        const key = num(kt, 'MidiKey', 60);
        kt.querySelectorAll('Notes > MidiNoteEvent').forEach((n) => {
          if (n.getAttribute('IsEnabled') === 'false') return;
          raw.push({ t: parseFloat(n.getAttribute('Time')), d: parseFloat(n.getAttribute('Duration')) || 0.25, p: key, v: Math.min(1, (parseFloat(n.getAttribute('Velocity')) || 100) / 127) });
        });
      });
      const out = [];
      if (loop) {
        // A looped clip starts playing StartRelative beats into its loop, then cycles the loop region.
        const L = Math.max(0.25, loop.end - loop.start), rel = loop.rel || 0;
        for (let k = 0; (k - 1) * L < len; k++)
          for (const n of raw) { const t = n.t - loop.start - rel + k * L; if (n.t >= loop.start && n.t < loop.end && t >= 0 && t < len) out.push({ ...n, t }); }
      } else for (const n of raw) { const t = n.t - from; if (t >= 0 && t < len) out.push({ ...n, t }); }
      return out;
    };
    const loopOf = (clip) => ({ on: (clip.querySelector('Loop > LoopOn') || { getAttribute: () => 'false' }).getAttribute('Value') === 'true', start: num(clip, 'Loop > LoopStart', 0), end: num(clip, 'Loop > LoopEnd', 4), rel: num(clip, 'Loop > StartRelative', 0) });
    const off = (clip) => { const d = clip.querySelector(':scope > Disabled'); return !!d && d.getAttribute('Value') === 'true'; };
    const tracks = [], sceneBars = {};
    let arrEnd = 0, audioTracks = 0, midiClips = 0;
    doc.querySelectorAll('Tracks > MidiTrack, Tracks > AudioTrack').forEach((t) => {
      const nameEl = t.querySelector('Name > EffectiveName'), tname = nameEl ? nameEl.getAttribute('Value') : 'Track';
      const isAudio = t.tagName === 'AudioTrack';
      if (isAudio) audioTracks++;
      const ft = { name: tname, type: isAudio ? 'audio' : t.querySelector('DrumGroupDevice') || /(^|[^a-z])(drums?|drum ?kit|percussion)([^a-z]|$)/i.test(tname) ? 'drums' : 'synth',
        vol: num(t, 'DeviceChain > Mixer > Volume > Manual', 0.8), pan: num(t, 'DeviceChain > Mixer > Pan > Manual', 0), clips: {}, arr: [] };
      t.querySelectorAll('MainSequencer > ClipTimeable > ArrangerAutomation > Events > MidiClip').forEach((c) => {
        if (off(c)) return;
        const start = parseFloat(c.getAttribute('Time')) || num(c, 'CurrentStart', 0), end = num(c, 'CurrentEnd', start + 4), lp = loopOf(c);
        for (const n of clipNotes(c, lp.start, end - start, lp.on ? lp : null)) ft.arr.push({ ...n, t: n.t + start });
        arrEnd = Math.max(arrEnd, end); midiClips++;
      });
      t.querySelectorAll('MainSequencer > ClipSlotList > ClipSlot').forEach((slot, i) => {
        const c = slot.querySelector('MidiClip');
        if (!c) return;
        const lp = loopOf(c), len = Math.max(1, lp.end - lp.start), notes = clipNotes(c, lp.start, len, { ...lp, rel: 0 });
        if (!notes.length) return;
        ft.clips['s' + i] = { bars: Math.ceil(len / 4), notes };
        sceneBars[i] = Math.max(sceneBars[i] || 1, Math.ceil(len / 4)); midiClips++;
      });
      tracks.push(ft);
    });
    const scenes = [], arrangement = [];
    if (arrEnd > 0) { scenes.push({ name: 'Arrangement', bars: Math.ceil(arrEnd / 4) }); arrangement.push({ scene: 0, reps: 1 }); }
    const slotIdx = {};
    Object.keys(sceneBars).map(Number).sort((a, b) => a - b).forEach((i) => { slotIdx[i] = scenes.length; scenes.push({ name: 'Scene ' + (i + 1), bars: sceneBars[i] }); });
    for (const ft of tracks) {
      const clips = {};
      if (ft.arr.length) clips[0] = { bars: scenes[0].bars, notes: ft.arr };
      for (const k in ft.clips) clips[slotIdx[k.slice(1)]] = ft.clips[k];
      ft.clips = clips;
    }
    if (!scenes.length) scenes.push({ name: 'Scene 1', bars: 4 });
    return {
      proj: S.fromFlat({ name, bpm, scenes, tracks, arrangement: arrangement.length ? arrangement : undefined }),
      report: `Ableton set: ${tracks.length} tracks, ${midiClips} MIDI clips, tempo ${Math.round(bpm)}. Track volume and pan kept.` +
        (audioTracks ? ` ${audioTracks} audio tracks came in empty: their audio files and all Live devices are not read.` : ' Live devices are not read; tracks use STRATUM instruments.'),
    };
  };

  // ---- FL Studio project (.flp event stream) ----
  IO.flpIn = (ab, name) => {
    const v = new DataView(ab), u8 = new Uint8Array(ab);
    const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    if (tag(0) !== 'FLhd') throw new Error('Not an FL Studio project');
    const ppq = v.getUint16(12, true) || 96;
    let o = 8 + v.getUint32(4, true);
    if (tag(o) !== 'FLdt') throw new Error('FL Studio data chunk missing');
    const end = Math.min(u8.length, o + 8 + v.getUint32(o + 4, true));
    o += 8;
    const text = (a, len) => {
      const b = u8.subarray(a, a + len), wide = len > 1 && b[1] === 0;
      return new TextDecoder(wide ? 'utf-16le' : 'latin1').decode(b).replace(/\0/g, '');
    };
    let bpm = 0, chan = -1, pat = 0, title = '';
    const clipItems = [], remotes = [], fxNames = [];
    let inMixer = false;
    const chans = {}, pats = {}, playlist = [];
    const ch = (i) => chans[i] || (chans[i] = { name: '', plugin: '' });
    while (o < end) {
      const id = u8[o++];
      if (id < 64) { if (id === 21 && chan >= 0) ch(chan).type = u8[o]; else if (id === 22 && chan >= 0 && !inMixer) ch(chan).routed = v.getInt8(o); o += 1; }
      else if (id < 128) { const w = v.getUint16(o, true); o += 2; if (id === 64) { chan = w; ch(w); inMixer = false; } else if (id === 98) inMixer = true; else if (id === 65) pat = w; else if (id === 66 && !bpm) bpm = w; }
      else if (id < 192) { const d = v.getUint32(o, true); o += 4; if (id === 156) bpm = d / 1000; }
      else {
        let len = 0, shift = 0, b;
        do { b = u8[o++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
        if (id === 192 && chan >= 0) ch(chan).name = text(o, len);
        else if (id === 196 && chan >= 0) ch(chan).sample = text(o, len);
        else if (id === 201) { if (inMixer) fxNames.push(text(o, len)); else if (chan >= 0) ch(chan).fl = text(o, len); }
        else if (id === 213 && !inMixer && chan >= 0 && ch(chan).fl === 'Fruity Wrapper') {
          // A hosted VST: a list of records (id, 64-bit length, data). 54 is the plugin's name, 56 its maker.
          const vst = {};
          for (let q = o + 4; q + 12 <= o + len;) {
            const rid = v.getUint32(q, true), rl = v.getUint32(q + 4, true);
            q += 12;
            if (q + rl > o + len) break;
            if (rid === 54) vst.name = text(q, rl); else if (rid === 56) vst.maker = text(q, rl);
            q += rl;
          }
          if (vst.name) ch(chan).vst = vst;
        }
        else if (id === 234 && chan >= 0 && len >= 21) {
          // Automation clip: points are 24 bytes each: time since the previous point in beats, value 0..1, tension, flags.
          const pts = [];
          for (let q = o + 21, n = v.getUint32(o + 17, true); n > 0 && q + 24 <= o + len; n--, q += 24) pts.push({ dt: v.getFloat64(q, true), v: v.getFloat64(q + 8, true) });
          ch(chan).auto = pts;
        }
        else if (id === 227 && len >= 12) remotes.push({ src: v.getUint16(o + 2, true), param: v.getUint16(o + 8, true), dest: v.getUint16(o + 10, true) });
        else if (id === 203 && chan >= 0 && !ch(chan).plugin) ch(chan).plugin = text(o, len);
        else if (id === 193) (pats[pat] || (pats[pat] = { notes: [] })).name = text(o, len);
        else if (id === 194) title = text(o, len);
        else if (id === 219 && chan >= 0 && len >= 8) { ch(chan).pan = v.getInt32(o, true) / 6400 - 1; ch(chan).vol = v.getUint32(o + 4, true) / 12800; }
        else if (id === 233 && !playlist.length) {
          // Playlist items are 32 bytes (60 from FL Studio 21, 80 from FL Studio 25); every item carries the constant 20480 at offset 4.
          const size = [32, 60, 80].find((z) => len >= z && len % z === 0 && v.getUint16(o + 4, true) === 20480 && (len < 2 * z || v.getUint16(o + z + 4, true) === 20480));
          for (let q = o; size && q + size <= o + len; q += size) {
            const base = v.getUint16(q + 4, true), idx = v.getUint16(q + 6, true);
            if (idx > base) playlist.push({ pat: idx - base, t: v.getUint32(q, true) / ppq, len: v.getUint32(q + 8, true) / ppq });
            else clipItems.push({ ch: idx, t: v.getUint32(q, true) / ppq, len: v.getUint32(q + 8, true) / ppq });
          }
        }
        else if (id === 224) {
          const P = pats[pat] || (pats[pat] = { notes: [] });
          for (let q = o; q + 24 <= o + len; q += 24) {
            const dur = v.getUint32(q + 8, true);
            P.notes.push({ ch: v.getUint16(q + 6, true), t: v.getUint32(q, true) / ppq, d: dur ? dur / ppq : 0.25, p: v.getUint16(q + 12, true) & 0x7f, v: Math.min(1, u8[q + 21] / 128) || 0.78 });
          }
        }
        o += len;
      }
    }
    const patIds = Object.keys(pats).map(Number).filter((k) => pats[k].notes.length).sort((a, b) => a - b);
    const scenes = patIds.map((k) => ({ name: pats[k].name || 'Pattern ' + k, bars: Math.max(1, Math.ceil(Math.max(...pats[k].notes.map((n) => n.t + n.d)) / 4)) }));
    const word = (re) => new RegExp('(^|[^a-z])(' + re + ')', 'i');
    const drumFor = (nm) => (word('kick|bd').test(nm) ? 36 : word('snare|sd').test(nm) ? 38 : word('clap').test(nm) ? 39 : word('open ?hat|ohh?').test(nm) ? 46 : word('hi-?hat|hat|hh').test(nm) ? 42 : word('tom').test(nm) ? 45 : word('rim').test(nm) ? 37 : word('perc|cowbell').test(nm) ? 56 : 0);
    // The playlist places patterns on a timeline; flatten it into one "Song" scene ahead of the patterns.
    const items = playlist.filter((it) => pats[it.pat] && pats[it.pat].notes.length && it.t < 8000);
    const songBars = items.length ? Math.max(1, Math.ceil(Math.max(...items.map((it) => it.t + (it.len || 4))) / 4)) : 0;
    const off = songBars ? 1 : 0;
    if (songBars) scenes.unshift({ name: 'Song', bars: songBars });
    const tracks = Object.keys(chans).map(Number).sort((a, b) => a - b).map((ci) => {
      const nm = chans[ci].name || chans[ci].plugin || 'Channel ' + (ci + 1), dp = chans[ci].fl === 'Fruit Kick' ? 36 : drumFor(nm), clips = {};
      const conv = (n, shift) => ({ t: n.t + shift, d: n.d, p: dp || n.p, v: n.v });
      patIds.forEach((k, si) => {
        const notes = pats[k].notes.filter((n) => n.ch === ci).map((n) => conv(n, 0));
        if (notes.length) clips[si + off] = { bars: scenes[si + off].bars, notes };
      });
      if (songBars) {
        const song = [];
        for (const it of items) for (const n of pats[it.pat].notes) if (n.ch === ci && (!it.len || n.t < it.len)) song.push(conv(n, it.t));
        if (song.length) clips[0] = { bars: songBars, notes: song };
      }
      return { name: nm, type: chans[ci].type === 4 ? 'audio' : dp ? 'drums' : 'synth', vol: chans[ci].vol, pan: chans[ci].pan, clips, ci, dp };
    }).filter((t) => chans[t.ci].type !== 5);   // automation clips are not tracks; they are read into automation below
    if (!tracks.length) throw new Error('No instrument channels found in this FL Studio project');
    const noteCount = patIds.reduce((a, k) => a + pats[k].notes.length, 0);
    if (!scenes.length) scenes.push({ name: 'Pattern 1', bars: 1 });
    const proj = S.fromFlat({ name: title || name, bpm: bpm || 140, scenes, tracks, arrangement: songBars ? [{ scene: 0, reps: 1 }] : undefined });
    // Sampler channels and playlist audio clips name a sample file; list them so the files can be found and loaded.
    proj.wanted = [];
    tracks.forEach((ft, i) => {
      const c = chans[ft.ci], t = proj.tracks[i];
      if (!c.sample || !t) return;
      const file = c.sample.split(/[\\/]/).pop();
      if (c.type === 4) proj.wanted.push({ t: t.id, kind: 'clip', path: c.sample, file, items: clipItems.filter((it) => it.ch === ft.ci).map((it) => ({ t: it.t, len: it.len })) });
      else if (!c.type) proj.wanted.push({ t: t.id, kind: 'inst', path: c.sample, file, pitch: ft.dp || 0 });
    });
    const audioClips = clipItems.filter((it) => chans[it.ch] && chans[it.ch].type === 4).length;
    // FL Studio's own instruments cannot be recreated; a few get a stand-in built-in sound, hosted VSTs are looked up later.
    const STAND = { BooBass: { wave: 'sine', wave2: 'triangle', detune: 0, attack: 0.01, release: 0.15, cutoff: 0.35, res: 0.1 }, 'Plucked!': { wave: 'sawtooth', wave2: 'triangle', detune: 0.05, attack: 0, release: 0.35, cutoff: 0.7, res: 0.1 } };
    const standIns = [], trackOf = {};
    proj.wantPlugins = [];
    tracks.forEach((ft, i) => {
      const c = chans[ft.ci], t = proj.tracks[i];
      trackOf[ft.ci] = t;
      if (!t || c.type !== 2 || !c.fl) return;
      if (c.vst) return proj.wantPlugins.push({ t: t.id, name: c.vst.name, maker: c.vst.maker || '' });
      if (STAND[c.fl] && t.inst) Object.assign(t.inst, STAND[c.fl]);
      standIns.push(c.fl);
    });
    // Automation clips: each is linked to what it controls and placed on the playlist. Channel volume and pan, mixer track
    // volume and pan, and master volume become automation in STRATUM; anything else is counted and left out.
    let autoRead = 0, autoSkipped = 0;
    const lane = (obj, key, pts) => { if (!pts.length) return; obj.auto = obj.auto || {}; obj.auto[key] = (obj.auto[key] || []).concat(pts).sort((a, b) => a.t - b.t); autoRead++; };
    for (const rc of remotes) {
      const c = chans[rc.src], items = clipItems.filter((it) => it.ch === rc.src);
      if (!c || !c.auto || !items.length) { autoSkipped++; continue; }
      const curve = (fn) => { const out = []; for (const it of items) { let at = 0; for (const p of c.auto) { at += p.dt; if (it.len && at > it.len + 1e-6) break; out.push({ t: it.t + at, v: fn(Math.min(1, Math.max(0, p.v))) }); } } return out; };
      const before = autoRead;
      const masterFree = !(proj.master.auto && proj.master.auto.vol);
      if (rc.dest & 0x4000) { if (rc.param === 0 && masterFree) lane(proj.master, 'vol', curve((x) => Math.min(1.25, (proj.master.vol * x) / 0.8))); }
      else if (rc.dest & 0x2000) {
        const ins = (rc.dest - 0x2000) >> 6, vol = rc.param === 0x1fc0, pan = rc.param === 0x1fc1;
        if (ins === 0 && vol) { if (masterFree) lane(proj.master, 'vol', curve((x) => Math.min(1.25, (proj.master.vol * x) / 0.8))); }
        else if (vol || pan) for (const ft of tracks) { const t = trackOf[ft.ci]; if (!t || (chans[ft.ci].routed || 0) !== ins || (t.auto && t.auto[vol ? 'vol' : 'pan'])) continue; lane(t, vol ? 'vol' : 'pan', curve(vol ? (x) => Math.min(1.25, (t.vol * x) / 0.8) : (x) => x * 2 - 1)); }
      } else {
        const t = trackOf[rc.dest];
        if (t && rc.param === 0) lane(t, 'vol', curve((x) => Math.min(1.25, x)));
        else if (t && rc.param === 1) lane(t, 'pan', curve((x) => x * 2 - 1));
      }
      if (autoRead === before) autoSkipped++;
    }
    const fxUsed = [...new Set(fxNames.filter(Boolean))], fake = [...new Set(standIns)];
    return {
      proj,
      report: `FL Studio project: ${tracks.length} channels, ${patIds.length} patterns, ${noteCount} notes, ` + (bpm ? `tempo ${Math.round(bpm)}` : 'tempo not found in the file so it is set to 140') + ', channel volume and pan kept. ' +
        (proj.wanted.length ? `It uses ${proj.wanted.length} sample files` + (audioClips ? ` (${audioClips} audio clips on the playlist)` : '') + '. An .flp only points at those files, so STRATUM looks for them on this Mac; use “Missing samples” to choose any it cannot find. ' : '') +
        (noteCount ? '' : 'This project has no pattern notes (it is built from audio or automation clips), so the tracks came in empty. ') +
        (songBars ? `The playlist was read into a ${songBars}-bar “Song” scene.` : 'No playlist found, so each pattern is placed once in the arrangement.') + ' ' + (autoRead ? `${autoRead} automation lanes read (volume and pan). ` : '') + (autoSkipped ? `${autoSkipped} automation clips control things STRATUM cannot automate (tempo, pitch or plugin settings) and were left out. ` : '') +
        (fake.length ? `FL Studio's own instruments cannot be recreated, so these play on a stand-in built-in sound: ${fake.join(', ')}. ` : '') +
        (fxUsed.length ? `Mixer effects not carried over: ${fxUsed.join(', ')}.` : ''),
    };
  };

  // ---- Reason song (.reason, Reason 6 and later) ----
  // The file is a paged container ("X15_FILE"): a directory page lists streams as page chains. One stream is the song as
  // IFF chunks; each audio track's recording is its own stream of interleaved 32-bit float samples starting at byte 1024.
  // Positions are in ticks, 15360 to the quarter note.
  IO.reasonIn = (ab, name) => {
    const v = new DataView(ab), u8 = new Uint8Array(ab), TPQ = 15360;
    const ascii = (b, o, n) => String.fromCharCode.apply(null, b.subarray(o, o + n));
    if (ascii(u8, 0, 8) !== 'X15_FILE') throw new Error('Only songs saved by Reason 6 or later can be read');
    const P = v.getUint32(8), dir = 52 + Number(v.getBigUint64(24)) * P;
    if (!P || dir + 12 > u8.length || v.getUint32(dir) !== 0xffffffff) throw new Error('The Reason song directory could not be found');
    const streams = {};
    for (let i = v.getUint32(dir + 8), o = dir + 12; i > 0 && o + 20 <= u8.length; i--) {
      const id = v.getUint32(o), len = Number(v.getBigUint64(o + 4)), np = Number(v.getBigUint64(o + 12)), pages = [];
      o += 20;
      for (let k = 0; k < np && o + 8 <= u8.length; k++, o += 8) pages.push(Number(v.getBigUint64(o)));
      o += 4;
      streams[id] = { len, pages };
    }
    const load = (st) => {
      const out = new Uint8Array(st.len);
      st.pages.forEach((pg, i) => { const at = i * P; if (at < st.len) out.set(u8.subarray(52 + pg * P, 52 + pg * P + Math.min(P, st.len - at)), at); });
      return out;
    };
    const first = (st, n) => (st.pages.length ? ascii(u8, 52 + st.pages[0] * P, n) : '');
    const songStream = Object.values(streams).find((st) => first(st, 4) === 'FORM');
    if (!songStream) throw new Error('No song data found in this Reason file');
    const song = load(songStream), sv = new DataView(song.buffer);
    const kids = (o, end) => {
      const out = [];
      while (o + 8 <= end) {
        const t = ascii(song, o, 4), n = sv.getUint32(o + 4);
        if (!/^[ -~]{4}$/.test(t) || o + 8 + n > end) break;
        const group = t === 'FORM' || t === 'CAT ' || t === 'LIST';
        out.push({ t: group ? ascii(song, o + 8, 4) : t, group, o: o + (group ? 12 : 8), end: o + 8 + n });
        o += 8 + n + (n & 1);
      }
      return out;
    };
    const all = (node, t, out) => { out = out || []; for (const k of kids(node.o, node.end)) { if (k.t === t) out.push(k); else if (k.group) all(k, t, out); } return out; };
    const child = (node, t) => kids(node.o, node.end).find((k) => k.t === t);
    const text = (o, end) => { const n = o + 4 <= end ? sv.getUint32(o) : 0; return o + 4 + n <= end ? { s: new TextDecoder().decode(song.subarray(o + 4, o + 4 + n)).trim(), next: o + 4 + n } : { s: '', next: end }; };
    // The song proper is a "CAT RS10" group wrapped in a BODY chunk after the embedded sample bank.
    const body = all({ o: 0, end: song.length }, 'BODY').filter((k) => k.end - k.o > 64).pop();
    let rs = null;
    for (let o = body ? body.o : song.length; body && o < body.o + 1024; o++) if (ascii(song, o, 4) === 'CAT ' && ascii(song, o + 8, 4) === 'RS10') { rs = kids(o, body.end)[0]; break; }
    if (!rs) throw new Error('No song data found in this Reason file');
    const devices = {};
    for (const dv of all(rs, 'DEVI')) {
      const ds = child(dv, 'DESC');
      if (!ds || ds.end - ds.o < 14) continue;
      const nm = text(ds.o + 10, ds.end);
      devices[sv.getUint32(ds.o + 6)] = { name: nm.s, kind: text(nm.next + 9, ds.end).s };
    }
    const seq = child(rs, 'SQCT'), head = seq && child(seq, 'TRDC');
    let bpm = head && head.end - head.o >= 29 ? sv.getUint32(head.o + 23) / 1000 : 0;
    const tempoRead = bpm >= 20 && bpm <= 999;
    if (!tempoRead) bpm = 120;
    const p = S.blankProject();
    p.name = name; p.bpm = Math.min(300, Math.max(30, bpm)); p.scale = 'Chromatic';
    if (!p.scenes.length) S.newScene(p, 'Scene 1', 1);
    S.migrate(p);
    const ctx = E.ensure(), used = [];
    let nClips = 0, nNotes = 0, nAudio = 0, nMuted = 0, nLost = 0;
    for (const tk of seq ? all(seq, 'TRFM') : []) {
      const td = child(tk, 'TRDC'), clips = all(tk, 'SNIF');
      if (!td || td.end - td.o < 14 || !clips.length) continue;
      const dev = devices[sv.getUint32(td.o + 9)] || { name: '', kind: '' }, ri = all(tk, 'TRRI')[0], tm = all(tk, 'TRTM')[0];
      let rec = null;
      if (ri && ri.end - ri.o >= 21) {
        const st = streams[sv.getUint32(ri.o + 13)], pg = st && st.pages.length ? 52 + st.pages[0] * P : -1;
        if (pg >= 0 && v.getUint32(pg) === 0x0513a997 && st.len > 1032) {
          const ch = Math.min(2, Math.max(1, v.getUint32(pg + 9))), sr = v.getUint32(pg + 13) || 44100, raw = load(st);
          const frames = Math.floor((raw.length - 1024) / (4 * ch)), f = new DataView(raw.buffer), buf = ctx.createBuffer(ch, frames, sr), id = S.uid();
          for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0, q = 1024 + 4 * c; i < frames; i++, q += 4 * ch) d[i] = f.getFloat32(q, true); }
          const own = tm && tm.end - tm.o >= 14 ? sv.getUint32(tm.o + 10) / 1000 : 0;
          rec = S.buffers[id] = { id, name: text(ri.o + 29, ri.end).s || dev.name || 'Audio', buf, bpm: own >= 20 && own <= 999 ? own : p.bpm };
        } else nLost++;
      }
      const drums = !ri && /kong|redrum|drum/i.test(dev.kind);
      const t = S.newTrack(p, ri ? 'audio' : drums ? 'drums' : 'synth', dev.name || (ri ? 'Audio' : dev.kind) || 'Track');
      t.mute = sv.getUint8(td.o + 13) === 1;
      if (!ri && dev.kind) used.push(dev.kind);
      for (const cl of clips) {
        const ic = child(cl, 'SNIC');
        if (!ic || ic.end - ic.o < 26) continue;
        let start = sv.getUint32(ic.o + 5) / TPQ, len = sv.getUint32(ic.o + 9) / TPQ;
        if (sv.getUint8(ic.o + 25) === 1) { nMuted++; continue; }
        if (ri) {
          const ac = all(cl, 'ACRC')[0];
          if (!rec || !ac) continue;
          let off = -sv.getInt32(ac.o + 5) / TPQ;
          const beats = rec.buf.duration * rec.bpm / 60, bars = Math.max(1, Math.ceil(beats / 4));
          if (off < 0) { start -= off; len += off; off = 0; }
          len = Math.min(len, bars * 4 - off);
          if (len <= 0) continue;
          t.regions.push({ id: S.uid(), start, len, off, clip: { audio: rec.id, warp: Math.abs(rec.bpm - p.bpm) > 0.01, bars, gain: 1 } });
          nClips++; nAudio++;
          continue;
        }
        const ev = child(cl, 'SNTE'), notes = [];
        if (!ev) continue;
        let o = ev.o + 9, at = 0;
        const vlq = () => { let x = 0, b; do { b = song[o++]; x = (x << 7) | (b & 0x7f); } while (b & 0x80 && o < ev.end); return x | 0; };
        for (let i = sv.getUint32(ev.o + 5); i > 0 && o < ev.end; i--) {
          at += vlq();
          const pitch = song[o++], vel = song[o++], dur = vlq();
          o++;
          const tb = at / TPQ;
          if (tb >= 0 && tb < len) notes.push({ t: tb, d: Math.max(0.05, Math.min(dur / TPQ, len - tb)), p: drums ? S.drumMap(pitch) : pitch, v: Math.max(0.05, vel / 127) });
        }
        if (!notes.length) continue;
        notes.sort((a, b) => a.t - b.t);
        t.regions.push({ id: S.uid(), start, len, off: 0, clip: { bars: Math.max(1, Math.ceil(len / 4)), notes } });
        nClips++; nNotes += notes.length;
      }
    }
    if (!p.tracks.length) throw new Error('No sequencer tracks with clips found in this Reason song');
    const kinds = [...new Set(used)];
    return {
      proj: p,
      report: `Reason song: ${p.tracks.length} tracks, ${nClips} clips (${nAudio} audio), ${nNotes} notes, ` + (tempoRead ? `tempo ${+p.bpm.toFixed(2)}. ` : 'tempo not found, set to 120. ') +
        'Audio recordings came in with their clip positions and are stretched to the song tempo. ' +
        (kinds.length ? `Reason devices are not recreated: ${kinds.join(', ')} tracks play on STRATUM's built-in sounds. ` : '') +
        (nMuted ? `${nMuted} muted clips were left out. ` : '') + (nLost ? `${nLost} audio tracks had no readable recording. ` : '') +
        'Mixer levels, effects, automation and samples inside devices are not read. To bring a device\'s real sound across, bounce its track to audio in Reason and save the song again: audio tracks come in as recorded.',
    };
  };

  // ---- DAWproject export (zip of project.xml + metadata.xml, stored uncompressed) ----
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u) => { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = crcTable[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  IO.zip = (files) => {
    const parts = [], central = [];
    let off = 0;
    const rec = (sig, extra, nameB, crc, size, tail) => {
      const b = new DataView(new ArrayBuffer(extra + nameB.length));
      b.setUint32(0, sig, true);
      let p = 4;
      if (extra === 46) { b.setUint16(p, 20, true); p += 2; }
      b.setUint16(p, 20, true); p += 2; b.setUint16(p, 0x0800, true); p += 2; b.setUint16(p, 0, true); p += 2; b.setUint32(p, 0x00210000, true); p += 4;
      b.setUint32(p, crc, true); p += 4; b.setUint32(p, size, true); p += 4; b.setUint32(p, size, true); p += 4; b.setUint16(p, nameB.length, true); p += 2; b.setUint16(p, 0, true); p += 2;
      if (extra === 46) { p += 10; b.setUint32(p, tail, true); p += 4; }
      const u = new Uint8Array(b.buffer); u.set(nameB, extra);
      return u;
    };
    for (const [fname, data] of files) {
      const nameB = enc.encode(fname), crc = crc32(data), local = rec(0x04034b50, 30, nameB, crc, data.length);
      central.push(rec(0x02014b50, 46, nameB, crc, data.length, off));
      parts.push(local, data);
      off += local.length + data.length;
    }
    const csize = central.reduce((a, c) => a + c.length, 0), eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true); eocd.setUint32(12, csize, true); eocd.setUint32(16, off, true);
    const all = [...parts, ...central, new Uint8Array(eocd.buffer)], out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
    let q = 0;
    for (const c of all) { out.set(c, q); q += c.length; }
    return out;
  };
  IO.dawprojectOut = (proj) => {
    const x = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const total = E.songBeats(proj), mode = total ? 'song' : 'scene', beats = total || proj.scenes[0].bars * 4, per = new Map();
    E.walk(proj, mode, proj.scenes[0].id, 0, beats, (tr, kind, beat, n) => { if (kind === 'note') { if (!per.has(tr)) per.set(tr, []); per.get(tr).push({ t: beat, n }); } });
    let st = '', lanes = '';
    proj.tracks.forEach((tr, i) => {
      st += `    <Track contentType="${tr.type === 'audio' ? 'audio' : 'notes'}" loaded="true" id="t${i}" name="${x(tr.name)}" color="${tr.color}">
      <Channel audioChannels="2" destination="chM" role="regular" solo="${tr.solo}" id="ch${i}">
        <Mute value="${tr.mute}" id="mu${i}" name="Mute"/>
        <Pan max="1.000000" min="0.000000" unit="normalized" value="${((tr.pan + 1) / 2).toFixed(6)}" id="pa${i}" name="Pan"/>
        <Volume max="2.000000" min="0.000000" unit="linear" value="${tr.vol.toFixed(6)}" id="vo${i}" name="Volume"/>
      </Channel>
    </Track>\n`;
      const notes = per.get(tr);
      if (!notes) return;
      lanes += `      <Lanes track="t${i}" id="ln${i}">\n        <Clips id="cl${i}">\n          <Clip time="0.0" duration="${beats.toFixed(4)}" playStart="0.0" name="${x(tr.name)}">\n            <Notes id="nt${i}">\n` +
        notes.map(({ t, n }) => `              <Note time="${t.toFixed(5)}" duration="${n.d.toFixed(5)}" channel="${tr.type === 'drums' ? 9 : 0}" key="${tr.type === 'drums' ? S.drumMap(n.p) : n.p}" vel="${(n.v == null ? 0.8 : n.v).toFixed(4)}" rel="0.5"/>`).join('\n') +
        `\n            </Notes>\n          </Clip>\n        </Clips>\n      </Lanes>\n`;
    });
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project version="1.0">
  <Application name="STRATUM" version="${S.VERSION}"/>
  <Transport>
    <Tempo max="666.000000" min="20.000000" unit="bpm" value="${proj.bpm.toFixed(6)}" id="tempo" name="Tempo"/>
    <TimeSignature denominator="4" numerator="4" id="tsig"/>
  </Transport>
  <Structure>
${st}    <Track contentType="audio notes" loaded="true" id="tM" name="Master">
      <Channel audioChannels="2" role="master" solo="false" id="chM">
        <Volume max="2.000000" min="0.000000" unit="linear" value="${proj.master.vol.toFixed(6)}" id="voM" name="Volume"/>
      </Channel>
    </Track>
  </Structure>
  <Arrangement id="arr">
    <Lanes timeUnit="beats" id="lnRoot">
${lanes}    </Lanes>
  </Arrangement>
  <Scenes/>
</Project>\n`;
    const meta = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<MetaData>\n  <Title>${x(proj.name)}</Title>\n</MetaData>\n`;
    return IO.zip([['project.xml', enc.encode(xml)], ['metadata.xml', enc.encode(meta)]]);
  };

  // The whole song (or the current scene when nothing is arranged) rendered offline, plugin tracks included.
  IO.mixdown = async () => {
    const proj = S.proj, total = E.songBeats(proj), song = total > 0, scene = S.ui.currentScene();
    S.ui.toast('Rendering audio…');
    await new Promise((r) => setTimeout(r, 30));
    const buf = await E.render(proj, song ? 'song' : 'scene', scene.id, song ? total : scene.bars * 4 * 4);
    return S.plug.mixInto(buf, E.plugEvents);
  };
  // Share: render the mixdown (optionally only the first `clip` seconds, faded out), then let the Mac app make the branded
  // video and audio file and hand them to Messages, Mail, AirDrop or an upload page.
  // `local`: return the audio instead of handing it to the Mac app (used when the video is drawn here, from Visuals).
  IO.share = async (target, title, artist, clip, local) => {
    const full = await IO.mixdown(), sr = full.sampleRate, n = clip ? Math.min(full.length, Math.round(clip * sr)) : full.length;
    const buf = E.ensure().createBuffer(2, n, sr), fade = n < full.length ? Math.min(n, Math.round(1.5 * sr)) : 0;
    for (let c = 0; c < 2; c++) {
      const from = full.getChannelData(Math.min(c, full.numberOfChannels - 1)), to = buf.getChannelData(c);
      for (let i = 0; i < n; i++) to[i] = from[i] * (i >= n - fade ? (n - i) / fade : 1);
    }
    const bins = 96, peaks = [], L = buf.getChannelData(0), R = buf.getChannelData(1);
    for (let b = 0; b < bins; b++) { let m = 0; for (let i = Math.floor((b * n) / bins), e = Math.floor(((b + 1) * n) / bins); i < e; i += 4) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i])); peaks.push(m); }
    const top = Math.max(1e-6, ...peaks);
    if (!native() || local) return { buf, peaks: peaks.map((p) => p / top) };
    native().postMessage({ op: 'share', target, title, artist, peaks: peaks.map((p) => +(p / top).toFixed(3)), b64: b64(IO.wav(buf)) });
  };
  // ---- built-in sound library (CC0 sounds bundled with the Mac app) ----
  // The sound library: the Mac app reads it from inside the app; Windows, phones, tablets and browsers fetch it from the
  // library folder next to the page.
  const libURL = (path) => 'library/' + path.split('/').map(encodeURIComponent).join('/');
  IO.libList = async () => IO._lib || (IO._lib = native() ? JSON.parse((await S.plug.ask({ op: 'libList' })) || '[]')
    : await fetch('library/library.json').then((r) => (r.ok ? r.json() : [])).catch(() => []));
  IO.libRead = async (path) => {
    if (!native()) return fetch(libURL(path)).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
    const b = await S.plug.ask({ op: 'libRead', path }); return b ? unb64(b).buffer : null;
  };
  IO.exportAs = async (kind) => {
    const proj = S.proj, base = proj.name || 'Untitled';
    if (kind === 'mid') return IO.saveFile(base + '.mid', IO.midiOut(proj));
    if (kind === 'dawproject') return IO.saveFile(base + '.dawproject', IO.dawprojectOut(proj));
    if (kind === 'wav') {
      const buf = await IO.mixdown();
      IO.saveFile(base + '.wav', IO.wav(buf));
      S.ui.toast('Mixdown rendered: ' + buf.duration.toFixed(1) + ' s');
    }
  };

  // Returns {proj, report} for session formats, or {audio: rec} for audio files.
  IO.importBytes = async (fname, ab) => {
    const ext = (fname.split('.').pop() || '').toLowerCase(), base = fname.replace(/\.[^.]+$/, '');
    try {
      let res;
      if (ext === 'stratum' || ext === 'json') res = { proj: await IO.loadProject(new TextDecoder().decode(ab)), report: 'Project opened.' };
      else if (ext === 'mid' || ext === 'midi') res = IO.midiIn(ab, base);
      else if (ext === 'als') res = IO.alsIn(await IO.gunzip(ab), base);
      else if (ext === 'flp') res = IO.flpIn(ab, base);
      else if (ext === 'zip') {
        // FL Studio zipped loop package: the project plus the samples it uses.
        const files = await IO.unzip(ab), flp = files.find((f) => /\.flp$/i.test(f.name));
        if (!flp && files.some((f) => /\.logicx\//i.test(f.name))) {
          const map = {}, nm = (files.find((f) => /\.logicx\//i.test(f.name)).name.match(/([^/]+)\.logicx\//i) || [])[1] || base;
          for (const f of files) { const m = f.name.match(/\.logicx\/(.*)$/i); if (m && m[1] && !/(^|\/)\._/.test(m[1])) map[m[1]] = f.data; }
          res = await IO.logicIn(map, nm);
          S.ui.imported(res);
          if (res.proj.wantPlugins && res.proj.wantPlugins.length) await IO.matchPlugins();
          return;
        }
        if (!flp) throw new Error('No FL Studio or Logic Pro project found inside this zip');
        res = IO.flpIn(flp.data, flp.name.split('/').pop().replace(/\.flp$/i, ''));
        S.ui.imported(res);
        let n = 0;
        for (const f of files) if (f !== flp && (await IO.offer(f.name, f.data).catch(() => false))) n++;
        S.ui.wantedDone(n);
        return IO.matchPlugins();
      }
      else if (ext === 'reason') res = IO.reasonIn(ab, base);
      else if (['rns', 'ptx', 'ptf', 'omf', 'aaf', 'dawproject'].includes(ext)) throw new Error('.' + ext + ' files cannot be opened in this version');
      else if (S.ui.pendingWave && !['stratum', 'json', 'mid', 'midi', 'als', 'flp', 'zip', 'reason'].includes(ext)) {
        // Audio becomes a wavetable for STRATUM Wave: up to 64 single cycles of 2048 samples, evenly spaced through the file.
        const w = S.ui.pendingWave, buf = await E.ensure().decodeAudioData(ab), n = buf.length, mono = new Float32Array(n);
        for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels; }
        const frames = n < 2048 ? 1 : Math.min(64, Math.floor(n / 2048)), out = new Float32Array(frames * 2048);
        for (let f = 0; f < frames; f++) {
          if (n < 2048) { for (let i = 0; i < 2048; i++) out[i] = mono[Math.floor((i * n) / 2048)]; continue; }
          const at = frames > 1 ? Math.round((f * (n - 2048)) / (frames - 1)) : 0;
          out.set(mono.subarray(at, at + 2048), f * 2048);
        }
        const ok = await S.plug.ask({ op: 'auWaveTable', t: w.t, osc: w.osc, name: base, b64: b64(new Uint8Array(out.buffer)) });
        S.ui.toast(ok ? `Wavetable loaded on oscillator ${w.osc ? 'B' : 'A'}: ${base} (${frames} frame${frames === 1 ? '' : 's'}).` : 'The wavetable could not be loaded.', !ok);
        S.ui.refresh();
        return;
      }
      else if (S.ui.locating) { if (await IO.offer(fname, ab)) S.ui.located++; return; }
      else res = { audio: await IO.addAudio(fname, ab) };
      S.ui.imported(res);
      if (res.proj && res.proj.wanted && res.proj.wanted.length) await IO.seek();
      if (res.proj && res.proj.wantPlugins && res.proj.wantPlugins.length) await IO.matchPlugins();
    } catch (e) {
      S.ui.toast('Could not open ' + fname + ': ' + (e.message || e), true);
    }
  };
})();
