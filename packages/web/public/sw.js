// Service worker: assets con cache-first, páginas con network-first y fallback offline.
// Cambiar VERSION borra las cachés anteriores (v2 podía tener páginas con datos de la sesión).
const VERSION = "rc-v3";
const ASSETS = ["/icon.svg", "/manifest.webmanifest"];
// Páginas para usar sin conexión. Se guardan pedidas SIN cookies: una versión neutra, sin datos de nadie
// (lo personal, como los reportes anónimos propios, lo agrega el navegador desde su almacenamiento).
const OFFLINE_PAGES = ["/reportar", "/mis-reportes"];

const anonymous = (url) => new Request(url, { credentials: "omit" });
const isPrivate = (res) => /private|no-store/i.test(res.headers.get("Cache-Control") ?? "");

// Referencias a archivos del build: en el HTML ("/_astro/x.js") y entre chunks ("./x.js" y "_astro/x.js",
// que es como Vite nombra los import() dinámicos, p. ej. exifr).
const ASSET_REF = /(?:\/_astro\/|["'`]_astro\/|["'`]\.\/)([\w$.-]+\.(?:js|css))/g;
const assetRefs = (text) => [...text.matchAll(ASSET_REF)].map((m) => `/_astro/${m[1]}`);

// Guarda los archivos que usan las páginas offline y, recorriendo los scripts, todo lo que importan.
// Sin esto, una página guardada abre sin conexión pero su asistente no carga o falla a mitad de camino.
async function cacheAssets(cache, urls) {
  const seen = new Set();
  let queue = urls;
  while (queue.length) {
    const next = [];
    await Promise.all([...new Set(queue)].filter((u) => !seen.has(u)).map(async (u) => {
      seen.add(u);
      let res = await cache.match(u);
      if (!res) {
        res = await fetch(u);
        if (!res.ok) return;
        await cache.put(u, res.clone());
      }
      if (u.endsWith(".js")) next.push(...assetRefs(await res.text()));
    }));
    queue = next;
  }
}

async function refreshOfflinePages(cache) {
  await Promise.all(OFFLINE_PAGES.map(async (path) => {
    const res = await fetch(anonymous(path));
    if (!res.ok || isPrivate(res)) return;
    await cacheAssets(cache, assetRefs(await res.clone().text()));
    await cache.put(path, res);
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

// El aviso de ¿Cuándo salgo? (lib/client/departure-alert.ts): tocarlo vuelve a la página abierta, o la abre.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url ?? "/cuando-salgo", location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => w.url.split("#")[0] === target);
    return open ? open.focus() : self.clients.openWindow(target);
  }));
});
