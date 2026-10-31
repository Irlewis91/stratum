// Equaliser bars in the hero.
(() => { const b = document.querySelector('.bars'); for (let i = 0; i < 48; i++) { const s = document.createElement('i'); s.style.animationDelay = (-(Math.sin(i * 1.7) + 1) * 0.55).toFixed(2) + 's'; s.style.animationDuration = (0.7 + ((i * 37) % 9) / 10).toFixed(2) + 's'; b.appendChild(s); } })();

// Layout switcher.
(() => {
  const caps = {
    strata: 'Strata, only in STRATUM: the song as glowing layers, a live Stage of Visuals, and Record, Share and Go live one click away.',
    pattern: 'Pattern: a step sequencer and channel rack, for building loops one pattern at a time.',
    session: 'Session: clips in a grid you launch live, scene by scene.',
    arrange: 'Arrange: a timeline of regions for laying out the whole song.',
    mixedit: 'Mix / Edit: big faders and editors for finishing the track.',
  };
  const img = document.getElementById('skinImg'), cap = document.getElementById('skinCap');
  cap.textContent = caps.strata;
  Object.keys(caps).forEach((k) => { const i = new Image(); i.src = 'img/' + k + '.jpg'; });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    img.src = 'img/' + b.dataset.skin + '.jpg'; cap.textContent = caps[b.dataset.skin];
  }));
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
  if (q.toString()) { history.replaceState(null, '', '/#download'); document.getElementById('download').scrollIntoView(); }
})();
