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
    '/lib/eventMatch.js',
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
