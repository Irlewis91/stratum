// The page plays when you scroll: your hand is the transport, and the equaliser only moves while you move.
(() => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches, root = document.documentElement;
  root.classList.add(calm ? 'calm' : 'play');
  const clamp = (v) => Math.min(1, Math.max(0, v)), make = (el, n) => Array.from({ length: n }, () => el.appendChild(document.createElement('i')));
  const hero = make(document.getElementById('heroBars'), innerWidth < 720 ? 28 : 48), chordEl = document.getElementById('chord'), chord = make(chordEl, innerWidth < 720 ? 40 : 72);
  const caps = {
    strata: 'Strata, only in STRATUM: the song as glowing layers, a live Stage of Visuals, and Record, Share and Go live one click away.',
    pattern: 'Pattern: a step sequencer and channel rack, for building loops one pattern at a time.',
    session: 'Session: clips in a grid you launch live, scene by scene.',
    arrange: 'Arrange: a timeline of regions for laying out the whole song.',
    mixedit: 'Mix / Edit: big faders and editors for finishing the track.',
  };
  const skins = document.getElementById('skins'), cap = document.getElementById('skinCap'), wipe = document.getElementById('wipe');
  const layers = [...document.querySelectorAll('#layers img')], tabs = [...document.querySelectorAll('.tabs button')];
  const mark = (k) => { cap.textContent = caps[k]; tabs.forEach((x) => { const on = x.dataset.skin === k; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); }); };
  mark('strata');
  tabs.forEach((b) => b.addEventListener('click', () => {
    if (calm) { layers.forEach((l) => l.classList.toggle('show', l.dataset.skin === b.dataset.skin)); layers[0].style.display = b.dataset.skin === 'strata' ? '' : 'none'; return mark(b.dataset.skin); }
    const i = layers.findIndex((l) => l.dataset.skin === b.dataset.skin), r = skins.getBoundingClientRect(), span = skins.offsetHeight - innerHeight;
    scrollTo({ top: scrollY + r.top + (span * i) / (layers.length - 1) });
  }));
  if (calm) { [...hero, ...chord].forEach((x, i) => { x.style.height = 25 + 55 * Math.abs(Math.sin(i * 0.7)) + '%'; }); return; }
  const stage = document.getElementById('stage'), tilt = document.getElementById('tilt');
  // Each bar's place in the final chord: a shape that rises to two peaks and holds.
  const shape = (i, n) => { const x = i / (n - 1); return 0.16 + 0.8 * Math.pow(Math.sin(Math.PI * x), 1.4) * (0.62 + 0.38 * Math.abs(Math.cos(x * 9))); };
  let last = scrollY, energy = 0, shown = 'strata';
  const frame = (ms) => {
    const y = scrollY, t = ms / 1000, h = innerHeight;
    energy += (Math.min(1, Math.abs(y - last) / 34) - energy) * (Math.abs(y - last) > 1 ? 0.2 : 0.06);
    last = y;
    const sr = stage.getBoundingClientRect();
    if (sr.bottom > 0 && sr.top < h) {
      const p = clamp(-sr.top / Math.max(1, stage.offsetHeight - h + 100));
      tilt.style.setProperty('--p', p); stage.style.setProperty('--p', p);
      tilt.style.setProperty('--head', clamp((p - 0.12) / 0.8));
      hero.forEach((b, i) => { b.style.transform = `scaleY(${(0.08 + 0.92 * energy * Math.abs(Math.sin(i * 0.55 + t * 7 + Math.sin(i * 1.7) * 2))).toFixed(3)})`; });
    }
    const kr = skins.getBoundingClientRect();
    if (kr.bottom > 0 && kr.top < h) {
      // Each layout holds, then the playhead wipes in the next one. This is the widest stretch of the page.
      const f = clamp(-kr.top / Math.max(1, skins.offsetHeight - h)) * (layers.length - 1), seg = Math.min(layers.length - 2, Math.floor(f)), run = clamp((f - seg - 0.25) / 0.5);
      layers.forEach((l, i) => { if (i) l.style.clipPath = `inset(0 ${i <= seg ? 0 : i === seg + 1 ? (1 - run) * 100 : 100}% 0 0)`; });
      wipe.style.left = run * 100 + '%'; wipe.style.opacity = run > 0 && run < 1 ? 1 : 0;
      const now = layers[run > 0.5 ? seg + 1 : seg].dataset.skin;
      if (now !== shown) { shown = now; mark(now); }
    }
    const cr = chordEl.getBoundingClientRect();
    if (cr.bottom > 0 && cr.top < h) {
      const land = clamp((h - cr.top) / (h * 0.62));
      chord.forEach((b, i) => { const wobble = (1 - land) * energy * Math.abs(Math.sin(i * 0.8 + t * 7)); b.style.transform = `scaleY(${Math.min(1, 0.06 + land * (shape(i, chord.length) - 0.06) + wobble * 0.5).toFixed(3)})`; });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();

// Fade sections in as they scroll into view.
(() => {
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' }) : null;
  document.querySelectorAll('.reveal').forEach((el) => (io ? io.observe(el) : el.classList.add('in')));
})();

// Download gate: what the producer sees depends on whether they've signed in and joined.
(async () => {
  const q = new URLSearchParams(location.search), note = document.getElementById('note');
  const say = (t) => { note.textContent = t; note.hidden = false; };
  const msgs = {
    cancelled: 'Sign-in was cancelled. You can try again whenever you like.',
    expired: 'That sign-in took too long. Please try again.',
    failed: "Discord sign-in didn't go through. Please try again in a minute.",
    needed: 'Sign in with Discord first, then the download starts.',
    unavailable: "Discord sign-in isn't switched on yet. Join the server now and check back soon.",
  };
  if (q.get('signin')) say(msgs[q.get('signin')] || msgs.failed);
  let me = { signedIn: false };
  try { me = await (await fetch('/api/me', { cache: 'no-store' })).json(); } catch (e) {}
  if (me.invite) document.getElementById('joinBtn').href = me.invite;
  if (me.signedIn && me.member) {
    document.getElementById('gate').hidden = true;
    document.getElementById('files').hidden = false;
    document.getElementById('hello').textContent = 'Welcome, ' + me.name + '. Pick your download:';
    note.hidden = true;
  } else if (me.signedIn) {
    document.getElementById('s1').classList.add('done');
    document.getElementById('signBtn').textContent = "I've joined, check again";
    say('You are signed in as ' + me.name + ", but you're not in the STRATUM server yet. Join it, then press “I've joined, check again”.");
  }
  if (['signin', 'join', 'welcome'].some((k) => q.has(k))) { history.replaceState(null, '', '/#download'); document.getElementById('download').scrollIntoView(); }
})();
