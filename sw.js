// Bump VERSION whenever you change any app file, so clients pick up the new shell.
const VERSION = 'mdv-v29';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'about.md',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png',
];

// The shell is fetched past the browser's HTTP cache. Otherwise a heuristically "fresh" old copy of one
// file (servers like python's http.server send no Cache-Control) can be cached next to new copies of the
// others, e.g. a new index.html with an old app.js.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin files are revalidated past the HTTP cache too (see install); CDN URLs are immutable. A
// navigation request can't be copied with new options, so it's fetched by URL, and if that was redirected
// (which a navigation can't be answered with) the original request is used after all.
function revalidate(req, sameOrigin) {
  if (!sameOrigin) return fetch(req);
  if (req.mode !== 'navigate') return fetch(new Request(req, { cache: 'no-cache' }));
  return fetch(req.url, { cache: 'no-cache' }).then((res) => (res.redirected ? fetch(req) : res));
}

// Stale-while-revalidate for the app shell and the CDN libraries
// (the CDN URLs are version-pinned, so caching them is safe).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !cdn) return;

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: sameOrigin });
      const network = revalidate(req, sameOrigin)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
