const CACHE = "paz-taller-v56";
const SHELL = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) return;
  // GitHub Pages sirve index.html con Cache-Control: max-age=600 -- sin
  // "no-store" acá, un fetch() dentro de esta ventana de 10 minutos se
  // resuelve con la caché HTTP del navegador sin tocar la red siquiera,
  // pase lo que pase con la app (cerrarla no limpia esa caché). "Red
  // primero" no servía de nada si la "red" en realidad era caché vieja.
  e.respondWith(
    fetch(e.request, { cache: "no-store" })
      .then(r => {
        const copia = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});








