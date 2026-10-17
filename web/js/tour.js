// STRATUM guided tour: offered on first open, and from Help › Take the Tour. Each step lights up one part of the window
// and explains it; some steps wait for you to try the thing (press Play, open Sounds) and move on by themselves.
(function () {
  const S = window.S, E = S.engine, IO = S.io, T = (S.tour = {});
  const $ = (q) => document.querySelector(q);
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden'; };
  const pick = (sel) => (sel ? sel.split(',').map((q) => $(q.trim())).find(visible) || null : null);

  const STEPS = [
    { title: 'Welcome to STRATUM', text: 'This tour shows you where everything is in about two minutes. Use Next and Back, or Skip to leave at any time — you can take it again from the Help menu.' },
    { sel: '#playBtn', title: 'Play and stop', text: 'Press Play (or the Space bar) to hear the demo song. Try it now — the tour moves on when it starts playing.', wait: () => E.playing },
    { sel: '#modeSel', title: 'Scene loop or Song', text: 'Scene loop repeats the scene you are working on, like a pattern in FL Studio or a scene in Ableton. Song plays the whole arrangement from start to finish.' },
    { sel: '#bpm', title: 'Tempo and key', text: 'Set the tempo here, and the song’s key and scale next to it. The built-in players, the scale lock in the piano roll and STRATUM Tune all follow the key.' },
    { sel: '#skinSel', title: 'Comfort Skins', text: 'Choose a layout that feels like the software you know: Pattern (FL Studio), Session (Ableton Live), Arrange (Logic, Cubase) or Mix / Edit (Pro Tools). Your project stays the same — only the layout and shortcuts change.' },
    { sel: '#addTrackSel', title: 'Add tracks', text: 'Add a synth, drum or audio track. Any note track can later become STRATUM Wave (the wavetable synth), your own sample, a drum kit or a plugin.' },
    { sel: '#timeline, #session, #rack', title: 'Your music', text: 'Regions and clips live here. Click one to select it and edit it below; drag to move it, and use the arrow buttons to zoom.' },
    { sel: '#editor', title: 'Piano roll', text: 'Notes of the selected clip. Click to add a note, drag to move or stretch it, and use Scale lock to stay in key.' },
    { sel: '#devices, #inspector', title: 'Devices', text: 'The selected track’s instrument and effects. Choose the instrument at the top (built-in synth, STRATUM Wave, your own sample, drums or a plugin). Add effects by describing them in plain words with Prompt-to-Plugin, or pick from the stock effects, the 508 Airwindows effects and your own plugins.' },
    { sel: '[data-act="sounds"]', title: 'Sounds', text: 'Click Sounds to browse 791 free drums, percussion and vocal sounds plus MIDI chord kits. Preview with ▶ and add one to the selected track with one click. Try it now.', wait: () => !$('#pop').hidden && /Sounds/.test($('#pop').textContent), after: () => { const p = $('#pop'); if (p) p.hidden = true; } },
    { sel: '#recBtn', title: 'Record', text: 'Arm an audio track and press Record to record from your microphone or interface. Each pass becomes a take you can comp. Monitor lets you hear yourself while recording.' },
    { sel: '[data-act="open"]', title: 'Open and import', text: 'Open STRATUM projects, or bring in work from FL Studio, Ableton Live, Logic Pro, Reason, MIDI files and audio — with their samples where the project includes them.' },
    { sel: '[data-act="share"]', title: 'Share', text: 'Turn your track into a STRATUM video and audio file for Instagram, TikTok, Facebook, X, Threads and YouTube, or send it by Messages, Mail or AirDrop. Export saves a WAV, MIDI or DAWproject file.' },
    { sel: '[data-act="help"]', title: 'Help', text: 'Shortcuts for the current skin, this tour, and the Owner’s Manual are all under ? and the Help menu.' },
    { title: 'You’re ready', text: 'That’s the tour. Open the Owner’s Manual from the Help menu any time for the full guide, with diagrams and notes for people coming from other software.' },
  ];

  let i = 0, poll = null, box = null, card = null, dim = null;
  const close = () => { clearInterval(poll); [box, card, dim].forEach((x) => x && x.remove()); box = card = dim = null; T.running = false; };
  const show = () => {
    clearInterval(poll);
    const st = STEPS[i], el = pick(st.sel);
    if (!dim) { dim = document.createElement('div'); dim.className = 'tour-dim'; document.body.appendChild(dim); }
    if (!box) { box = document.createElement('div'); box.className = 'tour-box'; document.body.appendChild(box); }
    if (!card) { card = document.createElement('div'); card.className = 'tour-card'; document.body.appendChild(card); }
    card.innerHTML = `<div class="tour-step">${i + 1} / ${STEPS.length}</div><h3>${st.title}</h3><p>${st.text}</p><div class="tour-btns">` +
      `<button data-t="skip">Skip tour</button><span></span>${i ? '<button data-t="back">Back</button>' : ''}<button data-t="next" class="primary">${i === STEPS.length - 1 ? 'Finish' : 'Next'}</button></div>`;
    card.querySelectorAll('button').forEach((b) => (b.onclick = () => (b.dataset.t === 'skip' ? close() : b.dataset.t === 'back' ? go(-1) : go(1))));
    if (el) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect(), pad = 6;
      Object.assign(box.style, { display: 'block', left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
      dim.style.display = 'none';
      const cw = Math.min(360, innerWidth - 24), below = r.bottom + 14 + 200 < innerHeight;
      Object.assign(card.style, { width: cw + 'px', left: Math.max(12, Math.min(innerWidth - cw - 12, r.left + r.width / 2 - cw / 2)) + 'px', top: (below ? r.bottom + 14 : Math.max(12, r.top - 14 - card.offsetHeight)) + 'px', transform: 'none' });
    } else {
      box.style.display = 'none'; dim.style.display = 'block';
      Object.assign(card.style, { width: Math.min(420, innerWidth - 24) + 'px', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' });
    }
    if (st.wait) poll = setInterval(() => { if (st.wait()) { clearInterval(poll); setTimeout(() => { if (st.after) st.after(); go(1); }, 700); } }, 250);
  };
  const go = (d) => { i += d; if (i < 0) i = 0; if (i >= STEPS.length) return close(); show(); };
  T.start = () => { if (T.running) return; T.running = true; i = 0; show(); };
  addEventListener('resize', () => T.running && show());

  // First open: ask once whether to take the tour. The answer is remembered by the Mac app (or the browser).
  const prefs = { get: async () => { if (IO.native()) return (await S.plug.ask({ op: 'prefsGet' })) || {}; try { return JSON.parse(localStorage.getItem('stratum.prefs') || '{}'); } catch (e) { return {}; } },
    set: (k, v) => { if (IO.native()) IO.native().postMessage({ op: 'prefSet', key: k, value: v }); else try { const p = JSON.parse(localStorage.getItem('stratum.prefs') || '{}'); p[k] = v; localStorage.setItem('stratum.prefs', JSON.stringify(p)); } catch (e) {} } };
  T.offer = async () => {
    const p = await prefs.get();
    if (p.tourAsked || p.testing) return;
    prefs.set('tourAsked', true);
    const pop = $('#pop');
    pop.innerHTML = `<div class="popbox tour-welcome"><img src="logo.png" alt="" width="56" height="56"><h3>Welcome to STRATUM</h3><p>Would you like a quick tour? It points out where everything is and lets you try a few things as you go. It takes about two minutes.</p><div class="tour-btns"><button id="tourNo">Not now</button><span></span><button id="tourYes" class="primary">Take the tour</button></div><p class="hint">You can take it later from Help › Take the Tour.</p></div>`;
    pop.hidden = false;
    $('#tourYes').onclick = () => { pop.hidden = true; T.start(); };
    $('#tourNo').onclick = () => { pop.hidden = true; };
  };
  setTimeout(T.offer, 600);
})();
