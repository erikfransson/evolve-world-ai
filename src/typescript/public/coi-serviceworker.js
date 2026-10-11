// Retired: this URL once served a service worker that cross-origin isolated the Ecosystem pages for shared memory.
// Visitors who still have that worker installed fetch this file, which removes itself and reloads the pages it controlled.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
    })(),
  );
});
