// Network-first for the app shell, falling back to cache so the site opens offline. Firestore data has its own offline cache.
const CACHE = "mkt-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then((ch) => ch.put(r, c)); } return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match("/index.html"))),
  );
});
