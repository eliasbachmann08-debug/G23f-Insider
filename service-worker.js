const CACHE_NAME = "g23f-insider-v6-2026-08-17";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./stundenplan/index.html",
  "./stundenplan/styles.css",
  "./stundenplan/app.js",
  "./notes/index.html",
  "./notes/styles.css",
  "./notes/app.js",
  "./shared/firebase.js",
  "./shared/session.js",
  "./shared/shell.css",
  "./shared/shell.js",
  "./faecher/faecher.json",
  "./faecher/biologie/index.html",
  "./faecher/biologie/app.js",
  "./faecher/biologie/themen.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
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
