/* Sage service worker — cache the app shell, NEVER cache the API/audio.
   Bump CACHE to ship an update (pwa-standard auto-update pattern). */
const CACHE = "sage-v6";
const SHELL = ["./", "./index.html", "./app.js", "./style.css", "./manifest.json"];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Never cache the backend API or audio streams — always go to network.
  if (url.pathname.includes("/api/")) return;
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
