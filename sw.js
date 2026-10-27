// Service worker: gør det muligt at vise notifikationer på telefonen,
// når appen er føjet til hjemmeskærmen.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Tryk på en notifikation åbner appen (eller hopper tilbage til den)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((client) => "focus" in client);
      if (open) return open.focus();
      return self.clients.openWindow("./");
    })
  );
});
