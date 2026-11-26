/* Campaign Ops service worker: shows phone notifications and opens the right page when one is tapped.
   It caches nothing, so the console always shows live data. */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let msg = { title: 'Campaign Ops', body: 'Something needs a look.', url: '/', tag: 'campaign-ops' };
  try {
    if (event.data) msg = Object.assign(msg, event.data.json());
  } catch (e) {
    /* keep the default text */
  }
  // Only a page of this console: a path like /#p=P-0007, never another site.
  const url = typeof msg.url === 'string' && /^\/(?![\/\\])/.test(msg.url) ? msg.url : '/';
  event.waitUntil(
    self.registration.showNotification(String(msg.title).slice(0, 80), {
      body: String(msg.body).slice(0, 200),
      tag: String(msg.tag || 'campaign-ops').slice(0, 40),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
      renotify: true,
      // Urgent news (a broken page, broken tracking, risky copy) stays on a computer screen until it is seen.
      requireInteraction: msg.urgent === true,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(url);
      // The console is already open: bring it forward and show the page the notification is about.
      return open
        .focus()
        .then((w) => (w || open).navigate(url))
        .catch(() => self.clients.openWindow(url));
    }),
  );
});
