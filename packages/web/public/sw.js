// Service worker: assets con cache-first, páginas con network-first y fallback offline.
// Cambiar VERSION borra las cachés anteriores (v2 podía tener páginas con datos de la sesión).
const VERSION = "rc-v3";
const ASSETS = ["/icon.svg", "/manifest.webmanifest"];
// Páginas para usar sin conexión. Se guardan pedidas SIN cookies: una versión neutra, sin datos de nadie
// (lo personal, como los reportes anónimos propios, lo agrega el navegador desde su almacenamiento).
const OFFLINE_PAGES = ["/reportar", "/mis-reportes"];

const anonymous = (url) => new Request(url, { credentials: "omit" });
const isPrivate = (res) => /private|no-store/i.test(res.headers.get("Cache-Control") ?? "");

async function refreshOfflinePages(cache) {
  await Promise.all(OFFLINE_PAGES.map(async (path) => {
    const res = await fetch(anonymous(path));
    if (res.ok && !isPrivate(res)) await cache.put(path, res);
  }));
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => {
    await c.addAll(ASSETS);
    await refreshOfflinePages(c).catch(() => {});
  }).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/admin")) return;

  // /media/ queda afuera a propósito: si un moderador retira una foto, no tiene que seguir guardada acá.
  if (url.pathname.startsWith("/_astro/") || /\.(png|svg|webmanifest)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
      return res;
    })));
    return;
  }

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => {
      // Con conexión se renueva la versión neutra de las páginas offline (nunca la respuesta con sesión).
      if (res.ok && OFFLINE_PAGES.includes(url.pathname)) {
        e.waitUntil(caches.open(VERSION).then(refreshOfflinePages).catch(() => {}));
      }
      return res;
    }).catch(() => caches.match(url.pathname).then((hit) => hit || caches.match("/reportar"))));
  }
});
