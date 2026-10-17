/* Walk Companion service worker: offline app shell, walk data and OS map tiles. */
const SHELL = 'wc-shell-v2';
const DATA = 'wc-data-v1';
const TILES = 'wc-tiles-v1';
const OSM_TILES = 'wc-osm-v1';
const SHELL_FILES = [
  './', 'index.html', 'app.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'routes/index.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('wc-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'precache') caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => {});
});

function tileKey(url) { const u = new URL(url); u.search = ''; return u.toString(); }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // OS map tiles: cache first, keyed without the API key
  if (url.hostname === 'api.os.uk' && url.pathname.includes('/maps/raster/')) {
    const key = tileKey(req.url);
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(key);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok) c.put(key, r.clone()); return r; }
      catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  // OpenStreetMap fallback tiles: cached only as they are viewed (no bulk download, per the OSM tile policy)
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(OSM_TILES).then(async (c) => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok) c.put(req.url, r.clone()); return r; }
      catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Route data: network first so edits arrive, cache when offline
  if (url.pathname.includes('/routes/')) {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(DATA).then((c) => c.put(req, copy)); return r; })
      .catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  // App shell: cache first, refresh in the background
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
