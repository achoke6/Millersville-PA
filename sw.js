// Millersville.APP service worker.
//
// Two-cache strategy:
//   1. Shell cache (HTML, JS, CSS, icon) — cache-first, served instantly
//      after first visit. Updates when CACHE_VERSION changes (every deploy
//      via __BUILD_VERSION__ replacement in main.yml).
//   2. Data cache (*.json) — network-first with cache fallback. Online
//      users get fresh hourly data; offline users get the last-fetched copy.
//
// CACHE_VERSION is rewritten on each deploy by the GitHub Actions workflow,
// which sed-replaces __BUILD_VERSION__ with the current run id. That makes
// every deploy produce a byte-different sw.js, which the browser detects
// and triggers an update — no manual cache-version bumping needed.
//
// On activation, all caches whose names don't end in the current version
// are deleted, so old shell/data caches don't accumulate over months.

const CACHE_VERSION = '__BUILD_VERSION__';
const SHELL_CACHE   = 'mvapp-shell-' + CACHE_VERSION;
const DATA_CACHE    = 'mvapp-data-'  + CACHE_VERSION;

// Files that should be available offline immediately after first visit.
// Intentionally NOT including status.html (admin tool, not for end users)
// or *.json (those populate the data cache as users fetch them, network-
// first). Adding more here makes the install heavier but the offline
// experience richer.
const SHELL_URLS = [
    '/',
    '/index.html',
    '/app.js',
    '/style.css',
    '/Mapp.png',
    '/manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll(SHELL_URLS))
            // skipWaiting forces this SW to activate as soon as install
            // completes, replacing any older controlling SW. Combined with
            // clients.claim() in activate, that means a deploy reaches the
            // user on their next page load (no need to close all tabs).
            .then(() => self.skipWaiting())
            .catch(() => { /* shell precache failed — site still works via fetch fallback */ })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(k => !k.endsWith(CACHE_VERSION))
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;  // don't intercept cross-origin (sponsor sites, fonts CDNs, etc.)

    // Don't cache the SW itself or its companion files — the browser handles
    // SW updates via its own protocol and we don't want stale copies.
    if (url.pathname === '/sw.js' || url.pathname === '/manifest.json') return;

    // PMTiles basemap: NEVER intercept. It's fetched via HTTP Range requests;
    // the Cache API rejects 206 partial responses (cache.put() failures) and
    // caches.match() ignores Range headers — a cached full-body response would
    // answer a ranged request with the wrong bytes. Let the browser talk to
    // the network directly. (Map is online-only; the directory list itself
    // still works offline via the JSON data cache.)
    if (url.pathname.endsWith('.pmtiles')) return;

    // Network-first for JSON data: tries network, falls back to cache.
    // On success, also updates the cache so the offline copy stays current.
    if (url.pathname.endsWith('.json')) {
        event.respondWith(
            fetch(req)
                .then(response => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(DATA_CACHE).then(c => c.put(req, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(req))
        );
        return;
    }

    // Cache-first for everything else (HTML, JS, CSS, images): instant load
    // when cached, fetch + cache on miss. The version-pinned cache name
    // means a new deploy populates a fresh cache and old entries get pruned
    // in the activate handler — no stale assets across versions.
    event.respondWith(
        caches.match(req).then(cached => {
            if (cached) return cached;
            return fetch(req).then(response => {
                if (response && response.ok && response.type === 'basic') {
                    const copy = response.clone();
                    caches.open(SHELL_CACHE).then(c => c.put(req, copy));
                }
                return response;
            });
        })
    );
});

// ---------------------------------------------------------------------------
// Push notifications
//
// CRITICAL: without this 'push' listener, FCM-delivered pushes are received
// by the service worker and SILENTLY DROPPED — the server's webpush send
// succeeds (reports "Sent: N"), FCM accepts and delivers, but nothing ever
// appears on the device. This is distinct from the in-app "test" notification,
// which app.js fires via registration.showNotification() in the PAGE context
// and therefore works even when this handler is missing. If you're debugging
// "server says sent but phone shows nothing," this handler is the first thing
// to verify exists in the DEPLOYED sw.js (not just the repo).
//
// Payload contract: scripts/send-notifications.js sends
//   JSON.stringify({ title, body, url })
// Keep this parser in sync with buildPayload() there.
self.addEventListener('push', event => {
    // Parse the JSON payload defensively. A push with no data, or non-JSON
    // data, must still surface SOMETHING rather than throwing (a thrown
    // handler = silently dropped push = the exact bug this handler fixes).
    let payload = {};
    if (event.data) {
        try {
            payload = event.data.json();
        } catch (e) {
            // Not JSON — fall back to using the raw text as the body.
            try { payload = { body: event.data.text() }; } catch (e2) { payload = {}; }
        }
    }

    const title = payload.title || 'Millersville.APP';
    const options = {
        body: payload.body || 'Tap to see what\'s happening today.',
        icon: '/Mapp.png',
        badge: '/Mapp.png',
        // Stash the click-target URL so notificationclick can read it. Falls
        // back to the events page if the payload didn't include one.
        data: { url: payload.url || 'https://millersville.app/events' },
        // A stable tag means a second push replaces the first in the tray
        // rather than stacking duplicates if two fire close together.
        tag: 'mvapp-daily',
        renotify: true
    };

    // waitUntil keeps the SW alive until the notification is shown. Without
    // it, the SW may be killed before showNotification() resolves.
    event.waitUntil(self.registration.showNotification(title, options));
});

// Handle taps on the notification: focus an already-open Millersville.APP
// tab if one exists (and navigate it to the target), otherwise open a new
// window at the target URL.
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url)
        || 'https://millersville.app/events';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            // Reuse an existing tab on our origin if there is one.
            for (const client of windowClients) {
                if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
                    client.navigate(target);
                    return client.focus();
                }
            }
            // No existing tab — open a fresh one.
            if (clients.openWindow) return clients.openWindow(target);
        })
    );
});
