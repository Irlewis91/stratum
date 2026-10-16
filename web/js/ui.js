// STRATUM interface: comfort skins, panels, piano roll, rack back panel and keyboard maps.
(function () {
  const S = window.S, E = S.engine, D = S.dsp, IO = S.io;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const U = (S.ui = {
    skin: 'pattern', track: null, scene: null, note: null, block: -1, flip: false, keys: false, arm: null, scaleLock: true, lastLen: 1,
    bottom: { pattern: 'editor', session: 'devices', arrange: 'editor' }, ptWin: 'edit', log: [], held: {}, octave: 0, pendingAudio: null, pendingSample: null, pctl: {}, meters: [],
    region: null, playFrom: 0, pxb: 40, recording: null, monitor: false, sessionTop: 'session',
  });
  const P = () => S.proj;
  const tr = (id) => P().tracks.find((t) => t.id === id);
  const curTrack = () => tr(U.track) || P().tracks[0];
  const curScene = () => P().scenes.find((s) => s.id === U.scene) || P().scenes[0];
  U.currentScene = curScene;
  // The editor works on the selected timeline region if there is one, otherwise on the current scene's clip.
  const regionOf = (t) => (U.region && t ? t.regions.find((r) => r.id === U.region) : null);
  function target(create) {
    const t = curTrack(), sc = curScene(), rg = regionOf(t);
    if (rg) return { t, rg, clip: rg.clip, bars: Math.max(1, rg.clip.bars || 1) };
    let clip = t && t.clips[sc.id];
    if (t && create && !(clip && clip.notes) && t.type !== 'audio') clip = t.clips[sc.id] = { bars: sc.bars, notes: [] };
    return { t, sc, clip, bars: sc.bars };
  }
  const CW = 22, RH = 14, HEADW = 170, STEPW = 20, COMPX = 24;
  const SKIN_NAMES = { pattern: 'Pattern', session: 'Session', arrange: 'Arrange', mixedit: 'Mix / Edit' };

  U.toast = (msg, err) => {
    const t = $('#toast');
    t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
    clearTimeout(U._tt);
    U._tt = setTimeout(() => (t.hidden = true), err ? 9000 : 5000);
  };
  const setHTML = (id, html) => {
    const el = $('#' + id), sc = [...el.querySelectorAll('.scroll')].map((s) => [s.scrollLeft, s.scrollTop]);
    el.innerHTML = html;
    el.querySelectorAll('.scroll').forEach((s, i) => { if (sc[i]) { s.scrollLeft = sc[i][0]; s.scrollTop = sc[i][1]; } });
    return el;
  };
  const ctl = (type, desc, v, label) =>
    `<div class="ctlw"><div class="ctl ${type}" data-p="${esc(JSON.stringify(desc))}" style="--v:${Math.min(1, Math.max(0, v))}"></div>${label ? `<span>${esc(label)}</span>` : ''}</div>`;
  const ms = (t) => `<button class="m ${t.mute ? 'on' : ''}" data-act="mute" data-t="${t.id}">M</button><button class="s ${t.solo ? 'on' : ''}" data-act="solo" data-t="${t.id}">S</button>`;
  const sceneTabs = () => P().scenes.map((s) => `<button class="tab ${s.id === curScene().id ? 'on' : ''}" data-act="selScene" data-s="${s.id}">${esc(s.name)}</button>`).join('') +
    `<button class="tab" data-act="addScene" title="New scene">+</button>`;
  const opts = (list, cur) => list.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`; }).join('');

  // ---------- layout ----------
  function layout() {
    const b = U.bottom[U.skin], f = 'minmax(0,1fr)';
    let L;
    if (U.skin === 'pattern') L = { cols: `minmax(0,1.45fr) ${f}`, rows: `${f} ${f}`, cells: { rack: '1/1', [b === 'timeline' ? 'timeline' : 'editor']: '2/1', mixer: '1/2', devices: '2/2' } };
    else if (U.skin === 'session') L = { cols: f, rows: `${f} ${f} ${f}`, cells: { [U.sessionTop === 'timeline' ? 'timeline' : 'session']: '1/1', mixer: '2/1', [b === 'editor' ? 'editor' : 'devices']: '3/1' } };
    else if (U.skin === 'arrange') L = { cols: `230px ${f}`, rows: `minmax(0,1.15fr) ${f}`, cells: { inspector: '1/1/3/2', timeline: '1/2', [b]: '2/2' } };
    else L = { cols: f, rows: `minmax(0,1.35fr) ${f}`, cells: U.ptWin === 'mix' ? { mixer: '1/1', devices: '2/1' } : { timeline: '1/1', editor: '2/1' } };
    const m = $('#main');
    m.style.gridTemplateColumns = L.cols; m.style.gridTemplateRows = L.rows;
    for (const el of m.children) { el.hidden = !(el.id in L.cells); el.style.gridArea = L.cells[el.id] || ''; }
    U.visible = L.cells;
  }
  function syncHeader() {
    const p = P();
    $('#bpm').value = Math.round(p.bpm * 100) / 100;
    $('#rootSel').innerHTML = opts(S.NOTES.map((n, i) => [i, n]), p.root);
    $('#scaleSel').innerHTML = opts(Object.keys(S.SCALES), p.scale);
    $('#skinSel').value = U.skin; $('#modeSel').value = E.mode;
    $('#playBtn').textContent = E.playing ? '❚❚' : '▶';
    $('#playBtn').classList.toggle('on', E.playing);
    $('#metroBtn').classList.toggle('on', E.metro); $('#keysBtn').classList.toggle('on', U.keys);
    $('#recBtn').classList.toggle('on', !!U.recording); $('#monBtn').classList.toggle('on', U.monitor);
    document.title = 'STRATUM — ' + p.name;
  }
  function render() {
    layout();
    const R = { rack: renderRack, session: renderSession, timeline: renderTimeline, mixer: renderMixer, editor: renderEditor, devices: renderDevices, inspector: renderInspector };
    for (const id in U.visible) R[id]();
    U.meters = [...document.querySelectorAll('[data-m]')];
  }
  S.render = render;
  const changed = (structural) => { if (structural) E.rebuild(); else E.applyMix(); render(); };
  function setProject(proj) {
    E.stop();
    S.proj = proj;
    U.track = proj.tracks[0] && proj.tracks[0].id; U.scene = proj.scenes[0].id; U.note = null; U.block = -1; U.prFor = null; U.region = null; U.playFrom = 0;
    E.sceneId = U.scene;
    E.rebuild(); syncHeader(); render();
  }
  U.setProject = setProject;
  U.refresh = () => render();
  U.shareProgress = (f) => U.toast(`Making your STRATUM video… ${Math.round(f * 100)}%`);
  U.shareDone = (ok, msg) => U.toast(msg, !ok);
  // A follow-up to an import (samples found, plugins matched): shown after the import report so that is not lost.
  U.followUp = (msg, err) => { U.report = (U.report ? U.report + ' ' : '') + msg; U.toast(U.report, err); };

  // ---------- panels ----------
  function renderRack() {
    const p = P(), sc = curScene(), steps = sc.bars * 16;
    let h = `<div class="ptitle">Channel Rack ${sceneTabs()}</div><div class="scroll"><div class="rk" style="width:${HEADW + steps * STEPW + 20}px"><div class="ph" id="phRack"></div>`;
    for (const t of p.tracks) {
      const c = t.clips[sc.id], sel = t.id === U.track ? 'sel' : '';
      const head = `<div class="rkh" data-act="selTrack" data-t="${t.id}"><span class="chip" style="background:${t.color}"></span><b>${esc(t.name)}</b>${ms(t)}</div>`;
      const cells = (pitch) => {
        let s = '';
        for (let i = 0; i < steps; i++) {
          const on = c && c.notes && c.notes.some((n) => Math.abs(n.t - i * 0.25) < 1e-6 && (pitch == null || S.drumMap(n.p) === pitch));
          s += `<i class="st ${on ? 'on' : ''} ${(i >> 2) % 2 ? 'alt' : ''}" data-act="step" data-t="${t.id}" data-i="${i}" data-p="${pitch == null ? '' : pitch}" style="${on ? 'background:' + t.color : ''}"></i>`;
        }
        return s;
      };
      if (t.type === 'drums') {
        h += `<div class="rkrow ${sel}">${head}</div>`;
        for (const d of S.drumRows(t)) h += `<div class="rkrow sub ${sel}"><div class="rkh sub" title="${esc(d.n)}">${esc(d.n)}</div>${cells(d.p)}</div>`;
      } else if (t.type === 'audio') {
        const rec = c && S.buffers[c.audio];
        h += `<div class="rkrow ${sel}">${head}<div class="rkaudio" data-act="selTrack" data-t="${t.id}">${rec ? '♪ ' + esc(rec.name) : `<button data-act="loadAudio" data-t="${t.id}">Load audio…</button>`}</div></div>`;
      } else h += `<div class="rkrow ${sel}">${head}${cells(null)}</div>`;
    }
    setHTML('rack', h + '</div></div>');
  }

  function renderSession() {
    const p = P(), cs = curScene();
    let h = `<div class="ptitle">Session View <span class="hint">click a cell to edit its clip · ▶ launches a scene</span><button data-act="arrView">Arrangement view</button></div><div class="scroll"><table class="sg"><tr><th>Scenes</th>` +
      p.tracks.map((t) => `<th class="${t.id === U.track ? 'sel' : ''}" data-act="selTrack" data-t="${t.id}" style="--c:${t.color}">${esc(t.name)}</th>`).join('') + '</tr>';
    for (const s of p.scenes) {
      h += `<tr class="${s.id === cs.id ? 'cur' : ''}"><td class="scn"><button data-act="launch" data-s="${s.id}">▶</button><input value="${esc(s.name)}" data-chg="sceneName" data-s="${s.id}"><span>${s.bars} bar${s.bars > 1 ? 's' : ''}</span></td>`;
      for (const t of p.tracks) {
        const c = t.clips[s.id];
        h += `<td class="cell ${c ? 'has' : ''} ${t.id === U.track && s.id === cs.id ? 'sel' : ''}" data-act="cell" data-t="${t.id}" data-s="${s.id}" style="--c:${t.color}">${c ? (c.audio ? '♪ ' + esc((S.buffers[c.audio] || {}).name || 'audio') : c.notes.length + ' notes') : ''}</td>`;
      }
      h += '</tr>';
    }
    setHTML('session', h + `</table><button class="addscn" data-act="addScene">+ Scene</button></div>`);
  }

  function mini(c, len, off) {
    if (c.audio) return '<span>♪ ' + esc((S.buffers[c.audio] || {}).name || 'audio') + '</span>';
    if (!c.notes.length) return '';
    const L = Math.max(1, c.bars) * 4, ps = c.notes.map((n) => n.p), lo = Math.min(...ps), span = Math.max(1, Math.max(...ps) - lo);
    let s = '', count = 0;
    for (let k = 0; k * L < off + len && count < 240; k++)
      for (const n of c.notes) {
        const x = n.t + k * L - off;
        if (n.t >= L || x < 0 || x >= len) continue;
        s += `<i style="left:${(x / len) * 100}%;top:${8 + (1 - (n.p - lo) / span) * 76}%;width:${Math.max(0.4, (n.d / len) * 100)}%"></i>`;
        count++;
      }
    return s;
  }
  function renderTimeline() {
    const p = P(), total = S.songEnd(p), pxb = U.pxb, bw = pxb / 4, w = Math.max(900, (total / 4 + 8) * pxb), pt = U.skin === 'mixedit', rgSel = regionOf(curTrack());
    let h = `<div class="ptitle">${pt ? 'Edit Window' : 'Arrangement'} <button data-act="addBlock">+ Add “${esc(curScene().name)}” section</button>` +
      `<button data-act="zoom" data-d="out" title="Zoom out">−</button><button data-act="zoom" data-d="in" title="Zoom in">+</button>`;
    if (U.skin === 'session') h += `<button data-act="arrView">Session view</button>`;
    if (p.sections[U.block]) h += `<span class="bctl">Section: <button data-act="blk" data-d="left">◀ Move</button><button data-act="blk" data-d="right">Move ▶</button><button data-act="blk" data-d="more">Duplicate</button><button data-act="blk" data-d="del">Delete</button></span>`;
    if (rgSel) h += `<span class="bctl">Region: <button data-act="splitRg">Split at playhead</button><button data-act="dupRg">Duplicate</button><button data-act="delRg">Delete</button></span>`;
    else h += `<span class="hint">drag regions to move · drag an edge to resize · ⌥-drag copies · double-click a lane for a new region · click the ruler to set the start</span>`;
    h += `</div><div class="scroll"><div class="tl" style="width:${w + HEADW}px;--pxb:${pxb}px"><div class="ph" id="phTl"></div><div class="pf" style="left:${HEADW + U.playFrom * bw}px"></div>`;
    h += `<div class="tlrow arr"><div class="tlh">Arranger</div><div class="lane">` + p.sections.map((sec, i) =>
      `<div class="blk ${i === U.block ? 'sel' : ''}" data-act="selBlock" data-i="${i}" style="left:${sec.start * bw}px;width:${sec.len * bw - 2}px">${esc(sec.name)}</div>`).join('') + `</div></div>`;
    h += `<div class="tlrow rul"><div class="tlh"></div><div class="lane">`;
    for (let bar = 0, step = pxb < 24 ? 4 : 1; bar < Math.min(1200, w / pxb); bar += step) h += `<i style="left:${bar * pxb}px">${bar + 1}</i>`;
    h += '</div></div>';
    for (const t of p.tracks) {
      h += `<div class="tlrow ${t.id === U.track ? 'sel' : ''}"><div class="tlh" data-act="selTrack" data-t="${t.id}"><span class="chip" style="background:${t.color}"></span><b>${esc(t.name)}</b>` +
        (t.type === 'audio' ? `<button class="r ${t.arm ? 'on' : ''}" data-act="arm" data-t="${t.id}" title="Arm for recording">R</button>` : '') + ms(t) + (pt ? '<small>In 1-2 · Out 1-2</small>' : '') + `</div><div class="lane" data-lane="${t.id}">`;
      for (const r of t.regions)
        h += `<div class="reg ${r.id === U.region ? 'sel' : ''} ${r.takes ? 'rec' : ''}" data-rg="${r.id}" data-t="${t.id}" style="left:${r.start * bw}px;width:${Math.max(4, r.len * bw - 1)}px;--c:${t.color}">${r.takes ? `<span>● ${r.takes.length} take${r.takes.length > 1 ? 's' : ''}</span>` : mini(r.clip, r.len, r.off)}</div>`;
      h += '</div></div>';
    }
    if (!total) h += `<p class="hint pad">The song is empty. Add a scene as a section, double-click a lane to make a region, or arm an audio track and record.</p>`;
    setHTML('timeline', h + '</div></div>');
    bindTimeline();
  }
  function bindTimeline() {
    const tl = $('#timeline .tl');
    if (!tl) return;
    const bw = U.pxb / 4, snap = (b, e) => (e.shiftKey ? Math.round(b * 4) / 4 : Math.round(b));
    let drag = null;
    tl.onpointerdown = (e) => {
      const reg = e.target.closest('.reg'), rul = e.target.closest('.rul .lane');
      if (rul) {
        U.playFrom = Math.max(0, Math.round((e.clientX - rul.getBoundingClientRect().left) / bw));
        if (E.playing && E.mode === 'song' && !U.recording) E.play(U.playFrom);
        return renderTimeline();
      }
      if (!reg) return;
      const t = tr(reg.dataset.t), rg = t.regions.find((r) => r.id === reg.dataset.rg);
      U.track = t.id; U.region = rg.id; U.note = null;
      drag = { t, rg, el: reg, x: e.clientX, y: e.clientY, mode: e.offsetX > reg.offsetWidth - 7 ? 'size' : 'move', copy: e.altKey, row: P().tracks.indexOf(t), moved: false, rowH: reg.closest('.tlrow').offsetHeight };
      tl.setPointerCapture(e.pointerId);
    };
    tl.onpointermove = (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
      if (!drag.moved) return;
      const db = (e.clientX - drag.x) / bw;
      if (drag.mode === 'size') { drag.nlen = Math.max(0.25, snap(drag.rg.len + db, e)); drag.el.style.width = drag.nlen * bw - 1 + 'px'; }
      else {
        const tracks = P().tracks;
        let row = Math.min(tracks.length - 1, Math.max(0, drag.row + Math.round((e.clientY - drag.y) / drag.rowH)));
        if (tracks[row].type !== drag.t.type) row = drag.row;
        drag.nstart = Math.max(0, snap(drag.rg.start + db, e)); drag.nrow = row;
        drag.el.style.transform = `translate(${(drag.nstart - drag.rg.start) * bw}px,${(row - drag.row) * drag.rowH}px)`;
        drag.el.style.zIndex = 9;
      }
    };
    tl.onpointerup = () => {
      const d = drag;
      drag = null;
      if (!d) return;
      if (d.moved) {
        S.snap();
        if (d.mode === 'size') d.rg.len = d.nlen || d.rg.len;
        else {
          let rg = d.rg;
          const dest = P().tracks[d.nrow == null ? d.row : d.nrow];
          if (d.copy) { rg = JSON.parse(JSON.stringify(d.rg)); rg.id = S.uid(); dest.regions.push(rg); }
          else if (dest !== d.t) { d.t.regions.splice(d.t.regions.indexOf(rg), 1); dest.regions.push(rg); }
          if (d.nstart != null) rg.start = d.nstart;
          U.track = dest.id; U.region = rg.id;
        }
      }
      render();
    };
    tl.ondblclick = (e) => {
      const lane = e.target.closest('[data-lane]');
      if (e.target.closest('.reg')) return A.showEditor();
      if (!lane) return;
      const t = tr(lane.dataset.lane);
      if (t.type === 'audio') return U.toast('Audio regions come from recording or File › Open. Arm the track (R) and press Record.');
      S.snap();
      const rg = { id: S.uid(), start: Math.floor((e.clientX - lane.getBoundingClientRect().left) / bw / 4) * 4, len: 4, off: 0, clip: { bars: 1, notes: [] } };
      t.regions.push(rg); U.track = t.id; U.region = rg.id;
      render();
    };
  }

  function renderMixer() {
    const p = P();
    const strip = (t) => `<div class="strip ${t.id === U.track ? 'sel' : ''}" data-act="selTrack" data-t="${t.id}" style="--c:${t.color}"><div class="sname">${esc(t.name)}</div><div class="slots">` +
      t.fx.map((f) => `<div class="slot" data-act="selFx" data-t="${t.id}" title="${esc(f.prompt || f.name)}">${esc(f.name)}</div>`).join('') +
      `<div class="slot empty" data-act="addFx" data-t="${t.id}">+ insert</div></div>${ctl('knob', { k: 'pan', t: t.id }, (t.pan + 1) / 2, 'Pan')}<div class="fad">${ctl('fader', { k: 'vol', t: t.id }, t.vol / 1.25)}<div class="meter"><i data-m="${t.id}"></i></div></div><div class="msb">${ms(t)}</div></div>`;
    const master = `<div class="strip master"><div class="sname">Master</div><div class="slots"><div class="slot fixed">Console summing</div></div><div class="krow">${ctl('knob', { k: 'master', key: 'drive' }, p.master.drive, 'Drive')}${ctl('knob', { k: 'master', key: 'glue' }, p.master.glue, 'Glue')}</div><div class="fad">${ctl('fader', { k: 'master', key: 'vol' }, p.master.vol / 1.25)}<div class="meter"><i data-m="master"></i></div></div><div class="msb"></div></div>`;
    setHTML('mixer', `<div class="ptitle">${U.skin === 'mixedit' ? 'Mix Window' : 'Mixer'}</div><div class="scroll"><div class="strips">${p.tracks.map(strip).join('')}${master}</div></div>`);
  }

  const NOCV = { 'reverb.size': 1 };
  // One plugin effect in the Devices panel, with its controls underneath when they are open. Airwindows effects have no
  // window of their own, so their controls start open.
  const fxRow = (t, f, fi) => {
    const aw = f.id.startsWith('aw|'), key = t.id + ':' + fi, open = U.pctl[key] == null ? aw : U.pctl[key];
    return `<div class="slot">${esc(f.name)}${aw ? ' <span class="hint">Airwindows</span>' : ''} ${aw ? '' : `<button data-act="plugOpen" data-slot="${fi}">Open</button>`}` +
      `<button data-act="plugCtl" data-slot="${fi}" data-open="${open ? 1 : 0}">${open ? 'Hide controls' : 'Controls'}</button><button class="x" data-act="plugRmFx" data-i="${fi}" title="Remove">✕</button></div>` +
      (open ? `<div class="pctl" data-slot="${fi}"><span class="hint">Loading controls…</span></div>` : '');
  };
  // Fill open control panels from the plugin itself; a plugin that is still loading is asked again shortly.
  const fillControls = (tries) => {
    const t = curTrack();
    document.querySelectorAll('#devices .pctl').forEach(async (el) => {
      const slot = +el.dataset.slot, list = (await S.plug.params(t, slot)) || [];
      if (!list.length && (tries || 0) < 6) return setTimeout(() => el.isConnected && fillControls((tries || 0) + 1), 500);
      el.innerHTML = list.length ? list.map((q) => `<label class="prm"><span class="pn">${esc(q.name)}</span><input type="range" min="0" max="1" step="0.001" value="${q.v}" data-chg="plugParam" data-slot="${slot}" data-i="${q.i}"><span class="pv">${esc(q.text)}</span></label>`).join('')
        : '<span class="hint">No controls to show here; use Open for the plugin\'s own window.</span>';
    });
  };
  function renderDevices() {
    const t = curTrack();
    if (!t) return setHTML('devices', '');
    const kn = U.skin === 'pattern' ? 'hslider' : 'knob', back = U.flip;
    const jack = (dev, key, label) => `<div class="jackw"><i class="jack in ${t.cables.some((c) => c.dev === dev && c.key === key) ? 'on' : ''}" data-act="jackIn" data-dev="${dev}" data-key="${key}"></i><span>${esc(label)}</span></div>`;
    let h = `<div class="ptitle">${back ? 'Rack — back panel' : 'Devices'} <input class="tname" value="${esc(t.name)}" data-chg="trackName"> <button data-act="flip">${back ? 'Front (Tab)' : 'Flip to back (Tab)'}</button><button data-act="addFx" data-t="${t.id}">+ Prompt-to-Plugin</button><button data-act="delTrack">Delete track</button></div>` +
      `<div class="scroll"><div class="rackwrap ${back ? 'back' : ''}"><svg id="cables"></svg>`;
    if (back) {
      h += P().lfos.map((l, i) => `<div class="dev lfo"><h4>LFO ${i + 1} · CV source</h4><div class="krow">${ctl('knob', { k: 'lfo', i, key: 'rate' }, l.rate, 'Rate')}${ctl('knob', { k: 'lfo', i, key: 'depth' }, l.depth, 'Depth')}</div><select data-chg="lfoShape" data-i="${i}">${opts(['sine', 'triangle', 'square', 'sawtooth'], l.shape)}</select><div class="jackw"><i class="jack out ${U.arm === i ? 'armed' : ''}" data-act="jackOut" data-i="${i}"></i><span>CV out</span></div></div>`).join('');
    }
    const kindSel = t.type === 'audio' ? '' : `<label class="ikind">Instrument <select data-chg="instKind">${opts([['synth', 'Built-in synth'], ['sample', 'My own sample…'], ['drums', 'Drum kit / pads'], ['plugin', 'Plugin (Audio Unit / VST3)…']], t.plugin ? 'plugin' : t.type === 'drums' ? 'drums' : t.inst && t.inst.sample ? 'sample' : 'synth')}</select></label>`;
    if (t.plugin && t.type !== 'audio') {
      const pl = t.plugin, ok = S.plug.available();
      h += `<div class="dev inst plug"><h4>Plugin · ${esc(pl.name)} <span class="hint">${esc(pl.maker || '')}</span></h4>${kindSel}` +
        (ok ? `<div class="krow"><button data-act="plugOpen" data-slot="-1">Open plugin window</button><button data-act="plugPick" data-kind="inst">Change plugin…</button></div>` : `<p class="hint">Plugins run in the STRATUM Mac app; here the track plays the built-in sound.</p>`) +
        `<div class="hint">Plugin effects</div>` + (pl.fx || []).map((f, fi) => fxRow(t, f, fi)).join('') +
        `<div class="krow"><button data-act="plugPick" data-kind="fx">+ Plugin effect…</button></div><p class="hint">Plugin tracks go straight to the Mac's audio output, so the STRATUM effects and master section do not process them.</p></div>`;
    } else if (t.type === 'synth') {
      const i = t.inst, waves = ['sine', 'triangle', 'sawtooth', 'square'], smp = i.sample;
      const src = smp ? `<div class="krow"><span class="smp" title="${esc(smp.name)}">Sample: ${esc(smp.name)}</span><label>Root note <input type="number" min="12" max="108" value="${smp.root}" data-chg="instRoot" style="width:52px"> ${S.noteName(smp.root)}</label><label><input type="checkbox" data-chg="instLoop" ${smp.loop ? 'checked' : ''}> Loop</label><button data-act="instLoad">Replace…</button><button data-act="instClear">Use oscillators</button></div><div class="krow">` +
          [['attack', 'Attack'], ['release', 'Release'], ['cutoff', 'Cutoff'], ['res', 'Resonance']].map(([k, l]) => ctl(kn, { k: 'inst', t: t.id, key: k }, i[k], l)).join('') + '</div>'
        : `<div class="krow"><label>Osc 1 <select data-chg="inst" data-key="wave">${opts(waves, i.wave)}</select></label><label>Osc 2 <select data-chg="inst" data-key="wave2">${opts(waves, i.wave2)}</select></label><button data-act="instLoad" title="Play one of your own sounds across the keys">Load sample…</button></div><div class="krow">` +
          [['detune', 'Detune'], ['attack', 'Attack'], ['release', 'Release'], ['cutoff', 'Cutoff'], ['res', 'Resonance']].map(([k, l]) => ctl(kn, { k: 'inst', t: t.id, key: k }, i[k], l)).join('') + '</div>';
      h += `<div class="dev inst"><h4>${smp ? 'Sampler' : 'Synth'}</h4>${back ? '' : kindSel}` + (back ? `<div class="krow">${jack(-1, 'cutoff', 'Cutoff CV')}${jack(-1, 'res', 'Resonance CV')}</div>` : src) + '</div>';
    } else if (t.type === 'drums') {
      const pads = t.pads || {};
      h += `<div class="dev inst pads"><h4>Drum Sampler <span><button data-act="padKit" title="Pick several sound files; kicks, snares, claps and hats go to matching pads">Load sounds…</button></span></h4>${kindSel}<p class="hint">Load your own one-shots onto any pad. Pads without a sample play the built-in sound.</p><div class="padgrid">` +
        S.drumRows(t).map((d) => { const pd = pads[d.p]; return `<div class="padc ${pd ? 'on' : ''}"><b data-act="padPlay" data-p="${d.p}" title="Click to hear">${esc(d.n)}</b><small>${pd ? (d.base ? esc(d.base) + ' pad' : 'Extra pad') : 'Built-in'}</small>` +
          (pd ? `<div class="krow">${ctl('hslider', { k: 'pad', t: t.id, p: d.p, key: 'tune' }, ((pd.tune || 0) + 12) / 24, 'Tune')}${ctl('hslider', { k: 'pad', t: t.id, p: d.p, key: 'gain' }, (pd.gain == null ? 1 : pd.gain) / 2, 'Level')}</div>` : '') +
          `<div class="krow"><button data-act="padLoad" data-p="${d.p}">${pd ? 'Replace…' : 'Load…'}</button>${pd ? `<button data-act="padClear" data-p="${d.p}">${d.extra ? 'Remove' : 'Built-in'}</button>` : ''}</div></div>`; }).join('') +
        `<div class="padc add" data-act="padAdd"><b>+ Add pads</b><small>Pick one or more sounds</small></div></div></div>`;
    } else h += `<div class="dev inst"><h4>Audio Track</h4><p class="hint">Plays the audio clip in each scene.</p></div>`;
    if (!t.plugin && !back && S.plug.available()) {
      const pf = t.pfx || [];
      h += `<div class="dev inst plug"><h4>Plugin effects</h4>` + pf.map((f, fi) => fxRow(t, f, fi)).join('') +
        `<div class="krow"><button data-act="plugPick" data-kind="fx">+ Plugin effect…</button></div>` +
        (pf.length ? `<p class="hint">With a plugin effect on it, this track plays through the Mac's audio output directly, so the STRATUM effects on this track and the master section do not process it${t.type === 'synth' && !t.inst.sample ? ', and CV cables to its filter have no effect' : ''}.</p>` : `<p class="hint">Audio Unit, VST3 or VST2 effects on this track's audio.</p>`) + `</div>`;
    }
    t.fx.forEach((f, fi) => {
      h += `<div class="dev fx"><h4>${esc(f.name)} <button class="x" data-act="rmFx" data-i="${fi}" title="Remove">✕</button></h4>${f.prompt ? `<p class="hint">“${esc(f.prompt)}”</p>` : ''}<div class="krow">`;
      f.blocks.forEach((b, bi) => {
        const def = D.BLOCKS[b.type];
        for (const k in def.params) {
          const label = (f.blocks.length > 1 ? def.label.split(' ')[0] + ' ' : '') + def.params[k][0];
          if (back) { if (!NOCV[b.type + '.' + k]) h += jack(fi, bi + '.' + k, label); }
          else h += ctl(kn, { k: 'fx', t: t.id, i: fi, key: bi + '.' + k }, b.vals[k], label);
        }
      });
      h += `</div><p class="safe">${back ? 'CV inputs' : 'Output limited at 0 dBFS'}</p></div>`;
    });
    if (!t.fx.length && !back) h += `<div class="dev ghost" data-act="addFx" data-t="${t.id}"><h4>Empty insert</h4><p class="hint">Click to describe an effect in plain words.</p></div>`;
    if (back) h += `<p class="hint pad">Click an LFO “CV out” jack, then a device jack to patch a cable. Click a patched jack to unplug it.</p>`;
    setHTML('devices', h + '</div></div>');
    if (S.plug.available()) fillControls();
    drawCables();
  }
  function drawCables() {
    const svg = $('#cables');
    if (!svg) return;
    const wrap = svg.parentElement, r = wrap.getBoundingClientRect(), t = curTrack(), cols = ['#ffd43b', '#ff6b9d'];
    svg.setAttribute('width', wrap.scrollWidth); svg.setAttribute('height', wrap.scrollHeight);
    let h = '';
    if (U.flip && t) for (const c of t.cables) {
      const a = wrap.querySelector(`.jack.out[data-i="${c.src}"]`), b = wrap.querySelector(`.jack.in[data-dev="${c.dev}"][data-key="${c.key}"]`);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x1 = ra.left - r.left + ra.width / 2, y1 = ra.top - r.top + ra.height / 2, x2 = rb.left - r.left + rb.width / 2, y2 = rb.top - r.top + rb.height / 2, sag = Math.min(110, 30 + Math.abs(x2 - x1) * 0.2);
      h += `<path d="M${x1},${y1} C${x1},${y1 + sag} ${x2},${y2 + sag} ${x2},${y2}" stroke="${cols[c.src % 2]}"/>`;
    }
    svg.innerHTML = h;
  }

  function renderInspector() {
    const t = curTrack(), p = P();
    if (!t) return setHTML('inspector', '');
    setHTML('inspector', `<div class="ptitle">Inspector</div><div class="scroll insp"><label>Track <input value="${esc(t.name)}" data-chg="trackName"></label><div class="hint">Type: ${t.type}</div>` +
      `<div class="dual"><div><div class="fad">${ctl('fader', { k: 'vol', t: t.id }, t.vol / 1.25)}<div class="meter"><i data-m="${t.id}"></i></div></div><span>${esc(t.name)}</span></div>` +
      `<div><div class="fad">${ctl('fader', { k: 'master', key: 'vol' }, p.master.vol / 1.25)}<div class="meter"><i data-m="master"></i></div></div><span>Stereo Out</span></div></div>` +
      `<div class="krow">${ctl('knob', { k: 'pan', t: t.id }, (t.pan + 1) / 2, 'Pan')}<div class="msb">${ms(t)}</div></div>` +
      ((t.auto && (t.auto.vol || t.auto.pan)) || (p.master.auto && p.master.auto.vol) ? `<div class="hint">Automation (plays in Song mode): ${[t.auto && t.auto.vol ? 'volume ' + t.auto.vol.length + ' pts' : '', t.auto && t.auto.pan ? 'pan ' + t.auto.pan.length + ' pts' : '', p.master.auto && p.master.auto.vol ? 'master volume ' + p.master.auto.vol.length + ' pts' : ''].filter(Boolean).join(', ')} <button data-act="clearAuto">Clear</button></div>` : '') +
      `<div class="hint">Inserts</div>${t.fx.map((f) => `<div class="slot">${esc(f.name)}</div>`).join('')}<div class="slot empty" data-act="addFx" data-t="${t.id}">+ insert</div></div>`);
  }

  const prRows = (t) => { if (t.type === 'drums') return S.drumRows(t).map((d) => d.p); const r = []; for (let p = 96; p >= 24; p--) r.push(p); return r; };
  const rowPitch = (t, n) => (t.type === 'drums' ? S.drumMap(n.p) : n.p);
  function renderNotes() {
    const el = $('#prNotes'), tg = target(), t = tg.t, c = tg.clip;
    if (!el) return;
    if (!c || !c.notes) return (el.innerHTML = '');
    const rows = prRows(t);
    let h = c.notes.map((n, i) => {
      const row = rows.indexOf(rowPitch(t, n));
      return row < 0 ? '' : `<div class="nt ${n === U.note ? 'sel' : ''} ${n.g ? 'gl' : ''}" data-i="${i}" style="left:${n.t * 4 * CW}px;top:${row * RH}px;width:${Math.max(6, n.d * 4 * CW - 1)}px;opacity:${0.45 + 0.55 * (n.v == null ? 0.8 : n.v)}"></div>`;
    }).join('');
    const n = U.note;
    if (n && t.type === 'synth' && c.notes.includes(n) && P().scale !== 'Chromatic') {
      const up = [];
      for (let q = n.p + 1; q <= 96 && up.length < 4; q++) if (S.inScale(q, P())) up.push(q);
      for (const q of [up[1], up[3]]) {
        if (q == null || c.notes.some((m) => m.t === n.t && m.p === q)) continue;
        h += `<div class="gh" title="Suggested harmony — click to add" data-p="${q}" data-t="${n.t}" data-d="${n.d}" style="left:${n.t * 4 * CW}px;top:${rows.indexOf(q) * RH}px;width:${Math.max(6, n.d * 4 * CW - 1)}px"></div>`;
      }
    }
    el.innerHTML = h;
  }
  function drawWave(cv, buf) {
    const g = cv.getContext('2d'), d = buf.getChannelData(0), w = cv.width, hh = cv.height / 2, step = Math.max(1, d.length / w);
    g.fillStyle = getComputedStyle(document.body).getPropertyValue('--acc');
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let i = Math.floor(x * step), e = Math.min(d.length, Math.floor((x + 1) * step) + 1), inc = Math.max(1, Math.floor(step / 40)); i < e; i += inc) { const v = Math.abs(d[i]); if (v > m) m = v; }
      g.fillRect(x, hh - m * hh, 1, Math.max(1, m * 2 * hh));
    }
  }
  // Take lanes for a recorded region: drag across a take to use it for that stretch.
  function renderComp(tg, head) {
    const rg = tg.rg, w = rg.len * COMPX, bps = P().bpm / 60;
    let h = head + `<div class="tools"><span class="hint">Drag across a take to use it for that stretch of the region. Record again over this region to add another take.</span></div><div class="scroll"><div class="comp" style="width:${w + 90}px"><div class="ph" id="phComp"></div>`;
    rg.takes.forEach((tk, i) => {
      const rec = S.buffers[tk.audio], durB = rec ? rec.buf.duration * bps : 0;
      h += `<div class="lanerow"><div class="lh">Take ${i + 1}</div><div class="tklane" data-take="${i}" style="width:${w}px">` +
        `<canvas data-wave="${tk.audio}" width="${Math.min(8000, Math.max(1, Math.round(durB * COMPX)))}" height="46" style="left:${tk.shift * COMPX}px;width:${durB * COMPX}px"></canvas>` +
        rg.comp.filter((c) => c.take === i).map((c) => `<i class="use" style="left:${c.from * COMPX}px;width:${(c.to - c.from) * COMPX}px"></i>`).join('') + `<i class="paint"></i></div></div>`;
    });
    const el = setHTML('editor', h + '</div></div>');
    el.querySelectorAll('canvas[data-wave]').forEach((cv) => { const rec = S.buffers[cv.dataset.wave]; if (rec) drawWave(cv, rec.buf); });
    el.querySelectorAll('.tklane').forEach((lane) => {
      let x0 = null;
      const beat = (e) => Math.min(rg.len, Math.max(0, Math.round(((e.clientX - lane.getBoundingClientRect().left) / COMPX) * 4) / 4)), pt = lane.querySelector('.paint');
      lane.onpointerdown = (e) => { x0 = beat(e); lane.setPointerCapture(e.pointerId); };
      lane.onpointermove = (e) => { if (x0 == null) return; const x1 = beat(e); pt.style.cssText = `display:block;left:${Math.min(x0, x1) * COMPX}px;width:${Math.abs(x1 - x0) * COMPX}px`; };
      lane.onpointerup = (e) => {
        if (x0 == null) return;
        const x1 = beat(e), a = Math.min(x0, x1), b = Math.max(x0, x1);
        x0 = null;
        if (b - a < 0.25) return render();
        S.snap(); S.paintComp(rg, a, b, +lane.dataset.take); render();
      };
    });
  }
  function renderEditor() {
    const tg = target(), t = tg.t, sc = curScene(), rg = tg.rg, c = tg.clip;
    if (!t) return setHTML('editor', '');
    const where = rg ? `<span class="tab on">Region at bar ${Math.floor(rg.start / 4) + 1}</span><button class="tab" data-act="sceneMode">Edit scenes instead</button>` : sceneTabs();
    let h = `<div class="ptitle">${rg && rg.takes ? 'Take Lanes' : t.type === 'audio' ? 'Audio Clip' : 'Piano Roll'} · <b>${esc(t.name)}</b> ${where}</div>`;
    if (rg && rg.takes) return renderComp(tg, h);
    if (t.type === 'audio') {
      const rec = c && S.buffers[c.audio];
      h += `<div class="scroll aud">` + (rec ? `<canvas id="wave" width="1000" height="110"></canvas><div class="tools"><b>${esc(rec.name)}</b><span>${rec.buf.duration.toFixed(1)} s</span>` +
        `<label>Source BPM <input type="number" data-chg="srcBpm" value="${rec.bpm || ''}" min="40" max="240"></label><label><input type="checkbox" data-chg="warp" ${c.warp ? 'checked' : ''}> Warp to project tempo</label>` +
        `<label>Loop length (bars) <input type="number" data-chg="clipBars" value="${c.bars}" min="1" max="999"></label><button data-act="stems">Separate stems (AI)</button><button data-act="split">Band split into 4 tracks</button><button data-act="loadAudio" data-t="${t.id}">${rg ? 'Add audio…' : 'Replace audio…'}</button></div>` +
        `<p class="hint">Warping time-stretches the file to the project tempo without changing its pitch. Separate stems runs a neural network (HT-Demucs) on this Mac to split a mix into vocals, drums, bass and other; it can take about as long as the audio itself. Band split is a quick frequency and mid/side filter.</p>`
        : `<p class="pad">No audio in “${esc(sc.name)}”. <button data-act="loadAudio" data-t="${t.id}">Load audio…</button></p>`) + '</div>';
      setHTML('editor', h);
      if (rec) drawWave($('#wave'), rec.buf);
      return;
    }
    const rows = prRows(t), steps = tg.bars * 16, n = U.note && c && c.notes && c.notes.includes(U.note) ? U.note : null, synth = t.type === 'synth';
    h += `<div class="tools">` + (rg ? `<label>Loop length (bars) <select data-chg="clipBars">${opts([1, 2, 4, 8, 16, 32, 64].includes(tg.bars) ? [1, 2, 4, 8, 16, 32, 64] : [tg.bars, 1, 2, 4, 8, 16, 32, 64], tg.bars)}</select></label>` :
      `<label>Scene bars <select data-chg="sceneBars">${opts([1, 2, 4, 8, 16, 32].includes(sc.bars) ? [1, 2, 4, 8, 16, 32] : [sc.bars, 1, 2, 4, 8, 16, 32], sc.bars)}</select></label>` +
      `<label>Chords <input data-chg="chords" value="${esc((sc.chords || [1]).join(' '))}" size="9" title="Scale degrees, one per bar"></label>` +
      `<label>Session player <select data-chg="player">${opts([['', 'None (manual)'], ['drums', 'Drummer'], ['bass', 'Bass'], ['chords', 'Chords'], ['arp', 'Arpeggio']], t.player || '')}</select></label>` +
      (t.player ? `<button data-act="regen">Regenerate</button>` : '')) +
      (synth ? `<label><input type="checkbox" data-chg="scaleLock" ${U.scaleLock ? 'checked' : ''}> Scale lock</label>` : '') +
      (n ? `<span class="nsel">Note ${S.noteName(n.p)} ${ctl('hslider', { k: 'vel' }, n.v == null ? 0.8 : n.v, 'Velocity')}` + (synth ? `<label>Cents <input type="number" data-chg="cents" value="${n.c || 0}" min="-50" max="50" step="5"></label><label><input type="checkbox" data-chg="glide" ${n.g ? 'checked' : ''}> Glide</label>` : '') + `<button data-act="delNote">Delete</button></span>` : `<span class="hint">Click to add · drag to move · drag right edge to resize · Option-click to delete</span>`) + '</div>';
    h += `<div class="scroll" id="prScroll"><div class="pr" style="width:${60 + steps * CW}px;height:${rows.length * RH}px"><div class="prkeys">` +
      rows.map((p) => { const black = synth && [1, 3, 6, 8, 10].includes(p % 12); return `<div class="${black ? 'bk' : ''}" data-act="key" data-p="${p}">${synth ? (p % 12 === 0 || p % 12 === P().root ? S.noteName(p) : '') : esc((S.drumRows(curTrack()).find((d) => d.p === p) || { n: '' }).n)}</div>`; }).join('') +
      `</div><div class="prgrid" id="prGrid" style="width:${steps * CW}px">` +
      rows.map((p, i) => `<div class="prrow ${synth && !S.inScale(p, P()) ? 'out' : ''} ${synth && p % 12 === P().root ? 'root' : ''}" style="top:${i * RH}px"></div>`).join('') +
      `<div class="ph" id="phPr"></div><div id="prNotes"></div></div></div></div>`;
    setHTML('editor', h);
    renderNotes();
    bindPianoRoll();
    const key = t.id + (rg ? rg.id : sc.id);
    if (U.prFor !== key) {
      U.prFor = key;
      const s = $('#prScroll'), ps = c && c.notes && c.notes.length ? c.notes.map((x) => x.p) : [60];
      const mid = rows.indexOf(Math.round((Math.min(...ps) + Math.max(...ps)) / 2));
      s.scrollTop = Math.max(0, (mid < 0 ? 0 : mid) * RH - s.clientHeight / 2);
    }
  }
  function bindPianoRoll() {
    const grid = $('#prGrid');
    if (!grid) return;
    const tg0 = target(), t = tg0.t, bars = tg0.bars, rows = prRows(t), synth = t.type === 'synth';
    const clip = () => target(true).clip;
    const at = (e) => { const r = grid.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const sortN = (c) => c.notes.sort((a, b) => a.t - b.t);
    const lock = (p) => (synth && U.scaleLock ? S.snapToScale(p, P()) : p);
    let drag = null;
    grid.oncontextmenu = (e) => e.preventDefault();
    grid.onpointerdown = (e) => {
      const q = at(e), nEl = e.target.closest('.nt'), gEl = e.target.closest('.gh'), c = clip();
      S.snap();
      if (!tg0.rg) t.player = null;
      if (gEl) {
        const n = { t: +gEl.dataset.t, d: +gEl.dataset.d, p: +gEl.dataset.p, v: 0.8 };
        c.notes.push(n); sortN(c); U.note = n; E.audition(t, n.p, 0.8);
        return render();
      }
      if (nEl) {
        const n = c.notes[+nEl.dataset.i];
        if (e.altKey || e.button === 2) { c.notes.splice(c.notes.indexOf(n), 1); U.note = null; return render(); }
        U.note = n;
        drag = { n, mode: e.offsetX > nEl.offsetWidth - 7 ? 'size' : 'move', x: q.x, y: q.y, t0: n.t, d0: n.d, r0: rows.indexOf(rowPitch(t, n)) };
        grid.setPointerCapture(e.pointerId);
        return renderNotes();
      }
      const row = Math.floor(q.y / RH);
      if (row < 0 || row >= rows.length) return;
      const p = lock(rows[row]), tt = Math.floor(q.x / CW) * 0.25;
      if (tt >= c.bars * 4) c.bars = bars;
      const n = { t: tt, d: synth ? U.lastLen : 0.25, p, v: 0.8 };
      c.notes.push(n); sortN(c); U.note = n;
      E.audition(t, p, 0.8); logNote(t, p, 0.3);
      render();
    };
    grid.onpointermove = (e) => {
      if (!drag) return;
      const q = at(e), n = drag.n, dx = (q.x - drag.x) / CW / 4;
      if (drag.mode === 'size') { n.d = Math.max(0.25, Math.round((drag.d0 + dx) * 4) / 4); U.lastLen = n.d; }
      else {
        n.t = Math.min(bars * 4 - 0.25, Math.max(0, Math.round((drag.t0 + dx) * 4) / 4));
        const p = lock(rows[Math.min(rows.length - 1, Math.max(0, drag.r0 + Math.round((q.y - drag.y) / RH)))]);
        if (p !== n.p) { n.p = p; E.audition(t, p, n.v); }
      }
      renderNotes();
    };
    grid.onpointerup = () => { if (drag) { drag = null; sortN(clip()); render(); } };
  }

  // ---------- parameters ----------
  function applyParam(d, v) {
    const p = P(), g = E.graph;
    if (d.k === 'vol') tr(d.t).vol = v * 1.25;
    else if (d.k === 'pan') tr(d.t).pan = v * 2 - 1;
    else if (d.k === 'master') p.master[d.key] = d.key === 'vol' ? v * 1.25 : v;
    else if (d.k === 'lfo') p.lfos[d.i][d.key] = v;
    else if (d.k === 'vel') { if (U.note) U.note.v = Math.max(0.05, v); return; }
    else if (d.k === 'pad') { const pd = (tr(d.t).pads || {})[d.p]; if (pd) pd[d.key] = d.key === 'tune' ? Math.round(v * 24 - 12) : v * 2; return; }
    else if (d.k === 'inst') {
      tr(d.t).inst[d.key] = v;
      const ip = g && g.tracks[d.t] && g.tracks[d.t].instParams[d.key];
      if (ip) D.applyParam(g.ctx, ip, v, true);
      return;
    } else if (d.k === 'fx') {
      const [bi, key] = d.key.split('.');
      tr(d.t).fx[d.i].blocks[bi].vals[key] = v;
      const fx = g && g.tracks[d.t] && g.tracks[d.t].fx[d.i];
      if (fx) fx.setParam(d.key, v);
      return;
    }
    E.applyMix();
  }
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.ctl');
    if (!el) return;
    e.preventDefault();
    S.snap();
    const d = JSON.parse(el.dataset.p), v0 = parseFloat(el.style.getPropertyValue('--v')) || 0, x0 = e.clientX, y0 = e.clientY, hs = el.classList.contains('hslider');
    const span = hs ? el.offsetWidth : el.classList.contains('fader') ? el.offsetHeight : 130;
    el.setPointerCapture(e.pointerId);
    const mv = (ev) => { const v = Math.min(1, Math.max(0, v0 + (hs ? ev.clientX - x0 : y0 - ev.clientY) / span)); el.style.setProperty('--v', v); applyParam(d, v); };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });

  // ---------- score log (rolling 5-minute capture of played notes) ----------
  function logNote(t, p, secs) {
    const now = performance.now();
    U.log.push({ ms: now, p, secs, tid: t.id });
    while (U.log.length && now - U.log[0].ms > 300000) U.log.shift();
  }
  const NOTE_KEYS = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14 };
  const DRUM_KEYS = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'];
  function keyNote(code) {
    const t = curTrack();
    if (!t || t.type === 'audio') return null;
    if (t.type === 'drums') { const r = S.drumRows(t)[DRUM_KEYS.indexOf(code)]; return r ? r.p : null; }
    return code in NOTE_KEYS ? 60 + U.octave * 12 + NOTE_KEYS[code] : null;
  }

  // ---------- popovers ----------
  const showPop = (html) => { const p = $('#pop'); p.innerHTML = `<div class="popbox">${html}</div>`; p.hidden = false; const i = p.querySelector('input'); if (i) i.focus(); };
  const closePop = () => ($('#pop').hidden = true);
  $('#pop').addEventListener('pointerdown', (e) => { if (e.target.id === 'pop') closePop(); });
  const KEYMAP = {
    common: [['Space', 'play', 'Play / stop'], ['Tab', 'flip', 'Flip the rack to its back panel'], ['Meta+z', 'undo', 'Undo'], ['Meta+s', 'save', 'Save project'], ['Meta+o', 'open', 'Open / import'],
      ['Backspace', 'delRg', 'Delete the selected note or region'], ['Meta+e', 'splitRg', 'Split region at the playhead'], ['Meta+d', 'dup', 'Duplicate region or scene']],
    pattern: [['l', 'toggleMode', 'Pattern / Song mode'], ['F5', 'showTimeline', 'Playlist'], ['F7', 'showEditor', 'Piano roll'], ['=', 'nextScene', 'Next pattern'], ['-', 'prevScene', 'Previous pattern'], ['Meta+b', 'dupScene', 'Duplicate pattern'], ['r', 'rec', 'Record']],
    session: [['Shift+Tab', 'toggleBottom', 'Clip view / device view'], ['Meta+Shift+t', 'addSynth', 'Insert MIDI track'], ['Meta+t', 'addAudio', 'Insert audio track'], ['Meta+i', 'addScene', 'Insert scene'], ['Meta+d', 'dupScene', 'Duplicate scene'], ['F9', 'rec', 'Record'], ['F10', 'arrView', 'Session / Arrangement view']],
    arrange: [['Enter', 'stop', 'Go to beginning'], ['p', 'showEditor', 'Piano roll'], ['x', 'showMixer', 'Mixer'], ['b', 'showDevices', 'Devices'], ['k', 'metronome', 'Metronome'], ['r', 'rec', 'Record'], ['Meta+t', 'splitRg', 'Split region at the playhead'], ['m', 'muteSel', 'Mute track'], ['s', 'soloSel', 'Solo track'], ['Meta+Alt+s', 'addSynth', 'New software instrument track'], ['Meta+Alt+a', 'addAudio', 'New audio track']],
    mixedit: [['Enter', 'stop', 'Return to zero'], ['Meta+=', 'showMixer', 'Toggle Mix / Edit windows'], ['Shift+m', 'muteSel', 'Mute track'], ['Shift+s', 'soloSel', 'Solo track'], ['Meta+Shift+n', 'addSynth', 'New track'], ['7', 'metronome', 'Click on / off'], ['F12', 'rec', 'Record']],
  };

  // ---------- actions ----------
  const structural = (fn) => { S.snap(); fn(); changed(true); };
  const A = {
    play() {
      if (E.playing) return A.pause();
      E.mode = $('#modeSel').value; E.sceneId = curScene().id;
      let from = 0;
      if (E.mode === 'song') {
        const total = S.songEnd(P());
        if (!total) return U.toast('The song is empty — add a section or a region, or switch to Scene loop.', true);
        from = U.playFrom < total ? U.playFrom : 0;
      }
      E.play(from); syncHeader();
    },
    pause() { const was = U.recording; E.stop(); E.noLoop = false; if (was && !was.pending && IO.native()) IO.native().postMessage({ op: 'recStop' }); syncHeader(); },
    stop() { A.pause(); U.playFrom = 0; if (U.visible.timeline) renderTimeline(); },
    // Recording runs in the Mac shell (Core Audio input); the web layer plays the song alongside it.
    rec() {
      if (U.recording) return A.pause();
      if (!IO.native()) return U.toast('Recording needs the STRATUM Mac app, which captures the Mac’s audio input.', true);
      let t = P().tracks.find((x) => x.arm && x.type === 'audio');
      if (!t) {
        t = curTrack().type === 'audio' ? curTrack() : null;
        if (!t) { S.snap(); t = S.newTrack(P(), 'audio'); E.rebuild(); }
        t.arm = true;
      }
      E.ensure();
      U.track = t.id; U.recording = { tid: t.id, start: U.playFrom || 0, pending: true };
      IO.native().postMessage({ op: 'recStart', monitor: !!U.monitor });
      syncHeader();
    },
    arm(el) { const t = tr(el.dataset.t); t.arm = !t.arm; if (t.arm) for (const o of P().tracks) if (o !== t) o.arm = false; render(); },
    monitor() { U.monitor = !U.monitor; syncHeader(); U.toast(U.monitor ? 'Direct monitoring on: the input is passed straight to the output while recording, bypassing all effects. Use headphones to avoid feedback.' : 'Direct monitoring off.'); },
    zoom(el) { U.pxb = Math.min(240, Math.max(12, Math.round(U.pxb * (el.dataset.d === 'in' ? 1.5 : 1 / 1.5)))); render(); },
    arrView() { U.sessionTop = U.sessionTop === 'timeline' ? 'session' : 'timeline'; render(); },
    sceneMode() { U.region = null; U.note = null; render(); },
    dup() { return regionOf(curTrack()) ? A.dupRg() : A.dupScene(); },
    delRg() {
      if (U.note) return A.delNote();
      const t = curTrack(), rg = regionOf(t);
      if (!rg) return;
      S.snap(); t.regions.splice(t.regions.indexOf(rg), 1); U.region = null; render();
    },
    dupRg() { const t = curTrack(), rg = regionOf(t); if (!rg) return; S.snap(); const c = JSON.parse(JSON.stringify(rg)); c.id = S.uid(); c.start = rg.start + rg.len; t.regions.push(c); U.region = c.id; render(); },
    splitRg() {
      const t = curTrack(), rg = regionOf(t), pos = E.position(), at = Math.round((pos && E.mode === 'song' ? pos.song : U.playFrom) * 4) / 4;
      if (!rg) return U.toast('Select a region first.');
      S.snap();
      if (!S.splitRegion(t, rg, at)) { S.undo.pop(); return U.toast('Put the playhead inside the region (click the ruler), then split.'); }
      render();
    },
    metronome() { E.metro = !E.metro; syncHeader(); },
    keys() { U.keys = !U.keys; syncHeader(); U.toast(U.keys ? 'Keys on: A–L row plays the selected track, Z / X change octave. Everything you play is captured for Dump Score Log.' : 'Keys off: letter keys are shortcuts again.'); },
    toggleMode() { $('#modeSel').value = $('#modeSel').value === 'scene' ? 'song' : 'scene'; C.mode($('#modeSel')); },
    new() { S.snap(); const p = S.blankProject(); S.newScene(p, 'Scene 1', 1); S.newTrack(p, 'drums', 'Drums'); S.newTrack(p, 'synth', 'Synth'); setProject(p); },
    open() { U.pendingAudio = null; U.pendingSample = null; IO.open(); },
    share() {
      const p = P(), go = (t, label) => `<button data-act="shareGo" data-target="${t}">${label}</button>`;
      showPop(`<h3>Share your track</h3><p class="hint">STRATUM makes a branded vertical video (for TikTok, Reels, Shorts and X) and an audio file, and saves both in your Movies › STRATUM folder.</p>` +
        `<label>Title <input id="shTitle" value="${esc(p.name || 'Untitled')}"></label><label>Artist <input id="shArtist" value="${esc(p.artist || '')}" placeholder="Your artist name"></label>` +
        `<label>Length <select id="shClip">${opts([['', 'Whole track'], ['60', 'First 60 seconds'], ['30', 'First 30 seconds'], ['15', 'First 15 seconds']], '')}</select></label>` +
        `<div class="stock"><b>Send</b> ${go('messages', 'Text (Messages)')}${go('mail', 'Email')}${go('airdrop', 'AirDrop')}${go('more', 'More…')}</div>` +
        `<div class="stock"><b>Post</b> ${go('tiktok', 'TikTok')}${go('instagram', 'Instagram')}${go('youtube', 'YouTube')}${go('x', 'X')}</div>` +
        `<p class="hint">For TikTok, Instagram, YouTube and X, STRATUM opens the upload page and shows the video in Finder, ready to drag in.</p>` +
        `${go('save', 'Just save the files')} <button data-act="closePop">Cancel</button>`);
    },
    shareGo(el) {
      const title = ($('#shTitle').value || '').trim() || 'Untitled', artist = ($('#shArtist').value || '').trim(), clip = +$('#shClip').value || 0;
      P().artist = artist;
      closePop();
      if (!IO.native()) return U.toast('Sharing needs the STRATUM Mac app. Use Export to save a WAV file instead.', true);
      IO.share(el.dataset.target, title, artist, clip).catch((e) => U.toast('Could not share: ' + (e.message || e), true));
    },
    clearAuto() { structural(() => { delete curTrack().auto; delete P().master.auto; }); },
    wanted() {
      const w = P().wanted || [];
      showPop(`<h3>Missing samples</h3><p class="hint">This project uses these sound files, but they are not on this Mac where the project says they are. Choose them (you can pick several at once); files are matched by name.</p><div class="plist">` +
        w.map((x) => `<div title="${esc(x.path)}">${esc(x.file)}</div>`).join('') + `</div><button data-act="wantedPick">Choose sample files…</button> <button data-act="closePop">Close</button>`);
    },
    wantedPick() { closePop(); U.pendingAudio = null; U.pendingSample = null; U.locating = true; U.located = 0; IO.open(true); },
    save() { IO.saveProject(); },
    undo() { const s = S.undo.pop(); if (!s) return U.toast('Nothing to undo'); S.proj = JSON.parse(s); U.note = null; if (!tr(U.track)) U.track = P().tracks[0].id; if (!P().scenes.some((x) => x.id === U.scene)) U.scene = P().scenes[0].id; if (!P().scenes.some((x) => x.id === E.sceneId)) E.sceneId = U.scene; E.rebuild(); syncHeader(); render(); },
    help() {
      const row = ([k, , l]) => `<tr><td><kbd>${esc(k.replace('Meta', '⌘').replace('Alt', '⌥').replace('Shift', '⇧').replace(/\+/g, ' '))}</kbd></td><td>${esc(l)}</td></tr>`;
      showPop(`<h3>Shortcuts — ${esc(SKIN_NAMES[U.skin])}</h3><table class="keys">${[...KEYMAP.common, ...KEYMAP[U.skin]].map(row).join('')}</table><p class="hint">Switching the Comfort Skin changes both the layout and this key map. With “Keys” on, letter keys play notes instead.</p><button data-act="closePop">Close</button>`);
    },
    closePop,
    selTrack(el) { U.track = el.dataset.t; U.note = null; if (U.skin === 'session') U.bottom.session = 'devices'; render(); },
    selScene(el) { U.scene = el.dataset.s; U.note = null; U.region = null; if (!E.playing || E.mode === 'scene') E.sceneId = U.scene; render(); },
    cell(el) { U.track = el.dataset.t; U.scene = el.dataset.s; U.note = null; U.region = null; U.bottom.session = 'editor'; if (!E.playing) E.sceneId = U.scene; render(); },
    launch(el) { U.scene = el.dataset.s; E.sceneId = U.scene; E.mode = 'scene'; E.play(0); syncHeader(); render(); },
    addScene() { structural(() => { const s = S.newScene(P(), null, curScene().bars); s.chords = [...(curScene().chords || [1])]; U.scene = s.id; if (!E.playing) E.sceneId = s.id; }); },
    dupScene() { structural(() => { const o = curScene(), s = S.newScene(P(), o.name + ' copy', o.bars); s.chords = [...(o.chords || [1])]; for (const t of P().tracks) if (t.clips[o.id]) t.clips[s.id] = JSON.parse(JSON.stringify(t.clips[o.id])); U.scene = s.id; if (!E.playing) E.sceneId = s.id; }); },
    nextScene() { const s = P().scenes, i = s.indexOf(curScene()); A.selScene({ dataset: { s: s[(i + 1) % s.length].id } }); },
    prevScene() { const s = P().scenes, i = s.indexOf(curScene()); A.selScene({ dataset: { s: s[(i + s.length - 1) % s.length].id } }); },
    mute(el) { const t = tr(el.dataset.t); t.mute = !t.mute; changed(false); },
    solo(el) { const t = tr(el.dataset.t); t.solo = !t.solo; changed(false); },
    muteSel() { A.mute({ dataset: { t: curTrack().id } }); },
    soloSel() { A.solo({ dataset: { t: curTrack().id } }); },
    addSynth() { structural(() => (U.track = S.newTrack(P(), 'synth').id)); },
    addAudio() { structural(() => (U.track = S.newTrack(P(), 'audio').id)); },
    delTrack() { if (P().tracks.length < 2) return U.toast('A project needs at least one track.'); structural(() => { const t = curTrack(); P().tracks.splice(P().tracks.indexOf(t), 1); U.track = P().tracks[0].id; }); },
    step(el) {
      const t = tr(el.dataset.t), sc = curScene(), i = +el.dataset.i, tt = i * 0.25, p = el.dataset.p ? +el.dataset.p : null;
      S.snap(); t.player = null; U.region = null;
      const c = t.clips[sc.id] && t.clips[sc.id].notes ? t.clips[sc.id] : (t.clips[sc.id] = { bars: sc.bars, notes: [] });
      const hit = (n) => Math.abs(n.t - tt) < 1e-6 && (p == null || S.drumMap(n.p) === p);
      if (c.notes.some(hit)) c.notes = c.notes.filter((n) => !hit(n));
      else { const np = p != null ? p : S.degree(P(), 1, 3); c.notes.push({ t: tt, d: 0.25, p: np, v: 0.8 }); c.notes.sort((a, b) => a.t - b.t); E.audition(t, np, 0.8); }
      if (tt >= c.bars * 4) c.bars = sc.bars;
      U.track = t.id; render();
    },
    key(el) { const t = curTrack(), p = +el.dataset.p; E.audition(t, p, 0.8); logNote(t, p, 0.3); },
    delNote() { const c = target().clip; if (!c || !c.notes || !U.note) return; S.snap(); c.notes.splice(c.notes.indexOf(U.note), 1); U.note = null; render(); },
    regen() { S.snap(); S.generate(P(), curTrack(), curScene()); render(); },
    dump() {
      const t = curTrack(), sc = curScene(), ev = U.log.filter((x) => x.tid === t.id);
      if (t.type === 'audio') return U.toast('Select a synth or drum track first.');
      if (!ev.length) return U.toast('Nothing captured on this track yet. Turn on Keys (or click the piano-roll keys) and play — the last 5 minutes are always kept.');
      S.snap(); t.player = null;
      const bps = P().bpm / 60, q = (v) => Math.round(v * 4) / 4, t0 = ev[0].ms;
      const notes = ev.map((x) => ({ t: q(((x.ms - t0) / 1000) * bps), d: Math.max(0.25, q(x.secs * bps)), p: x.p, v: 0.8 })).filter((n) => n.t < 256);
      const bars = Math.max(sc.bars, Math.ceil(Math.max(...notes.map((n) => n.t + n.d)) / 4));
      sc.bars = bars; t.clips[sc.id] = { bars, notes };
      U.log = U.log.filter((x) => x.tid !== t.id);
      U.toast(`Score log dumped: ${notes.length} notes over ${bars} bar${bars > 1 ? 's' : ''} into “${sc.name}”.`);
      render();
    },
    addBlock() { S.snap(); S.stamp(P(), curScene(), 1); U.block = P().sections.length - 1; render(); },
    selBlock(el) { U.block = U.block === +el.dataset.i ? -1 : +el.dataset.i; if (P().sections[U.block]) U.playFrom = P().sections[U.block].start; render(); },
    blk(el) {
      const p = P(), sec = p.sections[U.block], d = el.dataset.d;
      if (!sec) return;
      const s0 = sec.start, e0 = sec.start + sec.len, len = sec.len, eps = 1e-6;
      const inside = (a, b) => { const out = []; for (const t of p.tracks) for (const r of t.regions) if (r.start >= a - eps && r.start < b - eps) out.push([t, r]); return out; };
      S.snap();
      if (d === 'del' || d === 'more') {
        const mine = inside(s0, e0), later = inside(e0, Infinity), by = d === 'del' ? -len : len;
        for (const [, r] of later) r.start += by;
        for (const s of p.sections) if (s !== sec && s.start >= e0 - eps) s.start += by;
        if (d === 'del') { for (const [t, r] of mine) t.regions.splice(t.regions.indexOf(r), 1); p.sections.splice(U.block, 1); U.block = -1; }
        else {
          for (const [t, r] of mine) { const c = JSON.parse(JSON.stringify(r)); c.id = S.uid(); c.start += len; t.regions.push(c); }
          p.sections.splice(U.block + 1, 0, { id: S.uid(), name: sec.name, start: e0, len });
        }
      } else {
        const sorted = [...p.sections].sort((a, b) => a.start - b.start), other = sorted[sorted.indexOf(sec) + (d === 'left' ? -1 : 1)];
        const A1 = other && (other.start < sec.start ? other : sec), B1 = other && (other.start < sec.start ? sec : other);
        if (!other || Math.abs(A1.start + A1.len - B1.start) > eps) { S.undo.pop(); return U.toast('There is no adjoining section on that side.'); }
        const ra = inside(A1.start, A1.start + A1.len), rb = inside(B1.start, B1.start + B1.len);
        for (const [, r] of ra) r.start += B1.len;
        for (const [, r] of rb) r.start -= A1.len;
        B1.start = A1.start; A1.start = B1.start + B1.len;
      }
      render();
    },
    showEditor() { if (U.skin === 'mixedit') U.ptWin = 'edit'; else U.bottom[U.skin] = 'editor'; render(); },
    showTimeline() { if (U.skin === 'pattern') U.bottom.pattern = 'timeline'; else if (U.skin === 'mixedit') U.ptWin = 'edit'; else if (U.skin === 'session') U.sessionTop = 'timeline'; render(); },
    showMixer() { if (U.skin === 'mixedit') U.ptWin = U.ptWin === 'mix' ? 'edit' : 'mix'; else if (U.skin === 'arrange') U.bottom.arrange = 'mixer'; render(); },
    showDevices() { if (U.skin === 'mixedit') U.ptWin = 'mix'; else if (U.skin !== 'pattern') U.bottom[U.skin] = 'devices'; render(); },
    toggleBottom() { U.bottom.session = U.bottom.session === 'editor' ? 'devices' : 'editor'; render(); },
    flip() { U.flip = !U.flip; U.arm = null; if (!U.visible.devices) return A.showDevices(); const d = $('#devices'); d.classList.remove('flipping'); void d.offsetWidth; d.classList.add('flipping'); renderDevices(); },
    selFx(el) { U.track = el.dataset.t; A.showDevices(); },
    addFx(el) {
      U.track = el.dataset.t || curTrack().id;
      showPop(`<h3>Prompt-to-Plugin · ${esc(curTrack().name)}</h3><input id="ppIn" placeholder="Describe the effect, e.g. dusty lo-fi tape saturation with an analog chorus">` +
        `<p class="hint">Press Return to build it. The builder recognises effect words (saturation, tape, lo-fi, filter, chorus, phaser, delay, reverb, compressor, bit-crush, tremolo, vinyl…) and intensity words (subtle, heavy, slow, fast, huge, short).</p>` +
        `<div class="stock">Or add a single effect: ${D.ORDER.map((k) => `<button data-act="addStock" data-type="${k}">${D.BLOCKS[k].label}</button>`).join('')}</div><button data-act="closePop">Cancel</button>`);
    },
    addStock(el) { structural(() => curTrack().fx.push(D.stock(el.dataset.type))); closePop(); A.showDevices(); },
    rmFx(el) { structural(() => { const t = curTrack(), i = +el.dataset.i; t.fx.splice(i, 1); t.cables = t.cables.filter((c) => c.dev !== i).map((c) => (c.dev > i ? { ...c, dev: c.dev - 1 } : c)); }); },
    jackOut(el) { U.arm = U.arm === +el.dataset.i ? null : +el.dataset.i; renderDevices(); },
    jackIn(el) {
      const t = curTrack(), dev = +el.dataset.dev, key = el.dataset.key, i = t.cables.findIndex((c) => c.dev === dev && c.key === key);
      if (i >= 0) return structural(() => t.cables.splice(i, 1));
      if (U.arm == null) return U.toast('Click an LFO “CV out” jack first, then this input.');
      structural(() => { t.cables.push({ src: U.arm, dev, key }); U.arm = null; });
    },
    loadAudio(el) { U.pendingAudio = el.dataset.t; U.pendingSample = null; IO.open(); },
    // Sampler: pick sound files for one pad, a whole kit, a new pad, or the sample a synth track plays.
    padLoad(el) { U.pendingSample = { t: curTrack().id, p: +el.dataset.p }; IO.open(); },
    padKit() { U.pendingSample = { t: curTrack().id }; IO.open(true); },
    padAdd() { U.pendingSample = { t: curTrack().id, add: true }; IO.open(true); },
    padPlay(el) { E.audition(curTrack(), +el.dataset.p, 0.9); },
    padClear(el) {
      const t = curTrack(), p = +el.dataset.p;
      S.snap(); delete t.pads[p];
      if (!S.DRUMS.some((d) => d.p === p)) { const keep = (c) => { if (c && c.notes) c.notes = c.notes.filter((n) => n.p !== p); }; Object.values(t.clips).forEach(keep); t.regions.forEach((r) => keep(r.clip)); }
      changed(true);
    },
    instLoad() { U.pendingSample = { t: curTrack().id }; IO.open(); },
    // Plugins: pick an installed Audio Unit as this track's instrument or as an effect after it.
    async plugPick(el) {
      if (!S.plug.available()) return U.toast('Plugins need the STRATUM Mac app.', true);
      const kind = el.dataset.kind, list = (await S.plug.list()).filter((p) => p.kind === kind);
      showPop(`<h3>${kind === 'inst' ? 'Choose an instrument plugin' : 'Add a plugin effect'} · ${esc(curTrack().name)}</h3><input placeholder="Type to filter" oninput="const q=this.value.toLowerCase();this.parentNode.querySelectorAll('.plist button').forEach(b=>b.hidden=!b.textContent.toLowerCase().includes(q))">` +
        `<p class="hint">${list.length} Audio Unit and VST3 ${kind === 'inst' ? 'instruments' : 'effects'} installed on this Mac.</p><div class="plist">` +
        list.sort((a, b) => (/Recommended/.test(b.collections || '') ? 1 : 0) - (/Recommended/.test(a.collections || '') ? 1 : 0)).map((p) => `<button data-act="plugSet" data-kind="${kind}" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-maker="${esc(p.maker)}" title="${esc(p.what || '')}">${esc(p.name)} <small>${esc(p.maker)}${p.category ? ' · ' + esc(p.category) : ''}${/Recommended/.test(p.collections || '') ? ' · recommended' : ''}</small></button>`).join('') + `</div><button data-act="closePop">Cancel</button>`);
    },
    plugSet(el) {
      const t = curTrack(), d = el.dataset;
      structural(() => {
        if (d.kind === 'inst') t.plugin = { id: d.id, name: d.name, maker: d.maker, state: '', fx: (t.plugin && t.plugin.fx) || [] };
        else S.plug.fxList(t).push({ id: d.id, name: d.name, state: '' });
      });
      closePop();
    },
    plugOpen(el) { S.plug.show(curTrack(), +el.dataset.slot); },
    plugCtl(el) { U.pctl[curTrack().id + ':' + el.dataset.slot] = el.dataset.open !== '1'; renderDevices(); },
    async plugRmFx(el) { await S.plug.capture(); structural(() => S.plug.fxList(curTrack()).splice(+el.dataset.i, 1)); },
    instClear() { S.snap(); delete curTrack().inst.sample; changed(true); },
    async stems() {
      const tg = target(), t = tg.t, c = tg.clip, rec = c && S.buffers[c.audio];
      if (!rec) return;
      if (U.stemBusy) return U.toast('Stem separation is already running.');
      U.stemBusy = true;
      U.toast('Separating stems… loading the model');
      try {
        const parts = await IO.separate(rec.buf, (f) => U.toast(`Separating stems… ${Math.round(f * 100)}%`));
        structural(() => {
          ['Drums', 'Bass', 'Other', 'Vocals'].forEach((nm, i) => {
            const id = S.uid(), nt = S.newTrack(P(), 'audio', t.name + ' · ' + nm);
            S.buffers[id] = { id, name: rec.name + ' (' + nm + ')', buf: parts[i], bpm: rec.bpm };
            if (tg.rg) nt.regions.push({ ...JSON.parse(JSON.stringify(tg.rg)), id: S.uid(), clip: { ...c, audio: id } });
            else nt.clips[tg.sc.id] = { ...c, audio: id };
          });
          t.mute = true;
        });
        U.toast('Stems separated into four new tracks (Drums, Bass, Other, Vocals). The original track is muted.');
      } catch (e) { U.toast('Stem separation failed: ' + (e.message || e), true); }
      U.stemBusy = false;
    },
    async split() {
      const tg = target(), t = tg.t, c = tg.clip, rec = c && S.buffers[c.audio];
      if (!rec) return;
      U.toast('Splitting into bands…');
      const parts = await D.bandSplit(rec.buf);
      structural(() => {
        for (const [nm, buf] of parts) {
          const id = S.uid(), nt = S.newTrack(P(), 'audio', t.name + ' · ' + nm);
          S.buffers[id] = { id, name: rec.name + ' (' + nm + ')', buf, bpm: rec.bpm };
          if (tg.rg) nt.regions.push({ ...JSON.parse(JSON.stringify(tg.rg)), id: S.uid(), clip: { ...c, audio: id } });
          else nt.clips[tg.sc.id] = { ...c, audio: id };
        }
        t.mute = true;
      });
      U.toast('Created 4 band tracks (Low, Centre mid, Sides, High) and muted the original.');
    },
  };
  S.menu = (a) => (a.startsWith('export:') ? IO.exportAs(a.slice(7)) : A[a] && A[a]());

  U.imported = (res) => {
    if (res.proj) { S.snap(); setProject(res.proj); U.wantedUI(); U.report = res.report; return U.toast(res.report); }
    if (U.pendingSample && tr(U.pendingSample.t) && tr(U.pendingSample.t).type !== 'audio') {
      const ps = U.pendingSample, t = tr(ps.t), nm = res.audio.name.replace(/\.[^.]+$/, '');
      S.snap();
      if (t.type === 'synth') t.inst.sample = { audio: res.audio.id, name: nm, root: 60, loop: false };
      else {
        t.pads = t.pads || {};
        let p = ps.p;
        if (p == null) {
          const g = ps.add ? 0 : S.drumGuess(nm);
          if (g && !t.pads[g]) p = g;
          else { p = 60; while (p < 127 && (t.pads[p] || S.DRUMS.some((d) => d.p === p))) p++; }
        }
        t.pads[p] = { audio: res.audio.id, name: nm, tune: 0, gain: 1 };
        ps.p = null;
      }
      U.track = t.id;
      changed(true);
      return U.toast(t.type === 'synth' ? `Sample loaded: ${nm}. It plays across the keys from its root note.` : `Loaded ${nm} onto a pad.`);
    }
    const rec = res.audio, sc = curScene();
    S.snap();
    const t = (U.pendingAudio && tr(U.pendingAudio)) || S.newTrack(P(), 'audio', rec.name.replace(/\.[^.]+$/, ''));
    U.pendingAudio = null;
    const bars = IO.audioBars(rec, true), clip = { audio: rec.id, warp: !!rec.bpm, bars, gain: 1 };
    if (U.visible.timeline) { const rg = { id: S.uid(), start: U.playFrom, len: bars * 4, off: 0, clip }; t.regions.push(rg); U.region = rg.id; }
    else { t.clips[sc.id] = clip; if (bars > sc.bars) sc.bars = bars; U.region = null; }
    U.track = t.id;
    changed(true);
    U.toast(rec.bpm ? `Audio added: ${rec.name} — detected ${rec.bpm} BPM, warped to ${Math.round(P().bpm)}.` : `Audio added: ${rec.name}. Tempo was not detected; enter the Source BPM to warp it.`);
  };
  // Called when a file-picker batch has finished (or was cancelled), so a later plain Open is not treated as a sample load.
  U.openDone = () => {
    U.pendingSample = null; U.pendingAudio = null;
    if (U.locating) { U.locating = false; U.wantedDone(U.located); }
  };
  // Samples the project points at: refresh the header button and say what was found.
  U.wantedUI = () => { const n = (P().wanted || []).length, b = $('#wantBtn'); b.hidden = !n; b.textContent = `Missing samples (${n})`; };
  U.wantedDone = (found) => {
    const left = (P().wanted || []).length;
    E.rebuild(); render(); U.wantedUI();
    if (found || left) U.followUp((found ? `Loaded ${found} sample file${found === 1 ? '' : 's'} into the project. ` : '') + (left ? `${left} could not be found — click “Missing samples” to choose them.` : 'All of its samples are loaded.'), !found && !!left);
  };
  U.recStarted = () => {
    const r = U.recording;
    if (!r) return;
    r.pending = false;
    E.mode = 'song'; E.noLoop = true;
    if (!U.visible.timeline) A.showTimeline();
    E.play(r.start); syncHeader();
  };
  U.recFailed = (msg) => { U.recording = null; E.stop(); E.noLoop = false; syncHeader(); U.toast('Recording could not start: ' + msg, true); };
  // A finished pass becomes a new region, or a new take on the recorded region it overlaps.
  U.recorded = (rec, inputLatency) => {
    const r = U.recording, t = r && tr(r.tid);
    U.recording = null; syncHeader();
    if (!t) return;
    const lat = (E.ctx.outputLatency || 0) + (E.ctx.baseLatency || 0) + inputLatency, cutN = Math.min(rec.buf.length - 1, Math.floor(lat * rec.buf.sampleRate));
    if (cutN > 0) {
      const nb = new AudioBuffer({ length: rec.buf.length - cutN, numberOfChannels: rec.buf.numberOfChannels, sampleRate: rec.buf.sampleRate });
      for (let c = 0; c < nb.numberOfChannels; c++) nb.copyToChannel(rec.buf.getChannelData(c).subarray(cutN), c);
      rec.buf = nb;
    }
    const len = Math.round(rec.buf.duration * (P().bpm / 60) * 100) / 100, s = r.start, e = s + len;
    if (len < 0.1) return U.toast('Nothing was recorded.');
    S.snap();
    let rg = t.regions.find((x) => x.takes && x.start < e - 1e-6 && x.start + x.len > s + 1e-6);
    if (rg) {
      if (s < rg.start) { const d = rg.start - s; rg.start = s; rg.len += d; rg.takes.forEach((k) => (k.shift += d)); rg.comp.forEach((c) => { c.from += d; c.to += d; }); }
      rg.len = Math.max(rg.len, e - rg.start);
      rg.takes.push({ audio: rec.id, shift: s - rg.start });
      S.paintComp(rg, s - rg.start, e - rg.start, rg.takes.length - 1);
    } else {
      rg = { id: S.uid(), start: s, len, off: 0, clip: { audio: rec.id, warp: true, bars: Math.max(1, Math.ceil(len / 4)), gain: 1 }, takes: [{ audio: rec.id, shift: 0 }], comp: [{ from: 0, to: len, take: 0 }] };
      t.regions.push(rg);
    }
    rec.name = t.name + ' take ' + rg.takes.length;
    U.track = t.id; U.region = rg.id;
    changed(false);
    U.toast(`Recorded take ${rg.takes.length} on “${t.name}” (${rec.buf.duration.toFixed(1)} s, ${Math.round(lat * 1000)} ms latency removed).` + (rg.takes.length > 1 ? ' Open the region to comp between takes.' : ''));
  };

  // ---------- change handlers ----------
  // Plugin controls move while dragging, not only when released.
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.chg === 'plugParam') S.plug.setParam(curTrack(), +el.dataset.slot, +el.dataset.i, +el.value).then((txt) => { const v = el.parentNode.querySelector('.pv'); if (v && txt != null) v.textContent = txt; });
  });
  const C = {
    bpm(el) { const v = Math.min(240, Math.max(40, parseFloat(el.value) || 120)); E.setBpm(v); el.value = v; },
    root(el) { S.snap(); P().root = +el.value; S.regenPlayers(P()); render(); },
    scale(el) { S.snap(); P().scale = el.value; S.regenPlayers(P()); render(); },
    mode(el) { E.mode = el.value; if (E.playing) { E.sceneId = curScene().id; E.play(0); } syncHeader(); },
    skin(el) { U.skin = el.value; document.body.className = 'skin-' + U.skin; U.flip = false; render(); U.toast('Layout and shortcuts switched to the ' + SKIN_NAMES[U.skin] + ' skin. Press ? for the key map.'); el.blur(); },
    export(el) { const v = el.value; el.value = ''; if (v) IO.exportAs(v); },
    addTrack(el) { const v = el.value; el.value = ''; if (v) structural(() => (U.track = S.newTrack(P(), v).id)); },
    sceneName(el) { const s = P().scenes.find((x) => x.id === el.dataset.s); S.snap(); s.name = el.value || s.name; render(); },
    trackName(el) { S.snap(); curTrack().name = el.value || curTrack().name; render(); },
    sceneBars(el) { S.snap(); const sc = curScene(); sc.bars = +el.value; S.regenPlayers(P(), sc); render(); },
    chords(el) { S.snap(); const sc = curScene(), v = el.value.split(/[\s,]+/).map(Number).filter((n) => n >= 1 && n <= 14); sc.chords = v.length ? v : [1]; S.regenPlayers(P(), sc); render(); },
    player(el) { S.snap(); const t = curTrack(); t.player = el.value || null; if (t.player) S.generate(P(), t, curScene()); render(); },
    scaleLock(el) { U.scaleLock = el.checked; },
    cents(el) { if (U.note) { S.snap(); U.note.c = Math.min(50, Math.max(-50, +el.value || 0)); } },
    glide(el) { if (U.note) { S.snap(); U.note.g = el.checked; renderNotes(); } },
    inst(el) { S.snap(); curTrack().inst[el.dataset.key] = el.value; },
    // Switch what a note track plays: built-in synth, the producer's own sample, a drum kit, or a plugin.
    plugParam() {},   // handled while dragging (see the input listener above)
    instKind(el) {
      const t = curTrack(), k = el.value;
      if (k === 'plugin') { render(); return A.plugPick({ dataset: { kind: 'inst' } }); }
      structural(() => {
        delete t.plugin;
        t.type = k === 'drums' ? 'drums' : 'synth';
        if (t.type === 'synth' && !t.inst) t.inst = S.newInst();
        if (k === 'synth' && t.inst) delete t.inst.sample;
      });
      if (k === 'sample' && !t.inst.sample) A.instLoad();
    },
    instRoot(el) { const s = curTrack().inst.sample; if (s) { S.snap(); s.root = Math.min(108, Math.max(12, Math.round(+el.value) || 60)); render(); } },
    instLoop(el) { const s = curTrack().inst.sample; if (s) { S.snap(); s.loop = el.checked; } },
    lfoShape(el) { S.snap(); P().lfos[+el.dataset.i].shape = el.value; E.applyMix(); },
    srcBpm(el) { const c = target().clip, rec = c && S.buffers[c.audio]; if (!rec) return; rec.bpm = Math.min(240, Math.max(0, parseFloat(el.value) || 0)); rec.warpCache = null; c.bars = IO.audioBars(rec, c.warp); render(); },
    warp(el) { const c = target().clip, rec = c && S.buffers[c.audio]; if (!c) return; S.snap(); c.warp = el.checked; if (rec) c.bars = IO.audioBars(rec, c.warp); render(); },
    clipBars(el) { const c = target().clip; if (c) { S.snap(); c.bars = Math.max(1, Math.round(+el.value) || 1); render(); } },
  };

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || e.target.closest('.ctl') || (e.target.matches('input,select') && el !== e.target)) return;
    if (el.tagName === 'BUTTON') el.blur();
    if (A[el.dataset.act]) A[el.dataset.act](el, e);
  });
  document.addEventListener('change', (e) => { const k = e.target.dataset.chg; if (k && C[k]) C[k](e.target); });
  document.addEventListener('keydown', (e) => {
    const inField = !!(e.target.matches && e.target.matches('input,select,textarea'));
    if (e.target.id === 'ppIn' && e.key === 'Enter') {
      const text = e.target.value.trim();
      if (!text) return;
      const pl = D.fromPrompt(text);
      structural(() => curTrack().fx.push(pl));
      closePop(); A.showDevices();
      const chain = pl.blocks.map((b) => D.BLOCKS[b.type].label).join(' → ');
      return U.toast(pl.matched ? `Built “${pl.name}”: ${chain}` : `No effect words recognised in that prompt, so “${pl.name}” starts as a gentle ${chain}. Try words like tape, chorus, delay or reverb.`, !pl.matched);
    }
    if (e.key === 'Escape') { closePop(); if (inField) e.target.blur(); return; }
    if (inField && !(e.metaKey && ['KeyS', 'KeyO'].includes(e.code))) { if (e.key === 'Enter') e.target.blur(); return; }
    if (U.keys && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.code === 'KeyZ' || e.code === 'KeyX') { U.octave = Math.min(2, Math.max(-3, U.octave + (e.code === 'KeyZ' ? -1 : 1))); return e.preventDefault(); }
      const p = keyNote(e.code);
      if (p != null) { e.preventDefault(); if (!e.repeat && !U.held[e.code]) { U.held[e.code] = { ms: performance.now(), p, t: curTrack() }; E.audition(curTrack(), p, 0.8); } return; }
    }
    const k = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.code.startsWith('Digit') ? e.code.slice(5) : { Space: 'Space', Equal: '=', Minus: '-' }[e.code] || e.key;
    const combo = (e.metaKey || e.ctrlKey ? 'Meta+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + k;
    const hit = [...KEYMAP[U.skin], ...KEYMAP.common].find((x) => x[0] === combo);
    if (hit) { e.preventDefault(); A[hit[1]](); }
  });
  document.addEventListener('keyup', (e) => {
    const h = U.held[e.code];
    if (!h) return;
    delete U.held[e.code];
    const now = performance.now();
    U.log.push({ ms: h.ms, p: h.p, secs: (now - h.ms) / 1000, tid: h.t.id });
    while (U.log.length && now - U.log[0].ms > 300000) U.log.shift();
  });
  $('#file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) await IO.importBytes(f.name, await f.arrayBuffer());
    U.openDone();
  });
  window.addEventListener('resize', drawCables);
  $('#devices').addEventListener('animationend', () => $('#devices').classList.remove('flipping'));

  // ---------- animation: playheads, meters, position ----------
  function frame() {
    requestAnimationFrame(frame);
    const pos = E.position(), cs = curScene(), here = pos && pos.scene && pos.scene.id === cs.id;
    $('#pos').textContent = pos ? `${Math.floor(pos.local / 4) + 1}.${Math.floor(pos.local % 4) + 1}.${Math.floor((pos.local % 1) * 4) + 1}` : '1.1.1';
    const put = (id, show, x) => { const el = document.getElementById(id); if (el) { el.style.display = show ? 'block' : 'none'; if (show) el.style.transform = `translateX(${x}px)`; } };
    put('phRack', here, HEADW + (pos ? pos.local * 4 * STEPW : 0));
    const tg = target(), rg = tg.rg, c = tg.clip, L = Math.max(1, (c && c.bars) || tg.bars) * 4, bw = U.pxb / 4, song = pos && E.mode === 'song';
    const inRg = rg && song && pos.song >= rg.start && pos.song < rg.start + rg.len;
    put('phPr', rg ? inRg : here, !pos ? 0 : rg ? ((pos.song - rg.start + rg.off) % L) * 4 * CW : (pos.local % L) * 4 * CW);
    put('phComp', inRg, 70 + (inRg ? (pos.song - rg.start) * COMPX : 0));
    put('phTl', !!song, HEADW + (song ? pos.song * bw : 0));
    if (E.graph) for (const el of U.meters) {
      const an = el.dataset.m === 'master' ? E.graph.master.an : E.graph.tracks[el.dataset.m] && E.graph.tracks[el.dataset.m].an;
      el._v = Math.max(an ? E.peak(an) : 0, (el._v || 0) * 0.9);
      el.style.height = Math.min(100, Math.sqrt(el._v) * 100) + '%';
    }
  }

  setProject(S.demoProject());
  S.undo.length = 0;
  frame();
})();
