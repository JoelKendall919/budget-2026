/* Budget 2026 — service worker.
   Caches the app shell so it opens instantly and still works on a train
   with no signal. It deliberately never caches data: the budget document
   comes from Supabase (or the localStorage mirror), never from here. */

const CACHE = "budget-shell-v2";
const SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./css/mobile.css",
  "./js/config.js",
  "./js/storage.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) return;          // Supabase & CDN: always live
  if (url.pathname.endsWith(".json")) return;          // never cache data

  // Network-first so a deploy is picked up promptly, cache as the fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});
