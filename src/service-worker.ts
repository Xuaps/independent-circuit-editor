/// <reference lib="webworker" />
export {};
declare const __ASSETS__: string[];
declare const __VERSION__: string;
declare const __HTML_SHA256__: string;
const scope = self as unknown as ServiceWorkerGlobalScope;
const prefix = 'independent-circuit-static-';
const cacheName = prefix + __VERSION__;
const assets = __ASSETS__;
async function verifyCachedShell(): Promise<void> {
  for (const path of ['/', '/index.html']) {
    const response = await caches.match(path, { cacheName });
    if (!response?.ok) throw new Error(`Missing cached offline shell: ${path}`);
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (sha256 !== __HTML_SHA256__) throw new Error(`Unexpected cached offline shell: ${path}`);
  }
}
scope.addEventListener('install', event => {
  // No skipWaiting: an updated build waits until all existing app tabs close.
  event.waitUntil((async () => {
    // This name may be shared by the active worker (e.g. the same script at a new URL).
    if (scope.registration.active && await caches.has(cacheName)) {
      await verifyCachedShell();
      for (const path of assets) {
        if (!(await caches.match(path, { cacheName }))?.ok) throw new Error(`Missing cached offline asset: ${path}`);
      }
      return;
    }
    try {
      await (await caches.open(cacheName)).addAll(assets);
      await verifyCachedShell();
    } catch (error) { await caches.delete(cacheName); throw error; }
    // A completed active cache is oldest: activation previously removed every predecessor.
    // Retain it plus this complete waiting build; replace superseded waiting caches only.
    const previous = (await caches.keys()).filter(key => key.startsWith(prefix) && key !== cacheName);
    const active = scope.registration.active ? previous[0] : undefined;
    for (const key of previous) if (key !== active) await caches.delete(key);
  })());
});
scope.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Activation follows a COMPLETE installation. Unrelated caches are untouched.
    for (const key of await caches.keys()) if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    await scope.clients.claim();
  })());
});
scope.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== scope.location.origin || url.search || !assets.includes(url.pathname)) return;
  event.respondWith(caches.open(cacheName).then(async cache => (await cache.match(url.pathname)) ?? fetch(event.request)));
});
