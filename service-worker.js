const CACHE_NAME = "g23f-insider-v15-2026-08-30";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=2026-08-21-3",
  "./app.js?v=2026-08-21-3",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./stundenplan/index.html",
  "./stundenplan/styles.css?v=2026-08-30-3",
  "./stundenplan/app.js?v=2026-08-30-1",
  "./notes/index.html",
  "./notes/styles.css",
  "./notes/app.js",
  "./shared/firebase.js",
  "./shared/session.js",
  "./shared/shell.css",
  "./shared/shell.js",
  "./faecher/index.html",
  "./faecher/styles.css",
  "./faecher/app.js",
  "./faecher/faecher.json",
  "./maturareise/index.html",
  "./maturareise/styles.css?v=2026-08-21-2",
  "./maturareise/app.js?v=2026-08-21-2",
  "./faecher/biologie/index.html",
  "./faecher/biologie/app.js",
  "./faecher/biologie/themen.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(async () => (await caches.match(event.request)) || caches.match("./index.html"))
    );
    return;
  }

  if (event.request.destination === "style" || event.request.destination === "script") {
    event.respondWith(
      fetch(event.request, { cache: "no-cache" }).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      });
    }).catch(() => caches.match("./index.html"))
  );
});
