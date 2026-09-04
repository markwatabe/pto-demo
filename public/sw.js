// Service worker for the Fiske Green Team schedule: receives Web Push
// reminders and opens the schedule when a notification is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'Green Team', body: 'You have an upcoming shift.' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    // keep defaults
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/fiske-schedule') && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow('/fiske-schedule');
    }),
  );
});
