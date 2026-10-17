// STRATUM offline support for the web app: the app is saved on first visit (and refreshed whenever online), and each
// library sound is saved the first time it is used, so STRATUM keeps working without a connection.
const VERSION = 'stratum-__BUILD__';
const SHELL = __SHELL__;
self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== 'stratum-library').map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const lib = url.pathname.includes('/library/') && !url.pathname.endsWith('library.json');
  if (lib) {
    // Library sounds never change: use the saved copy, or fetch and save it.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open('stratum-library').then((c) => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  // The app itself: always the newest version when online, the saved copy when offline.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
