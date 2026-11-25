// Service worker : l'accordeur doit démarrer sans réseau (cave, scène, avion).
// Stratégie « stale-while-revalidate » : réponse immédiate depuis le cache,
// mise à jour silencieuse en arrière-plan pour la prochaine ouverture.

const CACHE = 'accordeur-v8';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/tuner.js',
  './js/metronome.js',
  './js/pitch.js',
  './js/notes.js',
  './js/tunings.js',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // « reload » : on ignore le cache HTTP du navigateur (GitHub Pages sert
      // max-age=600), sinon une version fraîche de sw.js pourrait mettre en cache
      // les fichiers périmés de la version précédente.
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });

      // « no-cache » : revalide auprès du serveur plutôt que de relire le cache HTTP.
      const network = fetch(request, { cache: 'no-cache' })
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      if (cached) return cached;

      const fresh = await network;
      if (fresh) return fresh;

      // Hors ligne et rien en cache : on retombe sur la coquille de l'app.
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Hors ligne', { status: 503, statusText: 'Hors ligne' });
    })
  );
});
