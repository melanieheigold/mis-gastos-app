// Keeps the app shell available offline. Data is never cached here: app.js keeps the
// last good API response itself, so a stale shell can never show stale totals as fresh.

const SHELL = 'mg-shell-v7';
const FILES = ['./', 'index.html', 'app.css?v=7', 'app.js?v=7', 'config.js?v=7', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Shell: network first (so updates arrive), cache when offline. Other origins: untouched.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // no-cache: always ask GitHub whether the file changed (its 10-minute cache would
  // otherwise keep an old version after an upload); falls back to our copy offline.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
