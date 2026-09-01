// Truecairn web-push service worker (Continuity Verification CV-2).
// One job: display an incoming push. The payload is one of our bare templates
// ({title, body} — no vault content, no names, no tracking); there is no
// fetch handling, no caching, no analytics, and clicking simply focuses/opens
// the app. Kept dependency-free and reviewable at a glance on purpose.
self.addEventListener('push', (event) => {
  let data = { title: 'Truecairn', body: 'Open Truecairn.' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Undecodable payload: show the bare default rather than nothing.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/brand/app-icon.svg',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow('/');
    }),
  );
});
