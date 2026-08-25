const CACHE_VERSION = 'trinca-v2';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-192-dark.png',
  '/icons/icon-512.png',
  '/icons/icon-512-dark.png',
  '/icons/logo-full.png',
  '/icons/logo-full-dark.png',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Only GET requests are cacheable; everything else (POST /api/analyze, etc.)
  // goes straight to the network so it fails naturally when offline.
  if (req.method !== 'GET') return;

  // API calls (e.g. AI photo analysis) always need a live network — never cache them.
  if (url.pathname.startsWith('/api/')) return;

  // Page navigations: try the network first (to pick up updates), and fall back
  // to the cached app shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Same-origin static assets (manifest, icons, sw.js itself): cache-first,
  // refreshed in the background so the app keeps working offline.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Cross-origin requests (e.g. Google Fonts): pass through to the network as-is.
});
