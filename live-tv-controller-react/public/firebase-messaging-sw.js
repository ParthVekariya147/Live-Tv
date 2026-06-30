// Live TV Controller — Push Notification Service Worker
// Plain Web Push handler — no external CDN scripts required.
// This is simpler and more reliable than importing Firebase SDK scripts
// because it works even when gstatic.com CDN is slow or unreachable.

// Take over immediately when the SW is updated (no waiting for tabs to close)
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Claim all open clients so this SW controls them right away
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Pass every fetch straight to the network — this SW is push-only, no caching.
// Without this passthrough, the SW scope (/) would intercept page loads and
// serve stale cached assets on soft reload (F5).
self.addEventListener('fetch', (event) => {
  return;
});

// Push event — called by Chrome when FCM delivers a push to this subscription
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return; // non-JSON push — ignore
  }

  // FCM HTTP v1 merges notification + webpush.notification into payload.notification.
  // Our server also sets data.tag so same-event notifications collapse (replace each other).
  const notification = payload.notification || {};
  const data = payload.data || {};

  const title = notification.title || 'Live TV Controller';
  const tag   = data.tag || notification.tag || 'livetv';

  event.waitUntil(
    self.registration.showNotification(title, {
      body:     notification.body  || '',
      icon:     notification.icon  || '/icon-192.png',
      tag,
      badge:    '/icon-192.png',
      renotify: true,
    })
  );
});

// Notification click — bring existing tab into focus or open a new one
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
