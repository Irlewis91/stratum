// Windows self-check for STRATUM Sync (run by the Windows build workflow with tests/mock-sync-server.py): email-code
// sign-in and upload, then a Discord-style sign-in that leaves the page and returns. The result goes in the window title.
if (location.host === 'app.stratum') addEventListener('load', () => setTimeout(async () => {
  const done = (r) => { document.title = 'SYNCTEST ' + JSON.stringify(r); };
  try {
    if (sessionStorage.getItem('st-phase') === '2') {
      await new Promise((r) => setTimeout(r, 3000));
      return done({ email: sessionStorage.getItem('st-email'), user: S.sync.user() && S.sync.user().email, beat: S.proj.name, bpm: S.proj.bpm });
    }
    localStorage.removeItem('stratum.sync.session');
    await S.sync.emailCode('win@example.com'); await S.sync.verify('win@example.com', '123456');
    S.proj.name = 'Windows Beat'; await S.sync.now();
    sessionStorage.setItem('st-email', (await S.sync.list()).map((r) => r.name).join(','));
    await S.sync.signOut();
    S.ui.act('new'); S.proj.name = 'Win unsaved'; S.proj.bpm = 111;
    sessionStorage.setItem('st-phase', '2');
    S.sync.discord();
  } catch (e) { done({ error: String(e.message || e) }); }
}, 2500));
