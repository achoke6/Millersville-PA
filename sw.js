// Millersville.APP service worker.
//
// Two-cache strategy:
//   1. Shell cache (HTML, JS, CSS, icon) — cache-first, served instantly
//      after first visit. Updates when CACHE_VERSION changes (every deploy
//      via __BUILD_VERSION__ replacement in main.yml).
//   2. Data cache (*.json) — stale-while-revalidate. Cached copy returns
//      instantly, network refresh happens in the background. Page loads are
//      always fast; data lags by at most one page load when online. Falls
//      back to cache when offline.
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

    // JSON data: stale-while-revalidate. Returns cached copy IMMEDIATELY
    // (instant page paint), then fetches fresh from network in background and
    // updates the cache for next load. Two fixes from the previous network-
    // first implementation:
    //   1. No more "page hangs while SW waits on slow network" — cache wins
    //      first, network race happens behind the scenes.
    //   2. No more multi-day-stale data risk — the background refresh runs
    //      every page load when online, so cache freshness lags by exactly
    //      one page load (vs unbounded staleness if a fetch ever timed out
    //      and the cache then never refreshed).
    // Also bypasses the HTTP cache via `cache: 'no-store'` — without this,
    // browsers can layer their own caching on top of the SW cache, producing
    // staleness even after the SW cache updates. We want the SW to be the
    // single source of truth for data freshness.
    if (url.pathname.endsWith('.json')) {
        event.respondWith((async () => {
            const cached = await caches.match(req);
            const networkFetch = fetch(req, { cache: 'no-store' })
                .then(response => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(DATA_CACHE).then(c => c.put(req, copy));
                    }
                    return response;
                })
                .catch(() => null);
            // Cache hit → return it instantly, let network refresh race
            // behind it. Cache miss → must wait for network (no choice).
            if (cached) {
                event.waitUntil(networkFetch);
                return cached;
            }
            const fresh = await networkFetch;
            if (fresh) return fresh;
            // No cache, no network — return a synthetic empty response so
            // app.js's `if (!res.ok) return` short-circuits cleanly rather
            // than throwing an unhandled fetch rejection.
            return new Response('null', {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        })());
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
