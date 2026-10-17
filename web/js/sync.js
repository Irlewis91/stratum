// STRATUM Sync: sign in with Discord or an emailed code, and every beat you work on is kept in your account and opens on
// your Mac, Windows PC, phone and tablet. Talks straight to the Supabase project in sync-config.js (sign-in, a "projects"
// table of names and versions, and a private "projects" storage bucket holding the .stratum files).
(function () {
  const S = window.S, IO = S.io, U = S.ui;
  const CFG = window.STRATUM_SYNC || {};
  const SY = (S.sync = { state: 'off' });
  const KEY = 'stratum.sync.session', BUCKET = 'projects';
  const configured = () => !!(CFG.url && CFG.key);
  SY.configured = configured;

  // Where sign-in returns to. The Mac app intercepts this address and reloads its own page with the sign-in details.
  const REDIRECT = IO.platform === 'windows' ? 'https://app.stratum/index.html' : IO.platform === 'mac' ? 'https://irlewis91.github.io/stratum/?app=mac' : location.origin + location.pathname;
  const DEVICE = (() => {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
    if (IO.platform === 'windows' || /Windows/.test(ua)) return 'Windows PC';
    return 'Mac';
  })();
  SY.device = DEVICE;

  // ---------- session ----------
  let session = null;
  try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  const keep = (s) => { session = s; try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch (e) {} };
  SY.user = () => session && session.user;
  const fromAuth = (j) => ({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() / 1000 + (+j.expires_in || 3600), user: j.user || null });

  async function raw(path, opts = {}, auth = true) {
    const h = { apikey: CFG.key, ...(opts.headers || {}) };
    if (auth && session) h.Authorization = 'Bearer ' + session.access_token;
    const r = await fetch(CFG.url.replace(/\/$/, '') + path, { ...opts, headers: h });
    if (!r.ok) {
      let msg = r.status + '';
      try { const j = await r.json(); msg = j.msg || j.message || j.error_description || j.error || msg; } catch (e) {}
      const err = new Error(msg); err.status = r.status; throw err;
    }
    return r;
  }
  async function fresh() {
    if (!session) throw new Error('Not signed in');
    if (session.expires_at - 60 > Date.now() / 1000) return;
    try {
      const j = await (await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) }, false)).json();
      keep({ ...fromAuth(j), user: j.user || session.user });
    } catch (e) {
      if (e.status === 400 || e.status === 401) { keep(null); SY.state = 'signedout'; badge(); }
      throw e;
    }
  }
  const api = async (path, opts) => { await fresh(); return raw(path, opts); };
  const json = { 'Content-Type': 'application/json' };

  // Sign-in, Discord: the project is set aside, the page goes to Discord and comes back with the sign-in in its address.
  SY.discord = async () => {
    await stash();
    location.href = `${CFG.url.replace(/\/$/, '')}/auth/v1/authorize?provider=discord&scopes=${encodeURIComponent('identify email')}&redirect_to=${encodeURIComponent(REDIRECT)}`;
  };
  // Sign-in, email: a 6-digit code is emailed, then typed in here (works the same in every version of STRATUM).
  SY.emailCode = (email) => raw('/auth/v1/otp', { method: 'POST', headers: json, body: JSON.stringify({ email, create_user: true }) }, false);
  SY.verify = async (email, token) => {
    const j = await (await raw('/auth/v1/verify', { method: 'POST', headers: json, body: JSON.stringify({ type: 'email', email, token: token.replace(/\s/g, '') }) }, false)).json();
    keep(fromAuth(j));
    await signedIn();
  };
  SY.signOut = async () => {
    try { await api('/auth/v1/logout', { method: 'POST' }); } catch (e) {}
    keep(null); known = {}; SY.state = 'signedout'; badge();
  };

  // Returning from Discord: the address holds #access_token=…&refresh_token=…
  async function fromRedirect(hash) {
    const h = new URLSearchParams((hash == null ? location.hash : hash).replace(/^#/, ''));
    if (!h.get('access_token') && !h.get('error')) return false;
    try { history.replaceState(null, '', location.pathname + location.search.replace(/[?&]app=mac/, '')); } catch (e) { location.hash = ''; }
    if (h.get('error')) { U.toast('Sign-in was cancelled: ' + (h.get('error_description') || h.get('error')).replace(/\+/g, ' '), true); return false; }
    keep(fromAuth({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_in: h.get('expires_in') }));
    try { session.user = await (await raw('/auth/v1/user')).json(); keep(session); } catch (e) {}
    return true;
  }

  // ---------- setting the project aside during sign-in ----------
  const db = () => new Promise((res, rej) => { const r = indexedDB.open('stratum', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const kv = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('kv', mode), q = fn(t.objectStore('kv')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  async function stash() {
    try {
      const text = await IO.projectJSON(), base = SY.base && { id: SY.base.id, rev: SY.base.rev, print: SY.base.print };
      await kv('readwrite', (st) => st.put(JSON.stringify({ text, base }), 'stash'));
    } catch (e) {}
  }
  async function unstash() {
    try {
      const v = await kv('readonly', (st) => st.get('stash'));
      if (!v) return false;
      await kv('readwrite', (st) => st.delete('stash'));
      const { text, base } = JSON.parse(v);
      if (!text) return false;
      U.setProject(await IO.loadProject(text));
      if (base) SY.base = base;
      return true;
    } catch (e) { return false; }
  }

  // ---------- the beats in your account ----------
  const uid = () => session.user && session.user.id;
  const path = (id) => `${uid()}/${id}.stratum`;
  const gzip = async (text) => {
    if (!window.CompressionStream) return new Blob([text]);
    return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  };
  const gunzip = async (blob) => {
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (head[0] === 0x1f && head[1] === 0x8b) return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return blob.text();
  };
  SY.list = async () => (await (await api('/rest/v1/projects?select=id,name,updated_at,size,device,rev&order=updated_at.desc')).json());
  async function row(id) { const r = await (await api(`/rest/v1/projects?select=id,rev,device,updated_at,name&id=eq.${encodeURIComponent(id)}`)).json(); return r[0] || null; }

  async function upload(id, name, text, rev) {
    const body = await gzip(text);
    if (body.size > 50 * 1048576) throw new Error('This beat is over 50 MB with its audio, which is more than sync can store. Save it as a file instead.');
    await api(`/storage/v1/object/${BUCKET}/${path(id)}`, { method: 'POST', headers: { 'x-upsert': 'true', 'Content-Type': 'application/octet-stream' }, body });
    await api('/rest/v1/projects?on_conflict=user_id,id', { method: 'POST', headers: { ...json, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id, user_id: uid(), name, size: body.size, device: DEVICE, rev, updated_at: new Date().toISOString() }) });
  }
  // `unchanged`: only replace the beat on screen if it still matches this fingerprint (no edits while downloading).
  SY.open = async (id, unchanged) => {
    const blob = await (await api(`/storage/v1/object/authenticated/${BUCKET}/${path(id)}`)).blob();
    const r = await row(id);
    const proj = await IO.loadProject(await gunzip(blob));
    if (unchanged && print() !== unchanged) return null;
    proj.id = id;
    U.setProject(proj);
    SY.base = { id, rev: r ? r.rev : 1, print: print() };
    return proj;
  };
  SY.remove = async (id) => {
    await api(`/storage/v1/object/${BUCKET}/${path(id)}`, { method: 'DELETE' }).catch(() => {});
    await api(`/rest/v1/projects?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (SY.base && SY.base.id === id) SY.base = { id: null, rev: 0, print: print() };
  };

  // ---------- automatic syncing ----------
  // SY.base: the beat on screen, the version of it last synced, and a fingerprint of it at that moment.
  SY.base = null;
  const print = () => { const p = S.proj; if (!p) return ''; const t = JSON.stringify(p); let h = 0; for (let i = 0; i < t.length; i += 7) h = (h * 31 + t.charCodeAt(i)) | 0; return t.length + ':' + h; };
  let known = {}, busy = false, lastChange = 0, lastPrint = '', lastSynced = 0;
  SY.lastSynced = () => lastSynced;

  let running = Promise.resolve();
  function tick(force) { if (busy) return running; running = tick1(force); return running; }
  async function tick1(force) {
    if (!session || !configured() || !S.proj) return;
    // A different beat was opened (New, or a file): it syncs from its first change. A file that was synced before
    // (rev -1: version unknown) is never replaced by the account's copy; if both changed, both are kept.
    if (!SY.base || (SY.base.proj !== S.proj && SY.base.id !== S.proj.id)) { SY.base = { id: S.proj.id || null, rev: S.proj.id ? -1 : 0, print: print(), proj: S.proj }; lastPrint = SY.base.print; }
    SY.base.proj = S.proj;
    const now = print();
    if (now !== lastPrint) { lastPrint = now; lastChange = Date.now(); }
    const dirty = now !== SY.base.print;
    busy = true;
    try {
      if (dirty && (force || Date.now() - lastChange > 4000)) {
        if (!S.proj.id) S.proj.id = S.uid() + S.uid();
        const id = S.proj.id, remote = await row(id);
        let rev = (remote ? remote.rev : 0) + 1;
        if (remote && remote.rev > Math.max(0, SY.base.rev) && SY.base.id === id) {
          // Changed on another device while it was changed here too: keep both.
          S.proj.id = S.uid() + S.uid();
          S.proj.name = (S.proj.name || 'Untitled') + ` (${DEVICE})`;
          rev = 1;
          U.toast(`“${remote.name}” was also changed on your ${remote.device}, so this version is kept as “${S.proj.name}”.`);
        }
        SY.state = 'syncing'; badge();
        const proj = S.proj, text = await IO.projectJSON(), sent = print();   // what is uploaded; later edits stay pending
        await upload(proj.id, proj.name || 'Untitled', text, rev);
        if (S.proj === proj) SY.base = { id: proj.id, rev, print: sent, proj };
      } else if (!dirty && SY.base.id) {
        // Not changed here: if another device saved a newer version, bring it in.
        const remote = await row(SY.base.id);
        if (remote && SY.base.rev >= 0 && remote.rev > SY.base.rev && !S.engine.playing) {
          SY.state = 'syncing'; badge();
          if (await SY.open(SY.base.id, now)) {
            lastPrint = SY.base.print;
            U.toast(`“${remote.name}” was updated on your ${remote.device}.`);
          }
        }
      }
      lastSynced = Date.now();
      SY.state = 'synced';
    } catch (e) {
      SY.state = session ? 'error' : 'signedout';
      SY.error = e.message || String(e);
      if (!navigator.onLine) SY.state = 'offline';
    }
    busy = false;
    badge();
  }
  SY.now = async () => { await running; return tick(true); };

  async function signedIn() {
    SY.state = 'synced'; badge();
    U.toast(`Signed in${session.user && session.user.email ? ' as ' + session.user.email : ''}. Your beats now sync between your devices.`);
    await tick(true);
  }

  // ---------- header button ----------
  function badge() {
    const b = document.getElementById('syncBtn');
    if (!b) return;
    b.hidden = !configured();
    const t = { off: 'Sync', signedout: 'Sync', synced: '☁ Synced', syncing: '☁ Syncing…', offline: '☁ Offline', error: '☁ Sync problem' }[SY.state] || 'Sync';
    b.textContent = t;
    b.classList.toggle('warn', SY.state === 'error');
    b.title = SY.state === 'error' ? 'Sync problem: ' + SY.error : 'Sync your beats between devices';
  }
  SY.badge = badge;
  // The Mac app hands over the sign-in when its page never left (the sign-in finished without showing a page).
  SY.fromNative = async (hash) => { if (await fromRedirect(hash) && session) { await kv('readwrite', (st) => st.delete('stash')).catch(() => {}); await signedIn(); } badge(); };

  async function start() {
    badge();
    if (!configured()) return;
    const back = await fromRedirect();
    const restored = await unstash();
    if (back && session) await signedIn();
    else if (restored) U.toast('Sign-in did not finish; your beat is still here.', true);
    if (session) { SY.state = 'synced'; tick(); }
    else SY.state = 'signedout';
    badge();
    setInterval(() => tick(), 15000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); else tick(true); });
    addEventListener('online', () => tick());
  }
  // Wait until the demo song (or the restored beat) has been set up.
  setTimeout(start, 400);
})();
