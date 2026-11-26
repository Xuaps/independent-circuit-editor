/// <reference lib="webworker" />
export {};
declare const __ASSETS__: string[];
declare const __VERSION__: string;
const scope = self as unknown as ServiceWorkerGlobalScope;
const prefix = 'independent-circuit-static-';
const cacheName = prefix + __VERSION__;
const assets = __ASSETS__;
scope.addEventListener('install', event => {
  // No skipWaiting: an updated build waits until all existing app tabs close.
  event.waitUntil((async () => {
    try { await (await caches.open(cacheName)).addAll(assets); }
    catch (error) { await caches.delete(cacheName); throw error; }
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
