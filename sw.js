// Cache dell'app per l'uso offline e l'installazione
const CACHE = 'spotit-v57';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/supabase/supabase.js', 'account.js', 'groups.js', 'layers.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // mappe e ricerca sempre dalla rete
  if (req.mode === 'navigate') {
    // rete prima, così gli aggiornamenti arrivano subito; offline usa la copia
    e.respondWith(fetch(req.url, { cache: 'no-cache' }).catch(() => caches.match('index.html')));
    return;
  }
  // rete prima anche per i file dell'app, senza la cache del browser (GitHub la tiene 10 minuti)
  e.respondWith(fetch(req.url, { cache: 'no-cache' }).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
    return res;
  }).catch(() => caches.match(req)));
});

// Notifiche (es. un amico ha risposto "Ci sono")
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'WeSpot', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'WeSpot', {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag,
    silent: !!d.silent,
    vibrate: d.silent ? undefined : [120, 60, 120],
    data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) { c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
