const CACHE_NAME = 'aideal-auto-v7';
const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/static/css/app.css?v=6.1',
  '/static/js/app.js?v=6.1',
  '/static/js/obd2.js?v=6.1',
  '/static/icons/icon-192.svg',
  '/static/icons/icon-512.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Никогда не кэшируем пользовательские данные, сессии, настройки, воркер и авторизацию
  if (
    url.pathname.startsWith('/api/settings/') ||
    url.pathname.startsWith('/api/sessions/') ||
    url.pathname.startsWith('/api/worker-status/') ||
    url.pathname.startsWith('/api/auth/')
  ) {
    return;
  }

  // Для API словаря DTC используем стратегию Network-First с офлайн-кэшем и полным ключом url.search
  if (url.pathname.startsWith('/api/dtc/')) {
    const dtcCacheKey = new Request(url.origin + url.pathname + url.search, { method: 'GET' });
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(dtcCacheKey, clone));
          }
          return response;
        })
        .catch(() => caches.match(dtcCacheKey, { ignoreSearch: false }))
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) return;

  // HTML-навигация не должна возвращать чужой кэшированный профиль при онлайн-переходе
  if (event.request.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
