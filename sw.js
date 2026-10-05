// Service worker: aplikace funguje i offline, zvuky klavíru se uloží po prvním stažení
const APP = 'noty-app-v1', SAMPLES = 'noty-piano-v1';
const SHELL = ['./', 'index.html', 'engine.js', 'tone.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== APP && k !== SAMPLES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'generativelanguage.googleapis.com') return; // čtení not nikdy necachovat
  if (url.hostname === 'tonejs.github.io') {
    // zvuky klavíru: nejdřív z cache
    e.respondWith(caches.open(SAMPLES).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  if (url.origin === location.origin) {
    // aplikace: síť první (aby se projevily úpravy na GitHubu), offline z cache
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) caches.open(APP).then(c => c.put(e.request, r.clone()));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  }
});
