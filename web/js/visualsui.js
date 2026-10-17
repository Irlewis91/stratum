// The STRATUM Visuals window: full-window visuals that follow the mix (or one track), with controls along the bottom,
// presets, grids, performance keys, and presets that change with the song's scenes.
(function () {
  const S = window.S, V = S.vis, U = S.ui, E = S.engine, IO = S.io;
  const $ = (q) => document.querySelector(q);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const USER = 'stratum.visuals.presets';
  const userPresets = () => { try { return JSON.parse(localStorage.getItem(USER) || '{}'); } catch (e) { return {}; } };
  const allPresets = () => ({ ...V.FACTORY, ...userPresets() });
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Settings live in the project, so they save and sync with the beat.
  const cfg = () => {
    const p = S.proj;
    if (!p.visuals) p.visuals = { tiles: [V.defaults()], grid: [1, 1], link: true, sel: 0, source: 'master', tempo: true, slots: ['Warm Lamp', 'Hyperdrive', 'Digital Rain', 'Old School Plasma', 'Brick Party', 'Dead Channel', '8-Bit EQ', 'Title Pulse', 'Green Screen'], follow: {}, followOn: false, image: null };
    const c = p.visuals; c.tiles = c.tiles && c.tiles.length ? c.tiles : [V.defaults()];
    return c;
  };
  const cur = () => { const c = cfg(); return c.tiles[Math.min(c.sel || 0, c.tiles.length - 1)]; };

  let R = null, A = null, anNode = null, raf = 0, last = 0, tiles = [], perf = { flash: 0, shake: 0, invert: false, black: 0 }, overlayG = null, tab = 'mode', lastFollow = null, imgEl = null, imgKey = null;

  function analyser() {
    const ctx = E.ensure(); if (!E.graph) E.rebuild();
    const c = cfg(), node = c.source !== 'master' && E.graph.tracks[c.source] ? E.graph.tracks[c.source].an : E.graph.master.an;
    if (node !== anNode) { anNode = node; A = new V.Analyzer(node); }
    return ctx;
  }

  function syncTiles() {
    const c = cfg(), n = c.grid[0] * c.grid[1];
    while (c.tiles.length < n) c.tiles.push(clone(c.tiles[c.tiles.length - 1]));
    tiles = Array.from({ length: n }, (_, i) => tiles[i] || { st: {} });
    tiles.forEach((t, i) => {
      const base = c.link ? c.tiles[0] : c.tiles[i];
      if (c.link && i) {
        // Linked tiles share one look, each a step further along the same category.
        const m = V.modeOf(base.mode), same = V.MODES.filter((x) => x.cat === m.cat), k = same.indexOf(m);
        t.P = { ...base, mode: c.linkVary ? same[(k + i) % same.length].cat + '/' + same[(k + i) % same.length].name : base.mode };
      } else t.P = base;
    });
  }

  function size() {
    const cv = $('#visCanvas'), ov = $('#visOverlay'), box = $('#visuals'), dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = box.clientWidth * dpr, h = box.clientHeight * dpr; const k = Math.min(1, Math.sqrt((1920 * 1080) / (w * h))); w = Math.round(w * k); h = Math.round(h * k);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; ov.width = w; ov.height = h; }
  }

  function loadImage() {
    const c = cfg();
    if ((c.image || null) === imgKey) return;
    imgKey = c.image || null;
    if (!imgKey) { R.setImage(null); return; }
    imgEl = new Image(); imgEl.onload = () => R.setImage(imgEl); imgEl.src = imgKey;
  }

  function follow() {
    const c = cfg(); if (!c.followOn || !E.playing) return;
    let name = '';
    if (E.mode === 'song') { const b = E.beatAt(E.ctx.currentTime), sec = (S.proj.sections || []).find((s) => b >= s.start && b < s.start + s.len); name = sec ? sec.name : ''; }
    else { const sc = E.sceneById(E.sceneId); name = sc ? sc.name : ''; }
    const key = Object.keys(c.follow).find((k) => c.follow[k] && (name === k || name.startsWith(k + ' ')));
    if (key && key + c.follow[key] !== lastFollow) { lastFollow = key + c.follow[key]; applyPreset(c.follow[key], true); }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0.016); last = now;
    try {
      const ctx = analyser(), c = cfg();
      size(); syncTiles(); loadImage(); follow();
      A.read(ctx.currentTime, cur().gain || 1, c.tempo && E.playing ? E.beatAt(ctx.currentTime) : null);
      perf.flash *= 0.82; perf.shake *= 0.85;
      R.render(A, tiles, c.grid, perf, dt);
      if (tiles.some((t) => t.P.fx && t.P.fx.track && t.P.fx.track[0])) V.drawTrack(overlayG, R, tiles, A.f); else overlayG.clearRect(0, 0, overlayG.canvas.width, overlayG.canvas.height);
    } catch (e) { cancelAnimationFrame(raf); raf = 0; U.toast('Visuals stopped: ' + (e.message || e), true); }
  }

  // ---------------------------------------------------------------- open / close
  V.open = (opts = {}) => {
    const box = $('#visuals');
    box.hidden = false; document.body.classList.add('vis-open');
    if (!R) { try { R = new V.Renderer($('#visCanvas')); overlayG = $('#visOverlay').getContext('2d'); } catch (e) { box.hidden = true; return U.toast(e.message || String(e), true); } }
    imgKey = undefined; tiles = [];
    $('#visBar').hidden = !!opts.hideBar;
    drawBar();
    if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
  };
  V.close = () => { $('#visuals').hidden = true; document.body.classList.remove('vis-open'); cancelAnimationFrame(raf); raf = 0; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  V.isOpen = () => !$('#visuals').hidden;

  function applyPreset(name, silent) {
    const p = allPresets()[name]; if (!p) return;
    const c = cfg(), keep = { gain: cur().gain };
    if (c.link) c.tiles[0] = { ...clone(p), ...keep }; else c.tiles[c.sel] = { ...clone(p), ...keep };
    tiles.forEach((t) => (t.st = {}));
    if (!silent) U.toast('Visual: ' + name); drawBar();
  }
  V.applyPreset = applyPreset;

  // ---------------------------------------------------------------- controls
  function slider(key, label, val, path) { return `<label class="vsl">${label}<input type="range" min="0" max="1" step="0.01" value="${val}" data-vk="${path || key}"></label>`; }
  function drawBar() {
    const bar = $('#visBar'); if (!bar || bar.hidden) return;
    const c = cfg(), P = cur(), m = V.modeOf(P.mode), tabs = [['mode', 'Mode'], ['look', 'Look'], ['fx', 'Effects'], ['media', 'Image & text'], ['grid', 'Grid'], ['perf', 'Performance'], ['presets', 'Presets']];
    let body = '';
    if (tab === 'mode') body = `<div class="vcats">${V.CATS.map((k) => `<button class="${k === m.cat ? 'on' : ''}" data-vact="cat" data-v="${esc(k)}">${esc(k)}</button>`).join('')}</div>` +
      `<div class="vmodes">${V.MODES.filter((x) => x.cat === m.cat).map((x) => `<button class="${x === m ? 'on' : ''}" data-vact="mode" data-v="${esc(x.cat + '/' + x.name)}">${esc(x.name)}</button>`).join('')}</div>`;
    if (tab === 'look') body = `<div class="vrow">${slider('intensity', 'Intensity', P.intensity)}${slider('speed', 'Speed', P.speed)}${slider('size', 'Size', P.size)}${slider('trail', 'Trails', P.trail)}${slider('gain', 'Input', P.gain / 2, 'gain')}</div>` +
      `<div class="vpals">${Object.keys(V.PALETTES).map((k) => `<button class="vpal ${!P.colors && P.palette === k ? 'on' : ''}" data-vact="pal" data-v="${k}" title="${k}" style="background:linear-gradient(90deg,${V.PALETTES[k].join(',')})"></button>`).join('')}</div>` +
      `<div class="vrow">Your colours ${[0, 1, 2].map((i) => `<input type="color" data-vcol="${i}" value="${(P.colors || V.PALETTES[P.palette] || V.PALETTES.Stratum)[i]}">`).join('')} <button data-vact="nocolors">Use palette</button></div>`;
    if (tab === 'fx') body = Object.keys(V.FX).map((k) => `<div class="vrow"><b>${k[0].toUpperCase() + k.slice(1)}</b> ${V.FX[k].map((n, i) => `<button class="${(P.fx[k] || [0])[0] === i ? 'on' : ''}" data-vact="fx" data-k="${k}" data-v="${i}">${n}</button>`).join('')} ${slider(k, 'Amount', (P.fx[k] || [0, 0.5])[1], 'fx.' + k)}</div>`).join('');
    if (tab === 'media') body = `<div class="vrow"><b>Image</b> <button data-vact="img">Choose image…</button>${c.image ? ` <button data-vact="noimg">Remove</button> Use it as ${V.IMAGE_USE.map((n, i) => `<button class="${P.imageUse === i ? 'on' : ''}" data-vact="imguse" data-v="${i}">${n}</button>`).join('')}` : '<span class="hint"> or drop one onto the visuals</span>'}</div>` +
      `<div class="vrow"><b>Text</b> <span class="hint">One line per row (lyrics, the title…). Shown by the Text modes.</span></div><textarea id="visText" rows="3" placeholder="${esc(S.proj.name || 'Your lyrics')}">${esc(P.text || '')}</textarea>` +
      `<div class="vrow">Change line <select data-vsel="textCue">${opt([['beat', 'every beat'], ['bar', 'every bar'], ['4bars', 'every 4 bars'], ['manual', 'when I press T']], P.textCue)}</select> <button data-vact="font">Load a font…</button>${P.font ? ` <span class="hint">${esc(P.font)}</span>` : ''}</div>`;
    if (tab === 'grid') body = `<div class="vrow">Columns <select data-vsel="gc">${opt([1, 2, 3, 4, 5, 6].map((n) => [n, n]), c.grid[0])}</select> Rows <select data-vsel="gr">${opt([1, 2, 3, 4, 5, 6].map((n) => [n, n]), c.grid[1])}</select>` +
      ` <label><input type="checkbox" data-vchk="link" ${c.link ? 'checked' : ''}> Link all tiles</label> <label><input type="checkbox" data-vchk="linkVary" ${c.linkVary ? 'checked' : ''} ${c.link ? '' : 'disabled'}> Vary the mode across tiles</label></div>` +
      (c.link ? '' : `<div class="vrow">Editing tile ${Array.from({ length: c.grid[0] * c.grid[1] }, (_, i) => `<button class="${i === c.sel ? 'on' : ''}" data-vact="tile" data-v="${i}">${i + 1}</button>`).join('')}</div>`);
    if (tab === 'perf') {
      const names = Object.keys(allPresets()), scenes = [...new Set(S.proj.scenes.map((s) => s.name))];
      body = `<div class="vrow">Listen to <select data-vsel="source">${opt([['master', 'The whole mix'], ...S.proj.tracks.map((t) => [t.id, t.name])], c.source)}</select> <label><input type="checkbox" data-vchk="tempo" ${c.tempo ? 'checked' : ''}> Beats follow the song tempo</label></div>` +
        `<div class="vrow"><b>Keys 1–9</b> ${c.slots.map((s, i) => `<label class="vslot">${i + 1}<select data-vslot="${i}">${opt([['', '—'], ...names.map((n) => [n, n])], s)}</select></label>`).join('')}</div>` +
        `<div class="vrow"><label><input type="checkbox" data-vchk="followOn" ${c.followOn ? 'checked' : ''}> Change the visual with each scene while the song plays</label></div>` +
        (c.followOn ? `<div class="vrow">${scenes.map((n) => `<label class="vslot">${esc(n)}<select data-vfollow="${esc(n)}">${opt([['', 'keep'], ...names.map((x) => [x, x])], c.follow[n] || '')}</select></label>`).join('')}</div>` : '') +
        `<p class="hint">Keys while Visuals is open: Space play / stop · 1–9 presets · ← → previous / next · Enter flash · S shake · B blackout · I invert · T next line · G grid · F full screen · H hide controls · Esc close.</p>`;
    }
    if (tab === 'presets') {
      const u = userPresets();
      body = `<div class="vrow"><input id="visPresetName" placeholder="Name your look"> <button data-vact="save">Save preset</button></div>` +
        (Object.keys(u).length ? `<div class="vmodes"><b>Yours</b> ${Object.keys(u).map((n) => `<span class="vchip"><button data-vact="preset" data-v="${esc(n)}">${esc(n)}</button><button data-vact="delpreset" data-v="${esc(n)}" title="Delete">✕</button></span>`).join('')}</div>` : '') +
        `<div class="vmodes"><b>Factory</b> ${Object.keys(V.FACTORY).map((n) => `<button data-vact="preset" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>`;
    }
    bar.innerHTML = `<div class="vtabs">${tabs.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-vtab="${k}">${l}</button>`).join('')}<span class="vspace"></span><span class="hint vnow">${esc(m.cat)} · ${esc(m.name)}</span><button data-vact="hide" title="Hide controls (H)">Hide</button><button data-vact="full" title="Full screen (F)">Full screen</button><button data-vact="close">Close</button></div><div class="vbody">${body}</div>`;
  }

  function setPath(path, val) {
    const P = cur();
    if (path.startsWith('fx.')) { const k = path.slice(3); P.fx[k] = [(P.fx[k] || [0])[0], val]; }
    else if (path === 'gain') P.gain = val * 2;
    else P[path] = val;
  }

  function pickFile(accept, cb) { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => i.files[0] && cb(i.files[0]); i.click(); }
  function useImage(file) {
    const r = new FileReader();
    r.onload = () => {
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, 1024 / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        cfg().image = c.toDataURL(/png|gif|webp/.test(file.type) ? 'image/png' : 'image/jpeg', 0.85);
        if (cur().imageUse == null) cur().imageUse = 1;
        drawBar(); U.toast('Image added to the visuals.');
      };
      im.src = r.result;
    };
    r.readAsDataURL(file);
  }
  async function useFont(file) {
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[^\w -]/g, '');
    try { const f = new FontFace(name, await file.arrayBuffer()); await f.load(); document.fonts.add(f); cur().font = `"${name}"`; drawBar(); U.toast('Font loaded: ' + name); }
    catch (e) { U.toast('That font could not be loaded.', true); }
  }

  function step(dir) { const names = Object.keys(allPresets()); const at = names.findIndex((n) => JSON.stringify(allPresets()[n].mode) === JSON.stringify(cur().mode)); applyPreset(names[(at + dir + names.length) % names.length]); }

  function onClick(e) {
    const b = e.target.closest('button'); if (!b || !$('#visuals').contains(b)) return;
    const c = cfg(), P = cur(), a = b.dataset.vact;
    if (b.dataset.vtab) { tab = b.dataset.vtab; return drawBar(); }
    if (a === 'cat') { const m = V.MODES.find((x) => x.cat === b.dataset.v); P.mode = m.cat + '/' + m.name; tiles.forEach((t) => (t.st = {})); }
    if (a === 'mode') { P.mode = b.dataset.v; tiles.forEach((t) => (t.st = {})); }
    if (a === 'pal') { P.palette = b.dataset.v; P.colors = null; }
    if (a === 'nocolors') P.colors = null;
    if (a === 'fx') P.fx[b.dataset.k] = [+b.dataset.v, (P.fx[b.dataset.k] || [0, 0.6])[1] || 0.6];
    if (a === 'img') return pickFile('image/*', useImage);
    if (a === 'noimg') c.image = null;
    if (a === 'imguse') P.imageUse = +b.dataset.v;
    if (a === 'font') return pickFile('.ttf,.otf,.woff,.woff2', useFont);
    if (a === 'tile') c.sel = +b.dataset.v;
    if (a === 'preset') return applyPreset(b.dataset.v);
    if (a === 'delpreset') { const u = userPresets(); delete u[b.dataset.v]; localStorage.setItem(USER, JSON.stringify(u)); }
    if (a === 'save') { const n = ($('#visPresetName').value || '').trim(); if (!n) return U.toast('Name the preset first.', true); const u = userPresets(); u[n] = clone(P); try { localStorage.setItem(USER, JSON.stringify(u)); U.toast('Saved “' + n + '”.'); } catch (er) { U.toast('Could not save the preset.', true); } }
    if (a === 'hide') { $('#visBar').hidden = true; U.toast('Controls hidden. Press H (or tap the visuals) to bring them back.'); }
    if (a === 'full') return toggleFull();
    if (a === 'close') return V.close();
    drawBar();
  }
  function onInput(e) {
    const t = e.target;
    if (t.dataset.vk) setPath(t.dataset.vk, +t.value);
    if (t.dataset.vcol) { const P = cur(); const cols = (P.colors || V.PALETTES[P.palette] || V.PALETTES.Stratum).slice(); cols[+t.dataset.vcol] = t.value; P.colors = cols; }
    if (t.id === 'visText') cur().text = t.value;
  }
  function onChange(e) {
    const t = e.target, c = cfg(), P = cur();
    if (t.dataset.vsel === 'textCue') P.textCue = t.value;
    if (t.dataset.vsel === 'gc') c.grid = [+t.value, c.grid[1]];
    if (t.dataset.vsel === 'gr') c.grid = [c.grid[0], +t.value];
    if (t.dataset.vsel === 'source') { c.source = t.value; anNode = null; }
    if (t.dataset.vchk) { c[t.dataset.vchk] = t.checked; if (t.dataset.vchk === 'link') c.sel = 0; }
    if (t.dataset.vslot) c.slots[+t.dataset.vslot] = t.value;
    if (t.dataset.vfollow) c.follow[t.dataset.vfollow] = t.value;
    if (t.dataset.vsel || t.dataset.vchk) { c.sel = Math.min(c.sel || 0, c.grid[0] * c.grid[1] - 1); tiles = []; }
    drawBar();
  }
  function toggleFull() { const box = $('#visuals'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (box.requestFullscreen) box.requestFullscreen().catch(() => U.toast('Full screen is not available here; the visuals already fill the window.')); else U.toast('Full screen is not available here; the visuals already fill the window.'); }

  // Performance keys, only while Visuals is open (and not while typing).
  addEventListener('keydown', (e) => {
    if (!V.isOpen() || /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
    const k = e.key, c = cfg(); let used = true;
    if (/^[1-9]$/.test(k)) { if (c.slots[+k - 1]) applyPreset(c.slots[+k - 1]); }
    else if (k === 'ArrowRight') step(1); else if (k === 'ArrowLeft') step(-1);
    else if (k === 'Enter') perf.flash = 1; else if (k === 's' || k === 'S') perf.shake = 1;
    else if (k === 'b' || k === 'B') perf.black = perf.black ? 0 : 1; else if (k === 'i' || k === 'I') perf.invert = !perf.invert;
    else if (k === 't' || k === 'T') V.manualLine = (V.manualLine || 0) + 1;
    else if (k === 'g' || k === 'G') { const order = [[1, 1], [2, 2], [3, 3], [4, 4], [6, 6]], at = order.findIndex((o) => o[0] === c.grid[0] && o[1] === c.grid[1]); c.grid = order[(at + 1) % order.length]; tiles = []; drawBar(); }
    else if (k === 'f' || k === 'F') toggleFull();
    else if (k === 'h' || k === 'H') { const b = $('#visBar'); b.hidden = !b.hidden; drawBar(); }
    else if (k === 'Escape') { if (!document.fullscreenElement) V.close(); }
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  document.addEventListener('DOMContentLoaded', () => {});
  const box = $('#visuals');
  box.addEventListener('click', onClick);
  box.addEventListener('input', onInput);
  box.addEventListener('change', onChange);
  box.addEventListener('dragover', (e) => e.preventDefault());
  box.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (!f) return; if (/^image\//.test(f.type)) useImage(f); else if (/\.(ttf|otf|woff2?)$/i.test(f.name)) useFont(f); });
  $('#visCanvas').addEventListener('click', () => { const b = $('#visBar'); if (b.hidden) { b.hidden = false; drawBar(); } });
})();
