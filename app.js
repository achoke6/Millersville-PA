// Escape a value before it goes into innerHTML. Required for any field that
// can be user-submitted: community event
// submissions (Google Sheet → events with tag 'Community'), business form
// submissions, and reviews. Also defensive for RSS-scraped fields where a
// compromised upstream feed could inject markup. Coerces to string and
// replaces the five HTML-significant characters; anything else (numbers,
// booleans, null) becomes its safe string form.
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Some feeds pre-encode characters as HTML entities (e.g. an en-dash arrives as
// "&#8211;"). Decode those back to real characters BEFORE escHtml, so titles
// render correctly instead of showing the literal entity text. Handles numeric
// (&#8211; / &#x2013;) and the common named entities feeds emit.
const NAMED_ENTITIES = {
    amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:'\u00A0',
    ndash:'\u2013', mdash:'\u2014', lsquo:'\u2018', rsquo:'\u2019',
    ldquo:'\u201C', rdquo:'\u201D', hellip:'\u2026', amp38:'&'
};
const decodeEntities = s => String(s ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));

let allEvents=[], currentNews=[], allRestaurants=[];

// Date the home timeline is currently showing. Defaults to today (midnight),
// can be moved ±1 day via shiftHomeDay() and reset via resetHomeDay(). Not
// persisted — every fresh load lands on today, matching the "Today's news"
// expectation for a home page. The Specials & Deals card stays anchored to
// today regardless of this value.
let homeViewDate = null;
const allEvSources = ['MU','PM','Borough','Manor','Other'];
let evActiveSources = new Set(allEvSources), evTags=new Set();
let evAllMode = true;
let evKidMode=false;
// Marauder-only perk filters — hidden for Townies, shown for Marauders in place of family toggle
let evFreeFoodMode=false, evFreeStuffMode=false;

// ==================== MY FEED SYSTEM ====================
const FEED_KEY = 'mapp_feed_prefs';
const AFFILIATION_KEY = 'mapp_mu_affiliation'; // 'student' | 'townie' | null (unset)
const SHOW21_KEY = 'mapp_show_21plus'; // '1' = opted in to see 🍺-flagged drink specials (default off, site-wide)
const SHOWN_SOURCES_KEY = 'mapp_shown_sources'; // JSON array of Show opt-ins from the Uncommon picker — source keys (1:1 chips) AND per-item pref ids (PM sports / PM events chips; see UNCOMMON_SUB_SOURCES); survives Clear Favs
let feedPrefs = null; // null = not configured
let muAffiliation = null; // null = not yet asked; 'student' or 'townie' once set
let show21Plus = false;   // 21+ drink-specials opt-in — display setting, loaded in loadFeedPrefs
let shownSources = new Set(); // "Show events" source opt-ins — display setting, loaded in loadFeedPrefs

function setFeedDotVisible(visible) {
    const d1 = document.getElementById('feed-dot');
    const d2 = document.getElementById('feed-dot-desktop');
    if (d1) d1.style.display = visible ? 'block' : 'none';
    if (d2) d2.style.display = visible ? 'block' : 'none';
}

function loadFeedPrefs() {
    try { feedPrefs = JSON.parse(localStorage.getItem(FEED_KEY)); } catch(e) { feedPrefs = null; }
    setFeedDotVisible(!!feedPrefs);
    try { muAffiliation = localStorage.getItem(AFFILIATION_KEY); } catch(e) { muAffiliation = null; }
    try { show21Plus = localStorage.getItem(SHOW21_KEY) === '1'; } catch(e) { show21Plus = false; }
    try { shownSources = new Set(JSON.parse(localStorage.getItem(SHOWN_SOURCES_KEY)) || []); } catch(e) { shownSources = new Set(); }
    if (muAffiliation !== 'student' && muAffiliation !== 'townie') muAffiliation = null;
    // Shareable affiliation link: ?aud=townie (aliases: local/locals) or ?aud=mu
    // (aliases: student/marauder). ONLY sets affiliation when none is set yet, so a
    // launch link drops new locals into the local view but never overrides — or
    // silently wipes the favorites of — a returning user who already chose. Strips
    // the param either way so it can't re-fire on later loads.
    try {
        const _u = new URL(window.location.href);
        const _aud = (_u.searchParams.get('aud') || '').toLowerCase();
        if (_aud) {
            const mapped = (_aud === 'townie' || _aud === 'local' || _aud === 'locals') ? 'townie'
                : (_aud === 'mu' || _aud === 'student' || _aud === 'marauder' || _aud === 'marauders') ? 'student'
                : null;
            if (mapped && !muAffiliation) { muAffiliation = mapped; localStorage.setItem(AFFILIATION_KEY, mapped); }
            _u.searchParams.delete('aud');
            history.replaceState(null, '', _u.pathname + _u.search + _u.hash);
        }
    } catch(e) {}
}
// Persist the "Show events" source opt-ins. Own key — deliberately NOT wiped
// by Clear Favs (mirrors SHOW21_KEY): visibility opt-ins are identity-adjacent
// display settings, not favorites.
function saveShownSources() {
    try { localStorage.setItem(SHOWN_SOURCES_KEY, JSON.stringify([...shownSources])); } catch(e) {}
}
function saveFeedPrefs(prefs) {
    feedPrefs = prefs;
    localStorage.setItem(FEED_KEY, JSON.stringify(prefs));
    setFeedDotVisible(!!prefs);
    // If the user has push notifications enabled, the server has a stale
    // copy of their feedPrefs. Re-POST so tomorrow's morning push uses
    // the new prefs. Fire-and-forget — we don't surface failures to the
    // user since prefs already saved locally and the resend will retry
    // on next save anyway.
    if (typeof window.resendNotificationPrefs === 'function') {
        window.resendNotificationPrefs().catch(() => {});
    }
}

// ============================================================================
// PUSH NOTIFICATIONS
// ============================================================================
// Daily 7am ET digest of events matching the user's feedPrefs.
//
// Architecture: subscribe.php and unsubscribe.php on DreamHost persist the
// browser's PushSubscription object + the user's current feedPrefs.
// scripts/send-notifications.js runs on GitHub Actions cron, FTP-pulls the
// subscriptions list, sends pushes via web-push library. SW handlers in
// sw.js receive the push and show the OS notification.
//
// Public VAPID key — the private one only ever exists in GitHub secrets.
// This key authenticates that pushes are coming from us. Generated once
// per project; if rotated, all existing subscriptions become dead and
// users would need to resubscribe.
const VAPID_PUBLIC_KEY = 'BMS4BleklCKi4xhaBiH33Hszdp9YzBqewQWxgsl9LF5T8tLXT7Bojm8kMfk-jgTu66UYMhWqHuB7xgsxAxjWGJU';
const NOTIF_KEY = 'mvapp_notif_endpoint';  // localStorage marker for the active subscription

// Convert URL-safe base64 (the VAPID format) to the Uint8Array that
// PushManager.subscribe wants. Standard incantation lifted from MDN.
function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

// Capability detection. Notifications need: SW support, PushManager, and
// Notification API. iOS Safari has all three but ONLY when running as an
// installed PWA (display-mode: standalone) — in a regular Safari tab the
// PushManager.subscribe() call silently fails. We detect that case
// separately so we can surface the install nudge instead of an error.
function notificationsSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function isIOS() {
    // Includes iPadOS which (since 13) reports as Mac in UA but has
    // touch capability. Worth-detecting because iOS-PWA flow is unique.
    const ua = navigator.userAgent;
    return /iPad|iPhone|iPod/.test(ua)
        || (ua.includes('Macintosh') && 'ontouchend' in document);
}
function isStandalonePWA() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;  // older iOS Safari quirk
}

// Show the iOS-install instructional modal. Triggered when an iOS user
// tries to enable notifications from a non-PWA Safari tab — Apple doesn't
// expose beforeinstallprompt, so the only way for them to get pushes is
// to manually Add to Home Screen via the share sheet.
window.showIOSInstallNudge = function() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10001;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.onclick = (ev) => { if (ev.target === overlay) overlay.remove(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:420px;width:100%;padding:24px;position:relative;';
    modal.innerHTML = `
        <button onclick="this.closest('div[style*=fixed]').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-muted);">✕</button>
        <h3 style="margin:0 0 10px;">📱 Install Millersville.APP first</h3>
        <p style="font-size:0.9rem;line-height:1.5;margin:0 0 14px;color:var(--text-muted);">
            iPhone and iPad need the app installed to your home screen before they can receive notifications.
            It's quick:
        </p>
        <ol style="padding-left:20px;margin:0 0 16px;font-size:0.92rem;line-height:1.7;">
            <li>Tap the <strong>Share</strong> button <span style="display:inline-block;border:1px solid var(--border);border-radius:4px;padding:0 5px;font-size:0.85rem;">⬆︎</span> at the bottom of Safari.</li>
            <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
            <li>Tap <strong>Add</strong> in the top-right.</li>
            <li>Open the app from your home screen and come back here to enable notifications.</li>
        </ol>
        <p style="font-size:0.78rem;color:var(--text-muted);margin:0;font-style:italic;">
            (This only works in Safari. If you're in Chrome or another browser, switch to Safari first.)
        </p>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

// ==================== INSTALL PROMPT (Add to Home Screen) ====================
// A custom A2HS nudge that beats the browser default. On Android/Chrome we
// capture beforeinstallprompt (which suppresses the tiny native mini-infobar)
// and fire our own button on the user's terms; on iOS Safari — which has no
// install API at all — we reuse showIOSInstallNudge()'s share-sheet steps.
// Engagement-gated (2nd+ visit), dismissible with a multi-week snooze, and
// never shown to someone already running the installed app.
const INSTALL_SNOOZE_KEY = 'mapp_install_snooze_until'; // epoch ms
const VISIT_KEY = 'mapp_visit_count';
let deferredInstallPrompt = null; // the captured beforeinstallprompt event (Android/Chrome)

// Chrome/Edge/Android fire this before showing their own banner.
// preventDefault() suppresses the native mini-infobar so we can prompt our way.
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    try { maybeShowInstallBanner(); } catch (_) {}
});
// If they install (our button OR the browser menu), tear down our UI.
window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    const b = document.getElementById('mapp-install-banner');
    if (b) b.remove();
});

function installSnoozed() {
    const until = parseInt(localStorage.getItem(INSTALL_SNOOZE_KEY) || '0', 10);
    return !isNaN(until) && Date.now() < until;
}
function snoozeInstall(days) {
    try { localStorage.setItem(INSTALL_SNOOZE_KEY, String(Date.now() + days * 864e5)); } catch (_) {}
}
// Count app loads; used to hold the prompt back until someone returns.
function bumpVisitCount() {
    let n = parseInt(localStorage.getItem(VISIT_KEY) || '0', 10);
    n = isNaN(n) ? 1 : n + 1;
    try { localStorage.setItem(VISIT_KEY, String(n)); } catch (_) {}
    return n;
}

// Decide whether to surface the custom install banner on this load.
function maybeShowInstallBanner() {
    if (isStandalonePWA()) return;                               // already installed
    if (installSnoozed()) return;                                // recently dismissed
    if (document.getElementById('mapp-install-banner')) return;  // already showing
    // Don't compete with the first-run welcome banner — let that resolve first.
    const wb = document.getElementById('welcome-banner');
    if (wb && wb.style.display !== 'none' && wb.offsetParent !== null) return;

    const visits = parseInt(localStorage.getItem(VISIT_KEY) || '0', 10);
    if (isNaN(visits) || visits < 2) return;                     // wait for a return visit

    const ios = isIOS();
    // Android/Chrome need the captured event; iOS Safari can always show steps.
    // Any other browser without the event (e.g. desktop Firefox) → skip silently.
    if (!ios && !deferredInstallPrompt) return;

    showInstallBanner(ios);
}

function showInstallBanner(ios) {
    const bar = document.createElement('div');
    bar.id = 'mapp-install-banner';
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10000;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 6px 28px rgba(0,0,0,0.22);padding:14px 16px;display:flex;align-items:center;gap:12px;max-width:calc(100% - 24px);width:380px;';
    bar.innerHTML = `
        <img src="/Mapp.png" alt="" width="40" height="40" style="border-radius:9px;flex:0 0 auto;">
        <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:0.92rem;color:var(--navy);">Install Millersville.APP</div>
            <div style="font-size:0.8rem;color:var(--text-muted);line-height:1.35;">Add it to your home screen for one-tap access and game-day alerts.</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex:0 0 auto;">
            <button id="mapp-install-go" style="background:var(--gold);color:var(--navy);border:none;border-radius:999px;padding:7px 14px;font-weight:700;font-size:0.82rem;cursor:pointer;white-space:nowrap;">Install</button>
            <button id="mapp-install-dismiss" style="background:none;border:none;color:var(--text-muted);font-size:0.74rem;cursor:pointer;">Not now</button>
        </div>
    `;
    document.body.appendChild(bar);

    document.getElementById('mapp-install-dismiss').onclick = () => {
        snoozeInstall(21); // ~3 weeks before we ask again
        bar.remove();
    };
    document.getElementById('mapp-install-go').onclick = async () => {
        bar.remove();
        if (ios) { showIOSInstallNudge(); return; }   // share-sheet instructions
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        try {
            const choice = await deferredInstallPrompt.userChoice;
            if (choice && choice.outcome === 'dismissed') snoozeInstall(21);
        } catch (_) {}
        deferredInstallPrompt = null;
    };
}

/**
 * Subscribe the current browser to push notifications.
 * Walks: SW ready → permission prompt → PushManager.subscribe →
 * POST /subscribe.php with the subscription + current feedPrefs.
 * Returns { ok: bool, reason?: string } so the UI can surface failures.
 */
window.enableNotifications = async function() {
    if (!notificationsSupported()) {
        return { ok: false, reason: 'unsupported' };
    }
    // iOS-Safari-not-installed: skip the permission prompt (it would
    // succeed but PushManager.subscribe would silently fail) and surface
    // the install nudge instead.
    if (isIOS() && !isStandalonePWA()) {
        showIOSInstallNudge();
        return { ok: false, reason: 'ios-needs-install' };
    }

    // Permission flow. requestPermission resolves to 'granted' / 'denied' /
    // 'default' (closed without choosing). Browsers may auto-deny if the
    // user has previously dismissed the prompt several times.
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
        return { ok: false, reason: 'permission-' + perm };
    }

    // SW must be registered. We register it on app load (see initApp), but
    // if for some reason it isn't ready, .ready waits indefinitely — bound
    // it with a timeout so the UI doesn't hang forever.
    const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('sw-timeout')), 8000))
    ]);

    // Subscribe. userVisibleOnly is required by every browser — silent
    // pushes aren't allowed for web. applicationServerKey is the VAPID
    // public key in raw bytes form.
    let sub;
    try {
        sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
    } catch (err) {
        console.error('PushManager.subscribe failed:', err);
        return { ok: false, reason: 'subscribe-failed' };
    }

    // POST to subscribe.php with the subscription object and current prefs.
    // Server file is the source of truth — localStorage just remembers the
    // endpoint URL so we can unsubscribe later from this same browser.
    const subJSON = sub.toJSON();
    try {
        const res = await fetch('/subscribe.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subscription: subJSON,
                feedPrefs: feedPrefs || []
            })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (err) {
        // If server registration fails, undo the browser subscribe so we
        // don't end up with a "subscribed locally but server doesn't know"
        // ghost state.
        await sub.unsubscribe().catch(() => {});
        console.error('subscribe.php POST failed:', err);
        return { ok: false, reason: 'server-failed' };
    }

    localStorage.setItem(NOTIF_KEY, subJSON.endpoint);
    // Show the user a confirmation notification immediately. This is
    // a nice UX touch (proves it's working) and saves us from needing
    // a separate test endpoint.
    try {
        await reg.showNotification('🔔 Notifications enabled', {
            body: "You'll get a daily 7am summary of events from your favorites.",
            icon: '/Mapp.png',
            badge: '/Mapp.png',
            tag: 'mvapp-welcome'
        });
    } catch (_) { /* non-fatal */ }

    return { ok: true };
};

/**
 * Unsubscribe this browser from push notifications. Walks the inverse:
 * PushManager unsubscribe + POST /unsubscribe.php to remove the server entry.
 * Returns { ok } — failures are non-fatal (worst case: stale entry on the
 * server that the cron will reap on next 410 Gone).
 */
window.disableNotifications = async function() {
    const endpoint = localStorage.getItem(NOTIF_KEY);
    localStorage.removeItem(NOTIF_KEY);
    if (!notificationsSupported()) return { ok: true };  // nothing to do
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            await sub.unsubscribe();
            // Notify the server. Best-effort — if this fails, the cron's
            // 410-Gone handler will clean up automatically next morning.
            await fetch('/unsubscribe.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: sub.endpoint })
            }).catch(() => {});
        }
    } catch (err) {
        console.error('disableNotifications:', err);
    }
    return { ok: true };
};

/**
 * Resend the user's current feedPrefs to subscribe.php so the cron uses
 * fresh prefs for tomorrow's push. Called from saveFeedPrefs whenever the
 * user changes their selections. No-op if the user isn't subscribed.
 */
window.resendNotificationPrefs = async function() {
    const endpoint = localStorage.getItem(NOTIF_KEY);
    if (!endpoint) return;
    if (!notificationsSupported()) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) {
            // Browser dropped the subscription out from under us. Drop our
            // local marker too so we don't keep retrying.
            localStorage.removeItem(NOTIF_KEY);
            return;
        }
        await fetch('/subscribe.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subscription: sub.toJSON(),
                feedPrefs: feedPrefs || []
            })
        });
    } catch (err) {
        console.error('resendNotificationPrefs:', err);
    }
};

/**
 * Snapshot of current notification state, used to render the toggle UI
 * with the right initial state. Returns:
 *   'unsupported' — browser doesn't support push (older Safari, etc)
 *   'ios-blocked' — iOS Safari not installed as PWA
 *   'denied'      — user previously denied permission
 *   'enabled'     — actively subscribed
 *   'disabled'    — supported but not subscribed
 */
window.notificationStatus = function() {
    if (!notificationsSupported()) return 'unsupported';
    if (isIOS() && !isStandalonePWA()) return 'ios-blocked';
    if (Notification.permission === 'denied') return 'denied';
    if (localStorage.getItem(NOTIF_KEY)) return 'enabled';
    return 'disabled';
};

// ============================================================================
// END PUSH NOTIFICATIONS
// ============================================================================
// Advertise page is hidden from MU students — explicit 'student' only; unset
// and townie viewers both keep it (the page doubles as the pitch for visitors
// who haven't picked an identity yet). One gate covers the nav button and, if
// the viewer flips to student while ON the page (Feed settings), bounces them
// home. Wired into all three switch paths (new-surface rule: applyAffiliation /
// setMuAffiliation / toggle21Plus — no-op on the 21+ path), resetEverything
// (identity back to unset → button reappears), and initApp boot. The
// companion choke-point guard at the top of switchView() catches nav clicks,
// /advertise deep links, and popstate in one place.
function applyAdvertiseGate() {
    const btn = document.getElementById('nav-advertise');
    if (btn) btn.style.display = (muAffiliation === 'student') ? 'none' : '';
    if (muAffiliation === 'student') {
        const v = document.getElementById('view-advertise');
        if (v && v.classList.contains('active') && typeof window.switchView === 'function') window.switchView('home');
    }
}
window.setMuAffiliation = function(value) {
    if (value !== 'student' && value !== 'townie') return;
    muAffiliation = value;
    localStorage.setItem(AFFILIATION_KEY, value);
    // Re-render everything so the filter takes immediate effect
    if (typeof renderHomeFeed === 'function') renderHomeFeed();
    if (typeof loadHomeSpecials === 'function') loadHomeSpecials(); // home specials rail — separate render, reads muAffiliation
    if (typeof renderEvents === 'function') renderEvents();
    if (typeof renderFoodPage === 'function') renderFoodPage(); // Food page reads muAffiliation (groups + event gate) at build time
    applyAdvertiseGate(); // Advertise nav/page is Marauder-hidden — new-surface rule
};
// Whether an event is hidden from the current viewer's feed, based on the
// event's audience and the viewer's affiliation. Symmetric:
//   • Townies don't see MU-student-only events or intramural signups.
//   • Marauders don't see townie/community-only events (audience 'townie-only').
// Unset affiliation = Marauder default: see everything (users opt into townie
// behavior, or stay default, via the welcome banner / Feed settings).
function isHiddenForViewer(e) {
    if (muAffiliation === 'townie') return !!(e && (e.audience === 'mu-only' || isIntramural(e)));
    if (muAffiliation === 'student') return !!(e && e.audience === 'townie-only');
    return false; // unset → see everything
}
// Intramural signups (scraped from IMLeagues into events.json) are a MARAUDER-
// only thing — townies can't join MU intramural leagues. We identify them by
// their IMLeagues registration/source link (or an explicit 'Intramural' tag, if
// the scraper ever adds one). Used to (a) hide them from townies everywhere and
// (b) route them into the marauder "Upcoming Signups" box instead of the townie one.
function isIntramural(e) {
    if (!e) return false;
    if ((e.tags || []).includes('Intramural')) return true;
    const s = ((e.sourceLink || '') + ' ' + (e.registerLink || '')).toLowerCase();
    return s.includes('imleagues');
}

// Feed subscription tokens and their display config
// Organized into sections for the settings popup
// ============================================================================
// Sport gender model — single source of truth for which genders field each
// sport at each level (Penn Manor high school vs Millersville college). A sport
// with 2 genders is "split" (separate Boys/Girls or Men's/Women's follows,
// pills, labels); [] means "single" (no gender shown, matches any gender).
// Drives the favorites picker, SOURCE_UNLOCK_IDS, suggestFeedIdForEvent, the
// Sports-page pills, and the title/badge cleanup — change a sport here and
// everything downstream follows. PM tags genders Boys/Girls; MU tags Men's/Women's.
// Mirrored (lockstep) in lib/eventMatch.js SPORT_CFG and events.ics.php $sportCfg.
// ============================================================================
const SPORT_GENDERS = {
    pm: {
        'Baseball': [], 'Softball': [], 'Football': [], 'Field Hockey': [], 'Golf': [],
        'Cross Country': [], 'Swimming': [], 'Track': [], 'Bowling': [],
        'Soccer': ['Boys','Girls'], 'Tennis': ['Boys','Girls'], 'Volleyball': ['Boys','Girls'],
        'Basketball': ['Boys','Girls'], 'Wrestling': ['Boys','Girls'], 'Lacrosse': ['Boys','Girls'],
        'Unified Track & Field': [], 'Unified Bocce': []
    },
    mu: {
        'Baseball': [], 'Football': [], 'Wrestling': [], 'Cross Country': [], 'Field Hockey': [],
        'Lacrosse': [], 'Softball': [], 'Swimming': [], 'Volleyball': [], 'Track': [],
        'Basketball': ["Men's","Women's"], 'Golf': ["Men's","Women's"],
        'Soccer': ["Men's","Women's"], 'Tennis': ["Men's","Women's"]
    }
};
const PM_SPORT_ORDER = ['Baseball','Softball','Lacrosse','Volleyball','Football','Basketball',
    'Soccer','Field Hockey','Tennis','Track','Golf','Swimming','Cross Country','Wrestling','Bowling',
    'Unified Track & Field','Unified Bocce'];
const MU_SPORT_ORDER = ['Baseball','Softball','Lacrosse','Volleyball','Football','Basketball',
    'Soccer','Field Hockey','Tennis','Track','Golf','Swimming','Cross Country','Wrestling'];
const SPORT_ICON = {
    'Baseball':'⚾','Softball':'🥎','Lacrosse':'🥍','Volleyball':'🏐',
    'Football':'🏈','Basketball':'🏀','Soccer':'⚽','Field Hockey':'🏑',
    'Tennis':'🎾','Track':'🏃','Golf':'⛳','Swimming':'🏊',
    'Cross Country':'🏃','Wrestling':'🤼','Bowling':'🎳',
    'Unified Track & Field':'🤝','Unified Bocce':'🤝'
};
// Gender display word -> feed-id suffix (PM=boys/girls, MU=mens/womens).
const GENDER_SUFFIX = { "Boys":'boys', "Girls":'girls', "Men's":'mens', "Women's":'womens' };
function sportSuffix(tag) {
    return ({ 'Field Hockey':'fieldhockey', 'Cross Country':'crosscountry', 'Track':'track',
              'Unified Track & Field':'unified-track', 'Unified Bocce':'unified-bocce' })[tag]
           || tag.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function sportDisplayName(tag) { return tag === 'Track' ? 'Track & Field' : tag; }
function sportLevelFromTags(tags) { return tags.indexOf('PM') !== -1 ? 'pm' : tags.indexOf('MU') !== -1 ? 'mu' : null; }
function sportGendersFor(level, tag) { return (SPORT_GENDERS[level] && SPORT_GENDERS[level][tag]) || []; }
function isSplitSport(level, tag) { return sportGendersFor(level, tag).length >= 2; }
function allSportFeedIds(level) {
    const order = level === 'pm' ? PM_SPORT_ORDER : MU_SPORT_ORDER;
    const ids = [];
    order.forEach(function(tag) {
        const g = sportGendersFor(level, tag), base = level + '-' + sportSuffix(tag);
        if (g.length >= 2) g.forEach(function(x){ ids.push(base + '-' + GENDER_SUFFIX[x]); });
        else ids.push(base);
    });
    return ids;
}
function buildSportSubs(level) {
    const order = level === 'pm' ? PM_SPORT_ORDER : MU_SPORT_ORDER;
    const subs = [];
    order.forEach(function(tag) {
        const g = sportGendersFor(level, tag), base = level + '-' + sportSuffix(tag), icon = SPORT_ICON[tag] || '🏅';
        if (g.length >= 2) g.forEach(function(x){ subs.push({ id: base + '-' + GENDER_SUFFIX[x], label: x + ' ' + sportDisplayName(tag), icon: icon }); });
        else subs.push({ id: base, label: sportDisplayName(tag), icon: icon });
    });
    return subs;
}

// --- Display helpers (read the same SPORT_GENDERS model) -------------------
// A sport's gender is "redundant" only when one gender plays it at that level —
// then the gender word is stripped from titles/badges. Split sports keep gender
// (it's the only place it shows once badges are hidden). PM Cross Country /
// Swimming / Track / Golf / Bowling are single-pill but BOTH-gender (separate
// boys/girls events at the same meet) so they keep gender too — stripping would
// collapse boys & girls cards into identical rows.
const PM_KEEP_GENDER_SINGLE_PILL = ['Cross Country', 'Swimming', 'Track', 'Golf', 'Bowling'];
function sportGenderIsRedundant(level, sportTag) {
    if (isSplitSport(level, sportTag)) return false;
    if (level === 'pm' && PM_KEEP_GENDER_SINGLE_PILL.indexOf(sportTag) !== -1) return false;
    return true;
}
const GENDER_TAGS = ['Boys', 'Girls', "Men's", "Women's"];
// Strip a leading gender word from a sport title only when that gender is redundant.
function cleanSportTitle(title, tags) {
    const level = sportLevelFromTags(tags);
    if (!level) return title;
    const sportTag = sportsList.find(s => tags.indexOf(s) !== -1);
    if (!sportTag || !sportGenderIsRedundant(level, sportTag)) return title;
    return title.replace(/^(Boys|Girls|Men['\u2019]s|Women['\u2019]s)\s+/, '');
}
// Match an event against a Sports-page pill label ("Boys Soccer", "Field Hockey",
// "Track & Field", "Unified Track & Field"). A gendered label requires the sport
// tag AND that gender tag; a plain label matches the sport tag (any gender).
function eventMatchesSportLabel(tags, label) {
    if (!label) return true;
    const m = label.match(/^(Boys|Girls|Men's|Women's)\s+(.+)$/);
    const gender = m ? m[1] : null;
    const sportName = m ? m[2] : label;
    const sportTag = sportName === 'Track & Field' ? 'Track' : sportName;
    if (tags.indexOf(sportTag) === -1) return false;
    if (gender && tags.indexOf(gender) === -1) return false;
    return true;
}

const feedSections = {
    sports: {
        title: '🏆 Sports Favorites',
        groups: {
            pm: { label: 'Penn Manor Sports', icon: '🏫', headingStyle: true, audience: 'townie', subs: buildSportSubs('pm')},
            musports: { label: 'MU Sports', icon: '🏴‍☠️', headingStyle: true, audience: 'student', subs: buildSportSubs('mu')}
        }
    },
    events: {
        title: '📅 Event Favorites',
        groups: {
            pmev: { label: 'Penn Manor Events', icon: '🏫', headingStyle: true, audience: 'townie', subs: [
                {id:'pm-music',label:'Music/Arts',icon:'🎵'},{id:'pm-board',label:'Board Meetings',icon:'📋'}
            ]},
            mu: { label: 'MU Events', icon: '🏴‍☠️', headingStyle: true, audience: 'student', subs: [
                {id:'mu-arts',label:'Arts & Performances',icon:'🎭'},{id:'mu-public',label:'Public Events',icon:'📢'}
            ]},
            clubs: {
                label: 'MU GetInvolved',      // marauder-facing default
                townieLabel: 'MU Community Events', // shown to townies (GetInvolved is MU-internal jargon)
                icon: '🎓',
                headingStyle: true,
                audience: 'student',
                subs: [
                    {id:'clubs-all',label:'All Events',townieLabel:'All Community Events',icon:'🎓'},
                    {id:'clubs-social',label:'Social Clubs',icon:'🎉'},
                    {id:'clubs-arts',label:'Arts & Performance',icon:'🎭'},
                    {id:'clubs-service',label:'Service & Community',icon:'🤝'}
                ],
                // Collapsible nested subgroups — each renders as a click-to-
                // expand row inside the GetInvolved heading group. The
                // subgroup's master ID (e.g. clubs-sports) toggles the
                // umbrella, while individual children (cs-*, chapter names)
                // can be picked granularly. Default state is collapsed since
                // each subgroup has 19-21 chips that would overwhelm the
                // accordion if always-open.
                subgroups: [
                    {
                        key: 'clubsports',
                        label: 'Club Sports',
                        icon: '⚽',
                        masterId: 'clubs-sports',
                        children: [
                            {id:'cs-baseball',label:'Baseball',icon:'⚾'},
                            {id:'cs-softball',label:'Softball',icon:'🥎'},
                            {id:'cs-basketball-mens',label:"Men's Basketball",icon:'🏀'},
                            {id:'cs-basketball-womens',label:"Women's Basketball",icon:'🏀'},
                            {id:'cs-soccer-mens',label:"Men's Soccer",icon:'⚽'},
                            {id:'cs-soccer-womens',label:"Women's Soccer",icon:'⚽'},
                            {id:'cs-lacrosse',label:'Lacrosse',icon:'🥍'},
                            {id:'cs-volleyball-mens',label:"Men's Volleyball",icon:'🏐'},
                            {id:'cs-volleyball-womens',label:"Women's Volleyball",icon:'🏐'},
                            {id:'cs-rugby-mens',label:"Men's Rugby",icon:'🏉'},
                            {id:'cs-rugby-womens',label:"Women's Rugby",icon:'🏉'},
                            {id:'cs-icehockey',label:'Ice Hockey',icon:'🏒'},
                            {id:'cs-tennis',label:'Tennis',icon:'🎾'},
                            {id:'cs-frisbee',label:'Ultimate Frisbee',icon:'🥏'},
                            {id:'cs-fencing',label:'Fencing',icon:'🤺'},
                            {id:'cs-equestrian',label:'Equestrian',icon:'🐴'},
                            {id:'cs-dance',label:'Dance Team',icon:'💃'},
                            {id:'cs-bowling',label:'Bowling',icon:'🎳'},
                            {id:'cs-running',label:'Running',icon:'🏃'},
                            {id:'cs-mma',label:'MMA',icon:'🥋'}
                        ]
                    },
                    {
                        key: 'greeklife',
                        label: 'Greek Life',
                        icon: '🏛️',
                        masterId: 'clubs-greek',
                        // Per-chapter children. The id uses the `club:<Name>`
                        // pattern matching the existing club-tag matcher, so
                        // events tagged with the chapter name (e.g. 'Delta
                        // Zeta') get matched without any new logic. Names
                        // taken verbatim from millersville.edu/campuslife/
                        // fraternity-and-sorority-life — case-sensitive
                        // because the scraper preserves casing. The 19 active
                        // chapters; suspended (Sigma Tau Gamma) and
                        // unrecognized (Alpha Gamma Theta) are excluded.
                        children: [
                            // Sororities (10)
                            {id:'club:Alpha Xi Delta',label:'Alpha Xi Delta',icon:'♀'},
                            {id:'club:Alpha Sigma Alpha',label:'Alpha Sigma Alpha',icon:'♀'},
                            {id:'club:Alpha Sigma Tau',label:'Alpha Sigma Tau',icon:'♀'},
                            {id:'club:Chi Upsilon Sigma Latin Sorority Inc.',label:'Chi Upsilon Sigma',icon:'♀'},
                            {id:'club:Delta Zeta',label:'Delta Zeta',icon:'♀'},
                            {id:'club:Delta Sigma Theta Sorority Inc.',label:'Delta Sigma Theta',icon:'♀'},
                            {id:'club:Zeta Phi Beta Sorority Inc.',label:'Zeta Phi Beta',icon:'♀'},
                            {id:'club:Mu Sigma Upsilon Sorority Inc.',label:'Mu Sigma Upsilon',icon:'♀'},
                            {id:'club:Sigma Alpha Iota International Music Fraternity Inc.',label:'Sigma Alpha Iota',icon:'♀'},
                            {id:'club:Sigma Gamma Rho Sorority Inc.',label:'Sigma Gamma Rho',icon:'♀'},
                            // Fraternities (9)
                            {id:'club:Acacia Fraternity',label:'Acacia',icon:'♂'},
                            {id:'club:Alpha Phi Alpha Fraternity Inc.',label:'Alpha Phi Alpha',icon:'♂'},
                            {id:'club:Kappa Alpha Psi Fraternity Inc.',label:'Kappa Alpha Psi',icon:'♂'},
                            {id:'club:Lambda Sigma Upsilon',label:'Lambda Sigma Upsilon',icon:'♂'},
                            {id:'club:Tau Kappa Epsilon',label:'Tau Kappa Epsilon',icon:'♂'},
                            {id:'club:Phi Beta Sigma Fraternity Inc.',label:'Phi Beta Sigma',icon:'♂'},
                            {id:'club:Phi Delta Theta',label:'Phi Delta Theta',icon:'♂'},
                            {id:'club:Phi Mu Alpha Sinfonia',label:'Phi Mu Alpha Sinfonia',icon:'♂'},
                            {id:'club:Omega Psi Phi Fraternity Inc.',label:'Omega Psi Phi',icon:'♂'}
                        ]
                    }
                ]
            },
            // Other Events — marauder-native heading group below MU
            // GetInvolved (audience student: never extracted to Uncommon;
            // absent from the townie picker since these events are mu-only
            // anyway). Holds the small student-facing sources: Jesus Dogs
            // (first-class 2026-07-27, was Community-tag fallback) and The
            // Backyard (Google Calendar source, 2026-07-28). Chips are pure
            // follow (push/iCal/⭐) — both sources' events stay visible to
            // every marauder/unset viewer by default regardless (mu-only
            // audience bypass in isEventFromHiddenSource).
            otherevents: { label: 'Other Events', icon: '🎯', headingStyle: true, audience: 'student', subs: [
                {id:'jesus-dogs-all',label:'Free Hot Dog Thursdays',icon:'🌭'},
                {id:'backyard-all',label:'The Backyard',icon:'😊'},
                {id:'hub-all',label:'HUB Free Meals',icon:'🥪'}
            ] },
            borough: { label: 'Borough', icon: '🌳', headingStyle: true, audience: 'townie', subs: [{id:'borough-all',label:'All Borough Events',icon:'🌳'}] },
            manor: { label: 'Manor Twp.', icon: '🪶', headingStyle: true, audience: 'townie', subs: [{id:'manor-all',label:'All Manor Twp. Events',icon:'🪶'}] },
            other: { label: 'Other', icon: '🎯', headingStyle: true, audience: 'townie', subs: [
                {id:'other-vfw',label:'VFW Events',icon:'🎖️'},{id:'other-phantom',label:'Phantom Power',icon:'🎵'},
                {id:'other-community',label:'Community Events',icon:'📝'},
                {id:'raney-cellars-all',label:'Raney Cellars Events',icon:'🍺'},
                {id:'jacks-tavern-all',label:"Jack's Tavern Events",icon:'🍻'}
            ]},
            family: { label: 'Family Friendly', icon: '👨‍👩‍👧', headingStyle: true, audience: 'townie', subs: [{id:'family-events',label:'Family Friendly Events',icon:'👨‍👩‍👧'}] }
        },
        // Townie picker shape — heading-style throughout, same uniform look.
        // Borough and Family Friendly are now heading-style groups (matching
        // Penn Manor / MU / Other) instead of standalone pills. Club Sports
        // removed from MU University composites — it lives in the Sports
        // section now. Composites remain inside MU University to collapse
        // mu-arts + clubs-arts into "Arts & Performance" (etc.) since townies
        // don't experience those as distinct.
        townieGroups: {
            pmev: {
                label: 'Penn Manor', icon: '🏫', headingStyle: true,
                subs: [
                    {id:'pm-music',label:'Music/Arts',icon:'🎵'},
                    {id:'pm-board',label:'Board Meetings',icon:'📋'}
                ]
            },
            mu: {
                label: 'Millersville University', icon: '🏴‍☠️', headingStyle: true,
                composites: [
                    { label: 'Arts & Performance', icon: '🎭', linkedIds: ['mu-arts', 'clubs-arts'] },
                    { label: 'Public Events',      icon: '📢', linkedIds: ['mu-public'] },
                    { label: 'Alumni Events',      icon: '🎓', linkedIds: ['mu-alumni'] },
                    { label: 'Community Fundraisers', icon: '🤝', linkedIds: ['clubs-service'] }
                ]
            },
            borough: {
                label: 'Millersville Borough', icon: '🌳', headingStyle: true,
                subs: [{id:'borough-all',label:'All Borough Events',icon:'🌳'}]
            },
            manor: {
                label: 'Manor Twp.', icon: '🪶', headingStyle: true,
                subs: [{id:'manor-all',label:'All Manor Twp. Events',icon:'🪶'}]
            },
            other: {
                label: 'Other', icon: '🎯', headingStyle: true,
                subs: [
                    {id:'other-vfw',label:'VFW Events',icon:'🎖️'},
                    {id:'other-phantom',label:'Phantom Power',icon:'🎵'},
                    {id:'other-community',label:'Community Events',icon:'📝'},
                    {id:'raney-cellars-all',label:'Raney Cellars Events',icon:'🍺'},
                    {id:'jacks-tavern-all',label:"Jack's Tavern Events",icon:'🍻'}
                ]
            },
            family: {
                label: 'Family Friendly', icon: '👨‍👩‍👧', headingStyle: true,
                subs: [{id:'family-events',label:'Family Friendly Events',icon:'👨‍👩‍👧'}]
            }
        }
    },
    news: {
        title: '📰 News Favorites',
        groups: {
            // MU-side news — visible to both affiliations at full opacity.
            // Townies may legitimately want to follow MU news (e.g. alumni, parents),
            // and marauders obviously want it.
            news: { label: 'MU News Sources', icon: '📰', headingStyle: true, audience: 'both', subs: [
                {id:'news-mu',label:'MU News',icon:'📰'},{id:'news-snapper',label:'The Snapper',icon:'📰'},
                {id:'news-athletics',label:'MU Athletics',icon:'🏅'},{id:'news-review',label:'MU Review',icon:'📖'}
            ]},
            // Community news (Penn Manor, Borough) — tagged townie-audience so the
            // existing "dim for marauders" modal infrastructure (see groupDimmed
            // logic in openFeedSettings) kicks in. Marauders see these dimmed with
            // the "not typical for marauders — enable if interested" nag; favoriting
            // a sub here unlocks the source via SOURCE_UNLOCK_IDS below.
            newsCommunity: { label: 'Community News Sources', icon: '🌳', headingStyle: true, audience: 'townie', subs: [
                {id:'news-pm',label:'Penn Manor',icon:'📰'},{id:'news-borough',label:'Borough',icon:'🌳'}
            ]}
        }
    }
};
// Build flat feedOptions for backward compat
const feedOptions = {};
for (const sec of Object.values(feedSections)) {
    for (const [k,v] of Object.entries(sec.groups)) feedOptions[k] = v;
}
// Classify IDs by context
const sportFeedIds = new Set();
for (const g of Object.values(feedSections.sports.groups)) g.subs.forEach(s => sportFeedIds.add(s.id));
const eventFeedIds = new Set();
for (const g of Object.values(feedSections.events.groups)) g.subs.forEach(s => eventFeedIds.add(s.id));
// mu-alumni lives ONLY in the townie picker's MU composites (deliberately no
// Marauder chip — the events are townie-only), so the groups walk above never
// sees it. Register it by hand or hasEventPrefs misses alumni-only favorites.
eventFeedIds.add('mu-alumni');

// ========== Affiliation-based source hiding ==========
// When a user picks Marauder (or is unset), ALL community-side sources are
// hidden by default: PM/Borough/Manor events, the whole Other family (VFW,
// Phantom Power, Community, Raney Cellars, Jack's Tavern), PM sports, and
// PM/Borough news. When a user picks Townie, MU GetInvolved events + MU Club
// Sports are hidden by default.
// Two opt-in paths (2026-07-27): favoriting an item "unlocks" its source
// (SOURCE_UNLOCK_IDS — also subscribes push/iCal), OR the Uncommon picker's
// "Show events" middle state (shownSources) reveals it WITHOUT subscribing.
// Either path brings the source's pill back and its events into the lists.

// Map of source-pill → set of feed-pref IDs that "unlock" it. If user's feedPrefs contains
// any of these IDs, the source is considered user-opted-in and treated normally.
const SOURCE_UNLOCK_IDS = {
    // Events page source pills
    // 2026-08-03 granular pass: PM sports favorites no longer unlock the PM
    // EVENTS pill — a sport fav reveals only its own sport (see
    // pmSportsEventHidden); the events-page PM source is unlocked by its
    // own two items alone.
    'PM':      ['pm-music', 'pm-board'],
    'Borough': ['borough-all'],
    'Manor':   ['manor-all'],
    'VFW':     ['other-vfw'],
    // Other-family sources gated for marauders 2026-07-27 (were always-visible;
    // Phantom Power confirmed off-campus / not MU-affiliated — Adam's call):
    'Phantom':   ['other-phantom'],
    'Community': ['other-community'],
    'Raney':     ['raney-cellars-all'],
    'Jacks':     ['jacks-tavern-all'],
    // MU-side sources for townies
    'MU':         [], // MU itself always shown — only GetInvolved sub-content is gated
    'GetInvolved':['clubs-all', 'clubs-social', 'clubs-arts', 'clubs-sports', 'clubs-greek', 'clubs-service',
        'cs-baseball','cs-bowling','cs-equestrian','cs-fencing','cs-icehockey','cs-mma',
        'cs-basketball-mens','cs-basketball-womens','cs-lacrosse','cs-rugby-mens','cs-rugby-womens',
        'cs-soccer-mens','cs-soccer-womens','cs-volleyball-mens','cs-volleyball-womens',
        'cs-dance','cs-running','cs-softball','cs-tennis','cs-frisbee'],
    // Sports page source pills
    'SP_PM':      allSportFeedIds('pm'),
    'SP_Clubs':   ['clubs-sports'],
    // News page — Penn Manor and Borough news are community-side; hidden from
    // marauders by default. Each "unlocks" only via its matching news-* fav.
    'PM_NEWS':      ['news-pm'],
    'BOROUGH_NEWS': ['news-borough']
};

// Uncommon-picker group key → the source keys its three-state selector
// (Hidden / Show / ★ Faves) controls. Groups absent here (family — a
// cross-cutting pref, not a source) keep the plain master checkbox.
// Per-item since 2026-08-03: the group selector is a bulk set-all over each
// chip's own 👁 Show bit (see UNCOMMON_SUB_SOURCES below).
const UNCOMMON_GROUP_SOURCES = {
    pmev:    ['PM'],
    borough: ['Borough'],
    manor:   ['Manor'],
    other:   ['VFW','Phantom','Community','Raney','Jacks'],
    pm:      ['SP_PM'],
    newsCommunity: ['PM_NEWS','BOROUGH_NEWS']
};

// --- Per-item Show plumbing (2026-08-03) ------------------------------------
// Each Uncommon picker chip carries its own 👁 Show bit. The bit writes ONE
// shownSources key: the chip's source key where chips map 1:1 to sources
// (Other family, community news, Borough, Manor), or the pref id itself where
// chips are finer than their source (PM sports under SP_PM; pm-music/pm-board
// under PM). Legacy whole-source keys written by the old group-level Show
// ('SP_PM' / 'PM') are still honored by the event gates and migrate to
// per-item bits on the next modal Save.
const UNCOMMON_SUB_SOURCES = {
    'other-vfw': 'VFW', 'other-phantom': 'Phantom', 'other-community': 'Community',
    'raney-cellars-all': 'Raney', 'jacks-tavern-all': 'Jacks',
    'news-pm': 'PM_NEWS', 'news-borough': 'BOROUGH_NEWS',
    'borough-all': 'Borough', 'manor-all': 'Manor'
};
function shownKeyForItem(id) { return UNCOMMON_SUB_SOURCES[id] || id; }
// Sources whose Show state can also live in per-item pref ids.
const SOURCE_SHOW_ITEM_IDS = {
    'SP_PM': allSportFeedIds('pm'),
    'PM':    ['pm-music', 'pm-board']
};
// Render-time init for a chip's 👁 bit: its own key, plus the group's legacy
// whole-source key for finer-than-source groups (lights every chip so a
// pre-existing group-level Show migrates losslessly on Save).
function uncommonItemShown(groupKey, id) {
    if (shownSources.has(shownKeyForItem(id))) return true;
    return (UNCOMMON_GROUP_SOURCES[groupKey] || []).some(k => SOURCE_SHOW_ITEM_IDS[k] && shownSources.has(k));
}
// Shown OR faved, per item id — the per-event visibility test used by the
// granular gates below.
function isItemShownOrFaved(id) {
    if (!id) return false;
    if (shownSources.has(id)) return true;
    return !!(feedPrefs && feedPrefs.length && feedPrefs.indexOf(id) !== -1);
}

// Does the user's affiliation hide this source by default?
// Default (unset) affiliation behaves as Marauder — most users of the site are MU students,
// so that's the majority-optimal default. Townies explicitly opt in.
function isSourceHiddenByAffiliation(source) {
    if (muAffiliation === 'townie') {
        // Townies hide GetInvolved + MU Club Sports
        return source === 'GetInvolved' || source === 'SP_Clubs';
    }
    // Marauder OR unset/default: hide PM, Borough, Manor Twp., the whole Other
    // family (VFW, Phantom Power, Community, Raney Cellars, Jack's Tavern),
    // PM sports, and PM/Borough news. Phantom gated 2026-07-27 — it's
    // off-campus and not MU-affiliated (supersedes the old "campus venue"
    // carve-out that kept the Other pill always-visible).
    return source === 'PM' || source === 'Borough' || source === 'Manor' || source === 'VFW' || source === 'SP_PM'
        || source === 'Phantom' || source === 'Community' || source === 'Raney' || source === 'Jacks'
        || source === 'PM_NEWS' || source === 'BOROUGH_NEWS';
}
// Does the user have a favorite that "unlocks" this hidden source?
function hasFavInSource(source) {
    if (!feedPrefs || feedPrefs.length === 0) return false;
    const ids = SOURCE_UNLOCK_IDS[source] || [];
    // Individual club favorites (club:*) also count as unlocking GetInvolved
    if (source === 'GetInvolved' && feedPrefs.some(p => typeof p === 'string' && p.startsWith('club:'))) return true;
    return feedPrefs.some(p => ids.includes(p));
}
// Does a per-item Show bit exist for this source? (Sources whose Uncommon
// chips are finer than the source key — PM sports, PM events.)
function hasShownItemInSource(source) {
    const ids = SOURCE_SHOW_ITEM_IDS[source];
    return !!ids && ids.some(id => shownSources.has(id));
}
// Should this source be hidden from the user? Hidden by affiliation AND no
// favorite unlock AND not opted-in via the Uncommon picker's "Show events"
// state — whole-source key OR any per-item 👁 bit (2026-08-03).
function isSourceHidden(source) {
    return isSourceHiddenByAffiliation(source) && !hasFavInSource(source)
        && !shownSources.has(source) && !hasShownItemInSource(source);
}
// --- Granular per-event gates (2026-08-03) ----------------------------------
// PM sports: for marauder/unset viewers an event is visible only when ITS OWN
// sport is shown (👁) or faved — faving one sport no longer reveals the whole
// PM sports source. Legacy whole-group Show ('SP_PM') still honored. A bare
// split-sport id (gender tag missing on the event) matches either gender
// variant; an unidentifiable sport rides along whenever ANY PM sport is
// shown/faved (never silently stranded).
function pmSportsEventHidden(e) {
    if (!isSourceHiddenByAffiliation('SP_PM')) return false;
    if (shownSources.has('SP_PM')) return false;
    const ids = SOURCE_SHOW_ITEM_IDS['SP_PM'];
    const id = suggestFeedIdForEvent(e, true);
    if (id) {
        if (ids.indexOf(id) !== -1) return !isItemShownOrFaved(id);
        const variants = ids.filter(x => x.indexOf(id + '-') === 0);
        if (variants.length) return !variants.some(isItemShownOrFaved);
    }
    return !ids.some(isItemShownOrFaved);
}
// PM general events, parallel: pm-music / pm-board are individually
// shown/faved; PM events matching neither item (no Music/Arts or Board/PTO
// tag) ride along when either item is shown/faved. Legacy 'PM' Show honored.
function pmGeneralEventHidden(e) {
    if (!isSourceHiddenByAffiliation('PM')) return false;
    if (shownSources.has('PM')) return false;
    const id = suggestFeedIdForEvent(e, false);
    if (id === 'pm-music' || id === 'pm-board') return !isItemShownOrFaved(id);
    return !SOURCE_SHOW_ITEM_IDS['PM'].some(isItemShownOrFaved);
}
// DORMANT (2026-07-27 same-day revision — zero call sites): the Other pill
// went back to always-visible when Jesus Dogs became a first-class source
// under it, so nothing consults this anymore. Kept per the dormant-not-
// deleted convention; still correctly reads true only when every Other-
// family source is hidden.
function otherSourcesAllHidden() {
    return ['VFW','Phantom','Community','Raney','Jacks'].every(isSourceHidden);
}
// For a given event, is it from a hidden source?
function isEventFromHiddenSource(e) {
    if (!e) return false;
    const tags = e.tags || [];

    // Townie + public-audience: never source-hidden. The townie hide on
    // GetInvolved exists to filter out student-internal content (club
    // meetings, Greek Life, Residence Halls, etc.); events classified
    // audience:public during scrape are explicitly NOT student-internal —
    // they're community service, fundraisers, public-facing performances,
    // etc. Hiding them from townies defeats the audience classification.
    // Without this bypass, a townie has to set an unrelated favorite that
    // incidentally unlocks GetInvolved before they can see e.g. a Bake
    // Sale or Dance Team Showcase. The audience signal is the truth here,
    // not the source-pill default.
    //
    // Marauder side intentionally unchanged: their PM/Borough/VFW hide is
    // venue-focus-based, not audience-based ("I want MU campus content"),
    // so the existing default stands.
    if (muAffiliation === 'townie' && e.audience === 'public') return false;

    // Marauder-side audience bypass (2026-07-27): an event explicitly targeted
    // at MU students (audience 'mu-only') is never source-hidden from marauder
    // or unset viewers — mirrors the townie 'public' bypass above; the
    // audience signal is the truth here too. (Protects e.g. a community-sheet
    // row targeted at Marauders.) Townie hiding of mu-only events lives in
    // isHiddenForViewer and is untouched.
    if (muAffiliation !== 'townie' && e.audience === 'mu-only') return false;

    if (tags.includes('VFW') && isSourceHidden('VFW')) return true;
    if (tags.includes('PM')) {
        // PM sports events carry the PM tag too (the timeline runs this gate
        // on everything) — route them to the per-sport gate; everything else
        // gets the per-item PM-events gate (2026-08-03).
        const pmSport = tags.includes('Athletics') || tags.includes('Athletic Competitions');
        if (pmSport ? pmSportsEventHidden(e) : pmGeneralEventHidden(e)) return true;
    }
    if (tags.includes('Borough') && isSourceHidden('Borough')) return true;
    if (tags.includes('Manor') && isSourceHidden('Manor')) return true;
    if (tags.includes('Clubs/Orgs') && isSourceHidden('GetInvolved')) return true;
    // Other-family sources (gated for marauders 2026-07-27). Phantom Power
    // events carry 'Phantom Power' and/or 'Other'+'Live Music' — match either
    // form; the Other&&LiveMusic conjunction keeps MU concerts (Live Music
    // without Other) unaffected. NOTE: no audience bypass here — a Community-
    // sheet row targeted at Marauders/Both is still source-hidden for default
    // marauders until they Show/favorite Community (flagged in manifest §6).
    if ((tags.includes('Phantom Power') || (tags.includes('Other') && tags.includes('Live Music'))) && isSourceHidden('Phantom')) return true;
    // Bare 'Other' tag = Community family too (community-form submissions and
    // candidates-sheet creates emit it; suggestFeedIdForEvent has always
    // ★-mapped it to other-community). Missing here 2026-07-27a→d — townie
    // events leaked into the Marauder Other pill. !Live Music keeps Phantom
    // ('Other'+'Live Music') governed solely by its own line above.
    if ((tags.includes('Community') || (tags.includes('Other') && !tags.includes('Live Music'))) && isSourceHidden('Community')) return true;
    if (tags.includes('Raney Cellars') && isSourceHidden('Raney')) return true;
    if (tags.includes("Jack's Tavern") && isSourceHidden('Jacks')) return true;
    return false;
}
// For sports events, check against the sports-specific hidden sources
function isSportsEventFromHiddenSource(e) {
    const tags = e.tags || [];
    const isPM = tags.includes('PM') && (tags.includes('Athletics') || tags.includes('Athletic Competitions'));
    const isMUClubSport = tags.includes('Clubs/Orgs') && tags.includes('Club Sports');
    if (isPM && pmSportsEventHidden(e)) return true;
    if (isMUClubSport && isSourceHidden('SP_Clubs')) return true;
    return false;
}
// For news items, is it from a hidden source? Parallel to isEventFromHiddenSource.
// Marauders (default) hide Penn Manor + Borough news unless they've favorited one.
// Townies see everything (no townie-side news hiding rules exist).
function isNewsFromHiddenSource(n) {
    if (!n || !n.source) return false;
    if (n.source === 'Penn Manor News' && isSourceHidden('PM_NEWS')) return true;
    if (n.source === 'Millersville Borough' && isSourceHidden('BOROUGH_NEWS')) return true;
    return false;
}

// Returns true ONLY when the user has favorites set AND this event matches them.
// Unlike eventMatchesFeed, this returns FALSE when no favorites exist — which is what
// the card-favorite-highlight needs (no prefs = no gold border, no star). eventMatchesFeed
// returns true in the no-prefs case to mean "show everything", which is correct for its
// filter/pinning callers but wrong for the highlight check.
function isEventFavorited(e) {
    if (!feedPrefs || feedPrefs.length === 0) return false;
    return eventMatchesFeed(e);
}

// Pick the best pref ID to toggle when the user taps the ☆ button on a card.
// Logic is "most specific first" — for an MU sports game tagged Baseball we'd rather
// toggle `mu-baseball` (specific) than `musports` (everything). For a club event we
// toggle `club:<orgName>` so only that club's events get the star treatment.
// Returns null for events where there's no sensible single-tag target (e.g. non-tagged
// VFW or Phantom Power events fall back to 'other-vfw' / 'other-phantom' group IDs).
function suggestFeedIdForEvent(e, isSportsPage) {
    const tags = e.tags || [];
    // Sports page: match the sport to the affiliation's sport pref
    if (isSportsPage) {
        const level = sportLevelFromTags(tags);
        if (level) {
            const sportTag = (level === 'pm' ? PM_SPORT_ORDER : MU_SPORT_ORDER).find(s => tags.includes(s));
            if (sportTag) {
                const base = level + '-' + sportSuffix(sportTag);
                if (isSplitSport(level, sportTag)) {
                    const g = sportGendersFor(level, sportTag).find(x => tags.includes(x));
                    return g ? base + '-' + GENDER_SUFFIX[g] : base;
                }
                return base;
            }
        }
        if (tags.includes('Clubs/Orgs')) return 'clubs-sports';
        return null;
    }
    // Events page: individual club for GetInvolved events — org name is a non-meta tag
    if (tags.includes('Clubs/Orgs')) {
        const metaTags = new Set(['MU', 'Clubs/Orgs', 'GetInvolved', 'Student Event', 'Public Event',
            'Arts Concert / Performance', 'Art Exhibit', 'Social', 'Arts', 'Fundraising',
            'Service', 'Cultural', 'Club Sports', 'Greek Life', 'Residence Halls',
            'Home Game Mode', 'Family Friendly']);
        const orgTag = tags.find(t => !metaTags.has(t));
        if (orgTag) return 'club:' + orgTag;
        // Fallback: broad GetInvolved sub-category
        if (tags.includes('Social')) return 'clubs-social';
        if (tags.includes('Arts')) return 'clubs-arts';
        if (tags.includes('Club Sports')) return 'clubs-sports';
        if (tags.includes('Greek Life')) return 'clubs-greek';
        if (tags.includes('Service') || tags.includes('Cultural')) return 'clubs-service';
        return 'clubs-all';
    }
    // MU Calendar proper
    if (tags.includes('MU')) {
        // Alumni-page events (camps.json tags + the MU Calendar's 'Alumni
        // Engagement' customerName tag). Checked BEFORE Public Event so the
        // calendar twins (tagged both) star-suggest mu-alumni.
        if (tags.includes('Alumni Event') || tags.includes('Alumni Engagement') ||
            tags.includes('Summer Fun Series')) return 'mu-alumni';
        if (tags.includes('Arts Concert / Performance') || tags.includes('Art Exhibit')) return 'mu-arts';
        if (tags.includes('Public Event')) return 'mu-public';
        return null;
    }
    // Penn Manor events
    if (tags.includes('PM')) {
        if (tags.includes('Music/Arts')) return 'pm-music';
        if (tags.includes('Board/PTO')) return 'pm-board';
        return null;
    }
    // Borough
    if (tags.includes('Borough')) return 'borough-all';
    // Manor Twp.
    if (tags.includes('Manor')) return 'manor-all';
    if (tags.includes('Raney Cellars')) return 'raney-cellars-all';
    if (tags.includes("Jack's Tavern")) return 'jacks-tavern-all';
    if (tags.includes('Jesus Dogs')) return 'jesus-dogs-all';
    if (tags.includes('The Backyard')) return 'backyard-all';
    if (tags.includes('HUB')) return 'hub-all';
    // Other
    if (tags.includes('VFW')) return 'other-vfw';
    if (tags.includes('Phantom Power') || tags.includes('Live Music')) return 'other-phantom';
    // Community-submitted events
    if (tags.includes('Other')) return 'other-community';
    return null;
}

// Toggle a feed preference from a card-level ☆ button. Updates feedPrefs, persists,
// and re-renders the current view so gold borders/stars reflect the change.
// Resolve a prefId (e.g. "baseball-mu" or "club:Chess Club") back to the
// human-readable label users see in the favorites modal. Used by the toast
// message so the user knows exactly which category got toggled. Returns the
// prefId unchanged if no match found, which is a reasonable fallback (the
// user at least sees the raw identifier rather than a silent action).
function resolvePrefLabel(prefId) {
    if (!prefId) return '';
    if (prefId.startsWith('club:')) return prefId.slice(5);
    if (typeof feedSections === 'undefined' || !feedSections) return prefId;
    for (const section of Object.values(feedSections)) {
        if (!section || !section.groups) continue;
        for (const group of Object.values(section.groups)) {
            if (!group.subs) continue;
            const match = group.subs.find(s => s.id === prefId);
            if (match) {
                // Strip leading emoji(s) from the label for a cleaner toast.
                return (match.icon ? match.icon + ' ' : '') + match.label;
            }
        }
    }
    return prefId;
}

// Lightweight toast notifier. Reuses a single fixed element so repeated
// clicks don't stack multiple notifications. Auto-dismisses after 2s.
function showToast(message) {
    let toast = document.getElementById('mapp-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mapp-toast';
        toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--navy);color:white;padding:10px 18px;border-radius:999px;font-size:0.9rem;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,0.25);z-index:9999;opacity:0;transition:opacity 0.25s,transform 0.25s;pointer-events:none;max-width:calc(100% - 40px);text-align:center;';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    // Force reflow so the transition kicks in on first show
    // (otherwise the element goes straight to visible without animating).
    void toast.offsetWidth;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(20px)';
    }, 2000);
}

window.toggleCardFavorite = function(prefId, btnEl) {
    if (!prefId) return;
    if (!feedPrefs) feedPrefs = [];
    const idx = feedPrefs.indexOf(prefId);
    const wasActive = idx >= 0;
    const label = resolvePrefLabel(prefId);
    if (wasActive) {
        feedPrefs.splice(idx, 1);
        if (btnEl) {
            btnEl.classList.remove('active');
            btnEl.textContent = '☆';
            btnEl.setAttribute('title', 'Add to favorites');
            btnEl.setAttribute('aria-label', 'Add to favorites');
        }
        showToast(`Removed: ${label}`);
    } else {
        feedPrefs.push(prefId);
        if (btnEl) {
            btnEl.classList.add('active');
            btnEl.textContent = '★';
            btnEl.setAttribute('title', 'Remove from favorites');
            btnEl.setAttribute('aria-label', 'Remove from favorites');
            // Gold-pulse the card's secondary tag row so the user sees
            // which category bucket they just bookmarked. Animation runs
            // for ~1.2s and self-clears when it ends.
            const card = btnEl.closest('.app-card');
            if (card) {
                const tagsRow = card.querySelector('.card-tags');
                if (tagsRow) {
                    tagsRow.classList.remove('tags-flash');  // reset if mid-animation
                    void tagsRow.offsetWidth;                 // force reflow
                    tagsRow.classList.add('tags-flash');
                    setTimeout(() => tagsRow.classList.remove('tags-flash'), 1400);
                }
            }
        }
        showToast(`★ Added: ${label}`);
    }
    // Persist
    if (feedPrefs.length === 0) {
        localStorage.removeItem(FEED_KEY);
        feedPrefs = null;
    } else {
        localStorage.setItem(FEED_KEY, JSON.stringify(feedPrefs));
    }
    if (typeof setFeedDotVisible === 'function') setFeedDotVisible(!!(feedPrefs && feedPrefs.length > 0));

    // Surgical update: previously this triggered renderEvents() + renderSports()
    // + renderHomeUI() to refresh gold borders on OTHER cards matching the same
    // pref (e.g. starring "Baseball" should gold-border every Baseball card on
    // screen). Three full timeline rebuilds for a star click was costing
    // 100-200ms on slow phones. Now we walk only the visible card/tl-item
    // elements that have data-event-key, look each event up by key, and
    // toggle the visual state where it actually changed. ~5x faster, no
    // GC churn, no scroll position loss.
    if (typeof allEvents === 'undefined' || !allEvents) return;
    // Build a quick lookup map from eventKey → event so each card-update is O(1)
    // rather than scanning the whole array per card. Built once per toggle call.
    const eventByKey = new Map();
    for (const ev of allEvents) {
        const k = getEventKey(ev);
        eventByKey.set(k, ev);
    }
    document.querySelectorAll('[data-event-key]').forEach(el => {
        const key = el.getAttribute('data-event-key');
        const ev = eventByKey.get(key);
        if (!ev) return;
        const isFav = isEventFavorited(ev);
        // Card surfaces (.app-card) get a .card-fav class for the gold border.
        if (el.classList.contains('app-card')) {
            el.classList.toggle('card-fav', isFav);
            // Update the inline star button if present (skip the one we already
            // updated explicitly above — it's already correct).
            const star = el.querySelector('.card-fav-inline');
            if (star && star !== btnEl) {
                star.classList.toggle('active', isFav);
                star.textContent = isFav ? '★' : '☆';
                star.setAttribute('title', isFav ? 'Remove from favorites' : 'Add to favorites');
                star.setAttribute('aria-label', isFav ? 'Remove from favorites' : 'Add to favorites');
            }
        }
        // Timeline items (tl-item on home page) show the favorited state via
        // the tl-fav class — defined for the gold left-border accent.
        if (el.classList.contains('tl-item')) {
            el.classList.toggle('tl-fav', isFav);
        }
    });
};

// 1-arg wrapper around the shared lib (lib/eventMatch.js). The lib is
// loaded by a <script> tag in index.html before app.js, so window.event-
// MatchModule is available here. We close over the module-scope feedPrefs
// so existing call sites in this file stay as eventMatchesFeed(e).
//
// Source of truth lives in lib/eventMatch.js — edit there for both this
// caller AND scripts/send-notifications.js. The PHP port in events.ics.php
// has its own copy that must be hand-synced (different language).
const eventMatchesFeed = (e) => window.eventMatchModule.eventMatchesFeed(e, feedPrefs);

// Stable, unique-per-event key for use in click handlers, DOM data-attrs,
// favorite lookups, and iCal UIDs. Previously was `sourceLink || title+date`
// which broke for Borough events — every Borough event ships with the same
// shared sourceLink (millersvilleborough.org/resident-info/calendar/), so
// the array find would always return the FIRST Borough event in the list
// regardless of which card the user clicked.
//
// title+date is reliable because (a) the same event always has the same
// title and start time across scrape runs, (b) two real events never share
// BOTH exact title AND exact start time. The `|` separator is unlikely to
// appear inside an event title; even if it did, false-collisions would be
// extraordinarily rare.
function getEventKey(e) {
    return (e.title || '') + '|' + (e.date || '');
}

// A registration event (youth sports signups; PM community events that carry a
// deadline) asks people to REGISTER, not buy a ticket — so the UI shows a
// "📝 Register Now" button pointing at the signup page instead of a ticket
// link. The register URL lives on registerLink (set by the scraper), with
// sourceLink/ticketLink as fallbacks for older cached events.
function isRegistrationEvent(e) {
    return !!(e && (e.registrationRequired === true || e.registrationDeadline));
}
function getRegisterUrl(e) {
    return (e && (e.registerLink || e.sourceLink || e.ticketLink)) || '';
}

// A "program signup" is an open-registration program that lives in the events
// array as a normal dated event (no registrationDeadline) but that townies
// should be reminded to sign up for: youth/community camps (camps.json, tagged
// "Summer Camp"/"Athletic Camp") and Arts Smarts (artsmu.com; matched by title
// because its tag is the generic "Arts Concert / Performance"). TOWNIE-only in
// the Upcoming Signups box: the renderer gates the list on isTownie, and we
// exclude intramurals defensively. No deadline, so it's anchored on the start
// date; the register link is getRegisterUrl(e) — ticketLink for camps, sourceLink
// for Arts Smarts.
function isProgramSignup(e) {
    if (!e || e.registrationDeadline || isIntramural(e)) return false;
    const tags = e.tags || [];
    if (tags.includes('Summer Camp') || tags.includes('Athletic Camp')) return true;
    if (/arts\s*smarts?/i.test(e.title || '')) return true;
    return false;
}

// A "ticket package" is a hand-entered season-ticket / ticket-package promo —
// a community-submissions sheet row carrying a Registration Deadline (e.g. MU
// Football season tickets). Identified by TITLE, like Arts Smarts above: the
// sheet row's Title must contain "season ticket(s)" or "ticket package(s)" to
// be picked up. Surfaced on the Sports page's top signups block for townies,
// alongside the athletic camps; the home Upcoming Signups box already shows
// it via registrationDeadline, so this predicate is Sports-page-only.
function isTicketPackage(e) {
    if (!e || !isRegistrationEvent(e) || isIntramural(e)) return false;
    return /season\s*tickets?|ticket\s*packages?/i.test(e.title || '');
}

// Expand/collapse the overflow rows in the homepage Upcoming Signups box. The box
// renders SIGNUPS_COLLAPSED_COUNT rows on load and hides the rest so Today's
// Specials peeks above the fold and invites a scroll; this reveals them on tap.
// Display flip + label swap, mirroring the clubs-browser toggle.
window.toggleSignupsMore = function(btn) {
    const more = document.getElementById('home-signups-more');
    if (!more || !btn) return;
    const expand = more.style.display === 'none';
    more.style.display = expand ? 'block' : 'none';
    btn.setAttribute('aria-expanded', expand ? 'true' : 'false');
    btn.textContent = expand ? '▴ Show less' : (btn.dataset.moreLabel || 'Show more');
};


function newsMatchesFeed(n) {
    if (!feedPrefs || feedPrefs.length === 0) return true;
    const sourceMap = {
        'Millersville News':'news-mu','The Snapper':'news-snapper','MU Athletics':'news-athletics',
        'MU Review':'news-review','Penn Manor News':'news-pm','Millersville Borough':'news-borough'
    };
    return feedPrefs.includes(sourceMap[n.source] || '');
}

// Lightweight styled confirm/choice dialog — replaces native confirm() so the
// prompts match the app and can offer more than two options. Renders above the
// settings modal (z-index 10000). Each button: {label, cls, style, onClick}.
// Clicking the backdrop dismisses with no action.
window.mappDialog = function(opts) {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:380px;width:100%;padding:22px;box-shadow:0 12px 44px rgba(0,0,0,0.28);';
    const btns = (opts.buttons || []).map((b, i) =>
        `<button data-i="${i}" class="btn btn-sm ${b.cls || 'btn-outline'}" style="width:100%;padding:11px;font-size:0.88rem;${b.style || ''}">${b.label}</button>`
    ).join('');
    box.innerHTML = `<div style="font-weight:700;font-size:1.02rem;margin-bottom:6px;color:var(--navy);">${opts.title || ''}</div>
        <div style="font-size:0.85rem;color:var(--text-muted);line-height:1.45;margin-bottom:16px;">${opts.message || ''}</div>
        <div style="display:flex;flex-direction:column;gap:8px;">${btns}</div>`;
    ov.appendChild(box);
    document.body.appendChild(ov);
    box.querySelectorAll('button[data-i]').forEach(btn => {
        btn.onclick = () => { const i = +btn.dataset.i; ov.remove(); const cb = (opts.buttons[i] || {}).onClick; if (typeof cb === 'function') cb(); };
    });
    ov.onclick = e => { if (e.target === ov) ov.remove(); };
};

// Close the favorites/settings modal if open (overlay carries a stable id).
window.closeFeedModal = function() {
    const o = document.getElementById('feed-settings-overlay');
    if (o) o.remove();
};

// Clear Favs button → styled confirm (it's a total wipe; easy to hit by accident).
// Keeps the Local / MU Student setting intact. Reopens the modal so the pickers
// reflect the now-empty state.
window.confirmClearFavs = function() {
    if (!feedPrefs || feedPrefs.length === 0) return; // nothing to clear
    window.mappDialog({
        title: 'Clear all favorites?',
        message: "This removes every event, sport, and news favorite you've picked. Your Local / MU Student setting stays the same.",
        buttons: [
            { label: 'Clear favorites', cls: 'btn-outline', style: 'color:#dc2626;border-color:#dc2626;', onClick: () => {
                window.clearFavoritesOnly();
                if (document.getElementById('feed-settings-overlay')) { window.closeFeedModal(); window.openFeedSettings(); }
            }},
            { label: 'Cancel', cls: 'btn-outline', style: 'color:var(--text-muted);', onClick: () => {} }
        ]
    });
};

window.openFeedSettings = function() {
    loadFeedPrefs();
    const current = feedPrefs || [];
    const overlay = document.createElement('div');
    overlay.id = 'feed-settings-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
    overlay.onclick = function(ev){ if(ev.target===overlay) overlay.remove(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:520px;width:100%;max-height:90vh;overflow-y:auto;padding:28px;position:relative;';

    // Affiliation / dimming setup — shared state for all rendering helpers below.
    // Unset muAffiliation is treated as marauder (the app's default).
    const effectiveAffiliation = muAffiliation === 'townie' ? 'townie' : 'student';
    const isTownie = effectiveAffiliation === 'townie';
    const isMarauder = !isTownie;
    // Rank a group (or sub) by relevance to the current user — relevant first,
    // 'both' next, non-relevant last. Used to order sub-chips within a group.
    const audienceRank = aud => {
        if (!muAffiliation || aud === 'both') return 1;
        if (aud === muAffiliation) return 0;
        return 2;
    };
    // A group is "dimmed" for marauders when its audience is explicitly townie-
    // leaning (PM Events, Borough, etc.). Townies never dim. Now used to extract
    // dimmed groups into the Uncommon accordion, not to visually fade them
    // inside their natural section.
    const isGroupDimmed = (group) => {
        if (!isMarauder) return false;
        return !!(group && group.audience && group.audience !== 'both' && group.audience !== 'student');
    };
    // Use townie-specific label if user is townie and one is defined.
    const labelFor = (item) => (isTownie && item.townieLabel) ? item.townieLabel : item.label;
    // Display order: Events first (matches the nav), then Sports, then News.
    const sectionOrder = ['events', 'sports', 'news'];
    const orderedSections = sectionOrder
        .map(k => [k, feedSections[k]])
        .filter(([, v]) => v)
        .concat(Object.entries(feedSections).filter(([k]) => !sectionOrder.includes(k)));

    // Accordion + group rendering helpers — closure-scoped so they share
    // access to `current`, `effectiveAffiliation`, `isMarauder`, `labelFor`.
    const groupHasFavs = (g) => {
        if (g.linkedIds && Array.isArray(g.linkedIds)) {
            return g.linkedIds.some(id => current.includes(id));
        }
        if (g.headingStyle) {
            const allIds = [
                ...((g.subs || []).map(s => s.id)),
                ...((g.composites || []).flatMap(c => [
                    ...(c.linkedIds || []),
                    ...((c.subSports || []).map(s => s.id))
                ])),
                ...((g.subgroups || []).flatMap(sg => [
                    sg.masterId,
                    ...((sg.children || []).map(c => c.id))
                ]))
            ];
            return allIds.some(id => current.includes(id));
        }
        return (g.subs || []).some(s => current.includes(s.id));
    };
    const anyFavsIn = (groupEntries) => groupEntries.some(([, g]) => groupHasFavs(g));

    // Render one group block (label + checkboxes + sub-chips). Extracted so
    // both the per-section render AND the Uncommon bucket can reuse it.
    const renderGroupBlock = (key, group) => {
        // Composite group: a single togglable checkbox that maps to multiple
        // underlying pref IDs. Used by the townie picker to collapse e.g.
        // mu-arts + clubs-arts into one "MU Arts & Performance" item.
        // Checked state = "any linked ID is currently in feedPrefs".
        if (group.linkedIds && Array.isArray(group.linkedIds)) {
            const linkedIds = group.linkedIds;
            const isChecked = linkedIds.some(id => current.includes(id));
            return `<div style="margin-bottom:8px;">
                <label class="feed-pill${isChecked?' is-checked':''}">
                    <input type="checkbox" class="feed-sub" data-linked-ids="${linkedIds.join(',')}" ${isChecked?'checked':''} onchange="updateCompositeSub(this)">
                    <span>${group.icon} ${labelFor(group)}</span>
                </label>
            </div>`;
        }

        // Heading-style group: renders as an institutional cluster header
        // ("Penn Manor", "Millersville University", "Other") with its own
        // master checkbox attached. Children below can be either traditional
        // subs (granular pref-id chips) or composites (linkedIds aggregated
        // into chips). Master checkbox toggles every underlying pref ID
        // across both child types.
        if (group.headingStyle) {
            const subs = group.subs || [];
            const composites = group.composites || [];
            const subgroups = group.subgroups || [];
            // Marauder-only Uncommon groups get the three-state selector and
            // per-chip 👁 Show toggles (2026-08-03).
            const segGroup = isMarauder && !!UNCOMMON_GROUP_SOURCES[key];
            // Collect ALL underlying IDs (subs + every composite's linkedIds
            // + subgroup masters + subgroup children) to determine master
            // state. Master is checked when every underlying ID is in current.
            const allIds = [
                ...subs.map(s => s.id),
                ...composites.flatMap(c => [
                    ...(c.linkedIds || []),
                    ...((c.subSports || []).map(s => s.id))
                ]),
                ...subgroups.flatMap(sg => [
                    sg.masterId,
                    ...((sg.children || []).map(c => c.id))
                ])
            ];
            const allChecked = allIds.length > 0 && allIds.every(id => current.includes(id));

            // Render subs and composites alike as chips (same shape as the
            // marauder picker) so heading-style groups look uniform.
            const subsHtml = subs.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding-left:14px;margin-top:6px;">
                ${subs.map(s => {
                    const eyeOn = segGroup && uncommonItemShown(key, s.id);
                    const eye = segGroup ? `<button type="button" class="uncommon-eye" data-group="${key}" data-pref-id="${s.id.replace(/"/g,'&quot;')}" data-shown="${eyeOn?'1':'0'}" aria-pressed="${eyeOn?'true':'false'}" onclick="toggleUncommonEye(event, this)" title="Show these events without following" style="border:1px solid ${eyeOn?'var(--navy)':'var(--border)'};background:${eyeOn?'var(--navy)':'transparent'};color:${eyeOn?'#fff':'var(--text-muted)'};border-radius:999px;font-size:0.68rem;line-height:1;padding:2px 6px;margin-left:4px;cursor:pointer;font-family:inherit;">👁</button>` : '';
                    return `<label class="feed-chip${current.includes(s.id)?' is-checked':''}"><input type="checkbox" class="feed-sub" data-group="${key}" value="${s.id}" ${current.includes(s.id)?'checked':''} onchange="updateFeedGroup('${key}')"> ${s.icon} ${labelFor(s)}${eye}</label>`;
                }).join('')}
            </div>` : '';

            const compositesHtml = composites.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding-left:14px;margin-top:6px;">
                ${composites.map(c => {
                    const cChecked = (c.linkedIds || []).some(id => current.includes(id));
                    // Optional sub-sports chips inside a composite (used for
                    // Club Sports). Rendered as chips right after the composite.
                    const subSports = c.subSports || [];
                    const subSportsHtml = subSports.map(s => `<label class="feed-chip-tiny${current.includes(s.id)?' is-checked':''}"><input type="checkbox" class="feed-sub" data-group="${key}" value="${s.id}" ${current.includes(s.id)?'checked':''} onchange="updateFeedGroup('${key}')"> ${s.icon} ${s.label}</label>`).join('');
                    return `<label class="feed-chip${cChecked?' is-checked':''}"><input type="checkbox" class="feed-sub" data-group="${key}" data-linked-ids="${(c.linkedIds||[]).join(',')}" ${cChecked?'checked':''} onchange="updateCompositeSub(this)"> ${c.icon} ${c.label}</label>${subSportsHtml}`;
                }).join('')}
            </div>` : '';

            // Subgroups: collapsible nested sections with their own master +
            // children. Used by MU GetInvolved for Club Sports and Greek Life
            // — each carries 19-21 chips that would overwhelm the picker if
            // always-expanded. Default collapsed; click row to expand. The
            // subgroup master toggles all children at once via toggleFeedSubgroup.
            const subgroupsHtml = subgroups.length ? `<div style="padding-left:14px;margin-top:10px;">
                ${subgroups.map(sg => {
                    const childIds = (sg.children || []).map(c => c.id);
                    const masterChecked = current.includes(sg.masterId);
                    const anyChildChecked = childIds.some(id => current.includes(id));
                    // Auto-expand if user has any sub-pref selected — they're
                    // working in this subgroup, so don't make them re-find it.
                    const startExpanded = anyChildChecked;
                    const sgKey = key + '__' + sg.key;
                    const chipsHtml = (sg.children || []).map(c =>
                        `<label style="display:flex;align-items:center;gap:4px;font-size:0.78rem;padding:4px 9px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;background:${current.includes(c.id)?'var(--gold-soft)':'var(--bg)'};"><input type="checkbox" class="feed-sub" data-group="${key}" data-subgroup="${sgKey}" value="${c.id.replace(/"/g,'&quot;')}" ${current.includes(c.id)?'checked':''} onchange="updateFeedSubgroup('${sgKey}')" style="accent-color:var(--gold);"> ${c.icon||''} ${c.label}</label>`
                    ).join('');
                    return `<div class="feed-subgroup" data-subgroup-key="${sgKey}" style="margin-bottom:8px;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;">
                        <div class="feed-subgroup-header" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:${masterChecked||anyChildChecked?'var(--gold-soft)':'var(--bg)'};cursor:pointer;" onclick="toggleSubgroupCollapse(event, '${sgKey}')">
                            <input type="checkbox" class="feed-subgroup-master feed-sub" data-group="${key}" data-subgroup="${sgKey}" value="${sg.masterId}" ${masterChecked?'checked':''} onclick="event.stopPropagation()" onchange="toggleFeedSubgroup(this)" style="accent-color:var(--gold);">
                            <span style="flex:1;font-size:0.85rem;font-weight:700;">${sg.icon} ${sg.label}</span>
                            <span class="feed-subgroup-chevron" style="font-size:0.85rem;color:var(--text-muted);transition:transform 0.15s;${startExpanded?'transform:rotate(90deg);':''}">▸</span>
                        </div>
                        <div class="feed-subgroup-children" style="display:${startExpanded?'flex':'none'};flex-wrap:wrap;gap:6px;padding:10px 12px;background:var(--surface);border-top:1px solid var(--border);">${chipsHtml}</div>
                    </div>`;
                }).join('')}
            </div>` : '';

            // Club browser button — only on the GetInvolved (clubs) group.
            // Lives below the subgroups so it sits beneath Greek Life / Club
            // Sports as a "go deeper" affordance. The heading-style render
            // path lost this button when GetInvolved became heading-style;
            // restore it here.
            const clubBrowserHtml = key === 'clubs'
                ? '<div id="clubs-individual-wrap" style="padding-left:14px;margin-top:10px;"><button onclick="toggleClubBrowser()" class="btn btn-sm btn-outline" style="font-size:0.75rem;">📋 Browse Individual Clubs ▸</button><div id="clubs-individual-list" style="display:none;max-height:200px;overflow-y:auto;margin-top:8px;flex-wrap:wrap;gap:4px;"></div></div>'
                : '';

            // Uncommon three-state selector (marauder-only, source-mapped
            // groups): replaces the master checkbox with Hidden / Show /
            // ★ Faves. "Show" = see events without subscribing (push/iCal
            // untouched). Per-item since 2026-08-03: each chip carries its
            // own 👁 Show bit (pending in the chip's data-shown until Save);
            // the group control is a bulk set-all whose position is DERIVED —
            // ★ Faves when any chip is checked, Show when any 👁 is on, else
            // Hidden. Checking a chip while Hidden auto-moves the control
            // (the old unlock behavior, preserved). Initial styles baked at
            // render; refreshUncommonSeg re-derives on every interaction.
            const segSources = segGroup ? UNCOMMON_GROUP_SOURCES[key] : null;
            let headerHtml;
            if (segSources) {
                const pendingShown = subs.some(s => uncommonItemShown(key, s.id));
                const segState = groupHasFavs(group) ? 'fav' : (pendingShown ? 'show' : 'hidden');
                const segBtn = (state, text) => {
                    const on = segState === state;
                    return `<button type="button" data-state="${state}" onclick="setUncommonState('${key}','${state}')" style="font-size:0.7rem;padding:4px 9px;border:1px solid ${on?'var(--navy)':'var(--border)'};border-radius:999px;cursor:pointer;background:${on?'var(--navy)':'transparent'};color:${on?'#fff':'var(--text-muted)'};font-weight:${on?'700':'400'};font-family:inherit;white-space:nowrap;">${text}</button>`;
                };
                headerHtml = `<div class="feed-heading-label" style="display:flex;align-items:center;gap:8px;padding-bottom:6px;border-bottom:1px solid var(--border);">
                    <span class="feed-heading-text">${group.icon} ${labelFor(group)}</span>
                    <span class="uncommon-seg" data-uncommon-group="${key}" style="display:flex;gap:4px;margin-left:auto;">
                        ${segBtn('hidden','Hidden')}${segBtn('show','Show')}${segBtn('fav','★ Faves')}
                    </span>
                </div>`;
            } else {
                headerHtml = `<label class="feed-heading-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;padding-bottom:6px;border-bottom:1px solid var(--border);">
                    <input type="checkbox" class="feed-group" data-group="${key}" ${allChecked?'checked':''} onchange="toggleFeedGroup(this)" style="accent-color:var(--gold);width:16px;height:16px;">
                    <span class="feed-heading-text">${group.icon} ${labelFor(group)}</span>
                </label>`;
            }
            return `<div class="feed-heading-group" style="margin-bottom:14px;">
                ${headerHtml}
                ${subsHtml}
                ${compositesHtml}
                ${subgroupsHtml}
                ${clubBrowserHtml}
            </div>`;
        }

        const visibleSubs = group.subs.filter(s => {
            if (!s.audience || s.audience === 'both') return true;
            return s.audience === effectiveAffiliation;
        });
        if (visibleSubs.length === 0) return '';

        const allIds = visibleSubs.map(s => s.id);
        const allChecked = allIds.every(id => current.includes(id));
        const groupDimmed = isMarauder && group.audience && group.audience !== 'both' && group.audience !== 'student';
        const groupClass = groupDimmed ? 'feed-group-dimmed' : '';
        const subs = visibleSubs.slice().sort((a, b) => audienceRank(a.audience || group.audience || 'both') - audienceRank(b.audience || group.audience || 'both'));

        return `<div class="${groupClass}" style="margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <label style="font-size:0.88rem;font-weight:700;display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" class="feed-group" data-group="${key}" ${allChecked?'checked':''} onchange="toggleFeedGroup(this)" style="accent-color:var(--gold);width:16px;height:16px;">
                    ${group.icon} ${labelFor(group)}
                </label>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;padding-left:8px;">
                ${subs.map(s => {
                    const subAud = s.audience || group.audience || 'both';
                    const subDimmed = isMarauder && subAud !== 'both' && subAud !== 'student';
                    const subClass = subDimmed && !groupDimmed ? 'feed-group-dimmed' : '';
                    return `<label class="feed-chip${current.includes(s.id)?' is-checked':''}${subClass?' '+subClass:''}"><input type="checkbox" class="feed-sub" data-group="${key}" value="${s.id}" ${current.includes(s.id)?'checked':''} onchange="updateFeedGroup('${key}')"> ${s.icon} ${labelFor(s)}</label>`;
                }).join('')}
            </div>
            ${key === 'clubs' ? '<div id="clubs-individual-wrap" style="padding-left:8px;margin-top:8px;"><button onclick="toggleClubBrowser()" class="btn btn-sm btn-outline" style="font-size:0.75rem;">📋 Browse Individual Clubs ▸</button><div id="clubs-individual-list" style="display:none;max-height:200px;overflow-y:auto;margin-top:8px;display:none;flex-wrap:wrap;gap:4px;"></div></div>' : ''}
        </div>`;
    };

    // Render one accordion wrapper. `accent` is a left-border color preserving
    // the section color coding (navy/amber/border) from the old design.
    // `defaultOpen` controls initial expanded/collapsed state — we auto-expand
    // sections where the user already has favorites.
    const renderAccordion = (title, contentHtml, defaultOpen, subtitle, accent) => {
        const chevronStyle = defaultOpen ? 'transform:rotate(90deg);' : '';
        const contentStyle = defaultOpen ? '' : 'display:none;';
        const accentStyle = accent ? `border-left:4px solid ${accent};` : '';
        return `<div class="feed-accordion" data-open="${defaultOpen}" style="margin-bottom:10px;border:1px solid var(--border);${accentStyle}border-radius:var(--radius-sm);overflow:hidden;background:var(--surface);">
            <button type="button" onclick="toggleFeedAccordion(this)" style="width:100%;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;background:var(--bg);border:none;cursor:pointer;font-family:inherit;text-align:left;">
                <span style="flex:1;font-size:0.95rem;font-weight:800;color:var(--text);">
                    ${title}
                    ${subtitle ? `<span style="display:block;font-size:0.72rem;font-weight:400;color:var(--text-muted);margin-top:2px;">${subtitle}</span>` : ''}
                </span>
                <span class="feed-accordion-chevron" style="font-size:0.85rem;color:var(--text-muted);transition:transform 0.2s;${chevronStyle}">▶</span>
            </button>
            <div class="feed-accordion-content" style="${contentStyle}padding:14px;border-top:1px solid var(--border);">
                ${contentHtml}
            </div>
        </div>`;
    };

    // Main sections render. For marauders, dimmed (townie-audience) groups
    // are extracted out of their sections into a single "Uncommon" bucket at
    // the bottom — much cleaner than the old "dimmed at bottom of each section"
    // approach, since now sections show ONLY marauder-relevant picks.
    let sectionsHtml = '';
    const uncommonGroups = []; // [[key, group]] gathered for marauders

    for (const [secKey, section] of orderedSections) {
        // Townies use townieGroups when defined — a restructured shape with
        // composite groups and subgroup headings tailored to their UX needs.
        // Marauders always use the granular groups field.
        const sourceGroups = (isTownie && section.townieGroups) ? section.townieGroups : section.groups;
        const rawEntries = Object.entries(sourceGroups);

        let commonEntries;
        if (isMarauder) {
            commonEntries = [];
            for (const [gk, g] of rawEntries) {
                if (isGroupDimmed(g)) uncommonGroups.push([gk, g]);
                else commonEntries.push([gk, g]);
            }
        } else {
            commonEntries = rawEntries; // townies see everything in natural order
        }

        if (commonEntries.length === 0) continue;
        const groupHtml = commonEntries.map(([k, g]) => renderGroupBlock(k, g)).filter(Boolean).join('');
        if (!groupHtml.trim()) continue;

        const defaultOpen = anyFavsIn(commonEntries);
        const accent = secKey === 'sports' ? 'var(--navy)' : secKey === 'events' ? '#b45309' : 'var(--border)';
        sectionsHtml += renderAccordion(section.title, groupHtml, defaultOpen, null, accent);
    }

    // Bottom "Uncommon for Marauders" accordion — consolidates all the
    // townie-audience groups (PM Sports, PM Events, Borough, VFW, Phantom
    // Power, Community News) that used to appear individually dimmed within
    // each section. One collapsible bucket keeps the modal compact while
    // still making these options discoverable for marauders who want to
    // opt into community content. The "enable if interested" nag that used
    // to sit next to each dimmed group label now lives in the bucket's
    // subtitle, so we drop the per-group repetition.
    if (isMarauder && uncommonGroups.length > 0) {
        const uncommonHtml = uncommonGroups.map(([k, g]) => renderGroupBlock(k, g)).filter(Boolean).join('');
        const defaultOpen = anyFavsIn(uncommonGroups);
        sectionsHtml += renderAccordion(
            '🏘️ Uncommon for Marauders',
            uncommonHtml,
            defaultOpen,
            'Penn Manor, Borough, and broader community — hidden by default; Show to see events, ★ to follow',
            '#9ca3af'  // muted gray accent to de-emphasize vs. the themed sections
        );
    }

    // Build individual clubs list from events data
    const clubCategoryTags = new Set(['Clubs/Orgs','MU','GetInvolved','Social','Service','Academic','Cultural','Club Sports','Religious','Professional','Arts','Media','Governance','Recreation','Activism','Greek Life','Honor Society','Meeting','Performance','Lecture or Speaker','Movie or Film','Sporting','Fundraising','GroupBusiness','CommunityService','Tabling','Spirituality','ThoughtfulLearning','Educational Program',"Men's","Women's"]);
    const clubNames = new Map();
    allEvents.forEach(e => {
        const tags = e.tags || [];
        if (!tags.includes('Clubs/Orgs')) return;
        tags.forEach(t => {
            if (!clubCategoryTags.has(t) && t.length > 2) clubNames.set(t, (clubNames.get(t)||0) + 1);
        });
    });
    const sortedClubs = [...clubNames.entries()].filter(([,c]) => c >= 2).sort((a,b) => a[0].localeCompare(b[0]));
    window._individualClubs = sortedClubs.map(([name]) => name);

    modal.innerHTML = `
        <button onclick="window.closeFeedModal()" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-muted);z-index:2;">✕</button>
        <div style="margin-bottom:14px;">
            <h3 style="margin-bottom:4px;">⭐ My Favorites</h3>
            <p style="font-size:0.8rem;color:var(--text-muted);">Pick your favorites to personalize your experience.</p>
        </div>
        <!-- Mode selector band: plain Local / MU Student labels (with flavor) showing
             the current mode and letting users switch. Doubles as the first-run prompt
             for unset users (gold highlight + nudge copy). Switching while favorites
             exist pops a keep / start-fresh / cancel choice via pickAffiliation. -->
        <div style="margin-bottom:16px;padding:14px;border-radius:var(--radius-sm);border:${muAffiliation ? '1px solid var(--border)' : '2px solid var(--gold)'};background:${muAffiliation ? 'var(--bg)' : 'var(--gold-soft)'};">
            <div style="font-weight:700;font-size:0.9rem;margin-bottom:8px;">${muAffiliation ? "You're viewing as" : '👋 First — who are you?'}</div>
            <div style="display:flex;gap:8px;">
                <button onclick="window.pickAffiliation('townie')" class="btn btn-sm" style="flex:1;padding:11px 8px;font-size:0.88rem;font-weight:700;${muAffiliation === 'townie' ? 'background:var(--navy);color:#fff;border:1px solid var(--navy);' : 'background:transparent;color:var(--navy);border:1px solid var(--border);'}">🌳 Local</button>
                <button onclick="window.pickAffiliation('student')" class="btn btn-sm" style="flex:1;padding:11px 8px;font-size:0.88rem;font-weight:700;${muAffiliation === 'student' ? 'background:var(--navy);color:#fff;border:1px solid var(--navy);' : 'background:transparent;color:var(--navy);border:1px solid var(--border);'}">🏴‍☠️ MU Student</button>
            </div>
            <div style="font-size:0.76rem;color:var(--text-muted);margin-top:8px;">${muAffiliation ? 'Local shows community events & deals; MU Student adds campus life.' : 'Pick one to tailor your events, sports, and local listings — change it anytime.'}</div>
        </div>
        <!-- 21+ drink-specials opt-in. A display setting: applies immediately
             (not tied to Save) and is deliberately NOT wiped by Clear Favs.
             Default OFF for every viewer — 🍺-flagged items are hidden from
             the home rail, card specials boxes, and Today lens until checked. -->
        <div style="margin-bottom:16px;padding:14px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);">
            <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;">
                <input type="checkbox" ${show21Plus ? 'checked' : ''} onchange="window.toggle21Plus(this.checked)" style="margin-top:3px;flex-shrink:0;">
                <span>
                    <span style="font-weight:700;font-size:0.9rem;">🍺 Show 21+ drink specials</span>
                    <span style="display:block;font-size:0.76rem;color:var(--text-muted);margin-top:2px;">Bar &amp; drink specials are hidden by default. Check this to include them — for visitors 21 and older.</span>
                </span>
            </label>
        </div>
        <div id="feed-options">${sectionsHtml}</div>
        <!-- Calendar subscription card. Lets the user grab a personalized iCal
             feed URL containing their current favorites. Sits between the
             favorites picker and the affiliation footer because subscribing
             is the natural next step after picking what they care about.
             The button saves prefs first via saveAndOpenCalendar() so users
             never get a calendar feed with stale prefs. -->
        <div style="margin-top:14px;padding:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);">
            <div style="font-size:0.92rem;font-weight:700;margin-bottom:4px;">📅 Add to Your Calendar</div>
            <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:10px;">Subscribe to a calendar feed of just your favorites. Auto-updates with new events.</div>
            <button onclick="window.saveAndOpenCalendar()" class="btn btn-sm btn-outline" style="width:100%;font-size:0.85rem;">🔗 Get my subscription URL</button>
        </div>
        <!-- Push notifications card. Daily 7am digest of events matching the
             user's feedPrefs. Same save-first guard as calendar — toggle handler
             persists current prefs before subscribing so the server stores
             accurate prefs from the start. Initial label/style is set from
             notificationStatus() because state varies (unsupported, denied,
             enabled, etc) and we want the toggle to reflect reality on open. -->
        <div id="notif-card" style="margin-top:10px;padding:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);">
            <div style="font-size:0.92rem;font-weight:700;margin-bottom:4px;">🔔 Daily Notifications</div>
            <div id="notif-card-desc" style="font-size:0.78rem;color:var(--text-muted);margin-bottom:10px;">Get a 7am morning summary of today's events from your favorites.</div>
            <button id="notif-card-btn" onclick="window.toggleNotifications(this)" class="btn btn-sm btn-outline" style="width:100%;font-size:0.85rem;"></button>
        </div>
        <!-- Sticky footer: Clear Favs (left, secondary) + Save (right, primary).
             Pinned so Save stays reachable without scrolling this tall modal on
             mobile. Negative margins bleed it to the modal edges. -->
        <div style="position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--border);margin:16px -28px -28px;padding:14px 28px;display:flex;gap:10px;z-index:1;">
            <button onclick="window.confirmClearFavs()" class="btn btn-sm btn-outline" style="flex:1;padding:11px 8px;font-size:0.82rem;white-space:nowrap;">Clear Favs</button>
            <button onclick="window.saveFeedFromModal();window.closeFeedModal();" class="btn btn-sm btn-ticket" style="flex:2;padding:11px 8px;font-size:0.9rem;white-space:nowrap;">💾 Save</button>
        </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    // Render the notifications button with the right initial label/state.
    // Done after appendChild so the element is in the DOM and queryable.
    if (typeof window.refreshNotifButton === 'function') window.refreshNotifButton();
};

// Save current modal selections, then open the calendar subscription dialog.
// Wrapper for the "Get my subscription URL" button — without this, clicking
// the button before hitting Save uses stale localStorage prefs and the
// resulting iCal feed is wrong. Closing the modal here is intentional too;
// the calendar dialog opens its own modal on top.
window.saveAndOpenCalendar = function() {
    if (typeof saveFeedFromModal === 'function') saveFeedFromModal();
    const settingsModal = document.querySelector('div[style*="z-index:9999"]');
    if (settingsModal) settingsModal.remove();
    window.openCalendarSubscribe();
};

// Notification card button: state-aware. Reads notificationStatus(), wires
// the right action and label. Save-first guard inside the enable branch
// ensures the user's CURRENT modal selections are persisted before we
// hand them to the server, even if they haven't hit Save yet.
window.refreshNotifButton = function() {
    const btn = document.getElementById('notif-card-btn');
    const desc = document.getElementById('notif-card-desc');
    if (!btn || !desc) return;
    const status = window.notificationStatus();
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    switch (status) {
        case 'enabled':
            btn.textContent = '🔕 Turn off notifications';
            desc.textContent = "You'll get a 7am morning summary of today's favorited events.";
            break;
        case 'disabled':
            btn.textContent = '🔔 Enable daily notifications';
            desc.textContent = "Get a 7am morning summary of today's events from your favorites.";
            break;
        case 'denied':
            btn.textContent = '🚫 Notifications blocked in browser';
            btn.disabled = true;
            btn.style.opacity = '0.6';
            btn.style.cursor = 'not-allowed';
            desc.innerHTML = "You blocked notifications. To re-enable, find Millersville.APP in your browser's site settings and allow notifications.";
            break;
        case 'ios-blocked':
            btn.textContent = '📱 Install app to enable notifications';
            desc.textContent = 'Notifications need the app installed to your home screen on iPhone/iPad.';
            break;
        case 'unsupported':
            btn.textContent = '⚠️ Not supported in this browser';
            btn.disabled = true;
            btn.style.opacity = '0.6';
            btn.style.cursor = 'not-allowed';
            desc.textContent = 'This browser doesn\'t support push notifications. Try Chrome, Firefox, or Safari.';
            break;
    }
};

// Click handler for the notification card button. Branches on the current
// status. Save-first happens here for the enable case so the user's modal
// selections (which may differ from saved feedPrefs if they haven't hit
// Save) get sent to the server with the new subscription.
window.toggleNotifications = async function(btn) {
    const status = window.notificationStatus();
    if (status === 'enabled') {
        btn.textContent = 'Turning off…';
        btn.disabled = true;
        await window.disableNotifications();
        window.refreshNotifButton();
        return;
    }
    if (status === 'disabled') {
        // Save current modal selections first — the user may have changed
        // checkboxes without hitting "Save" yet, and we want those reflected
        // in what we send to the server. saveFeedFromModal updates feedPrefs
        // in-place; enableNotifications then reads the fresh value.
        if (typeof saveFeedFromModal === 'function') saveFeedFromModal();
        btn.textContent = 'Enabling…';
        btn.disabled = true;
        const result = await window.enableNotifications();
        if (!result.ok) {
            // Restore the button and surface the failure inline.
            window.refreshNotifButton();
            const desc = document.getElementById('notif-card-desc');
            if (desc) {
                if (result.reason === 'permission-denied') {
                    desc.innerHTML = '<span style="color:var(--danger);">You denied permission. Re-enable in your browser site settings.</span>';
                } else if (result.reason === 'permission-default') {
                    desc.innerHTML = '<span style="color:var(--danger);">You closed the permission dialog. Click the button to try again.</span>';
                } else if (result.reason === 'ios-needs-install') {
                    // Already shown the install nudge modal; nothing more to say.
                } else {
                    desc.innerHTML = '<span style="color:var(--danger);">Couldn\'t enable notifications (' + (result.reason || 'unknown') + '). Try again later.</span>';
                }
            }
            return;
        }
        window.refreshNotifButton();
        return;
    }
    if (status === 'ios-blocked') {
        window.showIOSInstallNudge();
        return;
    }
    // 'denied' and 'unsupported' have disabled buttons already, shouldn't reach here.
};

// Calendar subscription modal — opened from the "Get my subscription URL"
// button inside the favorites settings modal. Builds a /events.ics URL
// containing the user's current favorites in the ?p= query string and
// shows three paths to subscribe:
//   1. webcal:// link — Apple Calendar / iOS / macOS / Outlook desktop
//      tap-to-subscribe. Strip https:// → webcal:// since calendar apps
//      treat that scheme as "subscribe to read-only calendar".
//   2. Google Calendar deep-link — pre-fills Google's "Add by URL" form.
//   3. Copy URL — universal fallback for any other client.
//
// Calendar apps re-fetch on their own schedule (typically every few hours),
// so subscribers get fresh events automatically once added.
//
// Note: the URL is stateless — favorites travel in the URL itself. If the
// user changes their favorites later, the existing subscription keeps the
// OLD favorites until they re-subscribe with a fresh URL. We surface this
// in the modal so it's not a surprise.
window.openCalendarSubscribe = function() {
    const favs = (feedPrefs && feedPrefs.length > 0) ? feedPrefs : [];

    const origin = window.location.origin;
    // Comma-joined CSV in ?p=. encodeURIComponent handles the colons in
    // "club:RUF" style prefs and any spaces in club tag names.
    const httpsUrl = favs.length > 0
        ? `${origin}/events.ics?p=${encodeURIComponent(favs.join(','))}`
        : `${origin}/events.ics`;
    // webcal:// triggers the OS-level "subscribe to calendar" handler on
    // Apple platforms and Outlook. Same URL path as https — the protocol
    // swap is what calendar apps key off of.
    const webcalUrl = httpsUrl.replace(/^https?:\/\//, 'webcal://');
    // Google Calendar's add-by-URL deep link. The cid parameter MUST use the
    // webcal:// scheme — passing https:// makes Google interpret it as a
    // one-shot import and fail with "unable to add calendar." webcal:// is
    // what triggers the actual subscription flow. (Counter-intuitively,
    // Google still fetches the feed over HTTPS internally; webcal:// is just
    // the cue to subscribe rather than import.) See Simon Willison's TIL on
    // ICS subscription URLs for the canonical reference.
    const gcalUrl = `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(webcalUrl)}`;

    // Estimate how many events will appear in the subscription. Useful so
    // users can sanity-check before adding ("0 matches" → they probably
    // need to set more favorites first). Uses the same eventMatchesFeed
    // function the rendering uses, so the count matches reality.
    let countLabel;
    if (favs.length === 0) {
        countLabel = '<strong>No favorites set</strong> — your subscription will be empty. Pick some favorites above first.';
    } else if (Array.isArray(allEvents) && allEvents.length > 0) {
        const matches = allEvents.filter(e => eventMatchesFeed(e)).length;
        countLabel = matches > 0
            ? `<strong>${matches}</strong> upcoming event${matches === 1 ? '' : 's'} match your favorites.`
            : '0 events currently match your favorites — try adding more selections.';
    } else {
        countLabel = `Subscription will include events matching your ${favs.length} favorite${favs.length === 1 ? '' : 's'}.`;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.onclick = function(ev) { if (ev.target === overlay) overlay.remove(); };

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:480px;width:100%;max-height:90vh;overflow-y:auto;padding:24px;position:relative;';
    modal.innerHTML = `
        <button onclick="this.closest('div[style*=fixed]').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-muted);">✕</button>
        <h3 style="margin:0 0 4px;">📅 Subscribe to Your Calendar</h3>
        <p style="font-size:0.82rem;color:var(--text-muted);margin:0 0 14px;">${countLabel}</p>

        <div style="display:grid;gap:10px;margin-bottom:14px;">
            <a href="${escHtml(webcalUrl)}" class="btn btn-ticket" style="text-align:center;font-size:0.9rem;text-decoration:none;padding:12px;">
                📱 Apple Calendar / iOS / Outlook
            </a>
            <a href="${escHtml(gcalUrl)}" target="_blank" rel="noopener" class="btn btn-outline" style="text-align:center;font-size:0.9rem;text-decoration:none;padding:12px;">
                🟢 Google Calendar
            </a>
        </div>

        <div style="font-size:0.78rem;font-weight:700;margin-bottom:4px;">Or copy URL for any other app:</div>
        <div style="display:flex;gap:6px;margin-bottom:14px;">
            <input id="cal-url-input" type="text" readonly value="${escHtml(httpsUrl)}" onclick="this.select()" style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:monospace;font-size:0.72rem;background:var(--bg);color:var(--text);overflow:hidden;text-overflow:ellipsis;">
            <button onclick="window.copyCalendarUrl(this)" class="btn btn-sm btn-outline" style="font-size:0.78rem;white-space:nowrap;">Copy</button>
        </div>

        <p style="font-size:0.72rem;color:var(--text-muted);margin:0;line-height:1.5;">
            <strong>Note:</strong> If you change your favorites later, you'll need to re-subscribe with a new URL.
            Calendar apps refresh in the background every few hours.
        </p>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

// Clipboard copy helper for the calendar subscription URL. Tries the
// modern Clipboard API first (HTTPS, modern browsers), falls back to
// the legacy execCommand path (older browsers, non-secure contexts).
// The button's textContent flips to "✓ Copied" briefly as feedback.
window.copyCalendarUrl = function(btn) {
    const input = document.getElementById('cal-url-input');
    if (!input) return;
    const url = input.value;
    const done = () => {
        const orig = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = orig; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(() => {
            input.select(); document.execCommand('copy'); done();
        });
    } else {
        input.select(); document.execCommand('copy'); done();
    }
};

// === Uncommon-source three-state selector (Hidden / Show / ★ Faves) ========
// Marauder-only control on source-mapped Uncommon groups (UNCOMMON_GROUP_SOURCES).
// "Show" = see events without subscribing — the middle ground between
// hidden-by-default and favoriting (which also drives push/iCal).
// Per-item since 2026-08-03: each chip carries its own 👁 Show toggle
// (pending in the chip's data-shown until Save); the group control is a bulk
// set-all over those bits. saveFeedFromModal persists per-item bits into
// shownSources / mapp_shown_sources on Save.
window.setUncommonState = function(key, state) {
    const seg = document.querySelector(`.uncommon-seg[data-uncommon-group="${key}"]`);
    if (!seg) return;
    if (state === 'fav') {
        // ★ Faves = the old master-checkbox check-all behavior.
        document.querySelectorAll(`.feed-sub[data-group="${key}"]`).forEach(cb => {
            cb.checked = true;
            const label = cb.closest('label');
            if (label) label.classList.add('is-checked');
        });
    } else {
        // Hidden and Show both clear the group's favorites (moving OFF
        // ★ Faves must uncheck chips — otherwise the derived state would
        // snap right back to fav); they differ in the per-item 👁 bits,
        // set-all here and then adjustable chip by chip.
        const on = state === 'show';
        document.querySelectorAll(`.uncommon-eye[data-group="${key}"]`).forEach(eye => {
            eye.dataset.shown = on ? '1' : '0';
            styleUncommonEye(eye);
        });
        document.querySelectorAll(`.feed-sub[data-group="${key}"]`).forEach(cb => {
            cb.checked = false;
            const label = cb.closest('label');
            if (label) label.classList.remove('is-checked');
        });
    }
    refreshUncommonSeg(key);
};
// Restyle a chip's 👁 toggle from its data-shown bit.
function styleUncommonEye(btn) {
    const on = btn.dataset.shown === '1';
    btn.style.background = on ? 'var(--navy)' : 'transparent';
    btn.style.color = on ? '#fff' : 'var(--text-muted)';
    btn.style.borderColor = on ? 'var(--navy)' : 'var(--border)';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
// Per-chip 👁 Show toggle. Lives INSIDE the chip's <label> — preventDefault
// stops the label from also toggling its checkbox. Pending until Save.
window.toggleUncommonEye = function(ev, btn) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    btn.dataset.shown = btn.dataset.shown === '1' ? '0' : '1';
    styleUncommonEye(btn);
    refreshUncommonSeg(btn.dataset.group);
};
// Re-derive a selector's active position: any checked chip = ★ Faves
// (derived, matching the SOURCE_UNLOCK_IDS unlock rule), else any lit 👁
// picks Show, else Hidden. No-ops for non-Uncommon groups.
function refreshUncommonSeg(key) {
    const seg = document.querySelector(`.uncommon-seg[data-uncommon-group="${key}"]`);
    if (!seg) return;
    const anyFav = [...document.querySelectorAll(`.feed-sub[data-group="${key}"]`)].some(cb => cb.checked);
    const anyShown = [...document.querySelectorAll(`.uncommon-eye[data-group="${key}"]`)].some(b => b.dataset.shown === '1');
    const state = anyFav ? 'fav' : (anyShown ? 'show' : 'hidden');
    seg.querySelectorAll('button').forEach(b => {
        if (b.classList.contains('uncommon-eye')) return;
        const on = b.dataset.state === state;
        b.style.background = on ? 'var(--navy)' : 'transparent';
        b.style.color = on ? '#fff' : 'var(--text-muted)';
        b.style.borderColor = on ? 'var(--navy)' : 'var(--border)';
        b.style.fontWeight = on ? '700' : '400';
    });
}

window.toggleFeedGroup = function(groupCb) {
    const group = groupCb.dataset.group;
    const checked = groupCb.checked;
    document.querySelectorAll(`.feed-sub[data-group="${group}"]`).forEach(cb => {
        cb.checked = checked;
        const label = cb.closest('label');
        if (label) label.classList.toggle('is-checked', checked);
    });
};

// Expand/collapse a feed-settings accordion. data-open is the source of truth
// for the state — we mirror it into inline display + chevron rotation on each
// toggle so CSS is simple and no animation library is needed.
window.toggleFeedAccordion = function(btn) {
    const accordion = btn.closest('.feed-accordion');
    if (!accordion) return;
    const content = accordion.querySelector('.feed-accordion-content');
    const chevron = accordion.querySelector('.feed-accordion-chevron');
    const isOpen = accordion.dataset.open === 'true';
    if (isOpen) {
        content.style.display = 'none';
        if (chevron) chevron.style.transform = '';
        accordion.dataset.open = 'false';
    } else {
        content.style.display = '';
        if (chevron) chevron.style.transform = 'rotate(90deg)';
        accordion.dataset.open = 'true';
    }
};

window.toggleClubBrowser = function() {
    const list = document.getElementById('clubs-individual-list');
    if (!list) return;
    const isHidden = list.style.display === 'none';
    if (!isHidden) { list.style.display = 'none'; return; }

    // Prefer the full directory from clubs.json; fall back to events-derived list if unavailable
    const directory = (allClubsDirectory && allClubsDirectory.length > 0)
        ? allClubsDirectory
        : (window._individualClubs || []).map(n => ({ name: n, category: '', categories: [] }));

    // Render search input + major dropdown + scrollable list. The major
    // dropdown is populated once the mapping JSON loads (lazy fetch); the
    // search input is always available even if the mapping fails.
    list.style.display = 'block';
    list.style.flexWrap = 'initial';
    list.style.maxHeight = '380px';
    list.innerHTML = `
        <div id="major-filter-row" style="margin-bottom:8px;display:none;">
            <select id="major-filter-select" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.85rem;background:var(--surface);box-sizing:border-box;cursor:pointer;">
                <option value="">— Show all majors —</option>
            </select>
        </div>
        <input id="club-search-input" type="text" placeholder="Search ${directory.length} MU organizations..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.85rem;margin-bottom:8px;box-sizing:border-box;">
        <div id="club-search-results" style="display:flex;flex-wrap:wrap;gap:4px;max-height:260px;overflow-y:auto;"></div>`;

    const input = document.getElementById('club-search-input');
    const results = document.getElementById('club-search-results');
    const majorRow = document.getElementById('major-filter-row');
    const majorSelect = document.getElementById('major-filter-select');

    // Currently selected major spec (object from mapping JSON), or null for "all".
    let selectedMajor = null;

    function renderList(query) {
        const q = (query || '').trim().toLowerCase();
        const current = feedPrefs || [];
        // Filter pipeline: major filter narrows first (if active), then text
        // search refines. This is the most user-intuitive ordering — picking
        // a major sets a context, typing within it narrows further.
        let orgs = directory;
        if (selectedMajor) {
            orgs = orgs.filter(o => clubMatchesMajor(o, selectedMajor));
        }
        if (q) {
            orgs = orgs.filter(o => o.name.toLowerCase().includes(q) || (o.category || '').toLowerCase().includes(q));
        }
        if (!q && !selectedMajor) {
            // Default sort: favorited first, then alphabetical. Top 60 only.
            orgs = orgs.slice().sort((a, b) => {
                const af = current.includes('club:' + a.name) ? 0 : 1;
                const bf = current.includes('club:' + b.name) ? 0 : 1;
                if (af !== bf) return af - bf;
                return a.name.localeCompare(b.name);
            });
            if (orgs.length > 60) orgs = orgs.slice(0, 60);
        } else if (selectedMajor) {
            // When filtering by major, sort favorited first then alphabetical.
            // No 60-cap since major filtering naturally narrows the list.
            orgs = orgs.slice().sort((a, b) => {
                const af = current.includes('club:' + a.name) ? 0 : 1;
                const bf = current.includes('club:' + b.name) ? 0 : 1;
                if (af !== bf) return af - bf;
                return a.name.localeCompare(b.name);
            });
        }
        const totalInDir = directory.length;
        // Status row at top of results — communicates filter state to user.
        let showingInfo = '';
        if (selectedMajor && q) {
            showingInfo = `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">${orgs.length} clubs for ${selectedMajor.displayName || selectedMajor.name} matching "${q}"</div>`;
        } else if (selectedMajor) {
            showingInfo = `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">${orgs.length} clubs related to ${selectedMajor.displayName || selectedMajor.name}</div>`;
        } else if (q) {
            showingInfo = `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">${orgs.length} of ${totalInDir} match "${q}"</div>`;
        } else if (totalInDir > 60) {
            showingInfo = `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">Showing 60 of ${totalInDir} — type to search or pick your major above</div>`;
        }
        if (orgs.length === 0) {
            // Different empty-state message depending on what filters are active.
            const reason = selectedMajor
                ? `No clubs in our directory matched "${selectedMajor.displayName || selectedMajor.name}". <a href="#" onclick="event.preventDefault();document.getElementById('major-filter-select').value='';document.getElementById('major-filter-select').dispatchEvent(new Event('change'));" style="color:var(--navy);">Show all clubs</a>`
                : 'No organizations match.';
            results.innerHTML = showingInfo + `<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:0.85rem;">${reason}</div>`;
            return;
        }
        results.innerHTML = showingInfo + orgs.map(o => {
            const val = 'club:' + o.name;
            const checked = current.includes(val);
            const escapedName = o.name.replace(/"/g, '&quot;');
            return `<label class="feed-chip-tiny feed-chip-club${checked?' is-checked':''}"><input type="checkbox" class="feed-club" value="${val}" ${checked?'checked':''} onchange="this.closest('label').classList.toggle('is-checked', this.checked)"> ${escapedName}</label>`;
        }).join('');
    }

    input.addEventListener('input', () => renderList(input.value));
    majorSelect.addEventListener('change', () => {
        const idx = majorSelect.value;
        selectedMajor = (idx === '' || !majorClubsMapping) ? null : majorClubsMapping.majors[parseInt(idx)];
        renderList(input.value);
    });

    // Populate the major dropdown asynchronously. If load fails or returns
    // empty, the row stays hidden and the rest of the UI works unaffected.
    loadMajorClubsMapping().then(mapping => {
        if (!mapping || !mapping.majors || mapping.majors.length === 0) return;
        // Append major options. Use index as value so we can reference the
        // full spec object (with keywords + categories) on selection.
        const opts = mapping.majors.map((m, i) =>
            `<option value="${i}">${m.displayName || m.name}</option>`
        ).join('');
        majorSelect.insertAdjacentHTML('beforeend', opts);
        majorRow.style.display = 'block';

        // Diagnostic: log any mapping that produces 0 matches against the
        // current directory. Helps us spot dead/misaligned mappings without
        // needing a separate eval pass. Logs once per session.
        if (!window._majorMappingDiagnosticLogged) {
            window._majorMappingDiagnosticLogged = true;
            const empties = mapping.majors
                .filter(m => directory.filter(c => clubMatchesMajor(c, m)).length === 0)
                .map(m => m.displayName || m.name);
            if (empties.length > 0) {
                console.log(`[major-mapping] ${empties.length} of ${mapping.majors.length} majors produced 0 matches against ${directory.length}-club directory:`, empties);
            } else {
                console.log(`[major-mapping] all ${mapping.majors.length} majors produced ≥1 match against ${directory.length}-club directory.`);
            }
        }
    });

    renderList('');
};

window.updateFeedGroup = function(group) {
    const subs = document.querySelectorAll(`.feed-sub[data-group="${group}"]`);
    const groupCb = document.querySelector(`.feed-group[data-group="${group}"]`);
    if (groupCb) groupCb.checked = [...subs].every(s => s.checked);
    subs.forEach(cb => {
        const label = cb.closest('label');
        if (label) label.classList.toggle('is-checked', cb.checked);
    });
    // Uncommon groups render a three-state selector instead of a master
    // checkbox — re-derive its position (a checked chip = ★ Faves).
    if (typeof refreshUncommonSeg === 'function') refreshUncommonSeg(group);
};

// Subgroup toggle handlers. Subgroups are collapsible nested sections inside
// heading-style groups (Club Sports, Greek Life under MU GetInvolved). Each
// has: a master checkbox (toggles all children), a row that expands/collapses
// to reveal child chips, and a parent-state ripple back up to the group's
// master.

// Click on the subgroup row (anywhere except the master checkbox) toggles
// the chips panel. Stop propagation on the master so checking it doesn't also
// collapse/expand the panel.
window.toggleSubgroupCollapse = function(evt, sgKey) {
    // If the click originated on the master checkbox, ignore (its onclick
    // already stopped propagation). Belt and suspenders.
    if (evt && evt.target && evt.target.classList && evt.target.classList.contains('feed-subgroup-master')) return;
    const sg = document.querySelector(`.feed-subgroup[data-subgroup-key="${sgKey}"]`);
    if (!sg) return;
    const panel = sg.querySelector('.feed-subgroup-children');
    const chevron = sg.querySelector('.feed-subgroup-chevron');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'flex';
    if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
};

// Master checkbox toggled — set ALL children to match. Also flip the row
// background (gold-soft when any state is "on", default otherwise) and
// re-sync the parent group's master state via updateFeedGroup.
window.toggleFeedSubgroup = function(masterCb) {
    const sgKey = masterCb.dataset.subgroup;
    const groupKey = masterCb.dataset.group;
    const checked = masterCb.checked;
    const sg = document.querySelector(`.feed-subgroup[data-subgroup-key="${sgKey}"]`);
    if (!sg) return;
    sg.querySelectorAll(`.feed-sub[data-subgroup="${sgKey}"]:not(.feed-subgroup-master)`).forEach(cb => {
        cb.checked = checked;
        const label = cb.closest('label');
        if (label) label.classList.toggle('is-checked', checked);
    });
    const header = sg.querySelector('.feed-subgroup-header');
    if (header) header.classList.toggle('is-active', checked);
    if (groupKey && typeof updateFeedGroup === 'function') updateFeedGroup(groupKey);
};

// Individual child toggled — re-sync the subgroup master (checked when every
// child is checked, unchecked otherwise) and the parent group's master.
window.updateFeedSubgroup = function(sgKey) {
    const sg = document.querySelector(`.feed-subgroup[data-subgroup-key="${sgKey}"]`);
    if (!sg) return;
    const children = [...sg.querySelectorAll(`.feed-sub[data-subgroup="${sgKey}"]:not(.feed-subgroup-master)`)];
    const master = sg.querySelector('.feed-subgroup-master');
    const allChecked = children.length > 0 && children.every(c => c.checked);
    const anyChecked = children.some(c => c.checked);
    if (master) master.checked = allChecked;
    // Update each child's own check state class — updateFeedGroup won't reach them
    children.forEach(c => {
        const label = c.closest('label');
        if (label) label.classList.toggle('is-checked', c.checked);
    });
    const header = sg.querySelector('.feed-subgroup-header');
    if (header) header.classList.toggle('is-active', allChecked || anyChecked);
    // Cascade up to parent group master via the data-group attribute
    const groupKey = master && master.dataset.group;
    if (groupKey && typeof updateFeedGroup === 'function') updateFeedGroup(groupKey);
};

window.saveFeedFromModal = function() {
    // Persist the Uncommon "Show events" selections first (their own key, not
    // part of feedPrefs — survives Clear Favs). Per-item since 2026-08-03:
    // each chip's 👁 bit writes its own shownSources key — the mapped source
    // key for 1:1 chips, the pref id itself for finer-than-source chips (PM
    // sports, PM events). Runs before the empty-prefs early return below so
    // Show survives a fav wipe. Townie modals render no 👁s and leave
    // shownSources untouched (same as before).
    document.querySelectorAll('.uncommon-eye').forEach(eye => {
        const k = shownKeyForItem(eye.dataset.prefId);
        if (eye.dataset.shown === '1') shownSources.add(k); else shownSources.delete(k);
    });
    // Legacy whole-source Show keys migrate to per-item bits: render seeded
    // them into every chip's 👁 (uncommonItemShown), so once a group's 👁s
    // were present in this modal the group key itself is dropped.
    if (document.querySelector('.uncommon-eye[data-group="pm"]')) shownSources.delete('SP_PM');
    if (document.querySelector('.uncommon-eye[data-group="pmev"]')) shownSources.delete('PM');
    saveShownSources();
    // Composite subs (data-linked-ids) expand to multiple pref IDs; standard
    // subs use their single .value. De-duplicate via a Set since composites
    // could overlap with each other's linked IDs in theory.
    const seen = new Set();
    const selected = [];
    [...document.querySelectorAll('.feed-sub:checked')].forEach(cb => {
        if (cb.dataset.linkedIds) {
            cb.dataset.linkedIds.split(',').forEach(id => {
                const trimmed = id.trim();
                if (trimmed && !seen.has(trimmed)) {
                    seen.add(trimmed);
                    selected.push(trimmed);
                }
            });
        } else if (cb.value) {
            if (!seen.has(cb.value)) {
                seen.add(cb.value);
                selected.push(cb.value);
            }
        }
    });
    // Also capture individual club selections
    const clubSelections = [...document.querySelectorAll('.feed-club:checked')].map(cb => cb.value);
    const allPrefs = [...selected, ...clubSelections];
    if (allPrefs.length === 0) { clearFeedPrefs(); return; }
    saveFeedPrefs(allPrefs);
    renderHomeFeed();
    renderEvents(); renderSports(); renderNewsUI();
    // Pill visibility can change on save (Show/favorite reveals a source's
    // pill; clearing hides it) — the render fns don't touch pill display.
    updateEventsUI(); updateSportsUI();
};

// Visual feedback when a composite sub (linkedIds checkbox) is toggled.
// Reflects the same gold-border/soft-background pattern used by other
// favorited UI elements so the state is unmistakable.
window.updateCompositeSub = function(cb) {
    const label = cb.closest('label');
    if (!label) return;
    label.classList.toggle('is-checked', cb.checked);
    // If this composite belongs to a heading-style group (data-group present),
    // re-sync the master checkbox state — checked when every sibling sub
    // (chips + composites) is checked.
    if (cb.dataset.group) {
        const groupKey = cb.dataset.group;
        const siblingSubs = document.querySelectorAll(`.feed-sub[data-group="${groupKey}"]`);
        const masterCb = document.querySelector(`.feed-group[data-group="${groupKey}"]`);
        if (masterCb && siblingSubs.length > 0) {
            masterCb.checked = [...siblingSubs].every(s => s.checked);
        }
    }
};

window.clearFeedPrefs = function() {
    localStorage.removeItem(FEED_KEY);
    feedPrefs = null;
    setFeedDotVisible(false);
    if (typeof window.resendNotificationPrefs === 'function') window.resendNotificationPrefs().catch(() => {});
    renderHomeFeed();
    renderEvents(); renderSports(); renderNewsUI();
    // Unfavoriting can hide source pills — refresh them (latent staleness
    // fixed alongside the 2026-07-27 Show-events work). shownSources is
    // deliberately untouched: Show opt-ins survive Clear Favs.
    updateEventsUI(); updateSportsUI();
};

// Clear just the favorites list but keep the Marauder/Townie affiliation
window.clearFavoritesOnly = function() {
    localStorage.removeItem(FEED_KEY);
    feedPrefs = null;
    setFeedDotVisible(false);
    if (typeof window.resendNotificationPrefs === 'function') window.resendNotificationPrefs().catch(() => {});
    renderHomeFeed();
    renderEvents(); renderSports(); renderNewsUI();
};

// Reset everything: favorites AND affiliation. Next page load will re-prompt.
window.resetEverything = function() {
    localStorage.removeItem(FEED_KEY);
    localStorage.removeItem(AFFILIATION_KEY);
    localStorage.removeItem('welcomeDismissed'); // let the welcome banner show again
    feedPrefs = null;
    muAffiliation = null;
    setFeedDotVisible(false);
    renderHomeFeed();
    renderEvents(); renderSports(); renderNewsUI();
    applyAdvertiseGate(); // affiliation back to unset — nav-advertise reappears
};

function renderHomeFeed() {
    const hasFeed = feedPrefs && feedPrefs.length > 0;
    const feedCta = document.getElementById('home-feed-cta');
    if (feedCta) feedCta.style.display = hasFeed ? 'none' : 'block';
    // Welcome banner shows once on first visit. Dismisses permanently when:
    //   - User clicks "Set Up Favorites" (opens the feed modal; they've engaged)
    //   - User clicks "Skip for now" (explicit dismiss; stays Marauder-default)
    //   - User clicks "I'm a townie" (sets affiliation + offers favorites setup)
    //   - User has already set up favorites (hasFeed)
    const wb = document.getElementById('welcome-banner');
    if (wb) {
        const dismissed = localStorage.getItem('welcomeDismissed');
        wb.style.display = (!hasFeed && !dismissed) ? 'block' : 'none';
    }
    renderHomeUI();
}
// Day navigator on the home page. Selected day persists only for the current
// view session — refresh always lands on today.
// Tracks whether a slide animation is in progress so we can skip animating
// when the user fires off rapid-fire arrow presses or swipes — without this
// guard, multiple in-flight animations stack and produce visible jitter.
let homeSlideAnimating = false;

window.shiftHomeDay = function(direction) {
    if (!homeViewDate) homeViewDate = todayMidnight();
    const d = new Date(homeViewDate);
    d.setDate(d.getDate() + direction);
    // Bound the navigator: 30 days back (older events have rolled off the
    // scrape window), 60 days forward (matches scrape horizon). Beyond those,
    // every day would be empty and that's just confusing UX.
    const today = todayMidnight();
    const minDate = new Date(today); minDate.setDate(minDate.getDate() - 30);
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + 60);
    if (d < minDate || d > maxDate) return;

    const timeline = document.getElementById('home-timeline');
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Skip animation if (a) user prefers reduced motion, (b) we're already
    // animating (rapid-fire arrow press), or (c) timeline element is missing.
    // In any of those cases, fall back to instant re-render.
    if (reduceMotion || homeSlideAnimating || !timeline) {
        homeViewDate = d;
        renderHomeUI();
        return;
    }

    // Capture outgoing HTML, then advance state and produce incoming HTML.
    // We render the new HTML by temporarily setting homeViewDate, calling
    // renderHomeUI which writes to the live timeline element, capturing the
    // result, then orchestrating the slide. This means there's a brief moment
    // where the live timeline holds the NEW content before we wrap it — but
    // the wrapper happens synchronously in the same JS frame, so the user
    // doesn't see that intermediate state.
    const outgoingHTML = timeline.innerHTML;
    const outgoingHeight = timeline.offsetHeight;

    homeViewDate = d;
    renderHomeUI();
    const incomingHTML = timeline.innerHTML;

    runHomeSlide(timeline, outgoingHTML, incomingHTML, outgoingHeight, direction);
};

function runHomeSlide(timeline, outgoingHTML, incomingHTML, outgoingHeight, direction) {
    homeSlideAnimating = true;
    // Build a slide track: a flex row containing two panels side by side.
    // The track is wider than the timeline (each panel = 100% of timeline
    // width), and we translate it to reveal the incoming panel.
    // direction > 0 (forward): incoming on the right, slide left to reveal
    // direction < 0 (backward): incoming on the left, slide right to reveal
    const forward = direction > 0;
    const trackInitialOffset = forward ? '0' : '-50%';
    const trackFinalOffset = forward ? '-50%' : '0';
    const leftPanelHTML = forward ? outgoingHTML : incomingHTML;
    const rightPanelHTML = forward ? incomingHTML : outgoingHTML;

    timeline.innerHTML = `
        <div class="home-slide-track" style="transform: translateX(${trackInitialOffset});">
            <div class="home-slide-panel">${leftPanelHTML}</div>
            <div class="home-slide-panel">${rightPanelHTML}</div>
        </div>
    `;
    // Lock height during animation so the page doesn't jump if outgoing
    // and incoming panels have very different content heights.
    timeline.style.minHeight = outgoingHeight + 'px';
    timeline.style.overflow = 'hidden';

    // Force a reflow so the browser commits the initial transform before
    // we apply the transition + final transform. Without this, the browser
    // can collapse both transforms into a single instant jump.
    const track = timeline.querySelector('.home-slide-track');
    void track.offsetWidth;
    track.style.transition = 'transform 250ms ease-out';
    track.style.transform = `translateX(${trackFinalOffset})`;

    // After the slide finishes, settle on just the incoming content.
    // Using transitionend is more accurate than a setTimeout but we add
    // a fallback timeout in case the transitionend event doesn't fire
    // (page hidden during animation, etc.).
    let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        timeline.style.minHeight = '';
        timeline.style.overflow = '';
        timeline.innerHTML = incomingHTML;
        homeSlideAnimating = false;
    };
    track.addEventListener('transitionend', settle, { once: true });
    setTimeout(settle, 350);
}

window.resetHomeDay = function() {
    homeViewDate = todayMidnight();
    renderHomeUI();
};

// Swipe navigation for the home timeline. Listens on the timeline container
// only — not the whole page — so vertical scroll inside other sections isn't
// affected. Threshold logic is conservative on purpose:
//   - X-delta must be >60px (a real swipe, not a tap-jitter)
//   - X-delta must exceed Y-delta by 1.5× (ensures HORIZONTAL intent)
//   - Total gesture must complete in <600ms (filters slow drags)
// These together mean an accidental vertical-scroll-with-tilt won't trigger
// day nav, but a deliberate sideways flick will.
let swipeStartX = 0, swipeStartY = 0, swipeStartTime = 0;
// Mouse drag-to-scroll for the Directory category strip (touch scrolls
// natively via overflow-x). Tracks drag distance and suppresses the click on
// a pill if the user was actually dragging, so a drag doesn't fire a filter.
function attachCatStripDrag() {
    const row = document.getElementById('places-strip-group');
    if (!row || row._dragAttached) return;
    row._dragAttached = true;
    let isDown = false, startX = 0, startScroll = 0, moved = 0;
    row.addEventListener('mousedown', (e) => {
        isDown = true; moved = 0;
        startX = e.pageX; startScroll = row.scrollLeft;
        row.classList.add('dragging');
    });
    window.addEventListener('mouseup', () => {
        if (!isDown) return;
        isDown = false;
        row.classList.remove('dragging');
    });
    row.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        const dx = e.pageX - startX;
        moved += Math.abs(dx);
        row.scrollLeft = startScroll - dx;
    });
    // If the pointer moved more than a few px, treat it as a drag and cancel
    // the click so we don't accidentally select a category.
    row.addEventListener('click', (e) => {
        if (moved > 6) { e.preventDefault(); e.stopPropagation(); }
    }, true);
}

function attachHomeSwipeHandlers() {
    const timeline = document.getElementById('home-timeline');
    if (!timeline || timeline._swipeAttached) return;
    timeline._swipeAttached = true;
    timeline.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
        swipeStartTime = Date.now();
    }, { passive: true });
    timeline.addEventListener('touchend', (e) => {
        if (!swipeStartTime) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - swipeStartX;
        const dy = t.clientY - swipeStartY;
        const duration = Date.now() - swipeStartTime;
        swipeStartTime = 0;
        if (duration > 600) return;
        if (Math.abs(dx) < 60) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
        // Left swipe (dx < 0) advances forward → next day
        // Right swipe (dx > 0) goes back → previous day
        if (dx < 0) shiftHomeDay(1);
        else shiftHomeDay(-1);
    }, { passive: true });
}
window.dismissWelcome = function() {
    localStorage.setItem('welcomeDismissed', '1');
    const wb = document.getElementById('welcome-banner');
    if (wb) wb.style.display = 'none';
};
// Identity pick — student. Mirror of welcomeIdentifyAsTownie below: set the
// viewer's affiliation, dismiss the banner, then open the favorites modal so they
// can refine their feed. (Replaces the old "Set Up Favorites" CTA, which left the
// viewer unset/Marauder — the welcome now asks affiliation up front.)
window.welcomeIdentifyAsStudent = function() {
    pickAffiliation('student');
    localStorage.setItem('welcomeDismissed', '1');
    const wb = document.getElementById('welcome-banner');
    if (wb) wb.style.display = 'none';
    openFeedSettings();
};
// Secondary opt-out: user says they're a townie. Set affiliation, dismiss the banner,
// then open the feed modal (already in townie mode) so they can set up their favorites.
window.welcomeIdentifyAsTownie = function() {
    pickAffiliation('townie');
    localStorage.setItem('welcomeDismissed', '1');
    const wb = document.getElementById('welcome-banner');
    if (wb) wb.style.display = 'none';
    openFeedSettings();
};
window.pickAffiliation = function(value) {
    if (value !== 'student' && value !== 'townie') return;
    if (value === muAffiliation) return; // tapping the current mode is a no-op
    // Unset, or switching with no favorites to lose → just apply it.
    if (!muAffiliation || !feedPrefs || feedPrefs.length === 0) { applyAffiliation(value, false); return; }
    // Switching an established identity that HAS favorites → offer a real choice:
    // keep them, start fresh, or cancel the switch entirely.
    const label = value === 'student' ? '🏴‍☠️ MU Student' : '🌳 Local';
    window.mappDialog({
        title: `Switch to ${label}?`,
        message: `Your saved favorites were picked for your current view. Keep them, or start fresh with ${label} defaults?`,
        buttons: [
            { label: 'Keep my favorites', cls: 'btn-ticket', onClick: () => applyAffiliation(value, false) },
            { label: 'Start fresh', cls: 'btn-outline', onClick: () => applyAffiliation(value, true) },
            { label: 'Cancel', cls: 'btn-outline', style: 'color:var(--text-muted);', onClick: () => {} }
        ]
    });
};

// Apply an affiliation change (optionally wiping favorites), prune now-invalid
// state, re-render, and — if the settings modal is open — reopen it so the mode
// band and pickers reflect the new identity. Used by the first-run prompt and
// in-app switches alike.
function applyAffiliation(value, clearFavs) {
    muAffiliation = value;
    localStorage.setItem(AFFILIATION_KEY, value);
    if (clearFavs) {
        localStorage.removeItem(FEED_KEY);
        feedPrefs = null;
        setFeedDotVisible(false);
        // Keep the 7am digest / calendar feed in sync with the now-empty favorites.
        if (typeof window.resendNotificationPrefs === 'function') window.resendNotificationPrefs().catch(() => {});
    }
    pruneStaleStateForAffiliation();
    renderHomeFeed();
    if (typeof loadHomeSpecials === 'function') loadHomeSpecials(); // home specials rail is a separate render (reads muAffiliation at build time) — renderHomeFeed does NOT rebuild it
    if (typeof renderEvents === 'function') renderEvents();
    if (typeof renderSports === 'function') renderSports();
    if (typeof renderNewsUI === 'function') renderNewsUI();
    if (typeof renderPlaces === 'function') renderPlaces();
    if (typeof renderFoodPage === 'function') renderFoodPage(); // Food page reads muAffiliation + audience gates at build time
    if (typeof pruneEmptyPlaceCategories === 'function') pruneEmptyPlaceCategories(); // audience-aware menu prune — re-run on affiliation change
    applyAdvertiseGate(); // Advertise nav/page is Marauder-hidden — new-surface rule
    if (document.getElementById('feed-settings-overlay')) {
        window.closeFeedModal();
        if (typeof window.openFeedSettings === 'function') window.openFeedSettings();
    }
}

// 21+ drink-specials opt-in. A display setting, not a favorite — persists on
// its own key (survives Clear Favs), applies immediately (no Save needed),
// and re-renders the specials surfaces: home rail (loadHomeSpecials — NOT
// renderHomeFeed, which is the timeline), directory cards / Today lens /
// pins (renderPlaces), and the home timeline (renderHomeFeed).
window.toggle21Plus = function(on) {
    show21Plus = !!on;
    try { localStorage.setItem(SHOW21_KEY, show21Plus ? '1' : '0'); } catch (e) {}
    if (typeof renderHomeFeed === 'function') renderHomeFeed();
    if (typeof loadHomeSpecials === 'function') loadHomeSpecials(); // rail cards gate 🍺 items via placesSpecialsItemsFor — rebuild so the toggle shows without reload
    if (typeof renderPlaces === 'function') renderPlaces();
    if (typeof renderFoodPage === 'function') renderFoodPage(); // food-card specials boxes gate 🍺 items too
    applyAdvertiseGate(); // no-op for 21+ — called per the new-surface rule
};

// Called after affiliation changes. Cleans up state that may be invalid under the new
// affiliation. Specifically:
//   - evTags: drop any sub-filter tag not present in the new affiliation's evSubMap
//     (e.g. a Marauder with "Greek Life" selected becomes a Townie → "Greek Life" no
//     longer appears as a sub-chip, but the tag would silently keep filtering the list).
//   - feedPrefs: drop any pref tied to a sub-chip that the new affiliation can't see
//     in the modal (e.g. clubs-greek when switching to Townie). Protects against the
//     user not being able to uncheck favorites they no longer see.
//   - evKidMode / perk toggles: cleared here too, since the buttons themselves are
//     shown/hidden per affiliation and an invisible active filter is confusing.
function pruneStaleStateForAffiliation() {
    // Rebuild valid sub-tag set from the current affiliation's evSubMap
    if (typeof getEvSubMap === 'function' && typeof evTags !== 'undefined') {
        const validSubTags = new Set();
        const subMap = getEvSubMap();
        for (const subs of Object.values(subMap || {})) {
            for (const sub of subs) {
                const tag = typeof sub === 'string' ? sub : sub.tag;
                validSubTags.add(tag);
            }
        }
        // Prune any active tag that doesn't exist under the new affiliation
        for (const tag of Array.from(evTags)) {
            if (!validSubTags.has(tag)) evTags.delete(tag);
        }
    }
    // Prune feedPrefs: drop IDs tied to subs the user can't see anymore
    if (feedPrefs && feedPrefs.length > 0 && typeof feedSections !== 'undefined') {
        const effectiveAff = muAffiliation === 'townie' ? 'townie' : 'student';
        const visibleIds = new Set();
        for (const section of Object.values(feedSections)) {
            for (const group of Object.values(section.groups)) {
                for (const sub of group.subs) {
                    // A sub is visible if it has no audience OR its audience matches effective
                    if (!sub.audience || sub.audience === 'both' || sub.audience === effectiveAff) {
                        visibleIds.add(sub.id);
                    }
                }
            }
        }
        // Keep `club:*` favorites (individual clubs are always visible in the browser)
        const pruned = feedPrefs.filter(p => {
            if (typeof p !== 'string') return false;
            if (p.startsWith('club:')) return true;
            return visibleIds.has(p);
        });
        if (pruned.length !== feedPrefs.length) {
            feedPrefs = pruned;
            if (feedPrefs.length === 0) {
                localStorage.removeItem(FEED_KEY);
                feedPrefs = null;
            } else {
                localStorage.setItem(FEED_KEY, JSON.stringify(feedPrefs));
            }
        }
    }
    // Clear toolbar mode state that no longer applies. updateEventsUI/updateSportsUI
    // will be called by the renderEvents/renderSports that follow pickAffiliation.
    evKidMode = false;
    evFreeFoodMode = false;
    evFreeStuffMode = false;
    // Marauder Gold is a student-only directory filter — drop it on any change
    // (renderPlaces re-syncs the button visibility for the new affiliation).
    placesMGMode = false;
}
// ==================== END MY FEED ====================

// View mode state for Events page
// Infinite-scroll state: how many days of future events are currently rendered.
// Each "Load more" click adds LOAD_MORE_INCREMENT days for future, or
// LOAD_MORE_INCREMENT_PAST days for past. Past uses a smaller step because users
// typically want "last week's games" not "last 2 months" — 60-day jumps there are
// an awkward amount.
const INITIAL_DAYS = 60;
const INITIAL_DAYS_PAST = 14;
const LOAD_MORE_INCREMENT = 60;
const LOAD_MORE_INCREMENT_PAST = 14;
let evDaysVisible = INITIAL_DAYS;
// Favorites-only filter mode — when on, only favorited events show (still day-grouped).
// Replaces the old "pin at top" behavior since pinning all future favorites under the
// Today header was confusing when the first pinned card was weeks away.
let evFavOnlyMode = false;
let spFavOnlyMode = false;
// Events page retains mode/anchor only for back-compat with older functions that
// reference them; actively ignored by the new render pipeline.
let evMode='upcoming', evAnchorDate=new Date();

// Sports page state
let spActiveSources=new Set(['PM','MU','Clubs']), spSportTag=null, spHomeOnly=false;
// Sports view state: 'upcoming' (infinite-scroll forward) or 'past' (infinite-scroll backward)
let spTimeView = 'upcoming';
let spDaysVisible = INITIAL_DAYS;
let spPastDaysVisible = INITIAL_DAYS_PAST;
let spMode='week', spAnchorDate=new Date();

const sportsList=['Baseball','Softball','Track','Soccer','Lacrosse','Tennis','Volleyball','Wrestling','Basketball','Football','Field Hockey','Golf','Cross Country','Cheerleading','Swimming','Rugby','Fencing','Esports','Archery','Unified Track & Field','Unified Bocce'];
const topSources=['MU','PM','Borough','Manor','Other'];
const sportMetaTags=['Athletic Competitions','Athletics','Club Sports','Home Game Mode','H Games'];

// Sub-filter chips vary by affiliation:
//   - Marauders see MU-internal vocabulary (GetInvolved, Residence Halls, Greek Life)
//   - Townies see community-friendly vocabulary (Community). Residence Halls and Greek Life
//     are omitted because they're MU-internal living arrangements townies don't filter by.
// Each sub-chip entry is either a string (label = tagName = filter-tag) or
// { label, tag } when the display label differs from the underlying tag to match on.
function getEvSubMap() {
    // Default (unset) → show Marauder sub-filters. Townies explicitly opt in via the
    // affiliation picker, at which point they see the community-friendly vocabulary.
    const isTownie = muAffiliation === 'townie';
    return {
        'MU': isTownie
            ? [
                'Public Event',
                'Arts Concert / Performance',
                { label: 'Community', tag: 'Clubs/Orgs' },  // townie-friendly label for student-org public events
                'Fundraising'
            ]
            : ['Public Event', 'Arts Concert / Performance', 'GetInvolved', 'Residence Halls', 'Greek Life', 'Fundraising'],
        'PM': ['Music/Arts', 'School Events', 'Board/PTO', 'Health/Wellness', 'Field Trips', 'Meetings']
    };
}
// Keep evSubMap as a getter for any legacy readers that expect an object shape
const evSubMap = new Proxy({}, { get: (_, key) => getEvSubMap()[key] });

// Date helpers
function toDateStr(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;}
function localDateStr(iso){return toDateStr(new Date(iso));}
function todayMidnight(){const d=new Date();return new Date(d.getFullYear(),d.getMonth(),d.getDate());}
function getMonday(d){const day=d.getDay(),diff=d.getDate()-day+(day===0?-6:1);return new Date(d.getFullYear(),d.getMonth(),diff);}
function addDays(d,n){const r=new Date(d);r.setDate(r.getDate()+n);return r;}
function fmtDateLabel(d){const t=todayMidnight();if(toDateStr(d)===toDateStr(t))return 'Today, '+d.toLocaleDateString('en-US',{month:'short',day:'numeric'});return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});}
function fmtWeekLabel(start){const end=addDays(start,6);return start.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' – '+end.toLocaleDateString('en-US',{month:'short',day:'numeric'});}

function getDateRange(mode,anchor){
    const today=todayMidnight();
    if(mode==='upcoming') return {start:toDateStr(today),end:'9999-12-31'};
    if(mode==='past') return {start:'0000-01-01',end:toDateStr(addDays(today,-1))};
    if(mode==='day') return {start:toDateStr(anchor),end:toDateStr(anchor)};
    if(mode==='week'){return {start:toDateStr(anchor),end:toDateStr(addDays(anchor,6))};}
    return {start:'0000-01-01',end:'9999-12-31'};
}

function getVisibleDateRange(events){
    if(events.length===0) return null;
    const first=localDateStr(events[0].date);
    const last=localDateStr(events[events.length-1].date);
    const fd=new Date(first+'T12:00:00'), ld=new Date(last+'T12:00:00');
    return fd.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' – '+ld.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}

function updateModeUI(prefix,mode,anchor,filteredEvents){
    ['past','day','week'].forEach(m=>{
        const btn=document.getElementById(prefix+'-mode-'+m);
        if(btn) btn.classList.toggle('active',m===mode);
    });
    const prevBtn=document.getElementById(prefix+'-prev');
    const nextBtn=document.getElementById(prefix+'-next');
    const label=document.getElementById(prefix+'-date-label');
    const showArrows=(mode==='day'||mode==='week');
    if(prevBtn) prevBtn.style.display=showArrows?'flex':'none';
    if(nextBtn) nextBtn.style.display=showArrows?'flex':'none';
    if(label){
        if(mode==='day') label.textContent=fmtDateLabel(anchor);
        else if(mode==='week') label.textContent=fmtWeekLabel(anchor);
        else if((mode==='upcoming'||mode==='past')&&filteredEvents&&filteredEvents.length>0) label.textContent=getVisibleDateRange(filteredEvents);
        else label.textContent='';
    }
}

function isSportEvent(e){
    const t=e.tags||[];
    // Athletic Camps are kids events (not competitive games) — keep on Events page
    if(t.includes('Athletic Camp')) return false;
    return t.includes('Athletic Competitions')||t.includes('Athletics')||t.includes('Club Sports')||sportsList.some(s=>t.includes(s))||(t.includes('PM')&&t.includes('Athletics'));
}
function isPMSportByTitle(e){
    const t=e.tags||[];
    if(!t.includes('PM')) return false;
    const title=(e.title||'').toLowerCase();
    return title.includes('sport:')||sportsList.some(s=>title.includes(s.toLowerCase()))||(/\b(varsity|jv|j\.v\.)\b/i.test(title));
}
function matchesSource(tags,src){
    if(src==='All') return true;
    // MU now includes GetInvolved (MU Clubs) since those events are tagged MU + GetInvolved + Clubs/Orgs
    if(src==='MU') return tags.includes('MU');
    if(src==='PM') return tags.includes('PM');
    if(src==='Borough') return tags.includes('Borough');
    if(src==='Manor') return tags.includes('Manor');
    if(src==='Other') return tags.includes('Other') || tags.includes('Community') || tags.includes('Raney Cellars') || tags.includes("Jack's Tavern") || tags.includes('Jesus Dogs') || tags.includes('The Backyard') || tags.includes('HUB');
    // Sports page still uses 'Clubs' as a separate filter (Club Sports games)
    if(src==='Clubs') return tags.includes('Clubs/Orgs')&&(tags.includes('Club Sports')||sportsList.some(s=>tags.includes(s)));
    return false;
}
function formatDate(d){return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});}
function formatTime(d){return d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});}

// ==================== EVENT DURATION / END-TIME RESOLUTION ====================
// Sport-specific default duration in hours. Used at render time when an event
// has no explicit endTime from the source (Borough/PM iCal DTEND, Hudl
// durationSeconds, VFW Vision JSON, user submission). The scraper never
// persists these defaults to events.json — that keeps the "scraped value
// always wins" invariant honest and lets us hot-tune defaults without
// re-scraping. Mirrored (with the same numbers) in events.ics.php for the
// iCal subscription feed.
const SPORT_DEFAULTS = {
    'baseball': 3, 'softball': 3,
    'football': 3, 'wrestling': 3, 'track': 6,
    'basketball': 2, 'soccer': 2, 'tennis': 2, 'lacrosse': 2,
    'field hockey': 2, 'cross country': 2,
    'volleyball': 1.5,
    'swimming': 3, 'golf': 5
};
// Non-sport type defaults — Phantom Power live music, Etix concerts/lectures,
// generic performances. Keys match against tags AND title substrings (case-
// insensitive) so we catch both "Live Music" tagged events and "An Evening
// with X" titles. 'live music' is the catch-all for Phantom Power.
const TYPE_DEFAULTS = {
    'live music': 4, 'concert': 2.5, 'performance': 2.5,
    'theater': 2.5, 'theatre': 2.5,
    'lecture': 2, 'film': 2
};
const DEFAULT_DURATION_HOURS = 2;

// Resolve an event's end time. Order:
//   1. e.endTime (ISO string from scraper) wins always
//   2. SPORT_DEFAULTS lookup (tag match, then title keyword)
//   3. TYPE_DEFAULTS lookup (Phantom Power, Etix, etc.)
//   4. DEFAULT_DURATION_HOURS as final fallback
// Pure function — safe to call repeatedly during render.
function getEventEndTime(e) {
    if (!e) return null;
    if (e.endTime) {
        const parsed = new Date(e.endTime);
        if (!isNaN(parsed.getTime())) return parsed;
    }
    const start = new Date(e.date);
    if (isNaN(start.getTime())) return null;

    const lowerTags = (e.tags || []).map(t => String(t).toLowerCase());
    const title = (e.title || '').toLowerCase();
    const addHours = h => new Date(start.getTime() + h * 3600 * 1000);

    // Sport defaults — tag match first (cheaper, more reliable), then title.
    for (const [sport, hours] of Object.entries(SPORT_DEFAULTS)) {
        if (lowerTags.includes(sport)) return addHours(hours);
    }
    for (const [sport, hours] of Object.entries(SPORT_DEFAULTS)) {
        if (title.includes(sport)) return addHours(hours);
    }
    // Phantom Power → live music default. Tag-based detection.
    if (lowerTags.includes('phantom power')) return addHours(TYPE_DEFAULTS['live music']);
    // Other type defaults — tag match, then title keyword.
    for (const [type, hours] of Object.entries(TYPE_DEFAULTS)) {
        if (lowerTags.includes(type) || title.includes(type)) return addHours(hours);
    }
    return addHours(DEFAULT_DURATION_HOURS);
}

// True if event spans more than one daytime period — drives (a) date-range
// display in the popup ("Apr 28 – Apr 30") and (b) the "never live" rule for
// live badges. Uses a 12-hour duration threshold rather than "different
// calendar day" so a Phantom Power show running 8pm–midnight (which crosses
// a calendar boundary but is one continuous event) is correctly NOT flagged.
// Festivals, multi-day track meets, art shows reliably exceed 12h.
function isMultiDay(e) {
    if (!e) return false;
    const start = new Date(e.date);
    const end = getEventEndTime(e);
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) return false;
    return (end.getTime() - start.getTime()) > 12 * 3600 * 1000;
}
// ==============================================================================


function matchesSportSource(tags, src) {
    if(src==='MU') return tags.includes('MU')&&(tags.includes('Athletic Competitions')||tags.includes('Athletics'));
    if(src==='Clubs') return tags.includes('Clubs/Orgs')&&(tags.includes('Club Sports')||sportsList.some(s=>tags.includes(s)));
    if(src==='PM') return tags.includes('PM')&&tags.includes('Athletics');
    return false;
}

const viewPaths={home:'/',news:'/news',events:'/events',sports:'/sports',places:'/map',food:'/food',weather:'/weather',store:'/store',advertise:'/advertise',analytics:'/analytics'};   // places: /map canonical as of 2026-07-10 — legacy aliases below; food: /food canonical as of 2026-07-28 (took Board's nav slot; /board falls through to home)
const pathToView=Object.fromEntries(Object.entries(viewPaths).map(([k,v])=>[v,k]));

// ==================== URL STATE (shareable filter URLs) ====================
// Persists Events and Sports filter state to URL query params so views can be
// linked, bookmarked, and indexed. v1 scope: events + sports views only.
//
// Param contract — keep stable for backward compat with any shared links:
//
// Events (/events?...):
//   src=Borough,MU      Comma-separated subset of MU/PM/Borough/Other.
//                       Absent or all-listed → "All sources" (evAllMode = true).
//   tag=Music%2FArts    Comma-separated sub-tags (URL-encoded; tags can have /).
//                       Absent → no sub-tag filter.
//   kid=1               Kid-friendly toggle. Absent or 0 → off.
//   food=1              Free Food perk. Marauder-only filter; honored even for
//                       townies on shared links to keep URLs deterministic.
//   stuff=1             Free Stuff perk. Same.
//
// Sports (/sports?...):
//   src=MU              Comma-separated subset of MU/PM/Clubs.
//                       Absent or all-listed → "All sources" (spAllMode = true).
//   sport=Baseball      Single sport name (case-insensitive match against
//                       sportsList; canonical form preserved on write).
//                       Absent → no sport-tag filter.
//   home=1              Home Games only toggle.
//   past=1              Past games view (vs upcoming).
//
// Design calls (locked):
//   - URL wins over localStorage on initial load. A shared link should produce
//     the same view for everyone clicking it.
//   - replaceState (not pushState) on filter clicks — back button shouldn't
//     have to undo individual filter taps.
//   - View changes still pushState (handled by switchView) so back button
//     navigates between views, not within them.
//   - On view change, query params drop (switchView builds path-only URLs).

const URL_STATE_VIEWS = new Set(['events', 'sports']);

// Apply URL params to the relevant filter state. Idempotent — calling with
// the same URL twice produces the same state. Missing params resolve to
// "default off" so going from /events?kid=1 to /events fully clears the filter.
function applyURLStateToView(view) {
    if (!URL_STATE_VIEWS.has(view)) return;
    const params = new URLSearchParams(window.location.search);

    if (view === 'events') {
        const srcParam = params.get('src');
        const requested = srcParam ? srcParam.split(',').map(s => s.trim()).filter(Boolean) : [];
        const valid = requested.filter(s => allEvSources.includes(s));
        if (valid.length > 0 && valid.length < allEvSources.length) {
            evActiveSources = new Set(valid);
            evAllMode = false;
        } else {
            evActiveSources = new Set(allEvSources);
            evAllMode = true;
        }
        evTags.clear();
        const tagParam = params.get('tag');
        if (tagParam) {
            tagParam.split(',').map(t => t.trim()).filter(Boolean).forEach(t => evTags.add(t));
        }
        evKidMode      = params.get('kid')   === '1';
        evFreeFoodMode = params.get('food')  === '1';
        evFreeStuffMode= params.get('stuff') === '1';
    } else if (view === 'sports') {
        const validSpSrc = ['PM', 'MU', 'Clubs'];
        const srcParam = params.get('src');
        const requested = srcParam ? srcParam.split(',').map(s => s.trim()).filter(Boolean) : [];
        const valid = requested.filter(s => validSpSrc.includes(s));
        if (valid.length > 0 && valid.length < validSpSrc.length) {
            spActiveSources = new Set(valid);
            spAllMode = false;
        } else {
            spActiveSources = new Set(validSpSrc);
            spAllMode = true;
        }
        // Sport name: case-insensitive match → canonical form from sportsList.
        // Unknown sport → null (treated as "no sport filter").
        const sportParam = params.get('sport');
        spSportTag = sportParam
            ? (sportsList.find(s => s.toLowerCase() === sportParam.trim().toLowerCase()) || null)
            : null;
        spHomeOnly = params.get('home') === '1';
        spTimeView = params.get('past') === '1' ? 'past' : 'upcoming';
    }
    updatePageTitleForView(view);
}

// Serialize current filter state to URL query string. Uses replaceState so
// each filter click doesn't add a history entry — only view changes do.
function writeURLStateForView(view) {
    if (!URL_STATE_VIEWS.has(view)) return;
    const params = new URLSearchParams();

    if (view === 'events') {
        if (!evAllMode && evActiveSources.size > 0 && evActiveSources.size < allEvSources.length) {
            // Emit in canonical allEvSources order so URLs are stable across
            // Set-iteration order (sharing the same filter combo always yields
            // the same URL string — better for caching and indexing).
            const ordered = allEvSources.filter(s => evActiveSources.has(s));
            params.set('src', ordered.join(','));
        }
        if (evTags.size > 0) {
            params.set('tag', Array.from(evTags).sort().join(','));
        }
        if (evKidMode)       params.set('kid', '1');
        if (evFreeFoodMode)  params.set('food', '1');
        if (evFreeStuffMode) params.set('stuff', '1');
    } else if (view === 'sports') {
        const canonicalSpSrc = ['PM', 'MU', 'Clubs'];
        if (!spAllMode && spActiveSources.size > 0 && spActiveSources.size < canonicalSpSrc.length) {
            const ordered = canonicalSpSrc.filter(s => spActiveSources.has(s));
            params.set('src', ordered.join(','));
        }
        if (spSportTag) params.set('sport', spSportTag);
        if (spHomeOnly) params.set('home', '1');
        if (spTimeView === 'past') params.set('past', '1');
    }

    const path = viewPaths[view] || '/';
    const qs = params.toString();
    const newUrl = path + (qs ? '?' + qs : '');
    if (window.location.pathname + window.location.search !== newUrl) {
        history.replaceState({ view }, '', newUrl);
    }
    updatePageTitleForView(view);
}

// Set <title> based on view + active filters. Helps with browser tabs,
// social previews, and SEO snippets when shared links get indexed.
function updatePageTitleForView(view) {
    const base = 'Millersville.APP';
    let prefix = '';

    if (view === 'events') {
        const parts = [];
        if (evKidMode)       parts.push('Kid-Friendly');
        if (evFreeFoodMode)  parts.push('Free Food');
        if (evFreeStuffMode) parts.push('Free Stuff');
        if (!evAllMode && evActiveSources.size > 0 && evActiveSources.size < allEvSources.length) {
            const ordered = allEvSources.filter(s => evActiveSources.has(s));
            parts.push(ordered.join('/'));
        }
        if (evTags.size > 0) parts.push(Array.from(evTags).sort().join(', '));
        parts.push('Events');
        prefix = parts.join(' ');
    } else if (view === 'sports') {
        const parts = [];
        if (spTimeView === 'past') parts.push('Past');
        if (!spAllMode && spActiveSources.size > 0 && spActiveSources.size < 3) {
            const canonical = ['PM', 'MU', 'Clubs'];
            parts.push(canonical.filter(s => spActiveSources.has(s)).join('/'));
        }
        if (spSportTag) parts.push(spSportTag);
        if (spHomeOnly) parts.push('Home Games');
        if (parts.length === 0) parts.push('Sports');
        else if (!spSportTag) parts.push('Sports');
        prefix = parts.join(' ');
    } else {
        // Other views — restore default site title.
        document.title = base + ' — Events, Sports, Weather & Community for Millersville, PA';
        return;
    }

    document.title = prefix + ' · ' + base;
}
// ==========================================================================
// Legacy URL redirects
pathToView['/services'] = 'places';
pathToView['/directory'] = 'places';   // pre-2026-07-10 canonical — bookmarks, shares, and indexed links keep working
pathToView['/places'] = 'places';   // legacy alias — old links keep working

// Runtime header-height measurement. The secondary sticky nav bar (events/
// sports pages) uses --header-h to position flush below the main header. A
// hardcoded CSS value drifts any time the header's content changes size —
// new nav item, bigger gear icon, Ecwid cart widget loading async, font
// metrics shifting across platforms. Measuring once on load and again
// whenever the header's bounding box changes keeps everything aligned
// without guess-work. Falls back to the CSS fallback values (60px desktop /
// 50px mobile) if the header element isn't found.
function updateHeaderHeightVar() {
    const header = document.querySelector('header');
    if (!header) return;
    const h = Math.round(header.getBoundingClientRect().height);
    if (h > 0) {
        document.documentElement.style.setProperty('--header-h', h + 'px');
    }
}
// rAF coalesce so rapid fire resize events don't thrash layout.
let _headerMeasurePending = false;
function scheduleHeaderMeasure() {
    if (_headerMeasurePending) return;
    _headerMeasurePending = true;
    requestAnimationFrame(() => {
        _headerMeasurePending = false;
        updateHeaderHeightVar();
    });
}

document.addEventListener("DOMContentLoaded",()=>{
    updateHeaderHeightVar();

    // Admin/demo convenience: ?resetWelcome=1 in the URL clears ONLY the
    // welcome-dismissed flag (not favorites or affiliation), letting the
    // banner resurface without losing real user state. Appended silently
    // via history.replaceState so the URL bar stays clean.
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.has('resetWelcome')) {
            localStorage.removeItem('welcomeDismissed');
            params.delete('resetWelcome');
            const cleanSearch = params.toString();
            const newUrl = window.location.pathname + (cleanSearch ? '?' + cleanSearch : '') + window.location.hash;
            history.replaceState(null, '', newUrl);
        }
    } catch (_) { /* no URL params support → skip */ }

    // Show welcome banner IMMEDIATELY if this is a first-time visitor.
    // We previously only set banner visibility in renderHomeFeed(), which
    // runs after ~9 concurrent data fetches settle — producing a 2-5 second
    // window where the page is visible but the banner isn't, making new
    // visitors think it doesn't exist. Since the show/hide condition only
    // reads localStorage, there's no reason to wait for remote data.
    try {
        const hasFeed = !!localStorage.getItem(FEED_KEY);
        const dismissed = !!localStorage.getItem('welcomeDismissed');
        if (!hasFeed && !dismissed) {
            const wb = document.getElementById('welcome-banner');
            if (wb) wb.style.display = 'block';
        }
    } catch (_) { /* localStorage blocked → banner stays hidden, no-op */ }

    // Install prompt (Add to Home Screen). Bump the visit counter, then decide
    // whether to surface our custom install banner. Engagement-gated so it never
    // fires on a first visit; Android/Chrome also re-trigger this via the
    // captured beforeinstallprompt event, while iOS relies on this call.
    try {
        bumpVisitCount();
        maybeShowInstallBanner();
    } catch (_) { /* localStorage blocked / unsupported → no install nudge */ }

    initApp();

    // Re-measure on viewport resize (covers mobile→desktop breakpoint flips
    // where the header's content swaps between hamburger and nav buttons).
    window.addEventListener('resize', scheduleHeaderMeasure);

    // Re-measure when web fonts finish loading — text-driven heights can
    // shift a pixel or two after font swap.
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(updateHeaderHeightVar);
    }

    // Re-measure whenever the header's own size changes. Catches async
    // widget loads (e.g., the Ecwid cart widget initializing after script
    // download) that would otherwise silently break the sticky offset.
    if (typeof ResizeObserver !== 'undefined') {
        const header = document.querySelector('header');
        if (header) new ResizeObserver(scheduleHeaderMeasure).observe(header);
    }
});

// Keyboard shortcuts: Left/Right arrows navigate weeks when on Events or Sports pages
document.addEventListener('keydown', (e) => {
    // Ignore if user is typing in an input/textarea/contenteditable
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    // Ignore if any modifier keys are held (don't hijack browser shortcuts)
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    // Ignore if a modal/overlay is open
    if (document.getElementById('search-overlay') || document.getElementById('feed-settings-overlay')) return;

    // Home view: arrow keys step through days on the timeline
    const homeView = document.getElementById('view-home');
    if (homeView && homeView.classList.contains('active')) {
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (typeof shiftHomeDay === 'function') shiftHomeDay(-1);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (typeof shiftHomeDay === 'function') shiftHomeDay(1);
        }
        return;
    }

    const eventsView = document.getElementById('view-events');
    const sportsView = document.getElementById('view-sports');
    const onEvents = eventsView && eventsView.classList.contains('active');
    const onSports = sportsView && sportsView.classList.contains('active');
    if (!onEvents && !onSports) return;

    // Arrow-key navigation used to step through weeks. With day-grouped infinite scroll
    // that concept is gone, so arrows are no longer bound. Left as a hook for future use.
});

async function initApp(){
    loadFeedPrefs();
    applyAdvertiseGate();   // nav-advertise visibility depends on affiliation — set before first paint
    await Promise.allSettled([loadWeather(),loadWeatherMU(),loadSpecials(),loadEvents(),loadPlaces(),loadHousing(),loadNews(),loadSignups(),loadClubsDirectory(),loadVenueAliases()]);
    linkEventsToPlaces();   // event↔place venue matching (Today lens, card/popup event lines)
    pruneEmptyPlaceCategories();   // directory + housing are loaded now — drop empty category chips
    if (typeof renderFoodPage === 'function') renderFoodPage();   // /food deep-link cold load: containers exist before data — re-render now that allPlaces/allEvents are in
    renderHomeFeed();
    attachHomeSwipeHandlers();
    syncFilterArrows();
    // Close the Directory filter dropdown when tapping outside it.
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('places-filter-menu');
        const btn = document.getElementById('places-filter-toggle');
        if (!menu || menu.style.display === 'none') return;
        if (menu.contains(e.target) || (btn && btn.contains(e.target))) return;
        menu.style.display = 'none';
        const arrow = document.getElementById('places-filter-arrow');
        if (arrow) arrow.textContent = '▾';
    });
    // Ecwid is now loaded lazily — first time the user visits /store, or
    // clicks the cart widget. Eager loading saved one round-trip when a
    // visitor went to the store, but cost EVERY visitor ~200KB of Ecwid
    // bundle + Stripe.js + Datadog RUM (Ecwid's vendor analytics) on
    // initial page load, plus the resulting third-party cookies. The vast
    // majority of millersville.app visitors never click into the store.
    setInterval(refreshCam,60000); refreshCam();
    // Route to correct view based on URL
    let p=window.location.pathname.replace(/\/$/,'');
    // Handle 404.html redirect: ?p=/sports → /sports
    const params=new URLSearchParams(window.location.search);
    if(params.has('p')){
        p=params.get('p').replace(/\/$/,'');
        history.replaceState(null,'',p);
    }
    let view=pathToView[p]||'home';
    // Redirect old /housing URL to services with Housing filter
    if(p==='/housing'){ view='places'; }
    // Normalize every legacy Map-page path (/directory, /places, /food,
    // /services, /housing) in the address bar — the aliases above keep them
    // routable; this keeps the visible URL canonical.
    if(view==='places' && p!=='/map'){ history.replaceState(null,'','/map'); }
    switchView(view,true);
    // Deep link: /map?today=1 lands with the Today lens already on (used by
    // the home rail's "View all →" opened in a new tab, and shareable).
    if(view==='places' && params.get('today')==='1'){ history.replaceState(null,'','/map'); if(!placesTodayMode) window.togglePlacesToday(); }
    if(p==='/housing'){ setTimeout(()=>{ const btn=document.querySelector('#svc-filter-group .src-btn:nth-child(2)'); if(btn) btn.click(); },500); }
}

// Handle browser back/forward
window.addEventListener('popstate',function(){
    const p=window.location.pathname.replace(/\/$/,'');
    const view=pathToView[p]||'home';
    switchView(view,true);
    // Re-apply URL filter state for events/sports views — covers the case of
    // navigating back to a filtered URL after switching views, or forward to
    // a previously-filtered state. applyURLStateToView is idempotent and
    // resets defaults when params are absent, so it's safe to call regardless.
    if (view === 'events' || view === 'sports') {
        applyURLStateToView(view);
        if (view === 'events') {
            if (typeof updateEventsUI === 'function') updateEventsUI();
            if (typeof renderEvSubFilters === 'function') renderEvSubFilters();
            if (typeof renderEvents === 'function') renderEvents();
        } else {
            if (typeof updateSportsUI === 'function') updateSportsUI();
            if (typeof renderSports === 'function') renderSports();
        }
    } else {
        // Other views — restore default page title.
        updatePageTitleForView(view);
    }
});

window.toggleMobileMenu=function(){
    if(window.innerWidth>1000) return;
    const nav=document.getElementById('top-nav'), overlay=document.getElementById('menu-overlay');
    if(nav.classList.contains('open')){nav.classList.remove('open');overlay.classList.remove('open');setTimeout(()=>{if(!nav.classList.contains('open'))nav.style.display='';},300);}
    else{nav.style.display='flex';void nav.offsetWidth;nav.classList.add('open');overlay.classList.add('open');}
};
const viewLabels={home:'',news:'/ News',events:'/ Events',sports:'/ Sports',places:'/ Map',food:'/ Food',weather:'/ Weather',store:'/ Store',advertise:'/ Advertise'};

let ecwidLoaded = false;
window.loadEcwidStore = function(){
    if(ecwidLoaded) return;
    ecwidLoaded = true;
    const s = document.createElement('script');
    s.setAttribute('data-cfasync','false');
    s.src = 'https://app.shopsettings.com/script.js?128927005&data_platform=code&data_date=2026-04-08';
    s.charset = 'utf-8';
    s.onload = function(){
        if(typeof xProductBrowser === 'function'){
            xProductBrowser("categoriesPerRow=3","views=grid(20,3) list(60) table(60)","categoryView=grid","searchView=list","id=my-store-128927005");
        }
        if(typeof Ecwid !== 'undefined'){
            Ecwid.init();
            Ecwid.OnPageLoaded.add(function(){
                injectEcwidCSS();
                // Kill Mailchimp/newsletter popups (they use Shadow DOM so we must remove the wrapper)
                function killPopups(){
                    document.querySelectorAll('.mcforms-wrapper, [id^="mcforms-"], [id*="PopupSignup"], [class*="mailchimp"], [class*="mc-banner"], [class*="mc-modal"]').forEach(el => el.remove());
                }
                killPopups();
                setTimeout(killPopups, 500);
                setTimeout(killPopups, 1500);
                setTimeout(killPopups, 3000);
                setTimeout(killPopups, 6000);
                setTimeout(killPopups, 10000);
                // Persistent watcher in case they inject late
                new MutationObserver(function(mutations){
                    for(const m of mutations){
                        for(const n of m.addedNodes){
                            if(n.nodeType===1 && (n.classList?.contains('mcforms-wrapper') || n.id?.startsWith('mcforms-'))){
                                n.remove();
                            }
                        }
                    }
                }).observe(document.body, { childList: true, subtree: true });
            });
            // Make cart widgets navigate to store page when clicked outside store
            document.querySelectorAll('.ec-cart-widget').forEach(function(w){
                w.addEventListener('click', function(){
                    const currentView = document.querySelector('.app-view.active');
                    if(currentView && currentView.id !== 'view-store'){
                        switchView('store');
                    }
                });
            });
        }
    };
    document.body.appendChild(s);
};

function injectEcwidCSS(){
    function resizeCategoryCards(){
        document.querySelectorAll('.grid-category').forEach(el => {
            el.style.maxWidth = '90px';
            el.style.flexBasis = '90px';
        });
        // Let images fill naturally inside the constrained card (matches source site)
        document.querySelectorAll('.grid-category__image-spacer').forEach(el => {
            el.style.paddingBottom = '0';
            el.style.height = '60px';
        });
        document.querySelectorAll('.grid-category__image-spacer-inner').forEach(el => {
            el.style.paddingBottom = '0';
        });
        document.querySelectorAll('.grid-category__shadow-inner').forEach(el => {
            el.style.fontSize = '0.7rem';
        });
    }
    resizeCategoryCards();
    setTimeout(resizeCategoryCards, 1000);
    setTimeout(resizeCategoryCards, 3000);
    setTimeout(resizeCategoryCards, 5000);

    const storeEl = document.getElementById('my-store-128927005');
    if(storeEl){
        const observer = new MutationObserver(function(){ resizeCategoryCards(); });
        observer.observe(storeEl, { childList: true, subtree: true });
    }
}

window.switchView=function(view,skipPush){
    if(view==='advertise' && muAffiliation==='student') view='home';   // Advertise is Marauder-hidden — nav click, /advertise deep link, and popstate all funnel here (URL left as typed on skipPush loads, same as the /board fallthrough)
    if(view==='places') initPlacesMap();   // lazy map init; invalidateSize on return visits
    if(view==='food' && typeof renderFoodPage==='function'){ foodShowClosedOn=false; foodShowClosedOff=false; renderFoodPage(); }   // Food page rebuilds on every entry; BOTH per-group closed toggles reset for the quick-look default
    document.querySelectorAll('.app-view').forEach(v=>v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    document.querySelectorAll('.nav-link').forEach(b=>b.classList.remove('active'));
    const btn=document.getElementById(`nav-${view}`); if(btn) btn.classList.add('active');
    const titleEl=document.getElementById('header-page-title');
    if(titleEl) titleEl.textContent=viewLabels[view]||'';
    window.scrollTo(0,0);
    const path=viewPaths[view]||'/';
    if(!skipPush && window.location.pathname.replace(/\/$/,'')!==path){
        history.pushState({view},'',path);
    }
    // Sync document.title with the new view (filter-aware for events/sports,
    // default site title elsewhere). Called after the pushState so the URL is
    // already correct when the title resolves.
    updatePageTitleForView(view);
    // Lazy-load Ecwid when store is first visited
    if(view==='store') loadEcwidStore();
};

// Cross-feed event de-duplication. getEventKey() is title+date, which assumes
// one event keeps one title across scrape runs. That breaks when a second feed
// (e.g. the MU calendar) publishes its own copy of an event we already carry:
// the two titles differ, so both render as duplicates. We collapse events that
// share the SAME start instant AND the SAME title "head" — the part before the
// first separator (— – : | ·), normalized — which is a tight match (two genuinely
// distinct events almost never share both). On a collision we keep the richer
// copy (ticket/register link, benefits, description, longer title) so a well-
// formed, Free-badged listing wins over a bare calendar duplicate. Events with
// no usable start time or too-short a head pass through untouched (never dropped).
function dedupeEvents(list) {
    if (!Array.isArray(list)) return list;
    const sigOf = e => ((e && e.title) || '').split(/[—–:|·]/)[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const richness = e => {
        let s = 0;
        if (e.ticketLink) s += 4;
        if (e.registerLink) s += 2;
        if (Array.isArray(e.benefits) && e.benefits.length) s += 2;
        if (e.description) s += 1;
        return s + Math.min((e.title || '').length, 120) / 120;
    };
    const byKey = new Map();
    const passthrough = [];
    for (const e of list) {
        const start = new Date(e && e.date).getTime();
        const sig = sigOf(e);
        if (isNaN(start) || sig.length < 3) { passthrough.push(e); continue; }
        const key = start + '|' + sig;
        const prev = byKey.get(key);
        if (!prev || richness(e) > richness(prev)) byKey.set(key, e);
    }
    return passthrough.concat(Array.from(byKey.values()));
}

async function loadEvents(){
    try{const res=await fetch('events.json'); if(!res.ok) return;
    allEvents=await res.json();
    // Collapse cross-feed duplicates (e.g. the MU calendar adding its own copy
    // of an event we already carry under a different title) before anything else
    // touches the array — see dedupeEvents.
    allEvents = dedupeEvents(allEvents);
    // Borough "Reserve Public Meeting Room" noise is now dropped at SCRAPE time
    // (scrape.js post-override sweep, 2026-07-28) — the render-time
    // BOROUGH_NOISE_TITLES filter that lived here was retired; unenriched
    // placeholders never reach events.json.
    // Pre-parse date strings to millisecond timestamps once, attached as
    // _dateMs. Filter and sort hot paths reference _dateMs instead of
    // calling `new Date(e.date)` (which allocates a Date and reparses the
    // string each time). With ~1200 events, a single render's filter+sort
    // would otherwise allocate 2000+ Date objects; this caches them once at
    // load. NaN/invalid dates fall to 0 — safer than throwing in a sort
    // comparator. Display code still uses `new Date(e.date)` since locale
    // formatting needs the Date object, not just a timestamp.
    for (const ev of allEvents) {
        const t = new Date(ev.date).getTime();
        ev._dateMs = isNaN(t) ? 0 : t;
    }
    allEvents.sort((a, b) => a._dateMs - b._dateMs);
    // Apply URL filter params if the user landed on /events or /sports with
    // a query string (deep link, bookmark, shared link). Done BEFORE the first
    // render so the result reflects the URL on initial paint — no flash of
    // unfiltered content.
    const _initialPath = window.location.pathname.replace(/\/$/, '');
    const _initialView = pathToView[_initialPath];
    if (_initialView === 'events' || _initialView === 'sports') {
        applyURLStateToView(_initialView);
    }
    renderEvents(); renderSports();
    if (currentNews.length > 0) renderNewsUI();
    // Load sibling meta for the "last updated" indicator. Failing quietly is fine —
    // the file may not exist on first deploy before the scraper has run.
    try {
        const metaRes = await fetch('events-meta.json', { cache: 'no-store' });
        if (metaRes.ok) {
            const meta = await metaRes.json();
            renderLastUpdated(meta.generatedAt);
        }
    } catch (_) { /* silent */ }
    }catch(e){console.error('Events load error:',e);}
}

// Render the homepage's "updated X ago" line. Reads from the scraper-written
// events-meta.json. The threshold for calling it "stale" is 3 hours — our cron runs
// hourly, so anything past 3 hours means 2+ consecutive runs failed.
function renderLastUpdated(iso) {
    if (!iso) return;
    const then = new Date(iso);
    if (isNaN(then)) return;
    const now = new Date();
    const diffMin = Math.max(0, Math.round((now - then) / 60000));
    let label;
    if (diffMin < 2) label = 'Just updated';
    else if (diffMin < 60) label = `Updated ${diffMin} min ago`;
    else if (diffMin < 120) label = 'Updated 1 hour ago';
    else if (diffMin < 24 * 60) label = `Updated ${Math.floor(diffMin / 60)} hours ago`;
    else label = `Updated ${Math.floor(diffMin / (24 * 60))} days ago`;
    const stale = diffMin > 180;
    const suffix = stale ? ' ⚠️' : '';
    // Footer indicator — visible across all views. (Previously also written
    // to a #home-last-updated pill on the home view, but that duplicated the
    // footer message in close visual proximity. Footer is the canonical
    // location now since it's seen on every page.)
    const footerEl = document.getElementById('footer-last-updated');
    if (footerEl) {
        footerEl.textContent = label + suffix;
        footerEl.classList.toggle('stale', stale);
    }
}

/* ==================== EVENTS PAGE ==================== */
window.setEventSourceAll=function(){
    evAllMode = true;
    evActiveSources = new Set(allEvSources);
    evTags.clear();
    updateEventsUI();
    renderEvents();
    writeURLStateForView('events');
};
window.toggleEventSource=function(src){
    evAllMode = false;
    const visibleEvSources = allEvSources.filter(s =>
        !(s === 'PM' && isSourceHidden('PM')) &&
        !(s === 'Borough' && isSourceHidden('Borough')) &&
        !(s === 'Manor' && isSourceHidden('Manor'))
    );
    if (visibleEvSources.length <= 2) {
        // Two-pill mode (typical Marauder view: MU + Other): multi-select is
        // meaningless — selecting the 2nd pill used to equal "all visible" and
        // snap straight to All (the 2026-07-27 reported bug). Pills act as
        // radio buttons instead: a tap selects just that source; tapping the
        // ACTIVE pill returns to All. Locals' >2-pill multi-select below is
        // untouched.
        if (evActiveSources.size === 1 && evActiveSources.has(src)) {
            evAllMode = true;
            evActiveSources = new Set(allEvSources);
        } else {
            evActiveSources = new Set([src]);
        }
    } else {
        if (evActiveSources.size === allEvSources.length && allEvSources.every(s => evActiveSources.has(s))) {
            evActiveSources = new Set([src]);
        } else {
            if(evActiveSources.has(src)) evActiveSources.delete(src);
            else evActiveSources.add(src);
        }
        // All mode activates when all VISIBLE sources are selected (affiliation can hide pills)
        if (visibleEvSources.length > 0 && visibleEvSources.every(s => evActiveSources.has(s))) {
            evAllMode = true;
            // Ensure hidden sources are also in the set so filter logic stays consistent
            evActiveSources = new Set(allEvSources);
        }
    }
    evTags.clear();
    updateEventsUI();
    renderEvents();
    writeURLStateForView('events');
};
function updateEventsUI(){
    const allBtn = document.getElementById('ev-src-all');
    if (allBtn) allBtn.classList.toggle('active', evAllMode);
    const srcMap = {'MU':'mu','PM':'pm','Borough':'borough','Manor':'manor','Other':'other'};
    // Hide pills for sources the user's affiliation doesn't care about (unless
    // shown/favorited). The Other pill is ALWAYS visible again (2026-07-27
    // same-day revision): Jesus Dogs became a first-class source living under
    // Other, and its dated events are marauder-native — so every marauder has
    // Other-pill content year-round. The rest of the Other family stays
    // event-gated via isEventFromHiddenSource; only the pill un-hides.
    const evPillHidden = (src) =>
        src === 'PM' ? isSourceHidden('PM')
        : src === 'Borough' ? isSourceHidden('Borough')
        : src === 'Manor' ? isSourceHidden('Manor')
        : false;
    // Degenerate row: with fewer than 2 visible source pills the row is a
    // meaningless single choice (All === the lone source) — hide All + the
    // survivor and force All mode. Reappears the moment a source is shown or
    // favorited (this fn re-runs on save / affiliation switch / pill taps).
    const visiblePillCount = allEvSources.filter(s => !evPillHidden(s)).length;
    if (visiblePillCount < 2 && !evAllMode) {
        evAllMode = true;
        evActiveSources = new Set(allEvSources);
        if (allBtn) allBtn.classList.toggle('active', true);
    }
    if (allBtn) allBtn.style.display = visiblePillCount < 2 ? 'none' : '';
    allEvSources.forEach(src => {
        const btn = document.getElementById('ev-src-' + srcMap[src]);
        if (!btn) return;
        btn.classList.toggle('active', !evAllMode && evActiveSources.has(src));
        btn.style.display = (evPillHidden(src) || visiblePillCount < 2) ? 'none' : '';
    });

    // Toolbar toggle swap based on affiliation:
    //   Marauder ('student')  → show 🍕 Free Food + 🎁 Free Stuff perks; hide 👨‍👩‍👧 family
    //   Townie ('townie')     → show 👨‍👩‍👧 family toggle; hide perks
    //   Unset (no choice yet) → hide BOTH. The gold Marauder perk toggles appear
    //                           ONLY after someone explicitly picks Marauder, so
    //                           undeclared visitors and townies never see them.
    const kidBtn = document.getElementById('ev-kid-toggle');
    const foodBtn = document.getElementById('ev-freefood-toggle');
    const stuffBtn = document.getElementById('ev-freestuff-toggle');
    const isTownie = muAffiliation === 'townie';
    const isMarauder = muAffiliation === 'student'; // explicit only — unset is NOT treated as Marauder here
    if (kidBtn) kidBtn.style.display = isTownie ? '' : 'none';
    if (foodBtn) foodBtn.style.display = isMarauder ? '' : 'none';
    if (stuffBtn) stuffBtn.style.display = isMarauder ? '' : 'none';
    // If affiliation changed to Townie, clear any stale perk-toggle state
    if (isTownie && (evFreeFoodMode || evFreeStuffMode)) {
        evFreeFoodMode = false; evFreeStuffMode = false;
        if (foodBtn) foodBtn.classList.remove('active');
        if (stuffBtn) stuffBtn.classList.remove('active');
    }
    // And similarly: non-townie shouldn't have an active kid-mode filter
    if (!isTownie && evKidMode) {
        evKidMode = false;
        if (kidBtn) kidBtn.classList.remove('active');
    }

    // "Clean state" for the clear-filters button: all sources on, no tag/kid/perk filters,
    // default scroll window (60 days). Week/anchor concept is retired.
    const isClean = evAllMode && evTags.size === 0 && !evKidMode && !evFreeFoodMode && !evFreeStuffMode && !evFavOnlyMode && evDaysVisible === INITIAL_DAYS;
    document.getElementById('ev-clear-btn').style.visibility = isClean ? 'hidden' : 'visible';

    // Refresh sub-category chip row so it matches the currently-active source
    renderEvSubFilters();
}
// Render sub-category filter chips under the source row. Shows subs for whichever
// top-level source is currently active (MU, PM, etc.). Clicking a sub chip toggles it
// in `evTags`, which the event filter uses to narrow down by sub-type (e.g. "Greek Life",
// "Music/Arts"). No-ops when multiple sources are active or when the active source has
// no sub-map entry (Borough and Other don't have sub-filters).
function renderEvSubFilters(){
    const c = document.getElementById('ev-sub-container');
    if (!c) return;
    c.innerHTML = '';
    c.classList.remove('active');

    // Only show sub-filters when exactly one source is active and it has a sub-map entry.
    if (evAllMode || evActiveSources.size !== 1) return;
    const src = Array.from(evActiveSources)[0];
    const subs = getEvSubMap()[src];
    if (!subs || subs.length === 0) return;

    c.classList.add('active');
    c.innerHTML = subs.map(sub => {
        // Entries can be strings (label === tag) or { label, tag } objects for the townie-
        // friendly "Community" relabel where display differs from the underlying filter tag.
        const label = typeof sub === 'string' ? sub : sub.label;
        const tag = typeof sub === 'string' ? sub : sub.tag;
        const active = evTags.has(tag);
        return `<button class="sub-tag-btn${active ? ' active' : ''}" onclick="toggleEventSub('${tag.replace(/'/g, "\\'")}')">${label}</button>`;
    }).join('');
}
// Toggle a sub-category tag on/off
window.toggleEventSub = function(tag){
    if (evTags.has(tag)) evTags.delete(tag);
    else evTags.add(tag);
    renderEvSubFilters();
    renderEvents();
    writeURLStateForView('events');
};
window.setEvMode = function(){};
// Legacy no-op stubs — the Events/Sports toolbars no longer have prev/next nav
// since the day-grouped infinite-scroll replaces week-paging. Kept so any stale
// onclick handlers or external callers don't throw.
window.evNavPrev = function(){};
window.evNavNext = function(){};
window.toggleKidFriendly=function(){
    evKidMode=!evKidMode;
    document.getElementById('ev-kid-toggle').classList.toggle('active',evKidMode);
    updateEventsUI();
    renderEvents();
    writeURLStateForView('events');
};
window.toggleFreeFood=function(){
    evFreeFoodMode=!evFreeFoodMode;
    document.getElementById('ev-freefood-toggle').classList.toggle('active',evFreeFoodMode);
    updateEventsUI();
    renderEvents();
    writeURLStateForView('events');
};
window.toggleFreeStuff=function(){
    evFreeStuffMode=!evFreeStuffMode;
    document.getElementById('ev-freestuff-toggle').classList.toggle('active',evFreeStuffMode);
    updateEventsUI();
    renderEvents();
    writeURLStateForView('events');
};
window.clearEventFilters=function(){
    evTags.clear(); evAllMode=true; evActiveSources=new Set(allEvSources);
    evKidMode=false; evFreeFoodMode=false; evFreeStuffMode=false;
    evFavOnlyMode=false;
    evDaysVisible = INITIAL_DAYS;
    document.getElementById('ev-kid-toggle').classList.remove('active');
    const ff=document.getElementById('ev-freefood-toggle');
    const fs=document.getElementById('ev-freestuff-toggle');
    if(ff) ff.classList.remove('active');
    if(fs) fs.classList.remove('active');
    updateEventsUI();
    renderEvents();
    writeURLStateForView('events');
    // Scroll to top so the user sees the reset fresh state
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Collapsible filter toggles
window.toggleEvFilters=function(){
    const wrap = document.getElementById('ev-filters-wrap');
    const arrow = document.getElementById('ev-filter-arrow');
    const isVisible = getComputedStyle(wrap).display !== 'none';
    wrap.style.display = isVisible ? 'none' : 'block';
    arrow.textContent = isVisible ? '▸' : '▾';
};
window.togglePlacesFilters=function(){
    const menu = document.getElementById('places-filter-menu');
    const arrow = document.getElementById('places-filter-arrow');
    const open = menu.style.display === 'none';
    menu.style.display = open ? 'block' : 'none';
    if (arrow) arrow.textContent = open ? '▴' : '▾';
};
window.toggleSpFilters=function(){
    const wrap = document.getElementById('sp-filters-wrap');
    const arrow = document.getElementById('sp-filter-arrow');
    const isVisible = getComputedStyle(wrap).display !== 'none';
    wrap.style.display = isVisible ? 'none' : 'block';
    arrow.textContent = isVisible ? '▸' : '▾';
};
// Sync filter arrows on load (mobile defaults to collapsed via CSS)
function syncFilterArrows(){
    ['ev','sp'].forEach(p => {
        const wrap = document.getElementById(p+'-filters-wrap');
        const arrow = document.getElementById(p+'-filter-arrow');
        if(wrap && arrow) arrow.textContent = getComputedStyle(wrap).display === 'none' ? '▸' : '▾';
    });
}

// ===== Day grouping helpers =====
// Format a Date as a friendly header label: "Today" / "Tomorrow" / "Thu, Apr 23"
function formatDayHeader(d) {
    const today = todayMidnight();
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((target - today) / (1000 * 60 * 60 * 24));
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Group a flat sorted list of events into [{dateKey, dateObj, events: [...]}, ...]
// Preserves the caller's sort order within each day.
//
// Multi-day handling: events that span >12h get added to EVERY day they cover,
// not just their start day. A 3-day track meet appears on Day 1, Day 2, and
// Day 3. Each repeat references the SAME underlying event object — favoriting
// from any day stars the original; clicking opens the same modal. To let card
// builders show "Day 2 of 3"-style badges, we annotate each group's events
// with `_dayNumber` and `_totalDays`. Single-day events get no annotation.
//
// The annotation lives on a shallow clone (Object.assign) so we don't mutate
// the source event — important because the same event may appear in multiple
// groups with different day numbers, and we don't want the last-written
// value to leak across groups.
function groupEventsByDay(events) {
    const groups = new Map();
    const getOrCreate = (key, dateObj) => {
        if (!groups.has(key)) {
            groups.set(key, { dateKey: key, dateObj, events: [] });
        }
        return groups.get(key);
    };

    for (const e of events) {
        const start = new Date(e.date);
        if (isNaN(start.getTime())) continue;
        const isMulti = isMultiDay(e);

        if (!isMulti) {
            const key = toDateStr(start);
            const grp = getOrCreate(key, new Date(start.getFullYear(), start.getMonth(), start.getDate()));
            grp.events.push(e);
            continue;
        }

        // Multi-day: enumerate every calendar day from start through end,
        // inclusive. Cap at 14 days defensively in case a bad endTime gives
        // us a 6-month span (e.g. an open-ended exhibit) — repeating a card
        // every day for half a year would clobber the UI.
        const end = getEventEndTime(e) || start;
        const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        const dayCount = Math.min(14, Math.round((endDay - startDay) / 86400000) + 1);
        for (let i = 0; i < dayCount; i++) {
            const d = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + i);
            const key = toDateStr(d);
            const grp = getOrCreate(key, d);
            // Shallow-clone so the annotation doesn't leak between groups.
            // The clone shares references for sourceLink, image, etc., so
            // memory cost is minimal — just one new wrapper object per day.
            grp.events.push(Object.assign({}, e, {
                _dayNumber: i + 1,
                _totalDays: dayCount
            }));
        }
    }
    return [...groups.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

// Build HTML for a single day group: a sticky header + its card list
function buildDayGroupHTML(group, buildCard) {
    const todayStr = toDateStr(todayMidnight());
    const isToday = group.dateKey === todayStr;
    const label = formatDayHeader(group.dateObj);
    const count = group.events.length;
    const plural = count === 1 ? 'event' : 'events';
    return `<div class="day-group-header${isToday ? ' today' : ''}">${label}<span class="day-count">${count} ${plural}</span></div>`
        + group.events.map(e => buildCard(e)).join('');
}

// Render N skeleton cards as a loading placeholder. Layout mimics the real
// .app-card so the visual shift on data arrival is minimal. Each card has
// a title bar, two metadata rows, and a tag row — the shimmer animation
// is pure CSS (.skel-bar class), no JS animation loops.
function renderSkeletonCards(n) {
    const card = `<div class="app-card card-skeleton" aria-hidden="true">
        <div class="card-body">
            <div class="card-heading"><span class="skel-bar" style="width:30px;height:30px;border-radius:50%;flex-shrink:0;"></span><span class="skel-bar" style="height:18px;flex:1;"></span></div>
            <span class="skel-bar" style="display:block;width:60%;height:14px;margin:6px 0;"></span>
            <span class="skel-bar" style="display:block;width:75%;height:14px;margin:6px 0 10px;"></span>
            <div style="display:flex;gap:6px;"><span class="skel-bar" style="width:50px;height:18px;border-radius:10px;"></span><span class="skel-bar" style="width:80px;height:18px;border-radius:10px;"></span></div>
        </div>
    </div>`;
    return card.repeat(n);
}

function renderEvents(){
    updateEventsUI();
    const container = document.getElementById('ev-events-container');
    // Loading state: events.json hasn't returned yet. Render 4 skeleton cards
    // so the page doesn't flash empty before content arrives. Once allEvents
    // populates, loadEvents triggers another renderEvents() which replaces
    // these. Empty allEvents after load is a different state (no events at
    // all) — we can't distinguish here, but realistically allEvents.length
    // is always >0 in production, so skeletons only show during fetch.
    if (!allEvents || allEvents.length === 0) {
        container.innerHTML = renderSkeletonCards(4);
        return;
    }
    if (evActiveSources.size === 0) {
        container.innerHTML = '<p class="empty-state">Select a source to view events.</p>';
        return;
    }

    // Infinite-scroll window: today through today+evDaysVisible
    const today = todayMidnight();
    const rangeStart = toDateStr(today);
    const rangeEnd = toDateStr(addDays(today, evDaysVisible));

    // Build the filter predicate once so we can reuse it when counting "beyond" events
    const filterEvent = (e) => {
        if (isSportEvent(e)) return false;
        if (isPMSportByTitle(e)) return false;
        if (isHiddenForViewer(e)) return false;
        if (isEventFromHiddenSource(e)) return false;
        const tags = e.tags || [];
        if (!Array.from(evActiveSources).some(src => matchesSource(tags, src))) return false;
        // Sub-tag filter uses OR semantics: an event matches if it has ANY of the
        // selected sub-tags. Previously this was AND (every tag must match) which felt
        // like the filter was "narrowing" beyond what users expected — they think of
        // sub-chips as additive ("show me Greek Life AND Fundraising events") and expect
        // the list to grow, not shrink.
        if (evTags.size > 0 && !Array.from(evTags).some(t => tags.includes(t))) return false;
        if (evKidMode && !e.kidFriendly) return false;
        if (evFreeFoodMode || evFreeStuffMode) {
            const benefits = e.benefits || [];
            const hasFood = benefits.includes('Free Food');
            const hasStuff = benefits.includes('Free Stuff');
            if (evFreeFoodMode && evFreeStuffMode) { if (!hasFood && !hasStuff) return false; }
            else if (evFreeFoodMode && !hasFood) return false;
            else if (evFreeStuffMode && !hasStuff) return false;
        }
        return true;
    };

    const allMatching = allEvents.filter(filterEvent);
    // Visible window (today + next N days)
    const filtered = allMatching.filter(e => {
        const d = localDateStr(e.date);
        return d >= rangeStart && d <= rangeEnd;
    });
    // Count of events beyond the window (to decide whether to show "Load more")
    const beyondCount = allMatching.filter(e => localDateStr(e.date) > rangeEnd).length;

    if (filtered.length === 0) {
        // Build a contextual empty-state message based on what's actively filtering.
        // We lead with the MOST restrictive-seeming filter so users understand why nothing shows.
        const activeTags = Array.from(evTags);
        const activeSources = Array.from(evActiveSources);
        const sourceLabel = activeSources.length <= 2 ? activeSources.join(', ') : activeSources.length + ' sources';
        const windowText = 'next ' + evDaysVisible + ' days';
        let msg, hint = '';
        if (evKidMode) {
            msg = '👨‍👩‍👧 No family-friendly events coming up in the ' + windowText + '.';
            hint = 'Try turning off the family filter, or loading more days.';
        } else if (evFreeFoodMode && evFreeStuffMode) {
            msg = '🍕🎁 No free food or free stuff events coming up.';
            hint = 'Try turning off one or both perk filters.';
        } else if (evFreeFoodMode) {
            msg = '🍕 No free food events coming up in the ' + windowText + '.';
            hint = 'Try turning off the free food filter.';
        } else if (evFreeStuffMode) {
            msg = '🎁 No free stuff events coming up in the ' + windowText + '.';
            hint = 'Try turning off the free stuff filter.';
        } else if (activeTags.length > 0 && !evAllMode) {
            msg = 'No events matching "' + activeTags.join(', ') + '" from ' + sourceLabel + ' in the ' + windowText + '.';
            hint = 'Try clearing your filters or adding more sources.';
        } else if (activeTags.length > 0) {
            msg = 'No events matching "' + activeTags.join(', ') + '" in the ' + windowText + '.';
            hint = 'Try clearing the filter tags.';
        } else if (!evAllMode) {
            msg = 'No events from ' + sourceLabel + ' in the ' + windowText + '.';
            hint = 'Try adding more sources or loading more days.';
        } else {
            msg = 'Nothing scheduled in the ' + windowText + '.';
            hint = beyondCount > 0 ? 'There are more events further out.' : 'Check back later — new events come in hourly.';
        }
        let html = '<div class="empty-state"><p>' + msg + '</p><p style="font-size:0.82rem;color:var(--text-muted);margin-top:4px;">' + hint + '</p>';
        // Offer a one-click clear button when any filter is active (other than just the default window)
        const anyFilterActive = evKidMode || evFreeFoodMode || evFreeStuffMode || activeTags.length > 0 || !evAllMode || evFavOnlyMode;
        if (anyFilterActive) {
            html += '<button class="btn btn-sm btn-outline" onclick="clearEventFilters()" style="margin-top:10px;">Clear all filters</button>';
        }
        html += '</div>';
        if (beyondCount > 0) html += '<button class="load-more-btn" onclick="evLoadMore()">Load more events (' + beyondCount + ' more available)</button>';
        container.innerHTML = html;
        return;
    }

    // Favorites UX: toolbar ⭐ Favs button is shown when user has event favorites.
    // Favorited cards get a gold border (.card-fav via buildEventCard) so they stand out
    // in their natural day group. When fav-only mode is active, the list narrows to favorites.
    const hasAnyPrefs = feedPrefs && feedPrefs.length > 0;
    const hasEventPrefs = hasAnyPrefs && feedPrefs.some(p => eventFeedIds.has(p) || p.startsWith('club:'));
    const favCount = hasEventPrefs ? allMatching.filter(e => eventMatchesFeed(e)).length : 0;

    // Show/hide toolbar fav button based on whether user has any event favorites
    const favBtn = document.getElementById('ev-fav-toggle');
    if (favBtn) {
        favBtn.style.display = (hasEventPrefs && favCount > 0) ? '' : 'none';
        favBtn.classList.toggle('active', evFavOnlyMode);
        favBtn.title = evFavOnlyMode ? 'Showing favorites only — tap to show all' : 'Jump to your favorites (' + favCount + ')';
    }

    let html = '';
    // Family-friendly mode note — mirrors the Directory's Marauder Gold blurb so
    // the active filter is explained inline. Shown on the has-results path; the
    // no-results path above carries its own family-mode empty message.
    if (evKidMode) {
        html += '<div class="ev-filter-blurb" style="background:var(--gold-soft);border:1px solid var(--gold);border-radius:var(--radius-sm);padding:8px 12px;margin-bottom:12px;font-size:0.82rem;color:var(--navy);">👨‍👩‍👧 Family-friendly mode is on — showing only events suitable for kids and families. Tap the 👨‍👩‍👧 button again to see everything.</div>';
    }
    let dayItems = filtered;

    // Setup hint (shown only when user has no prefs at all — not a filter chip, just guidance)
    if (!hasAnyPrefs) {
        html += '<div class="feed-setup-hint">⚙️ <a href="#" onclick="event.preventDefault();openFeedSettings();">Set up your favorites</a> to highlight your preferred events</div>';
    } else if (hasAnyPrefs && !hasEventPrefs) {
        html += '<div class="feed-setup-hint">No event favorites set — <a href="#" onclick="event.preventDefault();openFeedSettings();">add some</a> to highlight them here</div>';
    }

    // If favorites-only mode is on, narrow the list to favorites
    if (evFavOnlyMode && hasEventPrefs) {
        dayItems = filtered.filter(e => eventMatchesFeed(e));
        if (dayItems.length === 0) {
            html += '<p class="empty-state">No upcoming favorites in the next ' + evDaysVisible + ' days. <a href="#" onclick="event.preventDefault();evToggleFavOnly();">Show all events</a></p>';
            if (beyondCount > 0) html += '<button class="load-more-btn" onclick="evLoadMore()">Load more (' + beyondCount + ' more events)</button>';
            container.innerHTML = html;
            if (typeof refreshDayLabels === 'function') refreshDayLabels();
            return;
        }
    }

    // Day-grouped render
    const groups = groupEventsByDay(dayItems);
    html += groups.map(g => buildDayGroupHTML(g, e => buildEventCard(e, false))).join('');

    // Load more / footer note
    if (beyondCount > 0) {
        html += '<button class="load-more-btn" onclick="evLoadMore()">Load more events (' + beyondCount + ' more available)</button>';
    } else {
        html += '<div class="load-more-note">That\'s all scheduled events 👋</div>';
    }

    container.innerHTML = html;
    if (typeof refreshDayLabels === 'function') refreshDayLabels();
}

// Load the next batch of future days on the Events page
window.evLoadMore = function() {
    evDaysVisible += LOAD_MORE_INCREMENT;
    renderEvents();
};

// Toggle favorites-only filter on Events
window.evToggleFavOnly = function() {
    evFavOnlyMode = !evFavOnlyMode;
    renderEvents();
    // Scroll to top so the user sees the filtered view from the beginning
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Scroll-to-today helper (clicking the toolbar date label jumps back to Today)
window.evScrollToToday = function() {
    const container = document.getElementById('ev-events-container');
    if (!container) return;
    const todayHeader = container.querySelector('.day-group-header.today') || container.querySelector('.day-group-header');
    if (todayHeader) {
        const stickyOffset = 140; // site header + sticky toolbar combined
        const top = todayHeader.getBoundingClientRect().top + window.scrollY - stickyOffset;
        window.scrollTo({ top, behavior: 'smooth' });
    } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
};
window.spScrollToToday = function() {
    const container = document.getElementById('sp-events-container');
    if (!container) return;
    const todayHeader = container.querySelector('.day-group-header.today') || container.querySelector('.day-group-header');
    if (todayHeader) {
        const stickyOffset = 140;
        const top = todayHeader.getBoundingClientRect().top + window.scrollY - stickyOffset;
        window.scrollTo({ top, behavior: 'smooth' });
    } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
};

// ===== Toolbar date label — updates as the user scrolls through day groups =====
// Tracks which day-group-header is nearest the top of the viewport and mirrors its
// label into the toolbar's #ev-current-day-label / #sp-current-day-label span.
// Uses a simple scroll listener rather than IntersectionObserver because the
// day groups are added/removed as "Load more" extends the list.
function updateCurrentDayLabel(pageKey) {
    const prefix = pageKey; // 'ev' or 'sp'
    const labelEl = document.getElementById(prefix + '-current-day-label');
    const container = document.getElementById(prefix + '-events-container');
    if (!labelEl || !container) return;
    const headers = container.querySelectorAll('.day-group-header');
    if (headers.length === 0) {
        labelEl.textContent = 'Today';
        return;
    }
    // Defensive bail-out: when called immediately after innerHTML assignment,
    // the browser hasn't laid out the new DOM yet and getBoundingClientRect()
    // returns top: 0 for every header. The loop below would then mark every
    // header as "above threshold" and `active` would advance to the LAST one,
    // showing e.g. "Wed, Jun 24" on the toolbar at first paint instead of
    // "Today". If we detect this state, default to the today-marked header
    // (or the first if no today-marked exists) and skip the scroll math.
    const firstRect = headers[0].getBoundingClientRect();
    const lastRect = headers[headers.length - 1].getBoundingClientRect();
    if (firstRect.top === 0 && lastRect.top === 0) {
        const todayHeader = container.querySelector('.day-group-header.today');
        const fallback = todayHeader || headers[0];
        labelEl.textContent = (fallback.childNodes[0] ? fallback.childNodes[0].textContent.trim() : fallback.textContent.trim()) || 'Today';
        return;
    }
    // "Active" header = the last one whose top has scrolled above the toolbar offset
    const offsetTop = 120; // ~ site header (50) + toolbar height (70)
    let active = headers[0];
    for (const h of headers) {
        const rect = h.getBoundingClientRect();
        if (rect.top <= offsetTop + 8) active = h;
        else break;
    }
    // Extract just the label (ignore the count span)
    const labelText = active.childNodes[0] ? active.childNodes[0].textContent.trim() : active.textContent.trim();
    if (labelEl.textContent !== labelText) labelEl.textContent = labelText;
}
// Throttle to once-per-animation-frame to avoid jank on scroll
let _dayLabelScrollPending = false;
window.addEventListener('scroll', () => {
    if (_dayLabelScrollPending) return;
    _dayLabelScrollPending = true;
    requestAnimationFrame(() => {
        _dayLabelScrollPending = false;
        // Only update for whichever view is active
        const eventsView = document.getElementById('view-events');
        const sportsView = document.getElementById('view-sports');
        if (eventsView && eventsView.classList.contains('active')) updateCurrentDayLabel('ev');
        else if (sportsView && sportsView.classList.contains('active')) updateCurrentDayLabel('sp');
    });
}, { passive: true });
// Also update after renders in case a filter changes what's at the top.
// Defer to next animation frame so the browser has a chance to lay out the
// freshly-rendered DOM — calling immediately after innerHTML returns
// getBoundingClientRect tops of 0 for everything (no layout yet), which
// makes the active-header loop pick the last header instead of the first.
function refreshDayLabels() {
    requestAnimationFrame(() => {
        updateCurrentDayLabel('ev');
        updateCurrentDayLabel('sp');
    });
}

/* ==================== SPORTS PAGE ==================== */

let spAllMode = true; // tracks if "All" is the active selection

window.setSportsSourceAll=function(btn){
    spAllMode = true;
    spActiveSources = new Set(['PM','MU','Clubs']);
    spSportTag = null;
    updateSportsUI();
    renderSports();
    writeURLStateForView('sports');
};

window.toggleSportsSource=function(src){
    spAllMode = false;
    const visibleSources = ['PM','MU','Clubs'].filter(s =>
        !(s === 'PM' && isSourceHidden('SP_PM')) &&
        !(s === 'Clubs' && isSourceHidden('SP_Clubs'))
    );
    if (visibleSources.length <= 2) {
        // Two-pill mode (Marauders: MU + Clubs; Townies: PM + MU): radio
        // behavior — same 2026-07-27 fix as toggleEventSource. A tap selects
        // just that source; tapping the ACTIVE pill returns to All.
        if (spActiveSources.size === 1 && spActiveSources.has(src)) {
            spAllMode = true;
            spActiveSources = new Set(['PM','MU','Clubs']);
        } else {
            spActiveSources = new Set([src]);
        }
    } else {
        // When switching from All, start fresh with just this source
        if (spActiveSources.size === 3 && spActiveSources.has('PM') && spActiveSources.has('MU') && spActiveSources.has('Clubs')) {
            spActiveSources = new Set([src]);
        } else {
            if(spActiveSources.has(src)) spActiveSources.delete(src);
            else spActiveSources.add(src);
        }
        // If all VISIBLE sources are active, switch to All mode.
        if (visibleSources.length > 0 && visibleSources.every(s => spActiveSources.has(s))) {
            spAllMode = true;
            // Ensure hidden sources are also in the set so event filter stays consistent
            spActiveSources = new Set(['PM','MU','Clubs']);
        }
    }
    spSportTag=null;
    updateSportsUI();
    renderSports();
    writeURLStateForView('sports');
};

function updateSportsUI(){
    const allBtn = document.getElementById('sp-src-all');
    if (allBtn) allBtn.classList.toggle('active', spAllMode);
    ['PM','MU','Clubs'].forEach(src=>{
        const btn=document.getElementById('sp-src-'+src.toLowerCase());
        if(!btn) return;
        btn.classList.toggle('active', !spAllMode && spActiveSources.has(src));
        // Hide PM pill for Marauders (unless they favorited PM sports);
        // Hide Clubs pill for Townies (unless they favorited Club Sports)
        let hidePill = false;
        if (src === 'PM') hidePill = isSourceHidden('SP_PM');
        else if (src === 'Clubs') hidePill = isSourceHidden('SP_Clubs');
        btn.style.display = hidePill ? 'none' : '';
    });
    document.getElementById('hgame-toggle').classList.toggle('active', spHomeOnly);
    // Past button active state — highlighted when viewing past games
    const pastBtn = document.getElementById('sp-past-toggle');
    if (pastBtn) pastBtn.classList.toggle('active', spTimeView === 'past');
    document.getElementById('sp-no-source').style.display = spActiveSources.size===0 ? 'block' : 'none';
    // "Clean state" for the clear-filters button: all sources on, no tag filter, no home-only,
    // viewing the default Upcoming tab. (Day/week paging no longer exists.)
    const isClean = spAllMode && !spHomeOnly && !spSportTag && spTimeView === 'upcoming' && !spFavOnlyMode;
    document.getElementById('sp-clear-btn').style.visibility = isClean ? 'hidden' : 'visible';
}

// Legacy no-op stubs — Sports page uses Upcoming/Past tabs now, not week nav
window.setSpMode = function(){};
window.spNavPrev = function(){};
window.spNavNext = function(){};

window.toggleHomeGameMode=function(){
    spHomeOnly=!spHomeOnly;
    updateSportsUI();
    renderSports();
    writeURLStateForView('sports');
};
window.clearSportsFilters=function(){
    spSportTag=null; spHomeOnly=false; spAllMode=true;
    spActiveSources=new Set(['PM','MU','Clubs']);
    spTimeView='upcoming';
    spFavOnlyMode=false;
    spDaysVisible = INITIAL_DAYS;
    spPastDaysVisible = INITIAL_DAYS_PAST;
    // Past-toggle button's active class is refreshed by updateSportsUI below
    updateSportsUI();
    renderSports();
    writeURLStateForView('sports');
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// ── Sports-page camps block (townie-only) ───────────────────────
// The Sports page goes quiet in summer (MU/PM seasons are over) — but that's
// exactly when youth sports camps run, so for LOCAL viewers we surface the
// athletic camps here as a standalone section at the top of the page (above the date/filter bar). Deliberately
// decoupled from the game render: it lives in its own container
// (#sp-camps-section, created once and inserted before the sticky date/filter bar),
// does NOT participate in the All/PM/MU + sport-type filters, the favorites
// filter, or the "Load more games (N)" count, and self-hides whenever there are
// no upcoming camps (so it simply vanishes in-season). Sports camps are the
// Athletic-Camp subset of program signups (isProgramSignup) PLUS hand-entered
// ticket packages (isTicketPackage — e.g. MU Football season tickets) — tech
// camps and Arts Smarts stay on the home Upcoming Signups box only. Marauders/unset
// viewers never see it (college kids aren't the audience for youth camps).
function renderSportsCamps() {
    const anchor = document.querySelector('#view-sports .sticky-nav-bar');
    if (!anchor || !anchor.parentNode) return;
    // Create the section container once, parked at the very top of the Sports view (above the date/filter bar).
    let section = document.getElementById('sp-camps-section');
    if (!section) {
        section = document.createElement('div');
        section.id = 'sp-camps-section';
        anchor.parentNode.insertBefore(section, anchor);
    }
    const hide = () => { section.style.display = 'none'; section.innerHTML = ''; };

    // Locals only — the default (Marauder/unset) viewer never sees youth camps.
    const isTownie = muAffiliation === 'townie';
    if (!isTownie || !allEvents || allEvents.length === 0) return hide();

    const nowMs = Date.now();
    const camps = allEvents
        .filter(c => (isProgramSignup(c) && (c.tags || []).includes('Athletic Camp')) || isTicketPackage(c))
        .map(c => ({ ...c, _start: new Date(c.date).getTime() }))
        .filter(c => !isNaN(c._start) && c._start >= nowMs)   // upcoming only → self-hides off-season
        .sort((a, b) => a._start - b._start);
    if (camps.length === 0) return hide();

    // Reuse the canonical event card in events-page mode (Family badge + a
    // "📝 Register Now" CTA, not a sports "Away" badge). The cloned object adds
    // registrationRequired so buildEventCard routes to the register CTA via
    // getRegisterUrl; the original event in allEvents is left untouched.
    const cards = camps
        .map(c => buildEventCard({ ...c, registrationRequired: true }, false))
        .join('');
    section.style.display = '';
    section.innerHTML =
        '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:4px 0 12px;">'
            + '<span style="font-size:1.05rem;font-weight:700;color:var(--text);">⚾ Sports Signups & Tickets</span>'
            + '<span style="font-size:0.8rem;color:var(--text-muted);">camps & ticket packages for locals — register now</span>'
        + '</div>'
        + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:14px;margin-bottom:24px;">'
            + cards
        + '</div>';
}

function renderSports(){
    renderSportsCamps();
    // Loading state: events.json hasn't returned yet. Show skeletons in the
    // sports container so the page doesn't flash empty.
    if (!allEvents || allEvents.length === 0) {
        document.getElementById('sp-events-container').innerHTML = renderSkeletonCards(4);
        document.getElementById('sp-sport-tags').innerHTML = '';
        updateSportsUI();
        return;
    }
    if(spActiveSources.size===0){
        document.getElementById('sp-events-container').innerHTML='';
        document.getElementById('sp-sport-tags').innerHTML='';
        updateSportsUI();
        return;
    }

    updateSportsUI();

    const today = todayMidnight();
    const todayStr = toDateStr(today);
    const isPast = spTimeView === 'past';
    // Date window:
    //   upcoming: today through today+spDaysVisible
    //   past:     today-spPastDaysVisible through yesterday
    const daysN = isPast ? spPastDaysVisible : spDaysVisible;
    const rangeStart = isPast ? toDateStr(addDays(today, -daysN)) : todayStr;
    const rangeEnd   = isPast ? toDateStr(addDays(today, -1))     : toDateStr(addDays(today, daysN));

    // Base filter (source + hidden-affiliation + home-game toggle) — applied to BOTH counts & visible
    const filterSport = (e) => {
        if (!isSportEvent(e)) return false;
        if (isSportsEventFromHiddenSource(e)) return false;
        const tags = e.tags || [];
        if (!Array.from(spActiveSources).some(src => matchesSportSource(tags, src))) return false;
        if (spHomeOnly && !tags.includes('Home Game Mode') && !tags.includes('H Games')) return false;
        return true;
    };
    const allMatching = allEvents.filter(filterSport);

    // Sport-type tag row uses only the visible window's events (matches what the user sees)
    const windowMatching = allMatching.filter(e => {
        const d = localDateStr(e.date);
        return d >= rangeStart && d <= rangeEnd;
    });
    renderSportTypeTags(windowMatching);

    // Apply sport-type filter after the tag bar is rendered
    let filtered = spSportTag ? windowMatching.filter(e => eventMatchesSportLabel(e.tags || [], spSportTag)) : windowMatching;

    // Sort: past view newest-first (so "most recent" is at top); upcoming oldest-first
    filtered.sort((a, b) => isPast ? (b._dateMs - a._dateMs) : (a._dateMs - b._dateMs));

    // Count of events beyond the current window (for "Load more" label)
    let beyondCount = 0;
    if (isPast) {
        beyondCount = allMatching.filter(e => localDateStr(e.date) < rangeStart
            && (!spSportTag || eventMatchesSportLabel(e.tags || [], spSportTag))).length;
    } else {
        beyondCount = allMatching.filter(e => localDateStr(e.date) > rangeEnd
            && (!spSportTag || eventMatchesSportLabel(e.tags || [], spSportTag))).length;
    }

    const container = document.getElementById('sp-events-container');
    if (filtered.length === 0) {
        const sourceList = Array.from(spActiveSources);
        const sourceLabel = sourceList.length <= 2 ? sourceList.join(', ') : sourceList.length + ' sources';
        const windowText = isPast ? 'past ' + daysN + ' days' : 'next ' + daysN + ' days';
        let msg, hint = '';
        if (spHomeOnly && spSportTag) {
            msg = '🏠 No home ' + spSportTag.toLowerCase() + ' games ' + (isPast ? 'recently' : 'coming up') + '.';
            hint = 'Try turning off the home-only filter or picking a different sport.';
        } else if (spHomeOnly) {
            msg = '🏠 No home games in the ' + windowText + '.';
            hint = 'Try turning off the home-only filter.';
        } else if (spSportTag) {
            msg = 'No ' + spSportTag.toLowerCase() + ' games ' + (isPast ? 'recently' : 'coming up') + '.';
            hint = 'Try selecting a different sport, or clear the sport filter.';
        } else if (!spAllMode) {
            msg = 'No games from ' + sourceLabel + (isPast ? ' recently' : ' coming up') + '.';
            hint = 'Try adding more sources.';
        } else {
            msg = isPast ? 'No past games in the ' + windowText + '.' : 'Nothing scheduled in the ' + windowText + '.';
            hint = beyondCount > 0 ? 'There are more games further out.' : (isPast ? 'Past games stream in after they finish.' : 'Check back later — new games come in hourly.');
        }
        let html = '<div class="empty-state"><p>' + msg + '</p><p style="font-size:0.82rem;color:var(--text-muted);margin-top:4px;">' + hint + '</p>';
        const anyFilterActive = spHomeOnly || spSportTag || !spAllMode || spFavOnlyMode || spTimeView === 'past';
        if (anyFilterActive) {
            html += '<button class="btn btn-sm btn-outline" onclick="clearSportsFilters()" style="margin-top:10px;">Clear all filters</button>';
        }
        html += '</div>';
        if (beyondCount > 0) html += '<button class="load-more-btn" onclick="spLoadMore()">Load more games (' + beyondCount + ' more available)</button>';
        container.innerHTML = html;
        return;
    }

    // Favorites UX: toolbar ⭐ Favs button shown whenever user has sport favorites.
    // Works in both Upcoming and Past views — users can jump to past games of their
    // favorite teams to see scores, or upcoming games to see what's next.
    const hasAnyPrefs = feedPrefs && feedPrefs.length > 0;
    const hasSportPrefs = hasAnyPrefs && feedPrefs.some(p => sportFeedIds.has(p));
    const sportFavCount = hasSportPrefs ? allMatching.filter(e => eventMatchesFeed(e)).length : 0;

    const spFavBtn = document.getElementById('sp-fav-toggle');
    if (spFavBtn) {
        spFavBtn.style.display = (hasSportPrefs && sportFavCount > 0) ? '' : 'none';
        spFavBtn.classList.toggle('active', spFavOnlyMode);
        spFavBtn.title = spFavOnlyMode ? 'Showing favorites only — tap to show all' : 'Jump to your favorites (' + sportFavCount + ')';
    }

    let html = '';
    let dayItems = filtered;

    // Setup hints — shown in upcoming view only, since past view is more of a "check results"
    // mode where a fresh user wouldn't be configuring favorites.
    if (!isPast) {
        if (!hasAnyPrefs) {
            html += '<div class="feed-setup-hint">⚙️ <a href="#" onclick="event.preventDefault();openFeedSettings();">Set up your favorites</a> to highlight your preferred games</div>';
        } else if (hasAnyPrefs && !hasSportPrefs) {
            html += '<div class="feed-setup-hint">No sport favorites set — <a href="#" onclick="event.preventDefault();openFeedSettings();">add some</a> to highlight them here</div>';
        }
    }

    // Apply favorites-only filter in BOTH upcoming and past views
    if (spFavOnlyMode && hasSportPrefs) {
        dayItems = filtered.filter(e => eventMatchesFeed(e));
        if (dayItems.length === 0) {
            const timeLabel = isPast ? 'past ' + daysN + ' days' : 'next ' + daysN + ' days';
            const kindLabel = isPast ? 'past favorite games' : 'upcoming favorite games';
            html += '<p class="empty-state">No ' + kindLabel + ' in the ' + timeLabel + '. <a href="#" onclick="event.preventDefault();spToggleFavOnly();">Show all games</a></p>';
            if (beyondCount > 0) html += '<button class="load-more-btn" onclick="spLoadMore()">Load more (' + beyondCount + ' more games)</button>';
            container.innerHTML = html;
            if (typeof refreshDayLabels === 'function') refreshDayLabels();
            return;
        }
    }

    // Day-grouped render
    const groups = groupEventsByDay(dayItems);
    html += groups.map(g => buildDayGroupHTML(g, e => buildEventCard(e, true))).join('');

    if (beyondCount > 0) {
        html += '<button class="load-more-btn" onclick="spLoadMore()">Load more games (' + beyondCount + ' more available)</button>';
    } else {
        html += '<div class="load-more-note">That\'s all ' + (isPast ? 'past' : 'scheduled') + ' games 👋</div>';
    }
    container.innerHTML = html;
    if (typeof refreshDayLabels === 'function') refreshDayLabels();
}

// Load the next batch in the active view (upcoming extends forward, past extends backward)
window.spLoadMore = function() {
    if (spTimeView === 'past') spPastDaysVisible += LOAD_MORE_INCREMENT_PAST;
    else spDaysVisible += LOAD_MORE_INCREMENT;
    renderSports();
};

// Toggle favorites-only filter on Sports (Upcoming view only)
window.spToggleFavOnly = function() {
    spFavOnlyMode = !spFavOnlyMode;
    renderSports();
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Toggle Past mode on the Sports page. Replaces the old two-tab Upcoming/Past switcher.
// When Past is on, the list shows completed games newest-first. When off, it shows
// scheduled games chronologically. The Clear ✕ button lights up when Past is on so
// users have an obvious way out (alongside tapping the Past button itself again).
// Favorites-only filter stays available in both modes so users can jump to past games
// of their favorite teams.
window.toggleSportsPast = function() {
    const newView = spTimeView === 'past' ? 'upcoming' : 'past';
    spTimeView = newView;
    spMode = newView; // keep legacy variable in sync
    // Reset the other view's day window so switching feels fresh
    if (newView === 'upcoming') spPastDaysVisible = INITIAL_DAYS_PAST;
    else spDaysVisible = INITIAL_DAYS;
    renderSports();
    writeURLStateForView('sports');
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Back-compat: callers that still expect setSportsTimeView (e.g. memoryEdits or tests)
window.setSportsTimeView = function(view) {
    if (view !== 'upcoming' && view !== 'past') return;
    if (spTimeView !== view) toggleSportsPast();
};

function renderSportTypeTags(baseEvents){
    const row=document.getElementById('sp-sport-tags');
    // Smart pill labels from the events in the window: split sports get a pill
    // per gender present ("Boys Soccer"); single sports get one pill ("Field
    // Hockey", "Cross Country"). Sorted by sport then gender so Boys/Girls sit together.
    const labels=new Map(); // label -> sport display name (sort key)
    baseEvents.forEach(e=>{
        const tags=e.tags||[];
        const level=sportLevelFromTags(tags);
        const sportTag=sportsList.find(s=>tags.indexOf(s)!==-1);
        if(!sportTag) return;
        const display=sportDisplayName(sportTag);
        let label=display;
        if(level && isSplitSport(level,sportTag)){
            const g=sportGendersFor(level,sportTag).find(x=>tags.indexOf(x)!==-1);
            if(!g) return; // split sport, no gender tag (e.g. a generic camp) — no sport pill
            label=g+' '+display;
        }
        labels.set(label, display);
    });
    if(labels.size===0){row.innerHTML='';return;}
    let html=`<button class="sport-pill ${!spSportTag?'active':''}" onclick="setSportType(null)">All Sports</button>`;
    Array.from(labels.keys()).sort((a,b)=>labels.get(a).localeCompare(labels.get(b))||a.localeCompare(b)).forEach(label=>{
        const feedSuffix=label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
        const esc=label.replace(/'/g,"\\'");
        html+=`<button class="sport-pill ${spSportTag===label?'active':''}" data-feed="sport-${feedSuffix}" onclick="setSportType('${esc}')">${label}</button>`;
    });
    row.innerHTML=html;
}
window.setSportType=function(sport){
    spSportTag=(spSportTag===sport)?null:sport;
    renderSports();
    writeURLStateForView('sports');
};

/* ==================== CARD BUILDER ==================== */
// Generate a minimal .ics (iCalendar) file and trigger a browser download.
// The file is the universal "add to calendar" format accepted by Apple Calendar,
// Google Calendar (as import), Outlook, Thunderbird, and mobile OS calendars.
// We keep the ICS body minimal — Anthropic spec compliance:
//   - DTSTART/DTEND use floating time (no TZID) since event.date strings vary in
//     how they encode timezone; most are America/New_York local time from scrapers.
//     Floating time means "the calendar treats this as local time wherever imported"
//     which is the sensible default for a local-community aggregator.
//   - DTEND defaults to DTSTART + 1 hour since most event sources don't include
//     end times. Users can adjust after import.
//   - UID uses the sourceLink (or title+date as fallback) so re-importing the same
//     event updates rather than duplicates in calendars that respect UID.
function buildICS(e) {
    const start = new Date(e.date);
    if (isNaN(start)) return null;
    const end = new Date(start.getTime() + 60 * 60 * 1000); // +1 hour default
    // ICS wants YYYYMMDDTHHMMSS (no punctuation) in floating local time
    const pad = n => String(n).padStart(2, '0');
    const fmt = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
        + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + '00';
    const now = new Date();
    const dtStamp = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
        + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z';
    // ICS requires \-escape of commas, semicolons, backslashes; newlines become \n literal
    const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    // Long lines should be folded at 75 octets per RFC 5545, but most clients accept
    // unfolded lines. Skipping fold logic for minimalism.
    // UID format: <title>-<date>@millersville.app, sanitized to allowed chars.
    // Previously was sourceLink-based, which collided for Borough events
    // (all sharing the same calendar-page URL) — calendar clients dedupe by
    // UID, so multiple Borough events would overwrite each other in
    // subscriber calendars. title+date is unique per event.
    const uid = (e.title + '-' + e.date).replace(/[^\w@.-]/g, '').substring(0, 200) + '@millersville.app';
    const summary = esc((e.title || 'Event').substring(0, 250));
    const location = esc((e.location || '').substring(0, 250));
    const description = esc(((e.description || '') + (e.sourceLink ? '\n\n' + e.sourceLink : '')).substring(0, 1500));
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Millersville.APP//Event//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        'UID:' + uid,
        'DTSTAMP:' + dtStamp,
        'DTSTART:' + fmt(start),
        'DTEND:' + fmt(end),
        'SUMMARY:' + summary
    ];
    if (location) lines.push('LOCATION:' + location);
    if (description) lines.push('DESCRIPTION:' + description);
    if (e.sourceLink) lines.push('URL:' + e.sourceLink);
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n');
}

// Click handler for card 📅 buttons. Builds the ICS, triggers a download.
// Filename uses a slugged version of the event title for easy recognition in
// the user's Downloads folder.
// Build a Google Calendar web URL for a given event. Opens the GCal "create event"
// form pre-filled with details. Universal fallback for platforms where .ics downloads
// don't trigger an "Add to Calendar" prompt — notably iOS Safari, which drops the file
// into the Files app instead of offering the calendar sheet.
function buildGoogleCalendarURL(e) {
    const start = new Date(e.date);
    if (isNaN(start)) return null;
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
        + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + '00Z';
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: (e.title || 'Event').substring(0, 200),
        dates: fmt(start) + '/' + fmt(end),
        details: ((e.description || '') + (e.sourceLink ? '\n\n' + e.sourceLink : '')).substring(0, 1500),
        location: (e.location || '').substring(0, 250)
    });
    return 'https://calendar.google.com/calendar/render?' + params.toString();
}

// Mobile detection: .ics file downloads are a poor UX on both iOS (Safari drops
// the file in the Files app) and Android (Chrome drops it in Downloads and the
// user has to tap through the notification to reach Calendar). On mobile we
// offer a chooser modal with Google Calendar as primary (works one-tap on
// every platform via a pre-filled web URL) and .ics as secondary fallback.
// Desktop keeps the simple .ics download — OS-level .ics handlers (macOS
// Calendar, Outlook, Thunderbird) are reliable there.
function isIOS() {
    const ua = navigator.userAgent || '';
    // iPad on iOS 13+ reports as "MacIntel" so also check for touch
    return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
}
function isAndroid() {
    return /Android/i.test(navigator.userAgent || '');
}
function isMobile() {
    return isIOS() || isAndroid();
}

window.addToCalendar = function(btn) {
    const key = btn.dataset.cardkey;
    if (!key) return;
    const e = (allEvents || []).find(ev => getEventKey(ev) === key);
    if (!e) return;
    if (isMobile()) {
        showCalendarChooser(e);
    } else {
        downloadICS(e);
    }
};

// Share action — Web Share API on mobile (native share sheet: iMessage,
// AirDrop, WhatsApp, etc.), clipboard copy fallback on desktop. Share text
// includes title, formatted date/time, location, and a link back to the
// event's source or millersville.app if no source URL exists.
window.shareEvent = function(btn) {
    const key = btn.dataset.cardkey;
    if (!key) return;
    const e = (allEvents || []).find(ev => getEventKey(ev) === key);
    if (!e) return;

    const d = new Date(e.date);
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const isAllDay = e.allDay === true;
    const timeStr = isAllDay ? '' : ` @ ${formatTime(d)}`;
    // Prefer the event's own source URL (recap page, MU Calendar entry, etc.)
    // as the share link since it's the most specific landing page. Fall back
    // to the site root for events without a source — the user landing there
    // can at least find the same item via Today's list.
    const link = e.sourceLink || 'https://millersville.app';
    const location = (e.location || '').trim();

    const title = e.title || 'Millersville event';
    // Body includes all essentials so a shared SMS/iMessage is self-contained
    // without relying on link previews (which don't always render).
    const body = `${title}\n📅 ${dateStr}${timeStr}${location ? '\n📍 ' + location : ''}\n\n${link}`;

    // Visual success feedback — flips the icon to a green check for 1.5s
    // so the user knows the action fired. Used on both the native-share
    // success path AND the clipboard fallback.
    const flashSuccess = () => {
        const originalText = btn.innerHTML;
        const originalColor = btn.style.color;
        btn.innerHTML = '✓';
        btn.style.color = '#16a34a';
        btn.style.borderColor = '#16a34a';
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.style.color = originalColor;
            btn.style.borderColor = '';
        }, 1500);
    };

    if (navigator.share) {
        navigator.share({ title, text: body, url: link })
            .then(flashSuccess)
            .catch(err => {
                // AbortError = user dismissed the share sheet; don't treat as failure.
                if (err && err.name === 'AbortError') return;
                // Other errors (permission denied, etc.) — fall back to clipboard.
                copyToClipboardFallback();
            });
    } else {
        copyToClipboardFallback();
    }

    function copyToClipboardFallback() {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(body)
                .then(flashSuccess)
                .catch(() => {
                    // Clipboard API unavailable or blocked. Last resort:
                    // prompt() the text so user can manually copy. Rare path
                    // on modern browsers with HTTPS.
                    window.prompt('Copy this text to share:', body);
                });
        } else {
            window.prompt('Copy this text to share:', body);
        }
    }
};

// Trigger .ics download (desktop / Android primary path)
function downloadICS(e) {
    const ics = buildICS(e);
    if (!ics) return;
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const slug = (e.title || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60) || 'event';
    const a = document.createElement('a');
    a.href = url;
    a.download = slug + '.ics';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

// Mobile chooser modal. Google Calendar is the primary action — a pre-filled web
// URL works one-tap on both iOS (opens in browser / Google Calendar app) and
// Android (hands off to the GCal app if installed, otherwise web). The .ics
// download remains as a secondary option for users on Apple Calendar, Outlook,
// Samsung Calendar, etc. — the label is device-neutral since .ics isn't
// Apple-specific.
function showCalendarChooser(e) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.onclick = ev => { if (ev.target === overlay) overlay.remove(); };
    const gcalUrl = buildGoogleCalendarURL(e);
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:360px;width:100%;padding:20px;text-align:center;';
    modal.innerHTML = `
        <h3 style="margin:0 0 8px;font-size:1rem;">Add to Calendar</h3>
        <p style="font-size:0.82rem;color:var(--text-muted);margin:0 0 16px;">Which calendar do you use?</p>
        <div style="display:flex;flex-direction:column;gap:8px;">
            ${gcalUrl ? `<a href="${gcalUrl}" target="_blank" onclick="this.closest('div[style*=fixed]').remove();" class="btn btn-sm btn-ticket" style="padding:10px;text-decoration:none;">📆 Google Calendar</a>` : ''}
            <button onclick="this.closest('div[style*=fixed]').remove();downloadICS(window.__calEvent);" class="btn btn-sm btn-outline" style="padding:10px;">📥 Apple Calendar / Other (.ics)</button>
            <button onclick="this.closest('div[style*=fixed]').remove();" style="background:none;border:none;color:var(--text-muted);font-size:0.82rem;cursor:pointer;padding:6px;margin-top:4px;">Cancel</button>
        </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    // Stash the event on window so the inline handler can reach it after the closure
    window.__calEvent = e;
}
window.downloadICS = downloadICS;

function cleanLocation(loc) {
    if (!loc) return '';
    let cleaned = loc;
    // "ACampus Campuswide ALL" (and close variants) is a scraper artifact where
    // MU's audience/location codes get concatenated for events with no real
    // venue — campus-wide markers like holidays, evaluation periods, and
    // fiscal-year dates. Normalize the whole thing to a clean "Campus Wide".
    if (/campus\s*wide/i.test(cleaned)) {
        return 'Campus Wide';
    }
    // Strip the AcCALEN building code — MU uses it as a placeholder for
    // campus-wide calendar markers without a real venue. Match anywhere in
    // the string since the API returns variations: "AcCALEN", "AcCalen Spring".
    if (/\bAccalen\b/i.test(cleaned)) {
        cleaned = cleaned.replace(/\bAccalen\b\s*/gi, '').trim();
        if (!cleaned) cleaned = 'Millersville University';
    }

    // Building-name abbreviations. Apply BEFORE the duplicate-prefix dedup so
    // "Student Memorial Center" reduces to "SMC" first, then dedup catches
    // any "SMC SMC Commons" that survives. Same for the Reighard room name —
    // the long "Reighard Multi Purpose Room" wastes screen space on a phone
    // when "Reighard MPR" is universally understood on campus.
    cleaned = cleaned.replace(/\bStudent Memorial Center\b/gi, 'SMC')
                     .replace(/\bReighard Multi Purpose Room\b/gi, 'Reighard MPR');

    // Strip duplicated building-code prefixes from MU calendar data. The
    // raw API returns strings like "SMC SMC Commons" or "WARE Ware Center"
    // where the building code is prepended even though the venue name
    // already contains it.
    const dupRepeat = /^([A-Z]{2,6})\s+\1\b/;
    if (dupRepeat.test(cleaned)) {
        cleaned = cleaned.replace(dupRepeat, '$1');
    } else {
        const codePrefix = /^([A-Z]{2,6})\s+([A-Z][a-z]+)/;
        const m = cleaned.match(codePrefix);
        if (m && m[2].toLowerCase().startsWith(m[1].toLowerCase())) {
            cleaned = cleaned.slice(m[1].length + 1);
        }
    }

    // Fix upstream typo. MU Athletics' Sidearm calendar consistently misspells
    // Shippensburg as "Shippingsburg" (with extra 'i'). The town and the
    // university are both Shippensburg. Normalize on output since we can't
    // fix MU's data at the source.
    cleaned = cleaned.replace(/\bShippingsburg\b/g, 'Shippensburg');

    // Specific cleanups kept as a safety net.
    cleaned = cleaned.replace(/^Ware Center\s+(?!,)/, 'Ware Center, ');
    return cleaned;
}
// Whether an event is free admission. Lets us tell a real purchase link
// ("Buy Tickets") apart from an info/RSVP page that a free event happens to
// carry in ticketLink. Free community events (price "Free") were wrongly showing
// a ticket icon + "Buy Tickets" just because they had an info link.
function eventIsFree(e){
    const p = String((e && e.price) || '').trim().toLowerCase();
    return p === 'free' || p === 'free entry' || p === 'free admission' || p === 'free!' || /^\$?0(\.0+)?$/.test(p);
}

function buildEventCard(e,isSportsPage){
    const d=new Date(e.date), tags=e.tags||[];
    const priceText=e.price?e.price.toString():"Free";
    const isFree=!e.price||eventIsFree(e);
    const hasLink=e.ticketLink&&e.ticketLink.trim()!=="";
    const isHome=tags.includes('Home Game Mode')||tags.includes('H Games');

    // Determine main source label
    let sourceLabel='';
    if(tags.includes('VFW')) sourceLabel='VFW';
    else if(tags.includes('Other')&&tags.includes('Live Music')) sourceLabel='Phantom Power';
    else if(tags.includes('Borough')) sourceLabel='Borough';
    else if(tags.includes('Manor')) sourceLabel='Manor Twp.';
    else if(tags.includes('PM')) sourceLabel='PM';
    else if(tags.includes('MU')) sourceLabel='MU';

    const hiddenTags=[...topSources,...sportMetaTags,'MU Calendar','Penn Manor','Clubs/Orgs','Phantom Power','VFW','Live Music','Other','Human Resources','Office of the Provost','Office of VP for Finance and Administration','Advancement Department'];
    // Townie-friendly label swap: "GetInvolved" is MU-internal jargon. Only actual townies
    // see it as "Community" — unset/Marauder users see the original label since the default
    // is now Marauder mode.
    const relabelForTownie = (tag) => (muAffiliation === 'townie' && tag === 'GetInvolved') ? 'Community' : tag;
    // Collapse specific residence halls to the generic category (see source-pill
    // note): if "Residence Halls" is present, drop any specific-hall tag.
    const hideResHall = (t) => tags.includes('Residence Halls') && t !== 'Residence Halls' && /residence hall/i.test(t);
    const displayTags=tags.filter(t=>!hiddenTags.includes(t) && !hideResHall(t) && GENDER_TAGS.indexOf(t)===-1).map(relabelForTownie);
    let tagHtml=sourceLabel?`<span class="card-tag">${sourceLabel}</span>`:'';
    // Multi-day pill — annotated by groupEventsByDay when an event appears on
    // a day other than its start (or on Day 1 of a multi-day span). Helps
    // users distinguish "this event continues" from "this is a fresh event".
    // Only the day in question varies — the card otherwise renders identically
    // across all days the event covers.
    if (e._dayNumber && e._totalDays > 1) {
        tagHtml += `<span class="card-tag card-tag-multiday">Day ${e._dayNumber} of ${e._totalDays}</span>`;
    }
    tagHtml+=displayTags.map(t=>`<span class="card-tag">${t}</span>`).join('');

    // Score badge for completed games — large, top-right corner
    let scoreBadge='';
    let cardResultClass='';
    if(isSportsPage && e.gameResult && e.gameScore){
        const isWin = e.gameResult==='W';
        const isLoss = e.gameResult==='L';
        cardResultClass = isWin ? 'card-win' : isLoss ? 'card-loss' : 'card-tie';
        scoreBadge=`<div class="score-corner ${isWin?'score-win':isLoss?'score-loss':'score-tie'}"><span class="score-result">${e.gameResult}</span><span class="score-value">${e.gameScore}</span></div>`;
    }

    // Dynamic live check (doesn't rely on scraper's hourly isLive flag).
    // Multi-day events (festivals, multi-day track meets) are never "live" —
    // displaying a 72-hour LIVE badge is misleading. v1: per-day windows
    // would require day-by-day scrapes; for now, multi-day = never live.
    const now = new Date();
    const eventEnd = getEventEndTime(e) || new Date(d.getTime() + 3*60*60*1000);
    const isCurrentlyLive = isSportsPage && e.streamLink && d <= now && now <= eventEnd && !e.gameResult && !isMultiDay(e);
    const isPast = isSportsPage && d < now && !isCurrentlyLive;

    // Live badge
    let liveBadge='';
    if(isCurrentlyLive){
        liveBadge=`<a href="${e.streamLink}" target="_blank" class="badge badge-live">🔴 LIVE</a>`;
    }

    // Action buttons
    let actionHtml='';
    const isFuture = isSportsPage && d > now;
    if(isCurrentlyLive && e.streamLink){
        actionHtml=`<a href="${e.streamLink}" target="_blank" class="btn btn-sm btn-live">📺 Watch</a>`;
    } else if(isFuture && e.streamLink){
        actionHtml=`<a href="${e.streamLink}" target="_blank" class="btn btn-sm btn-outline" style="border-color:var(--gold);color:var(--gold);">📺 Live Stream</a>`;
    } else if(isPast && e.streamLink){
        actionHtml=`<a href="${e.streamLink}" target="_blank" class="btn btn-sm btn-outline">📺 Replay</a>`;
    } else if(!isSportsPage && e.streamLink){
        actionHtml=`<a href="${e.streamLink}" target="_blank" class="btn btn-sm btn-outline">📺 Stream</a>`;
    } else if(isRegistrationEvent(e) && getRegisterUrl(e)){
        // Registration event → "Register Now" (signup page), not a ticket link.
        // Reuses .btn-ticket styling (green CTA); stopPropagation so the click
        // opens the signup page instead of the card's detail modal.
        // TICKET PACKAGES (isTicketPackage, 2026-08-06): a purchase, not a
        // signup — same green CTA, label "🎟 Buy Tickets"; the link is
        // unchanged (getRegisterUrl falls back to sourceLink, the packages page).
        const regCtaLabel = isTicketPackage(e) ? '🎟 Buy Tickets' : '📝 Register Now';
        actionHtml=`<a href="${escHtml(getRegisterUrl(e))}" target="_blank" rel="noopener" class="btn btn-sm btn-ticket" onclick="event.stopPropagation();">${regCtaLabel}</a>`;
    } else if(hasLink && !isFree){
        actionHtml=`<a href="${e.ticketLink}" target="_blank" class="btn btn-sm btn-ticket">🎟 Tickets</a>`;
    } else if(!isFree){
        actionHtml=`<span class="badge badge-door">${priceText}</span>`;
    } else if(!isSportsPage && eventIsFree(e) && hasLink){
        // Free non-sports events that ALSO have a ticket/info link — events that
        // otherwise look ticketed (Summer Fun Series et al.). Keying on price alone
        // floods it (~600/677 default to "Free"), so the link is the signal that
        // this is a real event worth flagging as no-cost rather than a routine
        // meeting/lecture. Sports skip it (default free admission).
        actionHtml=`<span class="badge badge-free" style="background:var(--green);color:#fff;">Free</span>`;
    }

    // Game location badge (lower-left corner for sports) / Family badge for events
    let locBadge = '';
    if (isSportsPage) {
        if (isHome) locBadge = '<span class="game-loc-badge game-loc-home">🏠 Home</span>';
        else locBadge = '<span class="game-loc-badge game-loc-away">📍 Away</span>';
    } else if (e.kidFriendly) {
        locBadge = '<span class="game-loc-badge tag-family">👨‍👩‍👧 Family</span>';
    }

    // Hide time if event is explicitly all-day. Trusts the scraper's allDay
    // flag rather than guessing from "exactly 12:00". The old noon heuristic
    // misidentified real noon meetings (e.g. lunchtime club meetings) as
    // all-day.
    const isAllDay = e.allDay === true;
    const timeStr = isAllDay ? '' : ` @ ${formatTime(d)}`;

    // Student perks
    const benefits = e.benefits || [];
    let perkBadges = '';
    if (benefits.includes('Free Food')) perkBadges += '<span class="perk-badge perk-food">' + (e.perkFoodIcon || '🍕') + ' Free Food</span>';   // perkFoodIcon: per-event glyph override (Jesus Dogs 🌭)
    if (benefits.includes('Free Stuff')) perkBadges += '<span class="perk-badge perk-stuff">🎁 Free Stuff</span>';
    if (benefits.includes('Credit')) perkBadges += '<span class="perk-badge perk-credit">📚 Credit</span>';
    // Registration-required warning. Distinct from perks — this tells the user
    // "you can't just show up; check the linked source first." Shown on events
    // where Cowork flagged registrationRequired but no firm deadline was known.
    // (When a deadline IS known, scrape.js auto-hides the event past it.)
    // Ticket packages skip the registration pill — "Buy Tickets" says it
    // all, and "Registration required" misreads a purchase (2026-08-06).
    if (e.registrationRequired === true && !isTicketPackage(e)) perkBadges += '<span class="perk-badge perk-registration">📝 Registration required</span>';

    // Clean title
    const displayTitle = cleanSportTitle((e.title || '').replace(/^Millersville University\s*/i, '').replace(/ - (Girls|Boys)\s+(vs |@ )/i, ' $2'), e.tags || []);

    // Visual highlight for favorited cards. Replaces the old "pinned at top" behavior —
    // favorites now sit in their chronological day group with a gold accent so users can
    // spot them at a glance while scrolling. Uses isEventFavorited (not eventMatchesFeed)
    // because the latter returns true for all events when user has no prefs set.
    const isFav = (typeof isEventFavorited === 'function') && isEventFavorited(e);
    const favClass = isFav ? ' card-fav' : '';
    // One-tap favorite button — inline with title. Toggles the best-matching pref ID for
    // this event so the user doesn't have to open the settings modal for a simple pick.
    // For club events the ID is `club:<orgName>`; for MU sports it's the sport-specific ID;
    // everything else falls back to the broad source ID (e.g. `borough-all`). See
    // suggestFeedIdForEvent() for the mapping logic.
    const favId = (typeof suggestFeedIdForEvent === 'function') ? suggestFeedIdForEvent(e, isSportsPage) : null;

    // Description block — shown on event cards (not sports cards, where descriptions are
    // usually empty or boilerplate). Short descriptions render plain; longer ones get a
    // "more" link that toggles a `.expanded` class on the parent <div> via inline handler.
    // Kept inline rather than routed to the modal so users can scan multiple descriptions
    // at once without opening modals. Descriptions over 400 chars are truncated in the
    // scraper already (600 cap), so our 180-char preview is always smaller than the full.
    let descBlock = '';
    const desc = (e.description || '').trim();
    const PREVIEW_LEN = 180;
    if (desc && !isSportsPage) {
        // Escape via the central escHtml helper. Same protection as before
        // (the 5 HTML-significant chars), just one source of truth now.
        const escaped = escHtml(desc);
        if (desc.length <= PREVIEW_LEN) {
            descBlock = `<div class="card-desc"><p class="card-desc-text">${escaped}</p></div>`;
        } else {
            // Cut at a word boundary near PREVIEW_LEN so we don't truncate mid-word.
            let cut = desc.lastIndexOf(' ', PREVIEW_LEN);
            if (cut < PREVIEW_LEN - 30) cut = PREVIEW_LEN; // no word break nearby, use hard cut
            const preview = escHtml(desc.substring(0, cut));
            descBlock = `<div class="card-desc">
                <p class="card-desc-text card-desc-preview">${preview}… <a href="#" class="card-desc-more" onclick="event.preventDefault();event.stopPropagation();this.closest('.card-desc').classList.add('expanded');">more</a></p>
                <p class="card-desc-text card-desc-full">${escaped} <a href="#" class="card-desc-less" onclick="event.preventDefault();event.stopPropagation();this.closest('.card-desc').classList.remove('expanded');">less</a></p>
            </div>`;
        }
    }

    // Card-level identifier that addToCalendar uses to find the event in allEvents.
    // Uses sourceLink when available; otherwise title+date as a fallback (matches the
    // composite key strategy used by openEventDetails and search hit-handling).
    const cardKey = getEventKey(e).replace(/"/g, '&quot;');
    const calBtn = `<button class="btn-cal" data-cardkey="${cardKey}" onclick="event.stopPropagation();addToCalendar(this)" title="Add to calendar" aria-label="Add to calendar">📥</button>`;
    // Share button — uses Web Share API on mobile (native share sheet with
    // iMessage/AirDrop/Slack/etc.) and falls back to clipboard copy on
    // desktop browsers where navigator.share is undefined. Visual feedback
    // (✓) on the button itself confirms the copy worked on the fallback path.
    const shareBtn = `<button class="btn-share" data-cardkey="${cardKey}" onclick="event.stopPropagation();shareEvent(this)" title="Share" aria-label="Share">🔗</button>`;

    // Whole-card click opens the detail modal — the same one used by homepage
    // timeline and search results. All interactive children (star, calendar,
    // tickets, stream, description more/less) call stopPropagation so their
    // action wins over the card-level click.
    const modalKey = cardKey; // same composite key as cardKey
    const cardOnclick = `onclick="window.openEventDetails(&quot;${modalKey}&quot;)" style="cursor:pointer;"`;

    // Star renders inline before the title so it's visually anchored to the
    // event name rather than floating in the corner. Older layout used
    // position:absolute which forced ad-hoc left/right padding on the tags
    // row and title to avoid overlap — now the star is part of the title
    // flow line and those padding hacks are unnecessary.
    const inlineFavBtn = favId
        ? `<button class="card-fav-inline${isFav ? ' active' : ''}" onclick="event.stopPropagation();toggleCardFavorite('${favId.replace(/'/g, "\\'")}', this)" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}">${isFav ? '★' : '☆'}</button>`
        : '';

    return `<div class="app-card${isCurrentlyLive?' card-live':''} ${cardResultClass}${favClass}" data-event-key="${cardKey}" style="position:relative;" ${cardOnclick}>${scoreBadge}<div class="card-body">
        <div class="card-heading">${inlineFavBtn}<h3 class="card-title">${escHtml(displayTitle)}</h3></div>
        <p class="card-meta">📅 ${formatDate(d)}${timeStr}</p>
        <p class="card-meta">📍 ${escHtml(cleanLocation(e.location))}</p>
        ${tagHtml || liveBadge ? `<div class="card-tags card-tags-secondary">${tagHtml}${liveBadge}</div>` : ''}
        ${descBlock}
        ${perkBadges?`<div class="perk-row">${perkBadges}</div>`:''}
    </div><div class="card-footer"><div class="card-actions">${locBadge}${calBtn}${shareBtn}${actionHtml}</div></div></div>`;
}

/* ==================== HOME ==================== */
function renderHomeUI(){
    const now = new Date();
    if (!homeViewDate) homeViewDate = todayMidnight();
    const todayD = todayMidnight();
    const isToday = toDateStr(homeViewDate) === toDateStr(todayD);
    const viewDateStr = toDateStr(homeViewDate);
    const hasFeed = feedPrefs && feedPrefs.length > 0;

    // Update the day-navigator label and Today-snap-back visibility. The
    // label uses fmtDateLabel for consistent formatting ("Today, Apr 28" vs
    // "Tue, Apr 29"). Today button hidden when already on today since it
    // would be a no-op. When on today we show "Today – Fri, May 21" — the date
    // moved here from the weather bar (whose right slot now holds the MBA
    // spotlight rotation).
    const dayLabelEl = document.getElementById('home-day-label');
    if (dayLabelEl) {
        const todayDateStr = homeViewDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const labelText = isToday ? ('Today – ' + todayDateStr) : fmtDateLabel(homeViewDate);
        dayLabelEl.textContent = labelText;
    }
    const todayBtn = document.getElementById('home-day-today');
    if (todayBtn) todayBtn.style.display = isToday ? 'none' : '';

    // ===== COMBINED TIMELINE: games + events sorted by time =====
    // Filter against the currently-selected home view date. Same audience and
    // source filtering as before — date is the only thing that changes.
    const dayEvents = allEvents.filter(e => {
        if(localDateStr(e.date) !== viewDateStr) return false;
        if(isHiddenForViewer(e)) return false;
        if(isEventFromHiddenSource(e)) return false;
        if(isSportsEventFromHiddenSource(e)) return false;
        if((e.tags||[]).includes('Clubs/Orgs') && e.audience !== 'public' && muAffiliation === 'townie') return false;
        return true;
    }).sort((a,b) => a._dateMs - b._dateMs);

    const timeline = document.getElementById('home-timeline');
    if(dayEvents.length === 0){
        // Show next upcoming items relative to viewed day. Slightly different
        // copy depending on whether user is on today or another day.
        const upcoming = allEvents.filter(e => {
            const d = localDateStr(e.date);
            if (d <= viewDateStr) return false;
            if (isHiddenForViewer(e)) return false;
            if (isEventFromHiddenSource(e)) return false;
            if (isSportsEventFromHiddenSource(e)) return false;
            if ((e.tags||[]).includes('Clubs/Orgs') && e.audience !== 'public' && muAffiliation === 'townie') return false;
            return true;
        }).sort((a,b) => a._dateMs - b._dateMs).slice(0, 5);
        const noneCopy = isToday
            ? 'Nothing scheduled today.'
            : 'Nothing scheduled on ' + fmtDateLabel(homeViewDate) + '.';
        if (upcoming.length > 0) {
            // Build the "Coming up next" list with day-of-week subheadings.
            // Each event already has its time displayed, but without date
            // context, a list of "1:00 PM, 4:00 PM, 4:30 PM" looks like
            // a single day's schedule when it's actually events scattered
            // across the next several days/weeks. Inserting a small day
            // header whenever the date changes between consecutive events
            // gives users the temporal context to scan the list.
            let html = '<p class="home-empty">' + noneCopy + ' Coming up next:</p>';
            let lastDateStr = null;
            for (const e of upcoming) {
                const evDate = new Date(e._dateMs);
                const dStr = toDateStr(evDate);
                if (dStr !== lastDateStr) {
                    html += '<div class="tl-day-divider">' + fmtDateLabel(evDate) + '</div>';
                    lastDateStr = dStr;
                }
                html += buildTimelineItem(e, now);
            }
            timeline.innerHTML = html;
        } else {
            timeline.innerHTML = '<p class="home-empty">' + noneCopy + '</p>';
        }
    } else if (hasFeed) {
        const favs = dayEvents.filter(e => eventMatchesFeed(e));
        const others = dayEvents.filter(e => !eventMatchesFeed(e));
        const allLabel = isToday ? 'All Today' : 'All ' + fmtDateLabel(homeViewDate);
        let html = '';
        if (favs.length > 0) {
            html += '<div class="feed-pinned-header"><span>⚡ My Favorites</span></div>';
            html += favs.map(e => buildTimelineItem(e, now)).join('');
            if (others.length > 0) html += '<div class="feed-divider"><span>' + allLabel + '</span></div>';
        } else {
            const noFavCopy = isToday ? 'No favorites scheduled today' : 'No favorites scheduled';
            html += '<p class="home-empty">' + noFavCopy + '</p>';
            html += '<div class="feed-divider"><span>' + allLabel + '</span></div>';
        }
        html += others.map(e => buildTimelineItem(e, now)).join('');
        timeline.innerHTML = html;
    } else {
        timeline.innerHTML = dayEvents.map(e => buildTimelineItem(e, now)).join('');
    }

    // ===== LATEST NEWS (compact text links) =====
    const newsContainer = document.getElementById('home-news-list');
    // Filter PM/Borough news out for marauders (unless favorited) so the home
    // feed matches the main News page's marauder-default behavior.
    let latestNews = (currentNews || []).filter(n => !isNewsFromHiddenSource(n)).slice(0, 12);
    if (hasFeed) {
        const favNews = latestNews.filter(n => newsMatchesFeed(n));
        const otherNews = latestNews.filter(n => !newsMatchesFeed(n));
        latestNews = [...favNews, ...otherNews];
    }
    latestNews = latestNews.slice(0, 5);
    if(latestNews.length === 0){
        newsContainer.innerHTML = '<p class="home-empty">No news available</p>';
    } else {
        const sourceDisplay = {'Millersville News':'MU','The Snapper':'Snapper','MU Athletics':'MU Athletics','MU Review':'MU Review','Penn Manor News':'PM','Millersville Borough':'Borough'};
        newsContainer.innerHTML = latestNews.map(n => {
            const src = sourceDisplay[n.source] || n.source;
            return `<a href="${escHtml(n.link)}" target="_blank" class="home-news-item"><span class="home-news-src">${escHtml(src)}</span><span class="home-news-title">${escHtml(decodeEntities(n.title))}</span></a>`;
        }).join('');
    }

    // Upcoming Signups — surfaced to TOWNIES as a standing reminder regardless
    // of which day they're viewing. Two sources: (1) events with a
    // registrationDeadline within ~1 month (youth sports + PM community
    // events with deadlines), shown with a countdown and also present on the
    // calendar; (2) open-ended youth registrations flagged closesTBA (open now,
    // no announced close date), shown without a countdown and reminder-only.
    // Hidden for marauders/students and when both sources are empty.
    const signupsSection = document.getElementById('home-signups-section');
    const signupsList = document.getElementById('home-signups-list');
    if (signupsSection && signupsList) {
        const nowMs = Date.now();
        // How far ahead of a registration's DEADLINE we start showing an
        // already-open signup. ~1 month gives enough lead time to act without
        // surfacing it so early it's irrelevant (e.g. a winter sport's deadline
        // shouldn't appear in summer). Applies to open signups; closesTBA entries
        // (no deadline) show whenever active (see note on tbaSignups).
        const SIGNUP_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
        // How far ahead of its OPEN date we start showing a not-yet-open signup,
        // as an "Opens <date>" heads-up (no countdown). ~1 week of "mark your
        // calendar" lead before registration actually opens.
        const OPEN_LEAD_MS = 7 * 24 * 60 * 60 * 1000;
        // How far ahead of a program's START date we surface its (open) signup.
        // Programs (camps, Arts Smarts) carry no deadline, so we anchor on the
        // start and show them within this window. 60d gives seasonal summer camps
        // real lead time; widen/narrow here (Infinity = show all upcoming).
        const PROGRAM_LEAD_MS = 60 * 24 * 60 * 60 * 1000;
        // How many signup rows to show before a "Show N more" toggle. Keeps the
        // box short on load so Today's Specials peeks above the fold and invites a
        // scroll; the toggle reveals the rest. Counts across all row types.
        const SIGNUPS_COLLAPSED_COUNT = 4;
        const isTownie = muAffiliation === 'townie';
        // (1) Deadline-based signups — events carrying registrationDeadline.
        // AUDIENCE SPLIT: intramural signups go to marauders (and unset, which
        // defaults to marauder behavior); youth / community signups go to townies.
        // Three states via the optional registrationOpens field: not-yet-open
        // (shown up to OPEN_LEAD_MS early as "Opens <date>"), open-now (shown
        // within SIGNUP_LEAD_MS of the deadline with a countdown), and closed
        // (deadline passed → hidden). Missing registrationOpens = treat as open
        // now (prior behavior). All also appear on the calendar, dated on the deadline.
        const upcoming = (allEvents || [])
            .filter(e => e && e.registrationDeadline)
            .filter(e => isTownie ? !isIntramural(e) : isIntramural(e))
            .map(e => {
                const _dl = new Date(e.registrationDeadline).getTime();
                const _opRaw = e.registrationOpens ? new Date(e.registrationOpens).getTime() : NaN;
                return { ...e, _dl, _op: isNaN(_opRaw) ? null : _opRaw };
            })
            .filter(e => {
                if (isNaN(e._dl) || e._dl < nowMs) return false;            // invalid or closed
                // Ticket packages (2026-08-06) skip the lead window entirely:
                // on sale the day the sheet row lands, gone at the deadline —
                // a ~5-week seasonal run, not a winter deadline that would
                // surface irrelevantly in summer.
                if (isTicketPackage(e)) return true;
                const notYetOpen = e._op !== null && e._op > nowMs;
                return notYetOpen
                    ? (e._op - nowMs) <= OPEN_LEAD_MS                       // opens within the heads-up window
                    : (e._dl - nowMs) <= SIGNUP_LEAD_MS;                    // open now, deadline within window
            })
            // Order by the most relevant upcoming moment: a not-yet-open signup
            // by when it opens, an open one by when it closes.
            .sort((a, b) => {
                const ak = (a._op !== null && a._op > nowMs) ? a._op : a._dl;
                const bk = (b._op !== null && b._op > nowMs) ? b._op : b._dl;
                return ak - bk;
            });
        // (2) Open-ended signups — youth registrations flagged closesTBA (open
        // now, no announced close date). Townie-only: these are community youth
        // registrations with no intramural equivalent. Sourced from the raw
        // registrations (allSignups), NOT the events array: with no deadline
        // there's no calendar date to place them on, so they're reminder-only
        // here. The closesTBA filter also means deadline-based youth regs (which
        // lack the flag) never double-render in this section.
        const tbaSignups = (isTownie ? (allSignups || []) : [])
            .filter(r => r && r.status === 'active' && r.closesTBA === true && r.registerLink)
            .sort((a, b) => (a.title || a.org || '').localeCompare(b.title || b.org || ''));

        // (3) Program signups — open-registration programs that live in the
        // events array with no deadline (camps + Arts Smarts; see isProgramSignup).
        // TOWNIE-only: not intramural, no MU-student equivalent. Anchored on the
        // START date and shown when upcoming within PROGRAM_LEAD_MS. Linked straight
        // to the register page (getRegisterUrl) like the closesTBA rows — their
        // event-detail modal CTA is a ticket/price badge, not a signup path.
        const programSignups = (isTownie ? (allEvents || []) : [])
            .filter(isProgramSignup)
            .map(e => ({ ...e, _start: new Date(e.date).getTime() }))
            .filter(e => !isNaN(e._start) && e._start >= nowMs && (e._start - nowMs) <= PROGRAM_LEAD_MS)
            .sort((a, b) => a._start - b._start);

        // Collapse the Millersville Tech & Engineering catalog (20+ weekly camps,
        // one provider: millersvilletechcamps.com) into a single row so it doesn't
        // bury the rest of the box. Grouped only at 2+; a lone tech camp renders
        // individually. The synthetic row flows through the same map below
        // (title / location / _start, with a registerLink to the catalog root).
        const isTechCamp = e => {
            const u = getRegisterUrl(e);
            return u.includes('millersvilletechcamps.com') || (e.location || '').includes('Tech & Engineering');
        };
        const techCamps = programSignups.filter(isTechCamp);
        let programRender = programSignups;
        if (techCamps.length >= 2) {
            let catalog = getRegisterUrl(techCamps[0]);          // earliest; list is start-sorted
            try { catalog = new URL(catalog).origin + '/'; } catch (_) {}
            programRender = programSignups
                .filter(e => !isTechCamp(e))
                .concat([{ _synthetic: true, _start: techCamps[0]._start, title: 'MU Tech & Engineering Camps', location: `${techCamps.length} summer camps`, registerLink: catalog }])
                .sort((a, b) => a._start - b._start);
        }

        if (upcoming.length > 0 || programSignups.length > 0 || tbaSignups.length > 0) {
            signupsSection.style.display = '';
            const deadlineRows = upcoming.map(e => {
                // Not-yet-open signups show an "Opens <date>" heads-up counting
                // up to the open date (no urgency styling — nothing's closing).
                // Open signups keep the deadline + closing countdown.
                const notYetOpen = e._op !== null && e._op > nowMs;
                let byLabel, daysText, urgency = '';
                if (notYetOpen) {
                    const opLabel = new Date(e._op).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    const daysToOpen = Math.ceil((e._op - nowMs) / (24 * 60 * 60 * 1000));
                    byLabel = `Opens ${opLabel}`;
                    daysText = daysToOpen <= 0 ? 'opens today' : daysToOpen === 1 ? 'opens tomorrow' : `in ${daysToOpen} days`;
                } else {
                    const dlLabel = new Date(e._dl).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    const daysLeft = Math.ceil((e._dl - nowMs) / (24 * 60 * 60 * 1000));
                    urgency = daysLeft <= 3 ? ' home-signup-urgent' : '';
                    byLabel = `by ${dlLabel}`;
                    daysText = daysLeft <= 0 ? 'closes today' : daysLeft === 1 ? '1 day left' : `${daysLeft} days left`;
                }
                // The scraper no longer prefixes youth titles with "Register
                // by <date>: ", but keep this strip as a defensive no-op so any
                // older cached event still reads cleanly here.
                const cleanTitle = (e.title || '').replace(/^Register by [^:]+:\s*/i, '');
                const sub = e.location && !cleanTitle.toLowerCase().includes(e.location.toLowerCase())
                    ? e.location : '';
                // Open the same event detail modal the timeline/cards use,
                // instead of jumping straight to the signup link — the modal's
                // "Register Now" button is the path to the signup page. Kept as
                // an <a> (with preventDefault) so existing styling and native
                // keyboard focus/activation are preserved.
                const signupKey = getEventKey(e);
                // Ticket packages get a 🎟 marker so the row reads as a
                // purchase, not a registration (2026-08-06); the popup's CTA
                // is the matching "🎟 Buy Tickets" link.
                const rowIcon = isTicketPackage(e) ? '🎟 ' : '';
                return `<a href="#" class="home-signup-item${urgency}" onclick="event.preventDefault();window.openEventDetails(${JSON.stringify(signupKey).replace(/"/g, '&quot;')})">
                    <div class="home-signup-main">
                        <span class="home-signup-org">${rowIcon}${escHtml(cleanTitle)}</span>
                        ${sub ? `<span class="home-signup-sub">${escHtml(sub)}</span>` : ''}
                    </div>
                    <div class="home-signup-deadline">
                        <span class="home-signup-by">${byLabel}</span>
                        <span class="home-signup-days">${daysText}</span>
                    </div>
                </a>`;
            });
            // Open-ended rows: no calendar event exists to open a modal for, so
            // these link straight to the registration page. "Open now / closes
            // TBA" replaces the date/countdown.
            const tbaRows = tbaSignups.map(r => {
                const titleText = (r.title && r.title.trim()) ? r.title.trim() : (r.org || 'Registration');
                const sub = r.org && !titleText.toLowerCase().includes(r.org.toLowerCase()) ? r.org : '';
                // Honor an Opens date on open-ended rows (2026-08-06): before
                // it, the label reads "Opens <date> / closes TBA" — "Open now"
                // was factually wrong for a not-yet-open registration (Rec
                // Basketball, opens 9/1). sync-candidates now emits `opens` on
                // TBA rows; older JSON without the field keeps the prior
                // "Open now" reading (graceful).
                const opMs = r.opens ? new Date(r.opens).getTime() : NaN;
                const tbaByLabel = (!isNaN(opMs) && opMs > nowMs)
                    ? `Opens ${new Date(opMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                    : 'Open now';
                return `<a href="${escHtml(r.registerLink)}" target="_blank" rel="noopener" class="home-signup-item">
                    <div class="home-signup-main">
                        <span class="home-signup-org">${escHtml(titleText)}</span>
                        ${sub ? `<span class="home-signup-sub">${escHtml(sub)}</span>` : ''}
                    </div>
                    <div class="home-signup-deadline">
                        <span class="home-signup-by">${tbaByLabel}</span>
                        <span class="home-signup-days">closes TBA</span>
                    </div>
                </a>`;
            });
            // Program rows: dated by START, linked straight to the register page.
            const programRows = programRender.map(e => {
                const startLabel = new Date(e._start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                const daysToStart = Math.ceil((e._start - nowMs) / (24 * 60 * 60 * 1000));
                const startsText = daysToStart <= 0 ? 'starts today' : daysToStart === 1 ? 'starts tomorrow' : `starts in ${daysToStart} days`;
                const cleanTitle = (e.title || '');
                const sub = e.location && !cleanTitle.toLowerCase().includes(e.location.toLowerCase()) ? e.location : '';
                const url = getRegisterUrl(e);
                // Real program events open the same popup card as the timeline (its CTA
                // is "Register Now" — see openEventDetails). The synthetic Tech-Camps
                // rollup has no backing event, so it keeps linking to the catalog.
                const openTag = e._synthetic
                    ? `<a href="${escHtml(url)}" target="_blank" rel="noopener" class="home-signup-item">`
                    : `<a href="#" class="home-signup-item" onclick="event.preventDefault();window.openEventDetails(${JSON.stringify(getEventKey(e)).replace(/"/g, '&quot;')})">`;
                return `${openTag}
                    <div class="home-signup-main">
                        <span class="home-signup-org">${escHtml(cleanTitle)}</span>
                        ${sub ? `<span class="home-signup-sub">${escHtml(sub)}</span>` : ''}
                    </div>
                    <div class="home-signup-deadline">
                        <span class="home-signup-by">Starts ${startLabel}</span>
                        <span class="home-signup-days">${startsText}</span>
                    </div>
                </a>`;
            });
            // Render order matches the prior concat: deadline, program, tba.
            const rows = [...deadlineRows, ...programRows, ...tbaRows];
            if (rows.length <= SIGNUPS_COLLAPSED_COUNT) {
                signupsList.innerHTML = rows.join('');
            } else {
                const moreCount = rows.length - SIGNUPS_COLLAPSED_COUNT;
                const moreLabel = `▾ Show ${moreCount} more`;
                signupsList.innerHTML =
                    rows.slice(0, SIGNUPS_COLLAPSED_COUNT).join('')
                    + `<div id="home-signups-more" style="display:none;">${rows.slice(SIGNUPS_COLLAPSED_COUNT).join('')}</div>`
                    + `<button type="button" class="btn btn-sm btn-outline" aria-expanded="false" aria-controls="home-signups-more" data-more-label="${moreLabel}" style="width:100%;margin-top:8px;font-size:0.8rem;" onclick="window.toggleSignupsMore(this)">${moreLabel}</button>`;
            }
        } else {
            signupsSection.style.display = 'none';
        }
    }

    // ===== FEED CTA =====
    const feedCta = document.getElementById('home-feed-cta');
    if (feedCta) feedCta.style.display = hasFeed ? 'none' : 'block';
}

function buildTimelineItem(e, now) {
    const d = new Date(e.date);
    const tags = e.tags || [];
    const isSport = isSportEvent(e) || isPMSportByTitle(e);
    const isHome = tags.includes('Home Game Mode') || tags.includes('H Games');

    // Source label / org pill. For marauders only (muAffiliation === 'student')
    // and when the event has an orgShortName, use that as the pill instead of
    // the generic "MU" — most marauder home items are MU events, so the "MU"
    // label conveys nothing. The org short name (e.g. "IAEM", "SGA", "Acacia")
    // tells them which group is hosting at a glance. Falls back to standard
    // logic when no orgShortName, or when townie (townies see PM/MU/Borough
    // distinction as meaningful, so keep generic).
    // Administrative/department org names that should NOT be used as the pill —
    // they're not student-facing host orgs (unlike "SGA" or "IAEM"). Events like
    // holidays, breaks, and fiscal-year markers carry these as orgName, and
    // showing "Human Resources" as a pill is wrong; these should read "MU".
    const ADMIN_ORGS = /^(Human Resources|Office of the Provost|Office of VP|Registrar|Office of Grants|Advancement Department|Advancement|SMC Operations|Cultural Affairs)/i;
    const orgIsAdmin = ADMIN_ORGS.test(e.orgShortName || e.orgName || '');

    // Residence-hall events: the specific hall (e.g. "Shenks Residence Hall")
    // is often the wrong org — staff pick a building/wing org by mistake when
    // creating the event. When the generic "Residence Halls" category tag is
    // present, prefer that vaguer-but-accurate label over the specific hall.
    const isResHall = tags.includes('Residence Halls');

    let src = '';
    if (muAffiliation === 'student' && isResHall) {
        src = 'Residence Halls';
    } else if (muAffiliation === 'student' && e.orgShortName && !isSport && !orgIsAdmin) {
        src = e.orgShortName;
    } else if ((e.location||'').trim() === 'Phantom Power' || tags.includes('Phantom Power')) src = 'Phantom Power';
    else if(tags.includes('VFW')) src = 'VFW';
    else if(tags.includes('Borough')) src = 'Borough';
    else if(tags.includes('Manor')) src = 'Manor';
    else if(tags.includes('Raney Cellars')) src = 'Raney Cellars';
    else if(tags.includes("Jack's Tavern")) src = "Jack's Tavern";
    else if(tags.includes('Jesus Dogs')) src = 'Jesus Dogs';
    else if(tags.includes('The Backyard')) src = 'The Backyard';
    else if(tags.includes('HUB')) src = 'The HUB';
    else if(tags.includes('PM') && isSport) src = 'PM';
    else if(tags.includes('PM')) src = 'PM';
    else if(tags.includes('MU') && isSport) src = 'MU';
    else if(tags.includes('MU')) src = 'MU';
    else if(tags.includes('Community')) src = 'Community';
    else src = 'Event';

    // Clean title — strip "Millersville University" prefix and redundant gender
    let title = e.title || '';
    title = cleanSportTitle(title.replace(/^Millersville University\s*/i, '').replace(/ - (Girls|Boys)\s+(vs |@ )/i, ' $2'), e.tags || []);

    // For marauders: when the org pill already shows the org name, strip the
    // org name out of the title to avoid redundant display. The scraper's
    // decorateGenericTitle prepends org names to bare titles like "Practice"
    // or "Meeting" so they read sensibly when no pill is present — but on
    // the marauder home view the pill IS the org, so showing the name twice
    // is noise. Townies don't have org pills so they keep the full title.
    if (muAffiliation === 'student' && e.orgName && e.orgShortName) {
        const orgPattern = e.orgName
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // escape regex chars
            .replace(/[''']/g, "[''']?")              // tolerate curly/straight quote variants
            .replace(/\s+/g, '\\s+');                  // tolerate whitespace variants
        const re = new RegExp(`(^|\\s)${orgPattern}(\\s|$)`, 'i');
        const stripped = title.replace(re, ' ').replace(/\s{2,}/g, ' ').trim();
        // Sanity guard — only use the stripped version if it's still
        // meaningful (≥ 4 chars). Otherwise the title was probably JUST
        // the org name and stripping would leave nothing useful.
        if (stripped.length >= 4 && stripped !== title) {
            title = stripped;
        }
    }

    // Append location to title in timeline view. Helps users at-a-glance
    // know where to go without opening the modal. Skipped for: empty/generic
    // locations, locations already mentioned in the title, very long
    // locations (full street addresses), and cases where the location
    // matches the org name (the pill already conveys it — avoids "Free
    // Lunch — The HUB" with [The HUB] pill, which is double display).
    const rawLoc = cleanLocation(e.location || '').trim();
    const genericLoc = /^(millersville university|millersville borough|phantom power|raney cellars brewing|jack'?s family tavern|campus|tba|tbd|online|virtual|zoom|n\/a|pa)$/i;
    const orgEqualsLoc = e.orgShortName && rawLoc.toLowerCase() === e.orgShortName.toLowerCase();
    if (rawLoc && rawLoc.length <= 35 && !genericLoc.test(rawLoc) && !orgEqualsLoc && !title.toLowerCase().includes(rawLoc.toLowerCase())) {
        title = `${title} — ${rawLoc}`;
    }

    // Time — uses the scraper's allDay flag. Real noon meetings now show
    // their actual time instead of being heuristic-guessed as "All Day".
    const isAllDay = e.allDay === true;
    const timeStr = isAllDay ? 'All Day' : formatTime(d);

    // Badges
    let badges = '';
    if (isSport && isHome) badges += '<span class="tl-badge tl-home">🏠</span>';
    if (e.kidFriendly) badges += '<span class="tl-badge tl-family">👨‍👩‍👧</span>';
    const benefits = e.benefits || [];
    if (benefits.includes('Free Food')) badges += '<span class="tl-badge tl-perk">' + (e.perkFoodIcon || '🍕') + '</span>';   // perkFoodIcon: per-event glyph override (Jesus Dogs 🌭)
    if (benefits.includes('Free Stuff')) badges += '<span class="tl-badge tl-perk">🎁</span>';
    if (e.registrationRequired === true) badges += isTicketPackage(e)
        ? '<span class="tl-badge tl-registration" title="Ticket packages">🎟</span>'
        : '<span class="tl-badge tl-registration" title="Registration required">📝</span>';
    // Multi-day annotation (Day 2 of 3, etc.) — set by groupEventsByDay when
    // an event spans multiple calendar days. Renders before LIVE/score so the
    // user sees "this is part of a multi-day event" first.
    if (e._dayNumber && e._totalDays > 1) {
        badges += `<span class="tl-badge tl-multiday">Day ${e._dayNumber}/${e._totalDays}</span>`;
    }

    // Live / Score — same end-time + multi-day rules as card render.
    const _end = getEventEndTime(e) || new Date(d.getTime() + 3*60*60*1000);
    const _live = isSport && e.streamLink && d <= now && now <= _end && !e.gameResult && !isMultiDay(e);
    if (_live) badges += '<span class="badge badge-live" style="font-size:0.6rem;padding:1px 6px;">LIVE</span>';
    if (e.gameResult && e.gameScore) {
        const cls = e.gameResult==='W' ? 'tl-win' : e.gameResult==='L' ? 'tl-loss' : 'tl-tie';
        badges += `<span class="tl-badge ${cls}">${e.gameResult} ${e.gameScore}</span>`;
    }

    // Stream icon for games with Hudl broadcast data. Three states:
    //   - Future game + not yet started → "Stream scheduled" (Hudl has
    //     planned broadcast but it's not live yet — tooltip makes this
    //     clear rather than misleading users into thinking it's active).
    //   - Currently in game window → no separate icon; the LIVE badge
    //     above already announces the active stream with higher prominence.
    //   - Past game → "Replay available" (Hudl archives post-game).
    let streamBtn = '';
    if (isSport && e.streamLink && !_live) {
        if (d > now) {
            streamBtn = `<span class="tl-stream" title="Stream scheduled">📺</span>`;
        } else if (e.gameResult) {
            streamBtn = `<span class="tl-stream" title="Replay available">📺</span>`;
        }
    }

    // Ticket icon ONLY for genuinely ticketed events: a ticket link AND a non-free
    // price. For sports, MU's iCal only attaches a "Tickets:" URL to paid games, so
    // the link alone is a reliable signal there. But free non-sport events (e.g. the
    // Summer Fun Series) carry an info-page link in ticketLink and must NOT look like
    // a paid event — hence the eventIsFree() gate. Click opens the link and stops
    // propagation so the card's modal doesn't also fire.
    const hasTicket = !!(e.ticketLink && e.ticketLink.trim());
    let ticketBtn = '';
    if (hasTicket && !eventIsFree(e)) {
        const safeUrl = e.ticketLink.replace(/"/g, '&quot;');
        ticketBtn = `<a href="${safeUrl}" target="_blank" rel="noopener" class="tl-ticket" title="Buy tickets" onclick="event.stopPropagation();">🎟️</a>`;
    }
    // "Free" badge ONLY for free non-sport events that ALSO carry a ticket/info
    // link — i.e. events that otherwise look ticketed (Summer Fun Series, Candle
    // Lighting, Wreaths Across America) and are worth flagging as no-cost. Keying
    // on price alone floods it: ~600 of 677 events default to price "Free", most
    // of them routine meetings/lectures with no link that shouldn't be badged.
    let freeBadge = '';
    if (!isSport && eventIsFree(e) && hasTicket) {
        freeBadge = `<span class="tl-free" title="Free event" style="background:var(--green);color:#fff;font-size:0.62rem;font-weight:700;padding:1px 6px;border-radius:8px;">Free</span>`;
    }

    // Use event's sourceLink as unique identifier for the detail modal lookup.
    // Falls back to title+date composite for events without sourceLink.
    const eventKey = getEventKey(e);
    const typeClass = isSport ? ' tl-sport' : ' tl-event';
    // Add fav class so favorited events get the gold accent on the timeline
    // immediately at render time. Surgical updates in toggleCardFavorite
    // toggle this class without rebuilding the timeline.
    const tlFavClass = (typeof isEventFavorited === 'function' && isEventFavorited(e)) ? ' tl-fav' : '';

    // Wrap badges + stream icon in a single flex cluster so they stay
    // right-anchored and never wrap to a new line below the title.
    // Empty cluster is hidden via `.tl-badges:empty { display: none; }` in CSS.
    return `<div class="tl-item${typeClass}${tlFavClass}" data-event-key="${eventKey.replace(/"/g, '&quot;')}" onclick="window.openEventDetails(${JSON.stringify(eventKey).replace(/"/g, '&quot;')})">
        <span class="tl-time">${timeStr}</span>
        <div class="tl-content">
            <span class="tl-src${isSport?'':' tl-src-event'}">${src}</span>
            <span class="tl-title">${title}</span>
            <span class="tl-badges">${badges}${freeBadge}${streamBtn}${ticketBtn}</span>
        </div>
    </div>`;
}

// Event detail modal — shown when a user clicks a timeline card (home) or search result.
// Looks up event by key (sourceLink or title|date composite), renders title/time/location/
// description/tags/benefits, and provides buttons to open source link or tickets.
window.openEventDetails = function(key) {
    if (!key) return;
    const e = allEvents.find(ev => getEventKey(ev) === key);
    if (!e) return;

    const d = new Date(e.date);
    const tags = e.tags || [];
    const isSport = isSportEvent(e) || isPMSportByTitle(e);
    const isHome = tags.includes('Home Game Mode') || tags.includes('H Games');
    const isAllDay = e.allDay === true;
    // Build the time/date display. Three shapes:
    //   - Multi-day: "Apr 28 – Apr 30" (no clock times — dates only).
    //   - Same-day with end time: "Friday, May 1, 2026 · 5:00 PM – 7:00 PM"
    //   - All-day: "Friday, May 1, 2026 · All Day"
    // End time may come from the scraper (real DTEND/durationSeconds) or fall
    // back to a sport/type default; consumer doesn't care which.
    const endD = getEventEndTime(e);
    const multiDay = isMultiDay(e);
    let timeStr, dateStr;
    if (multiDay && endD) {
        // Date range only — clock times rarely meaningful for festivals/meets.
        const startDateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const endDateLabel = endD.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        dateStr = `${startDateLabel} – ${endDateLabel}`;
        timeStr = '';
    } else {
        dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        if (isAllDay) {
            timeStr = 'All Day';
        } else if (endD && endD.getTime() > d.getTime()) {
            timeStr = `${formatTime(d)} – ${formatTime(endD)}`;
        } else {
            timeStr = formatTime(d);
        }
    }

    // Source label (reuse logic from buildTimelineItem)
    let src = '';
    if(tags.includes('VFW')) src = 'VFW';
    else if(tags.includes('Borough')) src = 'Borough';
    else if(tags.includes('Manor')) src = 'Manor';
    else if(tags.includes('Raney Cellars')) src = 'Raney Cellars';
    else if(tags.includes("Jack's Tavern")) src = "Jack's Tavern";
    else if(tags.includes('Jesus Dogs')) src = 'Jesus Dogs';
    else if(tags.includes('The Backyard')) src = 'The Backyard';
    else if(tags.includes('HUB')) src = 'The HUB';
    else if(tags.includes('PM')) src = 'PM';
    else if(tags.includes('MU')) src = 'MU';
    else if(tags.includes('Community')) src = 'Community';
    else src = 'Event';

    // Badges row — home/family only. Score is shown in the dedicated scoreSummary
    // block below (more readable: "Millersville 4, Holy Family 2 – Final (W)"
    // beats a plain "W 4-2" pill). Perks get their own high-visibility strip.
    let badges = '';
    if (isSport && isHome) badges += '<span class="tl-badge tl-home">🏠 Home</span>';
    if (e.kidFriendly) badges += '<span class="tl-badge tl-family">👨‍👩‍👧 Family</span>';

    // Perk badges — prominent colored pills, own row, bigger sizing via
    // .event-details-overlay .perk-badge rules in CSS.
    const benefits = e.benefits || [];
    let perks = '';
    if (benefits.includes('Free Food'))  perks += '<span class="perk-badge perk-food">' + (e.perkFoodIcon || '🍕') + ' Free Food</span>';   // perkFoodIcon: per-event glyph override (Jesus Dogs 🌭)
    if (benefits.includes('Free Stuff')) perks += '<span class="perk-badge perk-stuff">🎁 Free Stuff</span>';
    if (benefits.includes('Credit'))     perks += '<span class="perk-badge perk-credit">📚 Credit</span>';

    // Tag chips (exclude noisy internal markers). Only townies get the Community relabel
    // (unset/Marauder users see "GetInvolved" since default is now Marauder mode).
    const hiddenTags = new Set(['MU','PM','Borough','Manor','Other','VFW','Clubs/Orgs','Live Music','H Games','Home Game Mode','Athletic Competitions','Athletics','Phantom Power','Human Resources','Office of the Provost','Office of VP for Finance and Administration','Advancement Department']);
    const relabelForTownie = (tag) => (muAffiliation === 'townie' && tag === 'GetInvolved') ? 'Community' : tag;
    const hideResHall = (t) => tags.includes('Residence Halls') && t !== 'Residence Halls' && /residence hall/i.test(t);
    const displayTags = tags.filter(t => !hiddenTags.has(t) && !hideResHall(t) && GENDER_TAGS.indexOf(t) === -1).map(relabelForTownie).slice(0, 6);

    const description = (e.description || '').trim();
    const descBlock = description
        ? `<div style="margin-top:12px;font-size:0.9rem;line-height:1.5;color:var(--text);">${escHtml(description)}</div>`
        : '';

    const location = (e.location || '').trim();
    const locBlock = location
        ? `<div style="margin-top:10px;font-size:0.88rem;color:var(--text-muted);">📍 ${escHtml(location)}</div>`
        : '';

    // Game score summary for past sports events. We store the score as "4-2"
    // (our-team first when home, their-team first when away — inherited from
    // the scraper's parse). Pair that with the opponent extracted from the
    // title to build a human-readable summary line. Inning-by-inning box
    // scores aren't in our data pipeline; the recap URL points at MaxPreps
    // (PM) or MU Athletics (MU) where the full box score is published.
    let scoreSummary = '';
    if (isSport && e.gameResult && e.gameScore) {
        const ourTeam = tags.includes('MU') ? 'Millersville' : tags.includes('PM') ? 'Penn Manor' : 'Home';
        // Extract opponent from title: "Softball vs Holy Family" → "Holy Family"
        const oppMatch = (e.title || '').match(/\s(?:vs\.?|@|at)\s+(.+?)(?:\s+(?:-|·|–).*)?$/i);
        const opponent = oppMatch ? oppMatch[1].trim() : '';
        const [n1, n2] = e.gameScore.split('-').map(s => s.trim());
        // When we won, our score is the higher number; when we lost, ours is lower.
        // Tie: either order works — use home-first convention.
        let ourScore, theirScore;
        if (e.gameResult === 'W') {
            ourScore = Math.max(+n1, +n2); theirScore = Math.min(+n1, +n2);
        } else if (e.gameResult === 'L') {
            ourScore = Math.min(+n1, +n2); theirScore = Math.max(+n1, +n2);
        } else {
            ourScore = n1; theirScore = n2;
        }
        const resultLabel = e.gameResult === 'W' ? 'Final (W)' : e.gameResult === 'L' ? 'Final (L)' : 'Final';
        const resultColor = e.gameResult === 'W' ? '#15803d' : e.gameResult === 'L' ? '#b91c1c' : '#6b7280';
        scoreSummary = `<div style="margin-top:12px;padding:10px 12px;background:var(--bg);border-left:4px solid ${resultColor};border-radius:var(--radius-sm);">
            <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;color:${resultColor};font-weight:700;">${resultLabel}</div>
            <div style="font-size:1rem;font-weight:700;color:var(--text);margin-top:2px;">${ourTeam} ${ourScore}${opponent ? `, ${opponent} ${theirScore}` : ` – ${theirScore}`}</div>
        </div>`;
    }

    // Inline linescore (box score). Rendered only when the scraper populated
    // event.periodScores. Structure: { labels: [...], home: {team, values},
    // away: {team, values}, ourTeamSide: 'home'|'away' }. ourTeamSide tells us
    // which row to visually emphasize (the "home team" in box-score parlance
    // is the school hosting, not necessarily the MU/PM team we're tracking).
    let linescoreBlock = '';
    if (isSport && e.periodScores && Array.isArray(e.periodScores.labels) && e.periodScores.home && e.periodScores.away) {
        const ps = e.periodScores;
        const rowHtml = (side, data) => {
            const isOur = side === ps.ourTeamSide;
            const rowStyle = isOur
                ? 'background:var(--gold-soft);font-weight:700;'
                : '';
            const teamName = (data.team || '').replace(/</g, '&lt;');
            const cells = (data.values || []).map((v, i) => {
                // Last three columns (R/H/E for baseball, or total for other
                // sports) get bold emphasis as summary values.
                const isTotal = i >= ps.labels.length - 3;
                const cellStyle = isTotal ? 'font-weight:700;border-left:1px solid var(--border);' : '';
                return `<td style="padding:4px 8px;text-align:center;${cellStyle}">${v}</td>`;
            }).join('');
            return `<tr style="${rowStyle}"><td style="padding:4px 8px;font-weight:600;">${teamName}</td>${cells}</tr>`;
        };
        const headerCells = ps.labels.map((lbl, i) => {
            const isTotal = i >= ps.labels.length - 3;
            const cellStyle = isTotal ? 'font-weight:800;border-left:1px solid var(--border);' : '';
            return `<th style="padding:4px 8px;text-align:center;font-size:0.72rem;color:var(--text-muted);${cellStyle}">${lbl}</th>`;
        }).join('');
        linescoreBlock = `<div style="margin-top:12px;overflow-x:auto;">
            <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);font-weight:700;margin-bottom:4px;">Box Score</div>
            <table style="border-collapse:collapse;font-size:0.85rem;min-width:100%;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;">
                <thead style="background:var(--bg);">
                    <tr><th style="padding:4px 8px;text-align:left;"></th>${headerCells}</tr>
                </thead>
                <tbody>
                    ${rowHtml('away', ps.away)}
                    ${rowHtml('home', ps.home)}
                </tbody>
            </table>
        </div>`;
    }

    // Action buttons
    let actions = '';
    if ((isRegistrationEvent(e) || isProgramSignup(e)) && getRegisterUrl(e)) {
        // Registration event → "Register Now" (signup page), not "Buy Tickets"
        // — EXCEPT ticket packages (2026-08-06), where a purchase is exactly
        // what it is: the label flips to "🎟 Buy Tickets", link unchanged.
        actions += `<a href="${escHtml(getRegisterUrl(e))}" target="_blank" rel="noopener" class="btn btn-sm btn-ticket" style="text-decoration:none;">${isTicketPackage(e) ? '🎟 Buy Tickets' : '📝 Register Now'}</a>`;
    } else if (e.ticketLink && !eventIsFree(e)) {
        // Paid/ticketed only. A free event never shows "Buy Tickets" — its link is
        // an info page, surfaced as "More Info" via the source button below.
        actions += `<a href="${e.ticketLink}" target="_blank" class="btn btn-sm btn-ticket" style="text-decoration:none;">🎟️ Buy Tickets</a>`;
    }
    if (e.streamLink) {
        // State-aware label — same three cases as the card buttons. Clarifies
        // that a future streamLink is a scheduled broadcast, not something
        // you can tune into right now.
        const streamD = new Date(e.date);
        const streamEnd = getEventEndTime(e) || new Date(streamD.getTime() + 3*60*60*1000);
        const streamNow = new Date();
        const isLiveNow = isSport && streamD <= streamNow && streamNow <= streamEnd && !e.gameResult && !multiDay;
        let streamLabel;
        if (isLiveNow) streamLabel = '🔴 Watch Live';
        else if (e.gameResult) streamLabel = '📺 Replay';
        else streamLabel = '📺 Live Stream';
        actions += `<a href="${e.streamLink}" target="_blank" class="btn btn-sm btn-outline" style="text-decoration:none;">${streamLabel}</a>`;
    }
    // Calendar action — uses the same key scheme as card buttons so addToCalendar can find it
    const modalCardKey = getEventKey(e).replace(/"/g, '&quot;');
    actions += `<button class="btn btn-sm btn-outline" data-cardkey="${modalCardKey}" onclick="addToCalendar(this)" style="cursor:pointer;">📅 Add to Calendar</button>`;
    // 🧭 Directions (2026-08-07): 2-tier resolver — linked place lat/lng or a
    // text-query fallback. Empty string = unresolvable/blocklisted → no
    // button. URL is "lat,lng" or fully encodeURIComponent'd — attr-safe.
    const dirUrl = eventDirectionsUrl(e);
    if (dirUrl) actions += `<a href="${dirUrl}" target="_blank" rel="noopener" class="btn btn-sm btn-outline" style="text-decoration:none;">🧭 Directions</a>`;
    actions += `<button class="btn btn-sm btn-outline" data-cardkey="${modalCardKey}" onclick="shareEvent(this)" style="cursor:pointer;">🔗 Share</button>`;
    // Source link labeling: for past sports games, promote it to "Game Recap
    // & Box Score" since the target URL is the MaxPreps/MU Athletics recap
    // page where inning/quarter box scores and recap articles live. Other
    // contexts keep the generic "View Source" label. Skip it entirely for a
    // registration event whose source IS the signup page — "Register Now"
    // already links there, so a second button to the same URL is just noise.
    // Info/source link. For a free event, fall back to its ticketLink (an info
    // page, not a purchase) so the link still surfaces, and label it "More Info"
    // rather than the generic "View Source".
    const infoUrl = e.sourceLink || (eventIsFree(e) ? e.ticketLink : '');
    const regDupesSource = (isRegistrationEvent(e) || isProgramSignup(e)) && infoUrl && infoUrl === getRegisterUrl(e);
    if (infoUrl && !regDupesSource) {
        const isPastGame = isSport && e.gameResult && e.gameScore;
        const isMUSport = isSport && tags.includes('MU');
        let srcLabel;
        if (isPastGame) srcLabel = '📊 Game Recap & Box Score';
        else if (eventIsFree(e) && !isSport) srcLabel = 'ℹ️ More Info';
        else if (isMUSport && !e.ticketLink) srcLabel = '🎟️ View on MU Athletics';
        else srcLabel = '🔗 View Source';
        actions += `<a href="${infoUrl}" target="_blank" class="btn btn-sm btn-outline" style="text-decoration:none;">${srcLabel}</a>`;
    }

    // Build modal
    const overlay = document.createElement('div');
    overlay.className = 'event-details-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9998;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px 16px;overflow-y:auto;';
    overlay.onclick = ev => { if (ev.target === overlay) overlay.remove(); };

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:540px;width:100%;padding:24px;position:relative;box-shadow:0 10px 40px rgba(0,0,0,0.2);';
    modal.innerHTML = `
        <button onclick="this.closest('.event-details-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-muted);padding:4px 8px;">✕</button>
        <h2 style="margin:0 0 8px;font-size:1.25rem;color:var(--navy);line-height:1.3;padding-right:24px;">${escHtml(e.title || 'Event')}</h2>
        <div style="font-size:0.92rem;color:var(--text);font-weight:600;">📅 ${dateStr}${timeStr ? ' · ' + timeStr : ''}</div>
        ${locBlock}
        ${scoreSummary}
        ${linescoreBlock}
        ${perks ? `<div class="modal-perks">${perks}</div>` : ''}
        ${badges ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:4px;">${badges}</div>` : ''}
        ${displayTags.length ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;">${displayTags.map(t => `<span class="card-tag">${t}</span>`).join('')}</div>` : ''}
        ${descBlock}
        ${actions ? `<div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:8px;">${actions}</div>` : ''}
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

/* ==================== HOME SPECIALS ==================== */
async function loadHomeSpecials(){
    try {
        const specials = await fetch('specials.json').then(r=>r.json());
        // specials.json is keyed by DIRECTORY PLACE SLUG (see scrape.js
        // assembly); each entry carries its display `name`. VFW is overridden
        // from vfw.json (the single source maintained by the Cowork task) via
        // the same helper the Map page uses, so the two can never disagree.
        try {
            const vfw = await fetch('vfw.json').then(r=>r.json());
            const vfwEntry = vfwSpecialsEntryFromJson(vfw);
            if (vfwEntry) specials['vfw-post-7294'] = vfwEntry;
        } catch(e){ /* vfw.json optional — fall back to specials.json if present */ }
        const dayName = new Date().toLocaleDateString('en-US',{weekday:'long'});
        const container = document.getElementById('home-specials');
        let cards = [];

        // Campus Cupboard — marauder-only resource (free grocery store inside
        // the HUB for MU students). Year-round, with auto-switching hours
        // between academic-year (M-F 8am-8pm) and summer (M-F 9am-1pm).
        // Summer pause is approximate — May 11 to Aug 24 — same window as
        // HUB meal events. Card always shown to marauders, never to townies.
        if (muAffiliation === 'student') {
            const cupboardItems = buildCampusCupboardItems(dayName);
            if (cupboardItems) {
                cards.push(`<div class="home-special-card" data-spslug="campus-cupboard" role="button" tabindex="0" aria-label="Details for Campus Cupboard" style="cursor:pointer;"><h3 class="home-special-name">🛒 Campus Cupboard</h3><p class="home-special-note">Free grocery store for MU students — inside The HUB</p>${cupboardItems.map(i=>`<p class="home-special-item">• ${i}</p>`).join('')}<p class="home-special-item" style="margin-top:8px;font-size:0.7rem;color:var(--text-muted);">Tap for map &amp; details →</p></div>`);
            }
        }

        for (const [slug, sp] of Object.entries(specials)) {
            // Audience-targeted specials — symmetric with the directory's
            // placeAudienceVisible vocabulary: 'locals' hides from marauders
            // (VFW is members-only/local), 'marauders' would hide from
            // townies/unset. Everything else shows to everyone.
            if (sp.audience === 'locals' && muAffiliation === 'student') continue;
            if (sp.audience === 'marauders' && muAffiliation !== 'student') continue;

            // Single source of truth — the same accumulation that drives the
            // Map page cards and the Today lens (closed days, day-only tags,
            // daily + recurring + weekly) so the rail can never disagree.
            const items = placesSpecialsItemsFor(sp, dayName);

            if(items.length > 0){
                const note = sp.note || '';
                cards.push(`<div class="home-special-card" data-spslug="${slug}" role="button" tabindex="0" aria-label="Details for ${sp.name || slug}" style="cursor:pointer;"><h3 class="home-special-name">${sp.name || slug}</h3><p class="home-special-note">${note}</p>${items.slice(0, 5).map(i=>`<p class="home-special-item">• ${i}</p>`).join('')}<p class="home-special-item" style="margin-top:8px;font-size:0.7rem;color:var(--text-muted);">${items.length > 5 ? `+${items.length - 5} more — tap for full list →` : 'Tap for map &amp; details →'}</p></div>`);
            }
        }
        container.innerHTML = cards.length > 0 ? cards.join('') : '<p class="home-empty">No specials today</p>';
    } catch(e) { document.getElementById('home-specials').innerHTML = '<p class="home-empty">No specials today</p>'; }
}

// ---- Home-rail specials popup (2026-07-14) ---------------------------------
// Tap a rail card -> modal card: mini locator map (same self-hosted Leaflet/
// PMTiles stack as /map -- placesMapAssetsLoad is shared and idempotent, so
// vendor assets load once whichever surface asks first), the directory row's
// details, today's items, and Directions / Website buttons. The item list
// comes from placesSpecialsItems -- the single source of truth -- so the 21+
// gate, closed days, and day-only tags apply here identically (a second
// inline accumulation would silently bypass the gate).
// The mini map is its OWN Leaflet instance (one container can't live in two
// maps), created per open and .remove()'d on close -- placesMap is untouched
// and the /map page's lazy init path is unaffected. Degradations, all silent:
// no directory match for the slug -> details-only popup (no map/buttons);
// place without lat/lng (geocoding is fail-closed) -> no map slot; vendor
// assets unreachable (offline first visit) -> map slot hides, details stay.
let homeSpecialMiniMap = null;

function homeSpecialPopupEsc(e){ if (e.key === 'Escape') window.closeHomeSpecialPopup(); }

window.closeHomeSpecialPopup = function(){
    if (homeSpecialMiniMap){ try { homeSpecialMiniMap.remove(); } catch(e){} homeSpecialMiniMap = null; }
    const ov = document.getElementById('home-special-popup-overlay');
    if (ov) ov.remove();
    document.removeEventListener('keydown', homeSpecialPopupEsc);
};

window.openHomeSpecialPopup = function(slug){
    window.closeHomeSpecialPopup();   // never two at once
    const dayName = new Date().toLocaleDateString('en-US',{weekday:'long'});
    let sp = (window._placesSpecials || {})[slug];
    // Directory row (address / link / coords / category). May be missing --
    // an unmatched specials slug (the specials-match drift case) degrades to
    // a details-only popup, never a throw.
    let place = (allPlaces || []).find(p => placeSlug(p) === slug) || null;
    let items = sp ? placesSpecialsItems(slug, dayName) : [];   // single source of truth (21+ gate lives inside)
    // Campus Cupboard -- synthesized: it lives outside allPlaces AND
    // _placesSpecials (window._cupboard + sheet-driven hours, per the
    // buildCampusCupboardCard static-info convention -- address/link
    // hardcoded there too). Marauder-only and closed-day-hidden exactly
    // like the rail card that opens this, so the guards can't disagree.
    if (slug === 'campus-cupboard'){
        const cb = window._cupboard, cbItems = buildCampusCupboardItems(dayName);
        if (!cb || !cbItems || muAffiliation !== 'student') return;
        sp = { name: '🛒 Campus Cupboard', eligibility: 'Inside The HUB · MU students only' };
        place = { ...cb, name: 'Campus Cupboard', category: 'Cupboard', placeType: 'cupboard',
                  address: cb.address || '121 N George St, Millersville, PA 17551',
                  link: cb.link || 'https://www.hubmu.org/free-groceries' };
        // hours/summerHours/breakClosed ride the ...cb spread — the Patch-K
        // placeHoursDetailsHtml line below resolves them via placeEffectiveHours.
        items = ['Free groceries — ' + cbItems[1]];   // standard Today's-Specials list; cbItems[0] hours line stays dropped — the 🕐 table carries hours (gold blurb retired 2026-07-22)
    }
    if (!sp) return;
    const hasCoords = !!(place && isFinite(place.lat) && isFinite(place.lng));
    const evToday = place ? placeEventsToday(place) : [];
    const q = place ? encodeURIComponent(place.address ? (place.name + ', ' + place.address) : (place.lat + ',' + place.lng)) : '';

    const ov = document.createElement('div');
    ov.id = 'home-special-popup-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:420px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 12px 44px rgba(0,0,0,0.28);position:relative;';

    let html = '';
    if (hasCoords) html += `<div id="home-special-mini-map" style="height:180px;border-radius:var(--radius) var(--radius) 0 0;background:var(--gold-soft);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:0.8rem;">Loading map…</div>`;
    html += `<button onclick="closeHomeSpecialPopup()" aria-label="Close" style="position:absolute;top:8px;right:8px;z-index:1001;width:32px;height:32px;border-radius:50%;border:none;background:rgba(20,32,58,0.75);color:#fff;font-size:1.05rem;line-height:1;cursor:pointer;">×</button>`;
    html += `<div style="padding:18px 20px 20px;">`;
    html += `<h3 class="home-special-name" style="font-size:1.1rem;">${sp.name || (place && place.name) || slug}</h3>`;
    const meta = place ? (place.cuisine || place.category || '') : '';
    if (meta) html += `<p style="font-size:0.78rem;color:var(--text-muted);margin:2px 0;">${meta}</p>`;
    if (place && place.address) html += `<p style="font-size:0.78rem;color:var(--text-muted);margin:2px 0;">📍 ${place.address}</p>`;
    // Eligibility line (Cupboard) — audience is already gated to marauders; this
    // is for self-selected/edge viewers + card↔popup consistency, so small + muted.
    if (sp.eligibility) html += `<p style="font-size:0.78rem;color:var(--text-muted);margin:2px 0;">${sp.eligibility}</p>`;
    { const _hd = placeHoursDetailsHtml(place, true); if (_hd) html += `<div style="margin:6px 0 0;">${_hd}</div>`; }
    if (items.length){
        html += `<p style="font-weight:700;font-size:0.85rem;margin:12px 0 4px;color:var(--navy);">Today's Specials (${dayName}):</p>`;
        if (sp.note) html += `<p style="font-size:0.74rem;color:var(--text-muted);font-style:italic;margin:2px 0 6px;">${sp.note}</p>`;
        html += items.map(i=>`<p class="home-special-item">• ${i}</p>`).join('');
    }
    evToday.slice(0,3).forEach(e => { html += `<p class="home-special-item">📅 ${e.title} · ${formatTime(new Date(e.t))}</p>`; });
    if (evToday.length > 3) html += `<p class="home-special-item" style="color:var(--text-muted);">+${evToday.length-3} more today</p>`;
    const btns = [];
    if (place && place.link) btns.push(`<a href="${place.link}" target="_blank" rel="noopener" class="btn btn-sm btn-outline" style="flex:1;text-align:center;">Website</a>`);
    if (q) btns.push(`<a href="https://www.google.com/maps/dir/?api=1&destination=${q}" target="_blank" rel="noopener" class="btn btn-sm btn-outline" style="flex:1;text-align:center;">Directions</a>`);
    // John Herr's: the full-circular popup already exists -- chain into it
    // instead of duplicating its deal list here.
    if (slug === 'john-herr-s-village-market' && allGroceryDeals.length > 0)
        btns.push(`<button onclick="closeHomeSpecialPopup();showGroceryDeals();" class="btn btn-sm btn-outline" style="flex:1;">All deals</button>`);
    if (btns.length) html += `<div style="display:flex;gap:8px;margin-top:14px;">${btns.join('')}</div>`;
    html += `</div>`;
    box.innerHTML = html;
    ov.appendChild(box);
    document.body.appendChild(ov);
    ov.onclick = e => { if (e.target === ov) window.closeHomeSpecialPopup(); };
    document.addEventListener('keydown', homeSpecialPopupEsc);

    if (hasCoords){
        placesMapAssetsLoad().then(() => {
            const el = document.getElementById('home-special-mini-map');
            if (!el) return;   // popup already closed before assets resolved
            el.textContent = '';
            // Static locator map: every interaction off. NB config key is
            // PLACES_MAP_CFG.bounds; maxBounds is only the Leaflet OPTION name
            // (the 2026-07-09 lesson).
            homeSpecialMiniMap = L.map(el, {
                center: [place.lat, place.lng], zoom: 16,
                minZoom: PLACES_MAP_CFG.minZoom, maxZoom: PLACES_MAP_CFG.maxZoom,
                maxBounds: PLACES_MAP_CFG.bounds,
                zoomControl: false, attributionControl: true,
                dragging: false, scrollWheelZoom: false, touchZoom: false,
                doubleClickZoom: false, boxZoom: false, keyboard: false
            });
            homeSpecialMiniMap.attributionControl.setPrefix(false);
            protomapsL.leafletLayer({
                url: PLACES_MAP_CFG.pmtiles, flavor: 'light', lang: 'en',
                attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
            }).addTo(homeSpecialMiniMap);
            const glyph = PLACE_PIN_OVERRIDES[placeSlug(place)] || MAP_PIN_ICONS[place.category] || '📍';
            const color = MAP_PIN_COLORS[(place.placeType==='food') ? 'food' : (place.category==='Cupboard' ? 'cupboard' : 'service')] || '#14203a';
            L.marker([place.lat, place.lng], { interactive: false, icon: L.divIcon({ className: '', html: `<div class="map-pin" style="border-color:${color}">${glyph}</div>`, iconSize: [30,30], iconAnchor: [15,15] }) }).addTo(homeSpecialMiniMap);
            setTimeout(()=>{ if (homeSpecialMiniMap) homeSpecialMiniMap.invalidateSize(); }, 60);   // size after modal layout settles
        }).catch(e => {
            const el = document.getElementById('home-special-mini-map');
            if (el) el.style.display = 'none';   // vendor assets unavailable -- details still show
            console.warn('Mini map unavailable:', e && e.message);
        });
    }
};

// One delegated listener on the rail -- attaches once, survives every
// innerHTML re-render (parity with the places/housing card listeners).
// Real links/buttons inside a card win over the popup; Enter/Space fire it
// for keyboard users (cards carry role=button + tabindex=0). The Campus
// Cupboard card carries data-spslug="campus-cupboard", routed to the
// synthesized branch in openHomeSpecialPopup (it lives outside allPlaces
// and _placesSpecials).
(function(){
    const rail = document.getElementById('home-specials');
    if (!rail) return;
    const fire = ev => {
        if (ev.target.closest('a,button')) return;
        const card = ev.target.closest('[data-spslug]');
        if (card){ ev.preventDefault(); window.openHomeSpecialPopup(card.getAttribute('data-spslug')); }
    };
    rail.addEventListener('click', fire);
    rail.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') fire(ev); });
})();

// Build a list of items shown on the Campus Cupboard card. Returns null
// when closed today (weekend / break / no sheet data) so the card is hidden
// entirely rather than showing a "closed" message. Open-today + the hours
// line now flow through the SHARED hours path — the Cupboard's sheet row
// carries hours_mon..sun / summer_hours_mon..sun / break_closed and
// placeEffectiveHours() resolves them like every other listing (2026-07-23;
// the hardcoded weekday check + May-11/Aug-25 summer window are retired).
// dayName param retained for call-site compatibility; the open check is
// ET-pinned via the shared helpers (an improvement — dayName was local-TZ).
function buildCampusCupboardItems(dayName) {
    // Sheet control: null = row removed/deactivated → hide entirely.
    // undefined (fetch failed) now ALSO hides — hours come from the sheet,
    // so with no data we make no claim (was: built-in fallback hours).
    const cb = window._cupboard;
    if (!cb) return null;
    const eh = placeEffectiveHours(cb);
    const todayVal = eh ? eh[HOURS_DAY_KEYS[hoursNowET().dayIdx]] : undefined;
    if (!todayVal || todayVal === 'closed') return null;   // closed/unknown today — hide
    const desc = cb.description
        || 'Fresh produce, dairy, eggs, frozen, canned & dry goods, hygiene products. Bring student ID.';
    return [`Open today: ${hoursFmtRanges(todayVal)}`, desc];
}

// Cupboard visibility predicate -- ONE function shared by the Places-page
// card (renderPlaces), the map pin list (placesMapPinList), and the home
// popup guard, so the mirrored spots can't drift (the placeTodayContent
// pattern). True = student viewer AND open today (per the sheet row's
// hours/summer_hours/break_closed, resolved by placeEffectiveHours through
// buildCampusCupboardItems). Being open IS its "today special", so the
// 🔥 Today lens now INCLUDES it -- and closed days hide the PIN too,
// aligning the old pin/card weekend asymmetry (the pin used to render on
// weekends while the card hid). (2026-07-14)
function cupboardTodayVisible(){
    return muAffiliation === 'student' &&
        !!buildCampusCupboardItems(new Date().toLocaleDateString('en-US',{weekday:'long'}));
}

/* ==================== WEATHER ==================== */
async function loadWeather(){
    try{const data=await(await fetch('weather.json')).json();
    const icon=data.icon||'🌡️';
    // Home page: weather bar (2/3) and MBA spotlight (1/3) as two SEPARATE
    // rounded cards in a flex row — siblings, not nested. The date moved to the
    // events header. renderSpotlight() fills #home-spotlight after this runs;
    // if there's no spotlight to show, the row collapses to weather full-width.
    document.getElementById('home-weather-bar').innerHTML=`<div class="home-top-row">
        <div class="weather-bar" onclick="switchView('weather')" style="cursor:pointer;">
            <div class="weather-bar-left">
                <span class="weather-bar-icon">${icon}</span>
                <span class="weather-bar-temp">${data.temp}°F</span>
                <span class="weather-bar-cond">${data.condition}</span>
            </div>
        </div>
        <div id="home-spotlight" class="home-spotlight" aria-label="Featured local member"></div>
    </div>`;
    renderSpotlight();
    // Weather page
    document.getElementById('w-icon').textContent=icon;
    document.getElementById('w-temp').textContent=`${data.temp}°F`;
    document.getElementById('w-feels').textContent=`Feels like ${data.feelsLike||data.temp}°F`;
    document.getElementById('w-cond').textContent=data.condition;
    document.getElementById('w-details').textContent=`Wind: ${data.wind} | Humidity: ${data.humidity}`;
    const stationEl=document.getElementById('w-station-update');
    if(stationEl) stationEl.textContent=data.stationUpdate||`Updated: ${data.lastUpdated||''}`;
    const sourceEl=document.getElementById('w-source');
    if(sourceEl) sourceEl.textContent=data.source?`Source: ${data.source}`:'';
    }catch(e){console.error('Weather load error:',e);}
}
async function loadSpecials(){ await loadHomeSpecials(); }

// Render the MU Weather Center detail (forecast, 7-day, radar/surface images,
// observations, discussion excerpt, videos) into the weather view. Data comes
// from weather-mu.json (written by scrape.js). Injected as #mu-weather-extra
// appended to #view-weather, so no index.html container is needed. Fails quietly
// if the file is missing — the current-conditions card still shows.
async function loadWeatherMU(){
    const host = document.getElementById('view-weather');
    if(!host) return;
    let data;
    try { data = await (await fetch('weather-mu.json')).json(); }
    catch(e){ return; }
    const esc = (typeof escHtml === 'function') ? escHtml : (s)=>String(s==null?'':s);
    const sections = [];

    const f = data.forecast || {};
    if (f.synopsis || (f.periods||[]).length) {
        const rows = (f.periods||[]).map(p=>`<tr><td style="font-weight:600;white-space:nowrap;padding:6px 12px 6px 0;vertical-align:top;">${esc(p.period)}</td><td style="padding:6px 0;">${esc(p.text)}</td></tr>`).join('');
        sections.push(`<div class="app-card">
            <h3 class="card-title">📋 Latest Forecast</h3>
            ${f.synopsis?`<p style="font-size:0.88rem;line-height:1.55;color:var(--text-muted);margin:8px 0 12px;">${esc(f.synopsis)}</p>`:''}
            ${rows?`<table style="width:100%;border-collapse:collapse;font-size:0.86rem;">${rows}</table>`:''}
            ${f.issued?`<p class="card-meta" style="margin-top:10px;">${esc(f.issued)}</p>`:''}
        </div>`);
    }

    const sd = data.sevenDay || {};
    if ((sd.days||[]).length) {
        const head = `<tr style="text-align:left;border-bottom:2px solid var(--border);"><th style="padding:6px 8px 6px 0;">Period</th><th style="padding:6px 8px;">Sky</th><th style="padding:6px 8px;">Weather</th><th style="padding:6px 8px;">PoP</th><th style="padding:6px 8px;">Temp</th></tr>`;
        const body = sd.days.map(x=>`<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 8px 6px 0;font-weight:600;white-space:nowrap;">${esc(x.period)}</td><td style="padding:6px 8px;">${esc(x.sky)}</td><td style="padding:6px 8px;">${esc(x.weather)}</td><td style="padding:6px 8px;">${esc(x.pop)}</td><td style="padding:6px 8px;font-weight:600;">${esc(x.temp)}°</td></tr>`).join('');
        sections.push(`<div class="app-card">
            <h3 class="card-title">📅 7-Day Outlook</h3>
            <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.84rem;margin-top:8px;">${head}${body}</table></div>
            ${sd.issued?`<p class="card-meta" style="margin-top:10px;">${esc(sd.issued)}</p>`:''}
        </div>`);
    }

    const im = data.images || {};
    if (im.radar || im.surfaceAnalysis) {
        const fig = (src,label,credit)=>src?`<figure style="margin:0;flex:1;min-width:260px;">
            <div style="font-weight:600;font-size:0.85rem;margin-bottom:6px;">${label}</div>
            <img src="${esc(src)}" alt="${esc(label)}" loading="lazy" style="width:100%;height:auto;border:1px solid var(--border);border-radius:var(--radius-sm);">
            <figcaption class="card-meta" style="margin-top:4px;">${credit}</figcaption></figure>`:'';
        sections.push(`<div class="app-card">
            <h3 class="card-title">🛰️ Radar & Surface Analysis</h3>
            <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;">
                ${fig(im.radar,'Local Radar','© AccuWeather.com')}
                ${fig(im.surfaceAnalysis,'Surface Analysis','© NOAA')}
            </div></div>`);
    }

    if ((data.observations||[]).length) {
        const head = `<tr style="text-align:left;border-bottom:2px solid var(--border);"><th style="padding:6px 6px 6px 0;">Time</th><th style="padding:6px;">Temp</th><th style="padding:6px;">Dew</th><th style="padding:6px;">RH</th><th style="padding:6px;">Wind</th><th style="padding:6px;">Cond.</th></tr>`;
        const body = data.observations.map(o=>`<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 6px 6px 0;font-weight:600;">${esc(o.time)}</td><td style="padding:6px;">${esc(o.temp)}°</td><td style="padding:6px;">${esc(o.dewpoint)}°</td><td style="padding:6px;">${esc(o.rh)}%</td><td style="padding:6px;white-space:nowrap;">${esc(o.windDir)} ${esc(o.windSpeed)}</td><td style="padding:6px;">${esc(o.condition)}</td></tr>`).join('');
        sections.push(`<div class="app-card">
            <h3 class="card-title">📊 Recent Observations</h3>
            <p class="card-meta" style="margin:2px 0 8px;">Past 6 hours · Millersville University station</p>
            <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.82rem;">${head}${body}</table></div>
        </div>`);
    }

    // Daily climate summary — the CWS month-to-date ledger
    // (www.atmos.millersville.edu/~cws/climo/dailysum.html), parsed by
    // scrape.js into weather-mu.json (data.dailySummary). FULL month, newest
    // first to match the observations card above. The station publishes
    // literal "Missing" for sensor gaps — values render as-is, and unit
    // suffixes (°, mph) attach only to numeric values so "Missing°" can
    // never appear. Footer stats (month total + year-to-date lines) render
    // only when parsed; the whole card is simply absent when scrape.js
    // couldn't fetch or parse the page (different HOST than the WIC pages —
    // see the watch note on the fetch block in scrape.js).
    const dsum = data.dailySummary || {};
    if ((dsum.days||[]).length) {
        const uv = (v,u)=>/^-?[\d.]+$/.test(v)?esc(v)+u:esc(v);   // unit only on numeric values ("Missing" stays bare)
        const sub = (t)=>t?`<br><span style="font-size:0.72em;color:var(--text-muted);font-weight:400;">(${esc(t)})</span>`:'';
        const head = `<tr style="text-align:left;border-bottom:2px solid var(--border);"><th style="padding:6px 6px 6px 0;">Date</th><th style="padding:6px;">High</th><th style="padding:6px;">Low</th><th style="padding:6px;">Peak Wind</th><th style="padding:6px;">Rain (in.)</th></tr>`;
        const body = [...dsum.days].reverse().map(d=>`<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 6px 6px 0;font-weight:600;white-space:nowrap;vertical-align:top;">${esc(d.date)}</td><td style="padding:6px;font-weight:600;vertical-align:top;">${uv(d.max,'°')}${sub(d.maxTime)}</td><td style="padding:6px;vertical-align:top;">${uv(d.min,'°')}${sub(d.minTime)}</td><td style="padding:6px;white-space:nowrap;vertical-align:top;">${uv(d.windSpeed,' mph')} · ${uv(d.windDir,'°')}${sub(d.windTime)}</td><td style="padding:6px;vertical-align:top;">${esc(d.rain)}</td></tr>`).join('');
        const stats = [];
        if (dsum.totalRain) stats.push(`Month rainfall: <b>${esc(dsum.totalRain)} in.</b>`);
        if (dsum.ytdRain) stats.push(`Year-to-date: <b>${esc(dsum.ytdRain)} in.</b>`);
        if (dsum.yearMax) stats.push(`Year max: <b>${uv(dsum.yearMax,'°')}</b>${dsum.yearMaxDate?` (${esc(dsum.yearMaxDate)})`:''}`);
        if (dsum.yearMin) stats.push(`Year min: <b>${uv(dsum.yearMin,'°')}</b>${dsum.yearMinDate?` (${esc(dsum.yearMinDate)})`:''}`);
        sections.push(`<div class="app-card">
            <h3 class="card-title">📈 Daily Climate Summary</h3>
            <p class="card-meta" style="margin:2px 0 8px;">${dsum.monthLabel?`${esc(dsum.monthLabel)} · `:''}Millersville University station · midnight-to-midnight · times in ( )</p>
            <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.82rem;">${head}${body}</table></div>
            ${stats.length?`<p style="font-size:0.84rem;line-height:1.6;margin:10px 0 0;">${stats.join(' · ')}</p>`:''}
            <a href="https://www.atmos.millersville.edu/~cws/climo/dailysum.html" target="_blank" rel="noopener" class="btn btn-sm btn-outline" style="margin-top:10px;">Full climate records ➔</a>
        </div>`);
    }

    const ds = data.discussion || {};
    if (ds.excerpt) {
        sections.push(`<div class="app-card" style="border-left:4px solid var(--gold);">
            <h3 class="card-title">📝 Weather Discussion</h3>
            ${ds.headline?`<p style="font-weight:700;margin:6px 0 2px;">${esc(ds.headline)}</p>`:''}
            ${ds.dateLine?`<p class="card-meta" style="margin:0 0 8px;">${esc(ds.dateLine)}</p>`:''}
            <p style="font-size:0.88rem;line-height:1.55;">${esc(ds.excerpt)}</p>
            <a href="${esc(ds.url||'https://www.millersville.edu/weathercenter/forecasts/weather-discussion.php')}" target="_blank" rel="noopener" class="btn btn-sm btn-outline" style="margin-top:10px;">Read the full discussion ➔</a>
        </div>`);
    }

    if ((data.videos||[]).length) {
        const cards = data.videos.map(v=>`<a href="${esc(v.url)}" target="_blank" rel="noopener" style="flex:1;min-width:150px;max-width:220px;text-decoration:none;color:inherit;">
            ${v.thumbnail?`<img src="${esc(v.thumbnail)}" alt="" loading="lazy" style="width:100%;height:auto;border-radius:var(--radius-sm);border:1px solid var(--border);">`:''}
            <div style="font-size:0.8rem;font-weight:600;margin-top:6px;line-height:1.3;">${esc(v.title)}</div></a>`).join('');
        sections.push(`<div class="app-card">
            <h3 class="card-title">🎥 Latest Videos</h3>
            <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;">${cards}</div>
        </div>`);
    }

    sections.push(`<p class="card-meta" style="text-align:center;margin:8px 0 4px;">Forecast, observations & discussion courtesy of the <a href="${esc(data.sourceUrl||'https://www.millersville.edu/weathercenter/')}" target="_blank" rel="noopener" style="color:var(--navy);">MU Weather Information Center</a></p>`);

    // Spacing: match whatever vertical rhythm the existing weather cards use
    // (their margin-bottom, or the parent container's grid/flex gap) and apply
    // it uniformly via the wrapper's flex `gap`. We also zero each MU card's own
    // margin so the gap is the SOLE spacer — otherwise the card's CSS margin
    // stacks on top of the gap and the MU section spaces wider than the rest of
    // the page (the inconsistency being fixed here).
    let gap = '16px';
    const sample = [...host.querySelectorAll('.app-card')].find(c => !c.closest('#mu-weather-extra'));
    if (sample) {
        const cs = getComputedStyle(sample);
        const pcs = sample.parentElement ? getComputedStyle(sample.parentElement) : null;
        const mb = cs.marginBottom;
        const pg = pcs ? (pcs.rowGap && pcs.rowGap !== 'normal' ? pcs.rowGap : pcs.gap) : '';
        if (mb && mb !== '0px') gap = mb;
        else if (pg && pg !== 'normal' && pg !== '0px') gap = pg;
    }
    let extra = document.getElementById('mu-weather-extra');
    if(!extra){ extra = document.createElement('div'); extra.id='mu-weather-extra'; host.appendChild(extra); }
    extra.style.display = 'flex';
    extra.style.flexDirection = 'column';
    extra.style.gap = gap;
    extra.style.marginTop = gap;
    extra.innerHTML = sections.join('');
    extra.querySelectorAll('.app-card').forEach(c => { c.style.marginTop = '0'; c.style.marginBottom = '0'; });
}
async function loadNews(){try{currentNews=await(await fetch('news.json')).json();renderNewsSubFilters();renderNewsUI();}catch(e){}}

let newsSource='All', newsSubFilter=null;

window.setNewsSource=function(src,btn){
    newsSource=src; newsSubFilter=null;
    btn.closest('.filter-group').querySelectorAll('.src-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    renderNewsSubFilters();
    renderNewsUI();
};

function renderNewsSubFilters(){
    const c=document.getElementById('news-sub-container'); c.innerHTML='';
    if(newsSource==='All'){c.classList.remove('active');return;}
    let filtered=currentNews.filter(n=>n.source===newsSource);
    const subs=new Set();
    filtered.forEach(n=>{
        if(n.subCategory) subs.add(n.subCategory);
        if(n.tags) n.tags.forEach(t=>subs.add(t));
    });
    const uniqueSubs=[...subs].sort();
    if(uniqueSubs.length<=1){c.classList.remove('active');return;}
    c.classList.add('active');
    uniqueSubs.forEach(sub=>{
        const b=document.createElement('button'); b.className='sub-btn'+(newsSubFilter===sub?' active':''); b.textContent=sub;
        b.onclick=()=>{
            newsSubFilter=(newsSubFilter===sub)?null:sub;
            c.querySelectorAll('.sub-btn').forEach(x=>x.classList.toggle('active',x.textContent===newsSubFilter));
            renderNewsUI();
        };
        c.appendChild(b);
    });
}

function buildNewsCard(n) {
    const sourceDisplay={'Millersville News':'MU','The Snapper':'MU Snapper'};
    let tags=[];
    if(n.source) tags.push(sourceDisplay[n.source]||n.source);
    if(n.subCategory && !tags.includes(n.subCategory)) tags.push(n.subCategory);
    if(n.tags) n.tags.forEach(t=>{if(!tags.includes(t)) tags.push(t);});
    const tagHtml=tags.length?`<div class="card-tags">${tags.map(t=>`<span class="card-tag">${t}</span>`).join('')}</div>`:'';
    return `<div class="app-card">${tagHtml}<p class="card-meta">${escHtml(n.date)}</p><h3 class="card-title">${escHtml(decodeEntities(n.title))}</h3><a href="${escHtml(n.link)}" target="_blank" class="btn btn-sm btn-outline" style="margin-top:12px;">Read ➔</a></div>`;
}

// Hide PM/Borough news source pills for marauders who haven't favorited them.
// Mirrors updateEventsUI / updateSportsUI pill-visibility pattern. Also resets
// newsSource back to 'All' if the currently-selected source just got hidden
// (e.g. user switched affiliation while on the Penn Manor pill).
function updateNewsSourcePills() {
    const pmBtn = document.querySelector('#news-source-group .src-btn[data-feed="news-pm"]');
    const boBtn = document.querySelector('#news-source-group .src-btn[data-feed="news-borough"]');
    const pmHidden = isSourceHidden('PM_NEWS');
    const boHidden = isSourceHidden('BOROUGH_NEWS');
    if (pmBtn) pmBtn.style.display = pmHidden ? 'none' : '';
    if (boBtn) boBtn.style.display = boHidden ? 'none' : '';
    // If the active pill just got hidden, fall back to "All".
    if ((pmHidden && newsSource === 'Penn Manor News') ||
        (boHidden && newsSource === 'Millersville Borough')) {
        newsSource = 'All';
        document.querySelectorAll('#news-source-group .src-btn').forEach(b => b.classList.remove('active'));
        const allBtn = document.querySelector('#news-source-group .src-btn');
        if (allBtn) allBtn.classList.add('active');
    }
}

function renderNewsUI(){
    // Refresh source pill visibility first — hidden PM/Borough pills may have
    // become visible (user favorited one) or vice-versa.
    updateNewsSourcePills();
    const c=document.getElementById('news-container');
    let f=currentNews.filter(n=>{
        // Affiliation-based source filter: marauders without a PM/Borough news favorite
        // won't see those items. If user has favorited one, it shows through normally.
        if (isNewsFromHiddenSource(n)) return false;
        if(newsSource!=='All'){
            if(n.source!==newsSource) return false;
        }
        if(newsSubFilter){
            const hasSub=(n.subCategory===newsSubFilter)||(n.tags&&n.tags.includes(newsSubFilter));
            if(!hasSub) return false;
        }
        return true;
    });
    if(f.length===0){ c.innerHTML='<p class="empty-state">No news articles found.</p>'; return; }

    const hasAnyPrefs = feedPrefs && feedPrefs.length > 0;
    const hasNewsPrefs = hasAnyPrefs && feedPrefs.some(p => p.startsWith('news-'));
    if (newsSource === 'All') {
        const feedItems = hasNewsPrefs ? f.filter(n => newsMatchesFeed(n)) : [];
        const otherItems = hasNewsPrefs ? f.filter(n => !newsMatchesFeed(n)) : f;
        let html = '';
        if (hasNewsPrefs && feedItems.length > 0) {
            html += '<div class="feed-pinned-header"><span>⚡ My Favorites</span></div>';
            html += feedItems.map(n => buildNewsCard(n)).join('');
            if (otherItems.length > 0) html += '<div class="feed-divider"><span>All News</span></div>';
        } else if (!hasAnyPrefs) {
            html += '<div class="feed-setup-hint">⚙️ <a href="#" onclick="event.preventDefault();openFeedSettings();">Set up your favorites</a> to see your preferred news sources first</div>';
        } else if (hasAnyPrefs && !hasNewsPrefs) {
            html += '<div class="feed-setup-hint">No news favorites set — <a href="#" onclick="event.preventDefault();openFeedSettings();">add some</a> to pin them here</div>';
        }
        html += otherItems.map(n => buildNewsCard(n)).join('');
        c.innerHTML = html;
    } else {
        c.innerHTML = f.map(n => buildNewsCard(n)).join('');
    }
}
let allPlaces=[], placesFilter='All', placesMGMode=false, placesMBAMode=false;
let allHousing=[];   // housing.json rows (rendered audience-filtered — see renderHousing)
let placesMap=null, placesMapMarkers=null, placesMapLibReady=false, placesMapLibLoading=null, placesMapFailed=false;   // Directory map (see DIRECTORY MAP block)
let placesMapMarkerBySlug = new Map();   // slug → Leaflet marker (card-tap → pin focus)
let placesMapUserDot = null, placesMapUserAcc = null;   // "My location" dot + accuracy circle (session-only, never stored)
let placesTodayMode=false;   // "Today" lens: places with a specials box today (see placesSpecialsItems)

// --- MBA (Millersville Business Association) membership integration ----------
// association.json is the SINGLE SOURCE OF TRUTH for membership. We load it
// once, build a name->member lookup, and derive badge + audience visibility at
// render time. Place listings carry NO membership fields — this avoids drift
// (edit the roster in one place; the Directory follows).
let mbaMembers = {};          // name -> roster entry
let mbaSpotlight = [];         // spotlight buyers (rotation content)
let mbaLoaded = false;

async function loadAssociation(){
    try {
        const data = await (await fetch('association.json')).json();
        mbaMembers = {};
        (data.members || []).forEach(m => {
            // Key by the name that appears in the Directory listing: matchListing
            // when present (member's listing has a different display name),
            // otherwise the member name itself.
            const key = m.matchListing || m.name;
            mbaMembers[key] = m;
        });
        mbaSpotlight = data.spotlight || [];
        mbaLoaded = true;
        // The weather bar (which hosts the spotlight slot) and this loader run
        // in parallel. Whichever finishes last should paint the spotlight, so
        // trigger a render here too; it no-ops if the slot isn't in the DOM yet.
        if (typeof renderSpotlight === 'function') renderSpotlight();
    } catch(e){ console.error('association.json load failed:', e); mbaLoaded = false; }
}

// Is this place an MBA member? Returns the roster entry or null.
function getMembership(placeName){
    return mbaMembers[placeName] || null;
}

// Did this place buy the Featured Spotlight add-on? Returns the spotlight
// entry (logo, tagline, link, liveFeed) or null. Spotlight entries are keyed
// by member name; a place's listing name may differ, so we match against both
// the listing name and the roster member's canonical name.
function getSpotlight(placeName){
    if (!mbaSpotlight || !mbaSpotlight.length) return null;
    // Direct match on the spotlight entry name.
    let hit = mbaSpotlight.find(s => s.name === placeName);
    if (hit) return hit;
    // The listing might be matched to a roster member whose name differs from
    // the listing name (via matchListing). Resolve through the roster.
    const member = getMembership(placeName);
    if (member) {
        hit = mbaSpotlight.find(s => s.name === member.name);
        if (hit) return hit;
    }
    return null;
}

// Audience visibility for a member listing. Returns true if the member should
// be visible to the CURRENT viewer given their muAffiliation.
//
// IMPORTANT — Directory-specific convention: unset affiliation is treated as
// TOWNIE here, which is DELIBERATELY different from the rest of app.js (where
// unset is treated as 'student'/marauder, see effectiveAffiliation). Rationale:
// the Directory's purpose is local-business findability, every member wants
// locals, and the MBA partnership benefits from undecided visitors seeing the
// full local roster. So an undecided visitor sees everything a townie sees.
//
// Non-members (no roster entry) are always visible — audience targeting is an
// MBA-member benefit only.
function mbaAudienceVisible(member){
    if (!member) return true;                 // non-member: always visible
    const aud = member.audience || 'both';     // members default to 'both'
    if (aud === 'both') return true;
    // Directory rule: treat unset as townie (local).
    const viewerIsStudent = (muAffiliation === 'student');
    if (aud === 'locals')    return !viewerIsStudent;  // townies + undecided
    if (aud === 'marauders') return viewerIsStudent;   // confirmed students only
    return true;
}

// Per-listing audience visibility for Directory cards. Unlike mbaAudienceVisible
// (MBA members only), this honors an `audience` field on the listing ITSELF, so
// non-member listings — campus resources, student-only services — can be hidden
// from townies. Precedence: the listing's own audience → its MBA member audience
// → 'both'. Same Directory townie-default convention (unset affiliation = local).
// Accepts the events sheet's vocabulary too ('townies' == 'locals').
function placeAudienceVisible(place){
    if (!place) return true;
    const member = getMembership(place.name);
    let aud = String(place.audience || (member && member.audience) || 'both').toLowerCase().trim();
    if (aud === 'townie' || aud === 'townies') aud = 'locals';
    if (aud === 'marauder' || aud === 'student' || aud === 'students') aud = 'marauders';
    if (aud === 'both' || aud === 'all' || aud === 'public' || aud === '') return true;
    const viewerIsStudent = (muAffiliation === 'student');
    if (aud === 'locals')    return !viewerIsStudent;  // townies + undecided
    if (aud === 'marauders') return viewerIsStudent;    // confirmed students only
    return true;  // unknown value → fail open (visible)
}

// The "MBA Member" badge — identical for both tiers (tier is an internal MBA
// dues matter, not something residents need to see). Returns '' for non-members.
function mbaBadge(placeName){
    return '';   // Verified shield retired 2026-07 (Today lens replaced the Verified toggle); body kept below for easy restore.
    if (!getMembership(placeName)) return '';
    // Verified-business shield (navy shield, gold trim, checkmark). Granted to
    // businesses on a paid Millersville.APP listing. (Independent of the MBA.)
    return `<span class="badge-mba" title="Verified business">
        <svg class="badge-mba-shield" viewBox="0 0 24 28" aria-hidden="true">
            <path d="M12 1 L22 5 V13 C22 20 17 25 12 27 C7 25 2 20 2 13 V5 Z"
                  fill="var(--navy)" stroke="var(--gold)" stroke-width="1.5"/>
            <path d="M7.5 14 L10.5 17 L16.5 10.5" fill="none" stroke="var(--gold)"
                  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    </span>`;
}

// --- Homepage spotlight rotation --------------------------------------------
// The weather bar's right slot rotates through MBA members who bought the paid
// Featured Spotlight add-on. Audience-filtered with the same townie-default
// rule as the Directory (see mbaAudienceVisible). Rotates on a timer with a
// randomized starting index so the same member isn't always shown first.
let spotlightTimer = null;
let spotlightIndex = 0;
let spotlightPool = [];
let spotlightStarted = false;
const SPOTLIGHT_ROTATE_MS = 6000;

// --- Spotlight analytics (GA4) ----------------------------------------------
// Fire impression/click events for Featured Spotlight buyers so we can show a
// business its real reach + click-through before pitching a paid listing.
// Impressions are de-duped to once per buyer per page-load (the rotation would
// otherwise re-count every SPOTLIGHT_ROTATE_MS); clicks always fire. The
// `audience` param splits MU vs townie engagement. Guards on gtag so it no-ops
// if the GA tag is blocked/absent.
let spotlightSeen = {};
function trackSpotlight(action, s){
    if (typeof gtag !== 'function' || !s || !s.name) return;
    if (action === 'spotlight_impression'){
        if (spotlightSeen[s.name]) return;
        spotlightSeen[s.name] = true;
    }
    const aud = (typeof muAffiliation !== 'undefined' && muAffiliation === 'student') ? 'marauders' : 'townies';
    gtag('event', action, { sponsor_name: s.name, audience: aud });
}

function renderSpotlight(){
    const el = document.getElementById('home-spotlight');
    if (!el) return;  // weather bar not rendered yet — will be called again

    // Build the eligible pool: spotlight buyers visible to the current viewer.
    // We match each spotlight entry to its roster member to read audience.
    spotlightPool = (mbaSpotlight || []).filter(s => {
        const member = getMembership(s.name) || mbaMembers[s.name] || null;
        // Spotlight entries may be spotlightOnly institutions (MU/Borough/PM)
        // whose roster entry has no matchListing; look them up by name too.
        const rosterEntry = member || (mbaMembers[s.name]) || { audience: s.audience };
        // Prefer the audience on the spotlight entry itself; fall back to roster.
        const audienceCarrier = { audience: s.audience || (rosterEntry && rosterEntry.audience) || 'both' };
        return mbaAudienceVisible(audienceCarrier);
    });

    if (spotlightPool.length === 0){
        // Nothing to show (no buyers, or none visible to this viewer). Hide the
        // slot gracefully so the weather bar just shows weather.
        el.innerHTML = '';
        el.style.display = 'none';
        if (spotlightTimer){ clearInterval(spotlightTimer); spotlightTimer = null; }
        return;
    }
    el.style.display = '';

    // Clear any prior timer — we always (re)establish a single clean rotation
    // below. This avoids orphaned/duplicate timers across the loadWeather +
    // loadAssociation double-call and any later weather-bar re-renders.
    if (spotlightTimer){ clearInterval(spotlightTimer); spotlightTimer = null; }

    // Randomize the starting member so exposure is fair, but keep the index in
    // range if we're re-rendering an existing rotation.
    if (spotlightIndex >= spotlightPool.length) spotlightIndex = 0;
    if (!spotlightStarted){
        spotlightIndex = Math.floor(Math.random() * spotlightPool.length);
        spotlightStarted = true;
    }

    paintSpotlight(el);

    // Rotate only when there's more than one member to show.
    if (spotlightPool.length > 1){
        spotlightTimer = setInterval(() => {
            const node = document.getElementById('home-spotlight');
            if (!node){ clearInterval(spotlightTimer); spotlightTimer = null; return; }
            spotlightIndex = (spotlightIndex + 1) % spotlightPool.length;
            paintSpotlight(node);
        }, SPOTLIGHT_ROTATE_MS);
    }
}

function paintSpotlight(el){
    const s = spotlightPool[spotlightIndex % spotlightPool.length];
    if (!s) return;
    trackSpotlight('spotlight_impression', s);
    const link = s.link || '#';
    const logo = s.logo
        ? `<img src="${s.logo}" alt="${(s.name||'').replace(/"/g,'&quot;')}" class="spotlight-logo" loading="lazy">`
        : '';
    const tagline = s.tagline ? `<span class="spotlight-tagline">${s.tagline}</span>` : '';
    // Compact card: "Featured" kicker, logo (or name fallback), tagline.
    el.innerHTML = `<a class="spotlight-card" href="${link}" target="_blank" rel="noopener" title="${(s.name||'').replace(/"/g,'&quot;')}">
        ${logo || `<span class="spotlight-name">${s.name||''}</span>`}
        ${tagline}
    </a>`;
    const card = el.querySelector('.spotlight-card');
    if (card) card.addEventListener('click', () => trackSpotlight('spotlight_click', s));
}




async function loadHousing(){try{allHousing=await(await fetch('housing.json')).json();if(!Array.isArray(allHousing))allHousing=[];renderHousing();}catch(e){}}
// §9 fix: housing cards now run through placeAudienceVisible like every other
// listing, and re-render on every renderPlaces() call so they track identity
// switches. Blank/both/unknown audience fails open, so output is identical to
// the old unfiltered render until a housing row actually carries an audience.
function renderHousing(){const c=document.getElementById('housing-container');if(!c)return;const visible=(allHousing||[]).filter(placeAudienceVisible);visible.sort((a,b)=>(b.featured===true)-(a.featured===true));c.innerHTML=visible.map(p=>{return `<div class="app-card"><h3 class="card-title">${p.name}</h3><p class="card-meta" style="font-weight:bold;text-transform:uppercase;margin-bottom:8px;">${p.landlord}</p><p style="font-size:0.9rem;margin-bottom:16px;">${p.description}</p><div class="card-footer"><a href="${p.link}" target="_blank" class="btn btn-sm btn-outline" style="display:block;text-align:center;">View Property</a></div></div>`;}).join('');}

async function loadPlaces(){try{
    const [restaurants, services, specials, vfw, cupboardData] = await Promise.all([
        fetch('restaurants.json').then(r=>r.json()).catch(()=>[]),
        fetch('services.json').then(r=>r.json()).catch(()=>[]),
        fetch('specials.json').then(r=>r.json()).catch(()=>({})),
        fetch('vfw.json').then(r=>r.json()).catch(()=>null),
        fetch('campus-cupboard.json').then(r=>r.json()).catch(()=>undefined),
        loadAssociation()   // populate mbaMembers/mbaSpotlight before render
    ]);
    // Campus Cupboard static info from the sheet-synced file. undefined = fetch
    // failed (fall back to built-in text); null = no cupboard row in the sheet
    // (hide the resource entirely). An object = use its description/address.
    if (cupboardData !== undefined) window._cupboard = cupboardData;
    // VFW specials come from vfw.json (single source, maintained by the
    // Cowork task) — synthesized via the shared helper (also used by the home
    // rail) under the 'vfw-post-7294' slug key, overriding the scrape-time
    // block in specials.json.
    const vfwEntry = vfwSpecialsEntryFromJson(vfw);
    if (vfwEntry) specials['vfw-post-7294'] = vfwEntry;
    // Store grocery deals for popup
    const jh = specials['john-herr-s-village-market'];
    if(jh && jh.rawDeals) { allGroceryDeals = jh.rawDeals; }
    allRestaurants = restaurants;
    // Merge: add category to restaurants, combine
    const foodPlaces = restaurants.map(r => ({...r, placeType:'food', category:'Food & Drink'}));
    const svcPlaces = services.map(s => ({...s, placeType:'service'}));
    allPlaces = [...foodPlaces, ...svcPlaces];
    // Store specials globally for rendering
    window._placesSpecials = specials;
    // Diagnostic (mirrors `venue-match: unmatched locations`): specials
    // entries whose slug matches no food/service listing — usually a
    // hand-typed place-specials.json key that doesn't equal the directory
    // row's slug. Harmless at runtime (the specials just don't attach);
    // fix the JSON key, or freeze the row's slug via the sheet's `slug` column.
    const _placeSlugSet = new Set(allPlaces.map(placeSlug));
    const _unmatchedSp = Object.keys(specials).filter(s => !_placeSlugSet.has(s));
    if (_unmatchedSp.length) console.log('specials-match: unmatched slugs (fix place-specials.json keys or sheet slugs):', _unmatchedSp);
    renderPlaces();
}catch(e){console.error('Places error:',e);}}

// ============================== DIRECTORY MAP ==============================
// Leaflet + self-hosted Protomaps PMTiles basemap (/millersville.pmtiles).
// Zero third-party requests at runtime. Vendor assets (/vendor/*) are lazy-
// injected the first time the Directory view opens, so no other page pays for
// them. Pins are rebuilt from the SAME predicates as the list — audience,
// category chip, MBA and Marauder-Gold lenses — via the refreshPlacesMap()
// call in renderPlaces(), so map and list can never disagree.
const PLACES_MAP_CFG = {
    pmtiles: '/millersville.pmtiles',
    center: [40.0015, -76.3545],                 // between the square and campus
    zoom: 15, minZoom: 13, maxZoom: 18,          // basemap data is z15, overzoomed
    bounds: [[39.95, -76.44], [40.07, -76.27]]   // = the pmtiles extract bbox
};
// Pin glyphs per category. NOTE: separate from the card-side catIcons map
// (function-local in renderPlaces). Adding a directory category now means
// keeping FOUR things in agreement: sheet value, #places-filter-menu data-cat,
// catIcons, and this map.
const MAP_PIN_ICONS = {
    'Food & Drink':'🍴','Housing':'🏠','Student Housing':'🎓','Shopping':'🛒','Campus':'🏛',
    'Health':'🏥','Beauty/Grooming':'💈','Finance':'🏦','Real Estate':'🏘',
    'Home Services':'🔨','Services':'🛠','Government':'🏛','Education':'📚',
    'Recreation':'🏞','Entertainment':'🎵','Venue':'🎉','Lodging':'🛏',
    'Transport':'🚌','Shipping':'📦','Mechanic':'🔧','Gas Station':'⛽',
    'EV Charging':'🔌','Cupboard':'🧺'
};
const MAP_PIN_COLORS = { food:'#b0452b', service:'#0f6e56', housing:'#5b4bc4', cupboard:'#a06a10' };
// Per-place pin glyph overrides, keyed by DIRECTORY PLACE SLUG — checked
// before the category default at BOTH pin sites (main map pins and the
// home-popup mini map). For the rare listing whose identity beats its
// category icon. First user: Jesus Dogs (🌭, not the Food & Drink 🍴).
// Promote to a sheet column if these ever multiply past a handful.
const PLACE_PIN_OVERRIDES = { 'jesus-dogs': '🌭', 'the-backyard': '😊', 'the-hub': '🥪',
    // Campus venues (2026-08-07): per-venue glyphs; anything not listed gets
    // the 'Campus' category default 🏛. Keys are directory slugs (leading
    // "the" dropped by slugify — e.g. The Ware Center → ware-center).
    'biemesderfer-stadium': '🏈', 'pucillo-gymnasium': '🏀', 'pucillo-field': '🏑',
    'mccomsey-tennis-courts': '🎾', 'winter-visual-performing-arts-center': '🎭',
    'ware-center': '🎭', 'millersville-catholic-house': '⛪', 'mcnairy-library': '📚' };

function placesMapAssetsLoad(){
    if (placesMapLibReady) return Promise.resolve();
    if (placesMapLibLoading) return placesMapLibLoading;
    const css = href => new Promise(res => { const l=document.createElement('link'); l.rel='stylesheet'; l.href=href; l.onload=res; l.onerror=res; document.head.appendChild(l); });
    const js  = src  => new Promise((res,rej) => { const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=()=>rej(new Error('failed to load '+src)); document.head.appendChild(s); });
    placesMapLibLoading = Promise.all([css('/vendor/leaflet.css'), css('/vendor/leaflet-gesture-handling.css'), js('/vendor/leaflet.js')])
        .then(() => Promise.all([js('/vendor/protomaps-leaflet.js'), js('/vendor/leaflet-gesture-handling.js')]))
        .then(() => { placesMapLibReady = true; });
    return placesMapLibLoading;
}

function initPlacesMap(){
    if (placesMap){ setTimeout(()=>placesMap.invalidateSize(), 60); return; }
    if (placesMapFailed) return;
    const el = document.getElementById('places-map');
    if (!el) return;
    placesMapAssetsLoad().then(() => {
        if (placesMap) return;
        el.classList.add('map-ready');
        placesMap = L.map(el, {
            center: PLACES_MAP_CFG.center, zoom: PLACES_MAP_CFG.zoom,
            minZoom: PLACES_MAP_CFG.minZoom, maxZoom: PLACES_MAP_CFG.maxZoom,
            maxBounds: PLACES_MAP_CFG.bounds, maxBoundsViscosity: 1.0,
            gestureHandling: true, zoomControl: true, attributionControl: true
        });
        placesMap.attributionControl.setPrefix(false);
        protomapsL.leafletLayer({
            url: PLACES_MAP_CFG.pmtiles, flavor: 'light', lang: 'en',
            attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
        }).addTo(placesMap);
        placesMapMarkers = L.layerGroup().addTo(placesMap);
    // 🎯 "My location" control — rides the native leaflet-bar styling, sits
    // under the zoom buttons. Geolocation is strictly user-initiated (the
    // permission prompt fires on first tap, never on load).
    const locateCtl = L.control({ position: 'topleft' });
    locateCtl.onAdd = function(){
        const div = L.DomUtil.create('div', 'leaflet-bar');
        const a = L.DomUtil.create('a', 'map-locate-btn', div);
        a.href = '#'; a.title = 'Show my location';
        a.setAttribute('role', 'button'); a.setAttribute('aria-label', 'Show my location');
        a.textContent = '🎯';
        L.DomEvent.on(a, 'click', function(ev){ L.DomEvent.stop(ev); placesMapLocate(); });
        return div;
    };
    locateCtl.addTo(placesMap);
    placesMap.on('locationfound', placesMapOnLocation);
    placesMap.on('locationerror', placesMapOnLocationError);
        refreshPlacesMap();
        setTimeout(()=>{ placesMap.invalidateSize(); placesMapFitVisible(); }, 60);   // frame every listed place once the container size is right
    }).catch(e => {
        // Vendor asset failed (offline first visit, bad deploy). The map stays
        // hidden and the directory list is completely unaffected.
        console.warn('Directory map unavailable:', e && e.message);
        placesMapFailed = true;
    });
}

function placesMapHasCoords(p){ return !!p && isFinite(p.lat) && isFinite(p.lng); }

// One pin set, same rules as the visible list. Mirrors: placeAudienceVisible
// on everything; MBA lens = verified members only; MG lens = marauderGold only;
// category chip; the housing-container visibility rule; and the Campus
// Cupboard pinned-card condition (students, All / Food & Drink, no lenses).
function placesMapPinList(){
    const pins = [];
    let list = (allPlaces||[]).filter(placeAudienceVisible);
    if (placesMBAMode) list = list.filter(p => getMembership(p.name));
    if (placesMGMode)  list = list.filter(p => p.marauderGold === true);
    if (placesFilter !== 'All') list = list.filter(p => p.category === placesFilter);
    if (placesTodayMode) list = list.filter(p => placeTodayContent(p));
    list.filter(placesMapHasCoords).forEach(p => pins.push({ place: p, group: (p.placeType==='food') ? 'food' : 'service' }));
    if (!placesMGMode && !placesMBAMode && !placesTodayMode && (placesFilter==='All' || placesFilter==='Housing')){
        (allHousing||[]).filter(placeAudienceVisible).filter(placesMapHasCoords)
            .forEach(p => pins.push({ place: {...p, category:'Housing'}, group: 'housing' }));
    }
    const cb = window._cupboard;
    if (cb && placesMapHasCoords(cb) && !placesMBAMode && !placesMGMode && cupboardTodayVisible() &&
        (placesFilter==='All' || placesFilter==='Food & Drink')){
        pins.push({ place: {...cb, category:'Cupboard'}, group: 'cupboard' });
    }
    return pins;
}

function refreshPlacesMap(){
    if (!placesMap || !placesMapMarkers) return;
    const entries = placesMapPinList();
    // Fan out pins that share identical coordinates (plaza clusters like the
    // Comet Dr strip, or two listings in one building) in a ~11 m ring so
    // every pin stays individually tappable at high zoom. Display-only; the
    // underlying data is untouched.
    const byKey = {};
    entries.forEach(en => {
        en.dlat = en.place.lat; en.dlng = en.place.lng;
        const k = en.place.lat.toFixed(6) + ',' + en.place.lng.toFixed(6);
        (byKey[k] = byKey[k] || []).push(en);
    });
    Object.values(byKey).forEach(g => {
        if (g.length < 2) return;
        const r = 0.00010;
        g.forEach((en, i) => {
            const a = 2 * Math.PI * i / g.length;
            en.dlat = en.place.lat + r * Math.sin(a);
            en.dlng = en.place.lng + r * Math.cos(a) / Math.cos(en.place.lat * Math.PI / 180);
        });
    });
    placesMapMarkers.clearLayers();
    placesMapMarkerBySlug.clear();
    entries.forEach(en => {
        const p = en.place;
        const glyph = PLACE_PIN_OVERRIDES[placeSlug(p)] || MAP_PIN_ICONS[p.category] || '📍';
        const color = MAP_PIN_COLORS[en.group] || '#14203a';
        const icon = L.divIcon({ className: '', html: `<div class="map-pin" style="border-color:${color}">${glyph}</div>`, iconSize: [30,30], iconAnchor: [15,15], popupAnchor: [0,-16] });
        const m = L.marker([en.dlat, en.dlng], { icon: icon, title: p.name })
            .bindPopup(placesMapPopup(p), { maxWidth: 240 })
            .on('click', () => scrollToPlaceCard(p));
        m.addTo(placesMapMarkers);
        placesMapMarkerBySlug.set(placeSlug(p), m);
    });
}

function placesMapPopup(p){
    const q = encodeURIComponent(p.address ? (p.name + ', ' + p.address) : (p.lat + ',' + p.lng));
    let html = `<div class="map-popup"><strong>${p.name}</strong>`;
    if (p.address) html += `<div class="map-popup-meta">📍 ${p.address}</div>`;
    const _ht = placeHoursText(p);
    if (_ht) html += `<div class="map-popup-meta">🕐 ${_ht}</div>`;
    // "Today" cluster — visually separated from the identity block above.
    const today = [];
    if (p.category === 'Cupboard') today.push('🔥 Free groceries today');
    else if (placeHasSpecialsToday(placeSlug(p))) today.push('🔥 Specials today');
    const evToday = placeEventsToday(p);
    evToday.slice(0,2).forEach(e => today.push(`📅 ${e.title} · ${formatTime(new Date(e.t))}`));
    if (evToday.length > 2) today.push(`+${evToday.length-2} more today`);
    if (!evToday.length){ const nx = placeNextUpcoming(p); if (nx) today.push(`📅 Next: ${new Date(nx.t).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})} · ${nx.title}`); }
    if (today.length) html += `<div style="border-top:1px solid var(--border);margin-top:6px;padding-top:5px;">${today.map(t=>`<div class="map-popup-meta">${t}</div>`).join('')}</div>`;
    html += `<div class="map-popup-btns">`;
    if (p.link) html += `<a href="${p.link}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">Website</a>`;
    html += `<a href="https://www.google.com/maps/dir/?api=1&destination=${q}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">Directions</a></div></div>`;
    return html;
}
// ---- Event ↔ place linkage -------------------------------------------------
// Links events to directory places by venue string, once per load, powering:
// the Today lens ("specials OR events today"), the card "Here today" box, and
// pin-popup event lines. Tiers: (1) venue-aliases.json overrides (normalized
// location → slug), (2) exact normalized name, (3) street-address containment,
// (4) word-boundary name containment (guarded: 2+ words or 8+ chars).
// ⚠ slugifyPlace() is MIRRORED in scripts/sync-directory.js (slugify) — the
// two must produce identical slugs or aliases/explicit slugs stop matching.
function normVenue(v){return (v||'').toLowerCase().replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim().replace(/^the /,'');}
function slugifyPlace(name){return normVenue(name).replace(/ /g,'-');}
function placeSlug(p){return p.slug || slugifyPlace(p.name);}
let _placeEvents = new Map();
async function loadVenueAliases(){
    try{ const r = await fetch('venue-aliases.json'); if (r.ok) window._venueAliases = await r.json(); }catch(e){}
}
function linkEventsToPlaces(){
    _placeEvents = new Map();
    if (!Array.isArray(allEvents) || !allEvents.length || !allPlaces.length) return;
    const aliases = (window._venueAliases && window._venueAliases.overrides) || {};
    // Longest names first so the most specific listing wins containment ties.
    const idx = allPlaces
        .map(p => ({ slug: placeSlug(p), n: normVenue(p.name), addr: normVenue((p.address||'').split(',')[0]) }))
        .filter(x => x.n)
        .sort((a,b) => b.n.length - a.n.length);
    const now = Date.now();
    const unmatched = new Set();
    allEvents.forEach(ev => {
        const loc = normVenue(ev.location);
        if (!loc) return;
        let slug = aliases[loc] || null;
        if (!slug){ const hit = idx.find(x => x.n === loc); if (hit) slug = hit.slug; }
        if (!slug){ const hit = idx.find(x => x.addr && x.addr.length >= 8 && (' '+loc+' ').includes(' '+x.addr+' ')); if (hit) slug = hit.slug; }
        if (!slug){
            const hit = idx.find(x => (x.n.length >= 8 || x.n.includes(' ')) && (' '+loc+' ').includes(' '+x.n+' '));
            if (hit) slug = hit.slug;
        }
        if (!slug){ unmatched.add(loc); return; }
        // Tier-1 handle for the event-modal Directions resolver (2026-08-07):
        // stamped on EVERY matched event, before the today+future gate below,
        // so past events' modals resolve directions too.
        ev._venuePlace = slug;
        const t = new Date(ev.date).getTime();
        if (isNaN(t) || t < now - 86400000) return;   // today + future only
        if (!_placeEvents.has(slug)) _placeEvents.set(slug, []);
        _placeEvents.get(slug).push({ title: ev.title, t });
    });
    _placeEvents.forEach(list => list.sort((a,b) => a.t - b.t));
    if (unmatched.size) console.debug('venue-match: unmatched locations (alias candidates):', [...unmatched].slice(0,40));
}
function placeEventsToday(p){
    const list = _placeEvents.get(placeSlug(p)) || [];
    const today = new Date().toDateString();
    return list.filter(e => new Date(e.t).toDateString() === today);
}
function placeNextUpcoming(p){
    const today = new Date().toDateString();
    return (_placeEvents.get(placeSlug(p)) || []).find(e => e.t > Date.now() && new Date(e.t).toDateString() !== today) || null;
}
// ─── Event → Directions resolver v2 (2026-08-07) ───
// Gives every event-detail modal a 🧭 Directions link when its location is
// resolvable. Two tiers, first hit wins:
//   (1) linked directory place (ev._venuePlace, stamped by linkEventsToPlaces)
//       → the place's lat/lng — the same precision pin popups use. With the
//       campus rows Active, this covers campus buildings, rooms (they attach
//       to their building via name containment), and every matched business.
//       A matched place WITHOUT coords (blank lat/lng cells) falls through.
//   (2) text-query fallback: the raw location string straight into the Google
//       directions URL — named venues, embedded street addresses, and
//       away-game cities resolve with zero data maintenance.
// Suppressed for blocklisted/too-short locations. NOTE: genericLoc is
// deliberately NOT reused — it marks real venues whose names are redundant
// with the source pill (e.g. Raney), exactly where directions SHOULD work.
// (v1's venue-directions.json table was superseded by campus directory rows
// before it ever shipped — place coords now carry that load.)
const EVENT_DIR_BLOCKLIST = new Set(['tbd','tba','campus','campuswide','online','virtual','zoom','various','various locations','multiple locations','penn manor school district']);
function eventDirectionsUrl(e){
    const rawLoc = ((e && e.location) || '').trim();
    if (!rawLoc) return '';
    const loc = normVenue(rawLoc);
    if (!loc || loc.length < 3 || EVENT_DIR_BLOCKLIST.has(loc)) return '';
    if (e._venuePlace){
        const p = (allPlaces || []).find(pl => placeSlug(pl) === e._venuePlace);
        if (p && typeof p.lat === 'number' && typeof p.lng === 'number')
            return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
    }
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(rawLoc)}`;
}
// The Today-lens predicate — used by BOTH the list filter and the pin filter,
// so the two-spot mirror stays in agreement through one function.
function placeTodayContent(p){ return placeHasSpecialsToday(placeSlug(p)) || placeEventsToday(p).length > 0; }
// Pin tap → pull that place's card up under the map, with a highlight pulse.
window.scrollToPlaceCard = function(p){
    const el = document.querySelector(`#view-places [data-place="${placeSlug(p)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('place-card-flash'); void el.offsetWidth;
    el.classList.add('place-card-flash');
};
// Card tap → focus that place's pin: pan the map and open its popup (the
// reverse of scrollToPlaceCard). Real actions inside a card (links/buttons)
// win over map focus. Places without coords have no marker — silent no-op.
// Programmatic openPopup() does NOT fire the marker's 'click' handler, so
// the two directions cannot feedback-loop.
window.focusPlaceOnMap = function(pOrSlug){
    if (!placesMap) return;
    const slug = typeof pOrSlug === 'string' ? pOrSlug : placeSlug(pOrSlug);
    const m = placesMapMarkerBySlug.get(slug);
    if (!m) return;
    const mapEl = document.getElementById('places-map');
    const box = mapEl.getBoundingClientRect();
    if (box.bottom < 100 || box.top > window.innerHeight) {
        mapEl.scrollIntoView({ behavior: 'smooth', block: 'start' });   // desktop: map can be scrolled away; mobile sticky never is
    }
    const target = m.getLatLng();
    if (placesMapUserDot){
        // Frame BOTH the clicked place and the user's dot — the map answers
        // "where is it relative to me" in one view. maxZoom 17 keeps a
        // next-door pair from zooming to rooftop level.
        placesMap.fitBounds(L.latLngBounds([target, placesMapUserDot.getLatLng()]), { padding: [48, 48], maxZoom: 17 });
    } else {
        // No location dot (permission not granted / never asked): street-level
        // on the place itself — also resolves the ~11 m fan-out ring that
        // co-located listings (shared building) compress into at low zoom.
        placesMap.setView(target, Math.max(placesMap.getZoom(), 16));
    }
    m.openPopup();
};
// One delegated listener per container — attaches once, survives every
// innerHTML re-render, and works for all three data-place card templates.
['places-container', 'housing-container'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', ev => {
        if (ev.target.closest('a,button,details')) return;
        const card = ev.target.closest('[data-place]');
        if (card) focusPlaceOnMap(card.getAttribute('data-place'));
    });
});

// "My location": one-shot browser geolocation per tap (no continuous watch).
// The position is used entirely client-side — a dot on the map — and is never
// stored or transmitted. Out-of-area locations (basemap only covers the
// extract bbox, and maxBounds clamps panning) get a message, not a marker.
// Frame the map around whatever pins are currently visible (lens results).
// One pin gets a clean setView; maxZoom 16 keeps two adjacent pins from
// zooming to rooftop level; zero coordful pins leaves the view alone.
function placesMapFitVisible(){
    if (!placesMap) return;
    const pts = [];
    placesMapMarkerBySlug.forEach(m => pts.push(m.getLatLng()));
    if (!pts.length) return;
    if (pts.length === 1){ placesMap.setView(pts[0], 16); return; }
    placesMap.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 16 });
}

function placesMapLocate(){
    if (!placesMap) return;
    if (!('geolocation' in navigator)){ placesMapOnLocationError({ code: 2 }); return; }
    placesMap.locate({ setView: false, enableHighAccuracy: true, timeout: 10000 });
}
function placesMapOnLocation(e){
    console.debug('locate:', e.latlng ? (e.latlng.lat.toFixed(5) + ',' + e.latlng.lng.toFixed(5)) : e.latlng, 'accuracy(m)', Math.round(e.accuracy || 0));
    if (placesMapUserDot){ placesMap.removeLayer(placesMapUserDot); placesMapUserDot = null; }
    if (placesMapUserAcc){ placesMap.removeLayer(placesMapUserAcc); placesMapUserAcc = null; }
    if (!L.latLngBounds(PLACES_MAP_CFG.bounds).contains(e.latlng)){   // NB: the config key is `bounds`; `maxBounds` is only the Leaflet OPTION name fed from it at init
        L.popup().setLatLng(placesMap.getCenter())
            .setContent('<div style="font-weight:700;margin-bottom:2px;">Outside the map area</div><div class="map-popup-meta">Your location is outside Millersville, so there’s nothing to show here.</div>')
            .openOn(placesMap);
        return;
    }
    // Cap the accuracy circle at 150 m: desktop Wi-Fi positioning can report
    // kilometers of uncertainty, and an honest circle that big swallows the
    // whole town and reads as a broken map. The dot rides zIndexOffset 1000
    // so it can never hide under a business pin.
    placesMapUserAcc = L.circle(e.latlng, { radius: Math.min(e.accuracy || 30, 150), weight: 1, color: '#2a6df4', fillColor: '#2a6df4', fillOpacity: 0.08 }).addTo(placesMap);
    placesMapUserDot = L.marker(e.latlng, {
        icon: L.divIcon({ className: '', html: '<div class="map-user-dot" title="You are here"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false, keyboard: false, zIndexOffset: 1000
    }).addTo(placesMap);
    placesMap.setView(e.latlng, Math.max(placesMap.getZoom(), 17));   // street level — a real "take me to me", never zooms OUT
}
function placesMapOnLocationError(err){
    if (!placesMap) return;
    // Geolocation error codes: 1 = permission blocked (browser/site level),
    // 2 = position unavailable (usually the OS location service, common on
    // desktop PCs), 3 = timeout. Saying WHICH one turns a dead end into a fix.
    const code = err && err.code;
    const raw = (err && err.message) ? String(err.message) : '';
    let msg;
    if (code === 1 && /permissions? policy/i.test(raw)){
        // The document itself carries a Permissions-Policy header that excludes
        // geolocation — the browser never prompts. Fix the header (.htaccess or
        // host-level security headers), not the browser settings.
        msg = 'The site is blocking geolocation via a Permissions-Policy header — this is server config (.htaccess / host security headers), not a browser setting.';
    } else if (code === 1){
        msg = 'Location is blocked for this site. Click the padlock → Site settings → Location → Allow — and if there was never a prompt, check the browser’s own location setting too.';
    } else if (code === 3){
        msg = 'Locating timed out — try again in a moment.';
    } else {
        msg = 'Your device couldn’t determine a position. On desktop PCs this usually means the operating system’s location service is off (Windows: Settings → Privacy & security → Location).';
    }
    const detail = raw ? '<div class="map-popup-meta" style="opacity:.65;font-size:11px;margin-top:3px;">' + raw.replace(/</g, '&lt;') + '</div>' : '';
    L.popup().setLatLng(placesMap.getCenter())
        .setContent('<div style="font-weight:700;margin-bottom:2px;">Location unavailable</div><div class="map-popup-meta">' + msg + '</div>' + detail)
        .openOn(placesMap);
}

// ============================ END DIRECTORY MAP ============================

// Hide directory category chips that have no listings at all, so the Filter menu
// reflects what's actually in the directory instead of ~18 categories (many empty).
// Pruned by data + AUDIENCE: a category stays only if a loaded place in it is
// visible to the current viewer (or, for Housing, if housing.json produced cards).
// The MBA/Marauder-Gold lens toggles do NOT prune (transient — pruning on those
// would flicker the menu). Reads each button's data-cat (set in index.html).
// Idempotent; called after the parallel data load in initApp() and on affiliation switch.
function pruneEmptyPlaceCategories(){
    const menu = document.getElementById('places-filter-menu');
    if (!menu) return;
    const present = new Set((allPlaces || []).filter(p => placeAudienceVisible(p)).map(p => p && p.category).filter(Boolean));
    const hc = document.getElementById('housing-container');
    if (hc && hc.children.length) present.add('Housing');
    menu.querySelectorAll('.filter-menu-item').forEach(b => {
        const cat = b.dataset.cat;
        if (!cat || cat === 'All') return;          // never hide "All Categories"
        b.style.display = present.has(cat) ? '' : 'none';
    });
}

window.setPlacesFilter=function(cat,btn){
    placesFilter=cat;
    // Highlight the chosen menu item.
    document.querySelectorAll('#places-filter-menu .filter-menu-item').forEach(b=>b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Reflect the active category on the Filter button (e.g. "Food ▾") so the
    // current filter is visible without a category row. "All" → plain "Filter".
    const label = document.getElementById('places-filter-toggle');
    if (label){
        const txt = (cat === 'All') ? 'Filter' : (btn ? btn.textContent.trim() : cat);
        label.innerHTML = `${txt} <span id="places-filter-arrow">▾</span>`;
    }
    // Close the menu after choosing.
    const menu = document.getElementById('places-filter-menu');
    if (menu) menu.style.display = 'none';
    renderPlaces();
};

// Marauder Gold filter — ANDs with the category chip. When active, only entries
// flagged `marauderGold:true` show, split into On Campus / Off Campus sections.
// Housing is hidden entirely since apartments don't accept MG for rent.
function updatePlacesFilterNote(){
    const note = document.getElementById('places-filter-note');
    if (!note) return;
    if (placesMBAMode) note.textContent = 'Showing only verified businesses.';
    else if (placesMGMode) note.textContent = 'Showing only businesses that accept Marauder Gold.';
    else if (placesTodayMode) note.textContent = 'Showing places with specials or events today.';
    else note.textContent = '';
}

// Single source of truth for "what specials does <place> have today" — used
// by buildFoodCard's specials box, the home rail, AND the Today lens (list +
// map pins), so no surface can disagree. All rules are data-driven off the
// entry itself (specials.json / place-specials.json):
//   • closedDays: [] of weekday names — closed day ⇒ no items at all
//     (generalizes the old hardcoded VFW closed-Sun/Mon rule).
//   • "(Fri only)"-style day tags on items age out once that day has passed
//     within the Monday-start week (generalizes the old VFW Saturday rule —
//     a Fri-only item still previews Tue–Fri, drops Sat/Sun).
//   • Order: daily → recurring → weekly (matches the old VFW display; the
//     other legacy entries never had both, so nothing visibly moved).
// sp.daily is spread-copied so pushes never mutate the shared object.
// ---- Structured business hours (sheet hours_mon..hours_sun) ---------------
// Listings may carry .hours = {mon:"11:00-21:00", tue:"closed", ...} emitted
// by sync-directory.js. Ranges are 24h ET; end "24:00" allowed; end < start
// means past midnight (spills into the next day); "00:00-24:00" = 24 hours;
// comma-joined = split hours. A missing day makes NO claim. All "now" math
// is pinned to America/New_York via Intl so a traveler's device clock can't
// flip the Open/Closed badge. No .hours (or unparseable) → all of this
// renders nothing, matching the lat/lng fail-quiet convention.
const HOURS_DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];   // Date.getDay() order
function hoursNowET(){
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
        const get = t => (parts.find(p => p.type === t) || {}).value || '';
        const dayIdx = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday'));
        const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
        if (dayIdx >= 0 && isFinite(mins)) return { dayIdx, mins };
    } catch (e) { /* ancient browser without timeZone support — fall through */ }
    const d = new Date();
    return { dayIdx: d.getDay(), mins: d.getHours() * 60 + d.getMinutes() };
}
function hoursParseRanges(v){
    if (!v || v === 'closed') return [];
    return String(v).split(',').map(s => s.trim()).map(r => {
        const m = r.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
        return m ? { start: +m[1]*60 + +m[2], end: +m[3]*60 + +m[4] } : null;
    }).filter(Boolean);
}
function hoursFmtMins(m){
    m = ((m % 1440) + 1440) % 1440;
    const h24 = Math.floor(m / 60), mm = m % 60, ap = h24 >= 12 ? 'PM' : 'AM';
    let h = h24 % 12; if (h === 0) h = 12;
    return h + (mm ? ':' + String(mm).padStart(2, '0') : '') + ' ' + ap;
}
function hoursFmtRanges(v){
    return hoursParseRanges(v).map(r => hoursFmtMins(r.start) + '–' + hoursFmtMins(r.end)).join(', ');
}
// Open-now check. Today's ranges: normal (end>start) span start..end; past-
// midnight (end<=start) is open from start onward. Yesterday's past-midnight
// ranges cover the early-morning spillover (Jack's 20:00-02:00 at Sat 1 AM).
function hoursOpenNow(hours){
    const now = hoursNowET();
    const today = hours[HOURS_DAY_KEYS[now.dayIdx]];
    const yest  = hours[HOURS_DAY_KEYS[(now.dayIdx + 6) % 7]];
    if (today === undefined && yest === undefined) return null;   // no data for the relevant days
    for (const r of hoursParseRanges(today)){
        if (r.end > r.start ? (now.mins >= r.start && now.mins < r.end) : (now.mins >= r.start))
            return { open: true, until: r.end > r.start ? r.end : r.end + 1440 };
    }
    for (const r of hoursParseRanges(yest)){
        if (r.end <= r.start && now.mins < r.end) return { open: true, until: r.end };
    }
    return { open: false };
}
// Inner text for the 🕐 line ('' = render nothing). Shared by both card
// builders and both popup surfaces so status logic lives in ONE place.
function placeHoursText(p){
    const _eh = placeEffectiveHours(p);
    if (!_eh) return '';
    const st = hoursOpenNow(_eh);
    if (!st) return '';
    const todayVal = _eh[HOURS_DAY_KEYS[hoursNowET().dayIdx]];
    const r0 = hoursParseRanges(todayVal || '')[0];
    if (st.open && r0 && r0.start === 0 && r0.end === 1440)
        return '<span style="color:#15803d;font-weight:700;">Open 24 hours</span>';
    if (st.open)
        return '<span style="color:#15803d;font-weight:700;">Open</span> · until ' + hoursFmtMins(st.until);
    if (todayVal === 'closed')
        return '<span style="color:#b91c1c;font-weight:700;">Closed</span> today';
    if (todayVal === undefined) return '';   // closed per yesterday's spillover, today unknown — say nothing
    return '<span style="color:#b91c1c;font-weight:700;">Closed</span> · today ' + hoursFmtRanges(todayVal);
}
function placeHoursLineHtml(p){
    const t = placeHoursText(p);
    return t ? `<p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">🕐 ${t}</p>` : '';
}
// Weekly hours table (Mon-first), today's row highlighted. '—' = no data
// for that day (makes no claim); '00:00-24:00' reads as Open 24 hours.
const HOURS_TABLE_ORDER = ['mon','tue','wed','thu','fri','sat','sun'];
const HOURS_DAY_LABELS = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun' };
// Compact time for the horizontal table only: 10:30a, 8p, 12p.
function hoursFmtMinsCompact(m){
    m = ((m % 1440) + 1440) % 1440;
    const h24 = Math.floor(m / 60), mm = m % 60, ap = h24 >= 12 ? 'p' : 'a';
    let h = h24 % 12; if (h === 0) h = 12;
    return h + (mm ? ':' + String(mm).padStart(2, '0') : '') + ap;
}
// Horizontal weekly hours table, Sun→Sat columns, today's column highlighted.
// Always visible (no disclosure). '—' = no data; split hours stack via <br>.
function placeHoursTableHtml(p){
    const _eh = placeEffectiveHours(p);
    if (!_eh) return '';
    const order = ['sun','mon','tue','wed','thu','fri','sat'];
    const labels = { sun:'Sun', mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat' };
    const todayKey = HOURS_DAY_KEYS[hoursNowET().dayIdx];
    const hlTh = 'background:var(--gold-soft, rgba(212,175,55,0.16));';
    const cell = 'padding:3px 4px;text-align:center;border-left:1px solid var(--border);';
    const head = order.map(d =>
        `<th style="${cell}font-weight:${d===todayKey?'700':'600'};${d===todayKey?hlTh:''}">${labels[d]}</th>`).join('');
    const body = order.map(d => {
        const v = _eh[d];
        const txt = v === undefined ? '—'
            : v === 'closed' ? 'Closed'
            : v === '00:00-24:00' ? '24 hrs'
            : hoursParseRanges(v).map(r => hoursFmtMinsCompact(r.start) + '–' + hoursFmtMinsCompact(r.end)).join('<br>');
        return `<td style="${cell}${d===todayKey?hlTh+'font-weight:700;':''}">${txt}</td>`;
    }).join('');
    return `<table style="border-collapse:collapse;width:100%;font-size:0.68rem;color:var(--text);margin:4px 0 2px;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;"><tr>${head}</tr><tr>${body}</tr></table>`;
}
// Short status line + always-visible horizontal table. The `open` param is
// retained for call-site compatibility but no longer changes behavior.
function placeHoursDetailsHtml(p, open){
    const _eh = placeEffectiveHours(p);
    if (!_eh) return '';
    const st = hoursOpenNow(_eh);
    if (!st) return '';
    const todayVal = _eh[HOURS_DAY_KEYS[hoursNowET().dayIdx]];
    const r0 = hoursParseRanges(todayVal || '')[0];
    let status;
    if (st.open && r0 && r0.start === 0 && r0.end === 1440)
        status = '<span style="color:#15803d;font-weight:700;">Open 24 hours</span>';
    else if (st.open)
        status = '<span style="color:#15803d;font-weight:700;">Open</span> · until ' + hoursFmtMins(st.until);
    else
        status = '<span style="color:#b91c1c;font-weight:700;">Closed</span>';
    return `<div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">🕐 ${status}${placeHoursTableHtml(p)}</div>`;
}
// Directory sort rank from open state: open (0) → closed (1) → unknown (2).
// Places without structured hours rank unknown, so hours-less listings keep
// their old alphabetical spot at the end of each open-state band.
function hoursSortRank(p){
    const _eh = placeEffectiveHours(p);
    if (!_eh) return 2;
    const st = hoursOpenNow(_eh);
    return st ? (st.open ? 0 : 1) : 2;   // open, closed, unknown
}
// ---- Academic-calendar hours resolution (2026-07-23) ----------------------
// MU's calendar follows a stable tradition (verified vs registrar 2025-2027):
// fall classes start the 4th MONDAY of August; spring commencement is the
// SATURDAY of the week containing the first Monday of May. Both boundaries
// are COMPUTED here — the warn-only cross-check in scrape.js compares them
// against MU's own calendar feed and flags any deviation in the Action log.
// If MU ever deviates, add a SUMMER_OVERRIDES entry; the math stays the
// default. Summer window = the day after commencement through the day
// before fall classes, inclusive. All "today" reads are ET-pinned.
function hoursTodayISO(){
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    } catch (e) { /* ancient browser — fall through to device-local */ }
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function isoAddDays(iso, n){
    const [y, m, d] = String(iso).split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.getUTCFullYear() + '-' + String(t.getUTCMonth()+1).padStart(2,'0') + '-' + String(t.getUTCDate()).padStart(2,'0');
}
// MIRRORED (warn-only) as muFallStartISO/muCommencementISO in scrape.js —
// drift there mis-warns in the Action log, never mis-renders the site.
function muFallStartISO(year){
    const dow = new Date(Date.UTC(year, 7, 1)).getUTCDay();      // Aug 1
    const firstMonday = 1 + ((8 - dow) % 7);
    return year + '-08-' + String(firstMonday + 21).padStart(2,'0');   // 4th Monday
}
function muCommencementISO(year){
    const dow = new Date(Date.UTC(year, 4, 1)).getUTCDay();      // May 1
    const firstMonday = 1 + ((8 - dow) % 7);
    return year + '-05-' + String(firstMonday + 5).padStart(2,'0');    // that week's Saturday
}
// Hand override, used ONLY if MU deviates from tradition (the scrape.js
// cross-check warning is the trigger). e.g. { 2028: { from:'2028-05-14', to:'2028-08-27' } }
const SUMMER_OVERRIDES = {};
function muSummerWindow(year){
    if (SUMMER_OVERRIDES[year]) return SUMMER_OVERRIDES[year];
    return { from: isoAddDays(muCommencementISO(year), 1), to: isoAddDays(muFallStartISO(year), -1) };
}
function isoInMuSummer(iso){
    const w = muSummerWindow(+String(iso).slice(0, 4));
    return iso >= w.from && iso <= w.to;
}
// Academic-break closures for break_closed listings. ESTIMATES aligned with
// jesus-dogs.activeRanges AND the-hub.activeRanges (place-specials.json) —
// tune ALL THREE at the twice-yearly registrar check (manifest §8). Inclusive ISO ranges; year-spanning
// winter break works via full-ISO string comparison. Summer is NOT a break —
// it has its own tier (summer_hours_ cells / inheritance) above.
const MU_BREAK_RANGES = [
    { from: '2026-11-26', to: '2026-11-29' },   // Thanksgiving 2026
    { from: '2026-12-18', to: '2027-01-18' },   // Winter break 2026-27
    { from: '2027-03-29', to: '2027-04-03' },   // Spring break 2027
];
function isoInMuBreak(iso){
    return MU_BREAK_RANGES.some(r => iso >= r.from && iso <= r.to);
}
// THE resolver: every hours-reading surface goes through the shared helpers
// (placeHoursText / placeHoursDetailsHtml / hoursSortRank), which now call
// this instead of reading p.hours directly. Waterfall per DAY, resolved
// against each table column's actual calendar date this ET week (so a
// boundary week — break ends Wednesday, fall starts Monday — shows each
// column correctly, not a whole-set flip):
//   1. breakClosed listing + date in MU_BREAK_RANGES  → closed
//   2. date in the computed summer window             → summer_hours_ cell,
//      blank cell INHERITS that day's regular cell (per-day inheritance)
//   3. otherwise                                      → regular hours cell
// No base AND no summer hours → null (breakClosed alone makes no claim).
// Fast path: listings with neither summerHours nor breakClosed return
// p.hours untouched — the 53 existing hours listings behave identically.
function placeEffectiveHours(p){
    if (!p || typeof p !== 'object') return null;
    const base = (p.hours && typeof p.hours === 'object') ? p.hours : null;
    const summer = (p.summerHours && typeof p.summerHours === 'object') ? p.summerHours : null;
    if (!base && !summer) return null;
    if (!summer && !p.breakClosed) return base;
    const todayISO = hoursTodayISO();
    const todayIdx = hoursNowET().dayIdx;
    const out = {};
    for (let i = 0; i < 7; i++){
        const key = HOURS_DAY_KEYS[i];
        const dISO = isoAddDays(todayISO, i - todayIdx);
        let v;
        if (p.breakClosed && isoInMuBreak(dISO)) v = 'closed';
        else if (summer && isoInMuSummer(dISO)) v = (summer[key] !== undefined) ? summer[key] : (base ? base[key] : undefined);
        else v = base ? base[key] : undefined;
        if (v !== undefined) out[key] = v;
    }
    return Object.keys(out).length ? out : null;
}
const SPECIALS_DAY_IDX = {Monday:0,Tuesday:1,Wednesday:2,Thursday:3,Friday:4,Saturday:5,Sunday:6};
function placesSpecialsItemsFor(sp, dayName){
    if (!sp) return [];
    if (Array.isArray(sp.closedDays) && sp.closedDays.includes(dayName)) return [];
    let items = [];
    if (sp.daily && sp.daily[dayName]) items = [...sp.daily[dayName]];
    if (sp.recurring && sp.recurring[dayName]) items.push(`🔁 ${sp.recurring[dayName]}`);
    if (sp.weekly && sp.weekly.length > 0) items = [...items, ...sp.weekly];
    // 21+ gate: any item containing 🍺 is alcohol-flagged (data convention,
    // documented in place-specials.json _format) and hidden for EVERY viewer
    // until they opt in via the My Favorites "Show 21+ drink specials"
    // checkbox. This one filter point covers the home rail, both card
    // specials boxes, the Today lens, and the map pins — they all flow
    // through this function. Also catches recurring items ("🔁 🍺 ...").
    if (!show21Plus) items = items.filter(i => !i.includes('🍺'));
    const todayIdx = SPECIALS_DAY_IDX[dayName];
    if (todayIdx !== undefined) {
        items = items.filter(i => {
            const m = i.match(/\((Mon|Tues?|Wed(?:nes)?|Thur?s?|Fri|Sat(?:ur)?|Sun)(?:day)?\.?\s+only\)/i);
            if (!m) return true;
            const idx = {mon:0,tue:1,wed:2,thu:3,fri:4,sat:5,sun:6}[m[1].slice(0,3).toLowerCase()];
            return idx === undefined ? true : todayIdx <= idx;
        });
    }
    return items;
}
// Slug-keyed wrapper over the global map (specials.json is keyed by directory
// place slug — Hard Rule 11's derivation; callers pass placeSlug(p)).
function placesSpecialsItems(slug, dayName){
    return placesSpecialsItemsFor((window._placesSpecials || {})[slug], dayName);
}
function placeHasSpecialsToday(slug){
    return placesSpecialsItems(slug, new Date().toLocaleDateString('en-US',{weekday:'long'})).length > 0;
}

// Synthesize the VFW specials entry from vfw.json (the single source the
// Cowork task maintains) — shared by loadPlaces and loadHomeSpecials, always
// overriding the scrape-time block in specials.json. Weekly items honor the
// exclusive validThrough like every other weekly block (an expired week drops
// the weekly list but keeps the evergreen recurring themes). Stored under the
// 'vfw-post-7294' slug = the directory row's slug; if that row is renamed,
// freeze its slug via the sheet's explicit `slug` column.
function vfwSpecialsEntryFromJson(vfw){
    if (!(vfw && vfw.weeklySpecials)) return null;
    const vt = vfw.weeklySpecials.validThrough ? new Date(vfw.weeklySpecials.validThrough + 'T00:00:00-04:00') : null;
    const current = vt && new Date() < vt;
    return {
        name: 'VFW Post 7294',
        audience: 'locals',
        closedDays: ['Sunday','Monday'],
        note: vfw.note || '',
        weekly: current ? (vfw.weeklySpecials.items || []) : [],
        weeklyDateRange: current ? (vfw.weeklySpecials.dateRange || '') : '',
        recurring: vfw.recurring || {}
    };
}

// "Today" lens — occupies the retired ✓ Verified slot, same exclusivity
// pattern as the old MBA toggle (Today and Marauder Gold are mutually
// exclusive; the category chip still ANDs with it).
window.togglePlacesToday=function(){
    placesTodayMode=!placesTodayMode;
    if(placesTodayMode){ placesMGMode=false; const g=document.getElementById('places-mg-toggle'); if(g) g.classList.remove('active'); }
    const btn=document.getElementById('places-today-toggle');
    if(btn) btn.classList.toggle('active', placesTodayMode);
    updatePlacesFilterNote();
    renderPlaces();
    placesMapFitVisible();   // ON: frame today's places; OFF: pins just rebuilt to every listed place — frame those
    window.scrollTo(0, 0);   // lens re-render can shrink the list; don't strand the viewport below it
};

// Home-rail "View all →" target + shareable deep link (/map?today=1):
// jump to the Map page with the Today lens already on. Wired to the
// index.html rail header; the initial router also calls it for ?today=1.
window.openPlacesToday=function(){
    switchView('places');
    if(!placesTodayMode) window.togglePlacesToday();
    else window.scrollTo(0, 0);
};

window.togglePlacesMarauderGold=function(){
    placesMGMode=!placesMGMode;
    if(placesMGMode){ placesMBAMode=false; placesTodayMode=false; const m=document.getElementById('places-mba-toggle'); if(m) m.classList.remove('active'); const t=document.getElementById('places-today-toggle'); if(t) t.classList.remove('active'); }
    const btn=document.getElementById('places-mg-toggle');
    if(btn) btn.classList.toggle('active', placesMGMode);
    updatePlacesFilterNote();
    renderPlaces();
    placesMapFitVisible();   // ON: frame MG places; OFF: frame every listed place
    window.scrollTo(0, 0);   // lens re-render can shrink the list; don't strand the viewport below it
};

window.togglePlacesMBA=function(){
    placesMBAMode=!placesMBAMode;
    if(placesMBAMode){ placesMGMode=false; const g=document.getElementById('places-mg-toggle'); if(g) g.classList.remove('active'); }
    const btn=document.getElementById('places-mba-toggle');
    if(btn) btn.classList.toggle('active', placesMBAMode);
    updatePlacesFilterNote();
    renderPlaces();
};

// Let each directory card size to its own content instead of stretching to the
// tallest card in its row — that row-stretch is what left a plain card with a
// big empty body when it sat next to a card with a tall specials/deals box.
// IMPORTANT: only do this when the container lays out in a ROW (CSS grid, or
// flex-wrap row) — i.e. desktop/tablet. On a single-column mobile flex-column,
// align-items controls the horizontal axis, so forcing 'start' there would
// shrink cards off full-width. We detect the current layout and re-check on
// resize so switching between breakpoints stays correct.
let _placesFitResizeBound = false;
function applyPlacesCardFit(pc){
    if (!pc) return;
    const cs = getComputedStyle(pc);
    const isGrid = cs.display.indexOf('grid') !== -1;
    const isRowFlex = cs.display.indexOf('flex') !== -1 && cs.flexDirection.indexOf('column') === -1;
    if (isGrid || isRowFlex) pc.style.alignItems = 'start';
    else pc.style.removeProperty('align-items'); // mobile column — keep full-width stretch
    if (!_placesFitResizeBound) {
        _placesFitResizeBound = true;
        let t;
        window.addEventListener('resize', () => {
            clearTimeout(t);
            t = setTimeout(() => applyPlacesCardFit(document.getElementById('places-container')), 150);
        });
    }
}

function renderPlaces(){
    // MU-only toolbar extra: the official campus map link (index.html, hidden
    // by default). Toggled here because renderPlaces re-runs on every
    // affiliation switch — same pattern as the housing audience filter.
    const cml = document.getElementById('places-campus-map-link');
    if (cml) cml.style.display = (muAffiliation === 'student') ? '' : 'none';
    renderHousing();        // §9: housing tracks audience + affiliation switches
    refreshPlacesMap();     // pins mirror the same filters as the list (no-op until map init)
    // Marauder Gold is an MU campus payment card, so its filter toggle is only
    // relevant to confirmed students. Hide it for townies and undeclared
    // viewers; if such a viewer somehow had MG mode active, drop it so they're
    // not stuck in a filtered view with no visible toggle to turn off.
    const mgBtn = document.getElementById('places-mg-toggle');
    const showMG = (muAffiliation === 'student');
    if (mgBtn) mgBtn.style.display = showMG ? '' : 'none';
    if (!showMG && placesMGMode) {
        placesMGMode = false;
        if (mgBtn) mgBtn.classList.remove('active');
    }

    const hc=document.getElementById('housing-container');
    const pc=document.getElementById('places-container');
    applyPlacesCardFit(pc);
    const specials = window._placesSpecials || {};
    const dayName = new Date().toLocaleDateString('en-US',{weekday:'long'});

    // Marauder Gold mode short-circuits the normal flow. Housing is hidden
    // (no MG-accepting apartments), the Campus Cupboard pin is skipped (not an
    // MG vendor), and the remaining MG-accepting places are grouped into
    // labeled On Campus / Off Campus sections. The category chip still applies
    // — MG ANDs with whatever category is selected (Food, Education, etc.).
    if(placesMGMode){
        hc.style.display='none';
        pc.style.display='';
        let mgFiltered = allPlaces.filter(p => p.marauderGold === true);
        if(placesFilter !== 'All'){
            mgFiltered = mgFiltered.filter(p => p.category === placesFilter);
        }
        // Respect audience targeting here too (listing's own, else MBA member).
        mgFiltered = mgFiltered.filter(p => placeAudienceVisible(p));
        const buildCard = p => (p.placeType==='food') ? buildFoodCard(p, specials, dayName) : buildServiceCard(p);
        const onCampus  = mgFiltered.filter(p => p.onCampus === true);
        const offCampus = mgFiltered.filter(p => p.onCampus !== true);
        let html = '';
        if(onCampus.length){
            html += `<div class="day-group-header">On Campus<span class="day-count">${onCampus.length} place${onCampus.length===1?'':'s'}</span></div>`;
            html += onCampus.map(buildCard).join('');
        }
        if(offCampus.length){
            html += `<div class="day-group-header">Off Campus<span class="day-count">${offCampus.length} place${offCampus.length===1?'':'s'}</span></div>`;
            html += offCampus.map(buildCard).join('');
        }
        pc.innerHTML = html || '<p class="empty-state">No Marauder Gold places match this filter.</p>';
        return;
    }

    // Housing visibility
    if((placesFilter==='All' || placesFilter==='Housing') && !placesMBAMode && !placesTodayMode){
        hc.style.display='';
    } else {
        hc.style.display='none';
    }

    if(placesFilter==='Housing'){
        pc.style.display='none';
        return;
    }
    pc.style.display='';

    // Filter places by category
    let filtered = placesFilter==='All' ? allPlaces : allPlaces.filter(p=>p.category===placesFilter);

    // MBA member lens: when active, show only businesses that are MBA members.
    if(placesMBAMode){
        filtered = filtered.filter(p => getMembership(p.name));
    }

    // "Today" lens: only places whose card shows a specials box today.
    if(placesTodayMode){
        filtered = filtered.filter(p => placeTodayContent(p));
    }

    // Audience targeting: drop listings whose audience excludes the current
    // viewer. A listing's own `audience` wins; otherwise its MBA member audience
    // applies; non-targeted listings always pass. Unset affiliation is treated as
    // townie here (Directory-specific convention — see placeAudienceVisible).
    filtered = filtered.filter(p => placeAudienceVisible(p));

    // Directory order: food before services (outermost, unchanged), then
    // open → closed → unknown within each section (hoursSortRank — open
    // places float to the top of their section), then alphabetical. Spotlight
    // buyers still get an enhanced card (logo, gold border) via getSpotlight()
    // in the card builders, but are NOT forced to the top — the directory
    // stays a fair, predictable listing.
    filtered.sort((a,b) =>
        ((a.placeType==='food'?0:1)-(b.placeType==='food'?0:1)) ||
        (hoursSortRank(a) - hoursSortRank(b)) ||
        a.name.localeCompare(b.name)
    );

    // Campus Cupboard pinned card — marauders only, shown in All and Food & Drink
    // views (it's a free grocery store inside the HUB). Skipped for townies
    // and for filter views that exclude food (e.g. Services).
    let cupboardCard = '';
    if (!placesMBAMode && cupboardTodayVisible() && (placesFilter === 'All' || placesFilter === 'Food & Drink')) {
        cupboardCard = buildCampusCupboardCard(dayName);
    }

    // Campus venues (2026-08-07): in the default All view they'd scatter
    // through the services section's unknown-hours band — collapse them into
    // ONE native <details> group at the end instead (food-page closed-group
    // precedent; native element, resets closed on every render, inline styles
    // only per Hard Rule 2). The Campus category chip shows them expanded via
    // the normal flow; the 🔥 Today lens keeps event-day campus places
    // INLINE (decision: they earned the spot); MBA mode never includes them.
    let campusGroup = '';
    if (placesFilter === 'All' && !placesTodayMode) {
        const campusList = filtered.filter(p => p.category === 'Campus');
        if (campusList.length) {
            filtered = filtered.filter(p => p.category !== 'Campus');
            campusGroup = `<details class="place-group" style="grid-column:1/-1;"><summary style="cursor:pointer;font-weight:700;padding:8px 0;">🏛 Campus<span class="day-count">${campusList.length} place${campusList.length===1?'':'s'}</span></summary>`
                + campusList.map(p => buildServiceCard(p)).join('') + '</details>';
        }
    }
    const cards = filtered.map(p => {
        if (p.placeType === 'food') return buildFoodCard(p, specials, dayName);
        return buildServiceCard(p);
    });
    const emptyMsg = placesMBAMode
        ? '<p class="empty-state">No verified businesses match this filter.</p>'
        : placesTodayMode
        ? '<p class="empty-state">No specials listed for today — check back tomorrow.</p>'
        : '<p class="empty-state">No listings found in this category. Know a local business? <a href="#" onclick="event.preventDefault();openSubmitBusiness();">Add it here →</a></p>';
    pc.innerHTML = (cupboardCard + cards.join('') + campusGroup) || emptyMsg;
    // Let each card size to its own content instead of stretching to the tallest
    // card in its row. Equal-height rows looked fine until a card with a big
    // specials/deals box forced its short row-mates to match, leaving an ugly
    // empty void. align-items:start gives the natural-height flow desktop was
    // missing (mobile already had it, being single-column). Works for both grid
    // and flex-wrap layouts; harmless if the container is neither.
    pc.style.alignItems = 'start';
}

// (cupboardHoursObject adapter RETIRED 2026-07-23 — the Cupboard's sheet row
// now carries hours_/summer_hours_/break_closed like every other listing and
// resolves through placeEffectiveHours; superseded infrastructure removed
// outright per the goldBlurb precedent, not dormant UI.)
// Build the Campus Cupboard card for the Places page. Mirrors the food-card
// shape (header + meta + action button); hours render via the shared path.
function buildCampusCupboardCard(dayName) {
    const items = buildCampusCupboardItems(dayName);
    if (!items) return '';   // closed today (weekend) — hide the card entirely
    return `<div class="app-card" style="border-left:4px solid var(--gold);display:flex;flex-direction:column;justify-content:flex-start;">
        <div class="card-body">
            <div class="card-heading"><span style="font-size:1.5rem;">🛒</span><h3 class="card-title">Campus Cupboard</h3></div>
            <p class="card-meta" style="margin-bottom:4px;">📍 Inside The HUB, 121 N George St</p>
            <p class="card-meta">MU students only</p>
            ${placeHoursDetailsHtml(window._cupboard, false)}
            <div class="specials-section"><p style="font-size:0.8rem;font-weight:700;margin-bottom:4px;">Today's Specials (${dayName}):</p><p style="font-size:0.8rem;color:var(--text);margin:2px 0;">• Free groceries — ${items[1]}</p></div>
            <a href="https://www.hubmu.org/free-groceries" target="_blank" rel="noopener" class="btn btn-sm btn-outline" style="font-size:0.78rem;">More info ↗</a>
        </div>
    </div>`;
}

// Shared specials-section renderer for directory cards. Reads the same
// vfw-merged specials object the Today lens uses (window._placesSpecials),
// so food AND service cards (e.g. The Corn Wagon, a Shopping listing) render
// identically — placesSpecialsItems stays the single source of truth for
// closed days, day-only tags, and daily→recurring→weekly order. Returns ''
// when the place has no specials entry or nothing lands on this day.
function placeSpecialsSectionHtml(pslug, dayName){
    const sp = (window._placesSpecials || {})[pslug];
    if(!sp) return '';
    const items = placesSpecialsItems(pslug, dayName);   // single source of truth (also drives the Today lens + home rail)
    if(items.length === 0) return '';
    const isGrocery = !!(sp.rawDeals && sp.rawDeals.length);
    const note = sp.note ? `<p style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px;font-style:italic;">${sp.note}</p>` : '';
    const dateRange = (!isGrocery && sp.weeklyDateRange) ? `<p style="font-size:0.7rem;color:var(--gold);font-weight:600;margin-bottom:4px;">${sp.weeklyDateRange}</p>` : '';
    const isVFW = pslug === 'vfw-post-7294';
    const heading = isGrocery ? '🏷️ Top Weekly Deals:' : isVFW ? `Specials (${dayName}):` : `Today's Specials (${dayName}):`;
    const topItems = isGrocery ? items.slice(0, 5) : items;
    const moreItems = isGrocery ? items.slice(5) : [];
    let moreHtml = '';
    if(moreItems.length > 0){
        moreHtml = `<button onclick="showGroceryDeals(event)" class="btn btn-sm btn-outline" style="margin-top:6px;font-size:0.75rem;width:100%;text-align:center;">View All ${items.length} Deals</button>`;
    }
    return `<div class="specials-section">${dateRange}<p style="font-size:0.8rem;font-weight:700;margin-bottom:4px;">${heading}</p>${note}${topItems.map(i=>`<p style="font-size:0.8rem;color:var(--text);margin:2px 0;">• ${i}</p>`).join('')}${moreHtml}</div>`;
}

function buildFoodCard(p, specials, dayName) {
    // Action buttons
    let actionBtn='';
    if(p.status==='App Required') actionBtn=`<div style="display:flex;gap:8px;"><a href="${p.iosLink||'#'}" target="_blank" class="btn btn-sm btn-outline" style="flex:1;text-align:center;">🍎 iOS</a><a href="${p.link||'#'}" target="_blank" class="btn btn-sm btn-outline" style="flex:1;text-align:center;">🤖 Android</a></div>`;
    else if(p.status==='Order Online') actionBtn=`<a href="${p.link}" target="_blank" class="btn btn-sm btn-ticket" style="display:block;text-align:center;">🛒 Order Online</a>`;
    else actionBtn=`<a href="${p.link}" target="_blank" class="btn btn-sm btn-outline" style="display:block;text-align:center;">📄 View Menu</a>`;

    const membersBadge = p.status==='Members Only' ? '<span class="badge-members-only">Members Only</span>' : '';
    const addr = p.address ? `<p class="card-meta" style="margin-bottom:4px;">📍 ${p.address}</p>` : '';
    const ratingRow = '';   // star ratings retired with the review system (2026-07)

    // Build specials section — specials.json is slug-keyed; all display rules
    // (closed days, day-only tags) live in placesSpecialsItems, so no place
    // needs name special-casing here. Grocery styling keys off rawDeals.
    // Specials section — shared with buildServiceCard via placeSpecialsSectionHtml.
    const pslug = placeSlug(p);
    let specialsHtml = placeSpecialsSectionHtml(pslug, dayName);

    const evT = placeEventsToday(p);
    const eventsHtml = evT.length ? `<div class="specials-section"><p style="font-size:0.8rem;font-weight:700;margin-bottom:4px;">📅 Here today:</p>${evT.slice(0,3).map(e=>`<p style="font-size:0.8rem;color:var(--text);margin:2px 0;">• ${e.title} · ${formatTime(new Date(e.t))}</p>`).join('')}</div>` : '';
    return `<div class="app-card" data-place="${placeSlug(p)}" style="position:relative;display:flex;flex-direction:column;justify-content:flex-start;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;"><span class="card-tag">🍴 ${p.cuisine || 'Food & Drink'}</span><span style="display:inline-flex;gap:6px;align-items:center;flex-shrink:0;">${membersBadge}${mbaBadge(p.name)}</span></div>
        <h3 class="card-title" style="margin-top:6px;">${p.name}</h3>
        ${ratingRow}${addr}${placeHoursDetailsHtml(p, false)}
        <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:8px;">${p.description||''}</p>
        ${specialsHtml}${eventsHtml}
        <div class="card-footer" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:auto;">
            <div style="flex:1;">${actionBtn}</div>
        </div>
    </div>`;
}

function buildServiceCard(p) {
    const svcDayName = new Date().toLocaleDateString('en-US',{weekday:'long'});
    const specialsHtml = placeSpecialsSectionHtml(placeSlug(p), svcDayName);   // e.g. The Corn Wagon — Shopping listing with a specials entry
    const catIcons={'Government':'🏛','Health':'🏥','Beauty/Grooming':'💈','Shopping':'🛒','Recreation':'🏞','Transport':'🚌','Finance':'🏦','Shipping':'📦','Entertainment':'🎵','Education':'📚','Mechanic':'🔧','Gas Station':'⛽','EV Charging':'🔌','Housing':'🏠','Home Services':'🔨','Real Estate':'🏘','Venue':'🎉','Lodging':'🛏','Services':'🛠','Student Housing':'🎓'};
    const icon = catIcons[p.category] || '🏢';
    const mba = mbaBadge(p.name);
    const ratingRow = '';   // star ratings retired with the review system (2026-07)
    const hours = placeHoursDetailsHtml(p, false);
    const phone = p.phone ? `<a href="tel:${p.phone.replace(/[^+\d]/g,'')}" style="font-weight:600;font-size:0.85rem;color:var(--text);text-decoration:none;">📞 ${p.phone}</a>` : '';
    const site = p.gasLink ? `<a href="${p.gasLink}" target="_blank" class="btn btn-sm btn-outline" style="font-size:0.75rem;">⛽ Prices</a>` :
                 p.link ? `<a href="${p.link}" target="_blank" class="btn btn-sm btn-outline" style="font-size:0.75rem;">🌐 Visit</a>` : '';

    // Enhanced listing for Featured Spotlight buyers: logo header, marketing
    // tagline, gold-accented card, and a hook for live-feed content (scraped
    // specials/deals — built per business where feasible; null for now).
    const evT = placeEventsToday(p);
    const eventsHtml = evT.length ? `<div class="specials-section"><p style="font-size:0.8rem;font-weight:700;margin-bottom:4px;">📅 Here today:</p>${evT.slice(0,3).map(e=>`<p style="font-size:0.8rem;color:var(--text);margin:2px 0;">• ${e.title} · ${formatTime(new Date(e.t))}</p>`).join('')}</div>` : '';
    const spot = getSpotlight(p.name);
    if (spot) {
        const logoHtml = spot.logo
            ? `<img src="${spot.logo}" alt="${(p.name||'').replace(/"/g,'&quot;')} logo" class="enhanced-logo" loading="lazy">`
            : '';
        const taglineHtml = spot.tagline
            ? `<p class="enhanced-tagline">${spot.tagline}</p>` : '';
        // liveFeed hook: when a scraped feed is configured for this member,
        // render it here. Empty for now — wired when per-business scraping ships.
        const liveFeedHtml = '';  // placeholder for future spot.liveFeed rendering
        return `<div class="app-card card-spotlight" data-place="${placeSlug(p)}" style="display:flex;flex-direction:column;justify-content:flex-start;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                <span class="card-tag">${icon} ${p.category}</span>
                ${mba}
            </div>
            ${logoHtml}
            <h3 class="card-title" style="margin-top:6px;">${p.name}</h3>
            ${taglineHtml}
            ${ratingRow}
            <p class="card-meta" style="margin-bottom:4px;">📍 ${p.address}</p>
            ${hours}
            <p style="font-size:0.85rem;color:var(--text-muted);margin:8px 0;">${p.description}</p>
            ${liveFeedHtml}${specialsHtml}${eventsHtml}
            <div class="card-footer" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:auto;">
                ${phone}
                <div style="display:flex;gap:6px;align-items:center;">
                            ${site}
                </div>
            </div>
        </div>`;
    }

    return `<div class="app-card" data-place="${placeSlug(p)}" style="display:flex;flex-direction:column;justify-content:flex-start;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <span class="card-tag">${icon} ${p.category}</span>
            ${mba}
        </div>
        <h3 class="card-title" style="margin-top:6px;">${p.name}</h3>
        ${ratingRow}
        <p class="card-meta" style="margin-bottom:4px;">📍 ${p.address}</p>
        ${hours}
        <p style="font-size:0.85rem;color:var(--text-muted);margin:8px 0;">${p.description}</p>
        ${specialsHtml}${eventsHtml}
        <div class="card-footer" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:auto;">
            ${phone}
            <div style="display:flex;gap:6px;align-items:center;">
                    ${site}
            </div>
        </div>
    </div>`;
}
// ==================== FOOD PAGE ====================
// (Community Board RETIRED 2026-07-28, full excision per the replacement
// precedent: nav button, view, loadBoard/renderBoard/setBoardFilter, the
// post modal, the homepage preview, the search-overlay section, and the
// scrape.js board.json generator are all gone; the Food page took the nav
// slot. board.json is deleted from the repo; the Google Form + response
// sheet (1FZ-eFzLYFAgNd7aBCrU5uwb5wMQ2x9tBf_KLGa6GJS0) close at leisure.)
let allSignups=[]; // youth sports registration windows (homepage Upcoming Signups)
async function loadSignups(){try{const d=await(await fetch('youth-sports-registration.json')).json();allSignups=(d&&d.registrations)?d.registrations:[];}catch(e){allSignups=[];}}

// Food page (/food) -- v3 (2026-07-30; v2 2026-07-28, v1 same day): the
// page answers "where can I eat TODAY" in one phone screen, minimal scroll.
//   1. Free food TODAY as home-timeline LINE ITEMS (buildTimelineItem --
//      tap opens the standard openEventDetails popup, the home-page
//      interaction). Nothing today -> ONE compact muted tappable next-up
//      line (v3 fixed the v2 drift that rendered a dated header PLUS a
//      full timeline item -- redundant on the page). Audience-gated via
//      isHiddenForViewer as before; 3-hour started-grace so a 10 PM
//      Jesus Dogs still shows at 11:30 PM.
//   1.5 ALL viewers (v4 2026-07-31; was locals/unset only): Today's
//      Specials strip above the listings -- one tappable line per place
//      with items today (placesSpecialsItemsFor = single source of truth,
//      21+ gate inside; audience gating mirrors loadHomeSpecials) ->
//      openHomeSpecialPopup does the detail work. Marauders get the
//      Campus Cupboard as the FIRST line (cupboardTodayVisible-equivalent
//      gate) -- this REPLACED the v3 pinned Food-page card.
//   2. Listings show places open TODAY: foodOpenState rank <= 1 (open now,
//      or opening later today with an 'Opens 10 AM' label). The shared
//      hoursSortRank is untouched -- it also drives the Places-page sort.
//      Rows are collapsed native <details> (summary = name + status +
//      specials dot; body = the untouched buildFoodCard -- specials box,
//      21+ gate, shared hours path). Done-for-the-day + hours-unlisted
//      rows sit behind PER-GROUP toggles (toggleFoodClosed('on'|'off'|
//      'all')); both flags RESET on every view entry (switchView hook).
//      A group with 0 open still shows its header + toggle (v3 -- the v2
//      empty-group vanish hid campus dining entirely late-night).
//      (The v3 pinned Cupboard card here was RETIRED in v4 -- the
//      Cupboard now rides the 1.5 strip like every other special;
//      buildCampusCupboardCard still serves the Places page.)
//   3. Townie-only pantry pointer card below the toggle -- primary action
//      is the Loft's Calendly scheduling link (hardcoded, Cupboard
//      static-info convention) with a muted view-on-map fallback.
//   3.5 Marauder-only SNAP Benefits pointer card (v4): PA COMPASS
//      eligibility + application links, SNAP-station location line.
// Rebuilt on view entry, initApp post-load, and all three affiliation/21+
// switch paths (standing rule). NOT a map surface (no pin mirror).
// ⚠ Live-smoke check: tl-item styling assumed CLASS-scoped in style.css
// (the home skeleton markup suggests so); if the free-food lines render
// unstyled, the rules are #home-timeline-scoped — add a shared class then.
let foodShowClosedOn = false, foodShowClosedOff = false;   // per-group session toggles (On/Off Campus; the flat non-student list drives both in lockstep); reset on every /food entry
window.toggleFoodClosed = function(grp){
    if (grp === 'on') foodShowClosedOn = !foodShowClosedOn;
    else if (grp === 'off') foodShowClosedOff = !foodShowClosedOff;
    else foodShowClosedOn = foodShowClosedOff = !(foodShowClosedOn && foodShowClosedOff);   // flat list ('all'): one button, both flags together
    renderFoodPage();
};
// Food-page-local open-state classifier -- FINER than the shared
// hoursSortRank (open/closed/unknown), which also drives the Places-page
// sort and must not be widened. Reads through placeEffectiveHours + the
// shared parse helpers per the hours-arc rule (never p.hours directly).
//   rank 0 open now (until = closing mins) | 1 opens later today
//   (opensAt = opening mins) | 2 done for the day / closed today |
//   3 no hours data. The page shows rank <= 1 by default ("where can I
//   eat TODAY" -- a 9:45 AM visit lists a 10 AM opener as 'Opens 10 AM'
//   instead of hiding it until the minute it opens).
function foodOpenState(p){
    const eh = placeEffectiveHours(p);
    if (!eh) return { rank: 3 };
    const st = hoursOpenNow(eh);
    if (!st) return { rank: 3 };
    if (st.open) return { rank: 0, until: st.until };
    const now = hoursNowET();
    const nxt = hoursParseRanges(eh[HOURS_DAY_KEYS[now.dayIdx]] || '')
        .filter(r => r.start > now.mins).sort((a,b) => a.start - b.start)[0];
    return nxt ? { rank: 1, opensAt: nxt.start } : { rank: 2 };
}
function renderFoodPage(){
    const c = document.getElementById('food-container');
    if (!c) return;
    const specials = window._placesSpecials || {};
    const now = new Date();
    const dayName = now.toLocaleDateString('en-US',{weekday:'long'});
    const isStudent = (muAffiliation === 'student');
    const secHdr = (label, count) => `<div class="day-group-header">${label}${count !== undefined ? `<span class="day-count">${count}</span>` : ''}</div>`;
    let html = '';

    // --- 1. Free food TODAY (line items + popup); else ONE next-up line ---
    const todayStr = now.toDateString();   // same today-convention as placeEventsToday
    const ffAll = (typeof allEvents !== 'undefined' ? allEvents : []).filter(e =>
        e && Array.isArray(e.benefits) && e.benefits.includes('Free Food') && !isHiddenForViewer(e)
    );
    const ffToday = ffAll.filter(e =>
        new Date(e._dateMs || e.date).toDateString() === todayStr &&
        (e._dateMs || 0) >= now.getTime() - 3*60*60*1000
    );
    if (ffToday.length){
        html += secHdr('🍕 Free Food Today', String(ffToday.length));
        html += `<div style="margin-bottom:14px;">${ffToday.map(e => buildTimelineItem(e, now)).join('')}</div>`;
    } else {
        const next = ffAll.find(e => (e._dateMs || 0) > now.getTime());
        if (next){
            const nd = new Date(next._dateMs);
            const ndTxt = nd.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
            const nk = JSON.stringify(getEventKey(next)).replace(/"/g, '&quot;');
            html += `<p role="button" tabindex="0" onclick="window.openEventDetails(${nk})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.openEventDetails(${nk})}" style="cursor:pointer;font-size:0.82rem;color:var(--text-muted);margin:2px 0 14px;">🍕 Free food returns <strong>${ndTxt}</strong> · ${escHtml(next.title || '')} →</p>`;
        } else if (muAffiliation !== 'townie'){
            html += `<p style="font-size:0.8rem;color:var(--text-muted);margin:2px 0 12px;">🍕 No free-food events scheduled — they return with the semester.</p>`;
        }
    }

    // --- 1.5 Today's Specials strip (ALL viewers as of v4 2026-07-31;
    // was locals/unset only -- the pinned Cupboard card covered marauders).
    // Same rules as the home rail: placesSpecialsItemsFor is the single
    // source of truth (21+ gate, closedDays, day-only tags inside);
    // audience gating mirrors loadHomeSpecials ('locals' hides from
    // marauders, 'marauders' hides from townies/unset). Marauders get the
    // Campus Cupboard as the FIRST line (buildCampusCupboardItems null =
    // weekend/break/no-data -> line absent) -- it replaced the retired
    // pinned Food-page card; tap opens the existing synthesized popup
    // branch (openHomeSpecialPopup('campus-cupboard')). Every line -> the
    // home-rail popup, which degrades gracefully. ---
    {
        const spLines = [];
        const cbItems = isStudent && typeof buildCampusCupboardItems === 'function' ? buildCampusCupboardItems(dayName) : null;
        if (cbItems){
            // cbItems[0] is "Open today: <hours>" (buildCampusCupboardItems)
            // -- strip that prefix for the line text; if the wording ever
            // changes, the full text shows instead (graceful, never wrong).
            const cbHours = String(cbItems[0]).replace(/^Open today:\s*/i, '');
            spLines.push(`<p role="button" tabindex="0" onclick="openHomeSpecialPopup('campus-cupboard')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openHomeSpecialPopup('campus-cupboard')}" style="cursor:pointer;font-size:0.85rem;margin:6px 0;padding:9px 12px;background:var(--surface);border:1px solid var(--gold);border-radius:var(--radius-sm);">🏷️ <strong>Campus Cupboard</strong> — Free groceries · ${cbHours} <span style="color:var(--text-muted);">· MU students only</span></p>`);
        }
        for (const [slug, sp] of Object.entries(specials)){
            if (!sp) continue;
            if (sp.audience === 'locals' && isStudent) continue;
            if (sp.audience === 'marauders' && !isStudent) continue;
            const items = placesSpecialsItemsFor(sp, dayName);
            if (!items.length) continue;
            const more = items.length > 1 ? ` <span style="color:var(--text-muted);">+${items.length - 1} more</span>` : '';
            spLines.push(`<p role="button" tabindex="0" onclick="openHomeSpecialPopup('${slug}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openHomeSpecialPopup('${slug}')}" style="cursor:pointer;font-size:0.85rem;margin:6px 0;padding:9px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);">🏷️ <strong>${sp.name || slug}</strong> — ${items[0]}${more}</p>`);
        }
        if (spLines.length){
            html += secHdr("Today's Specials", String(spLines.length));
            html += `<div style="margin-bottom:14px;">${spLines.join('')}</div>`;
        }
    }

    // --- 2. Listings: open TODAY by default (open now + opens later today,
    // via foodOpenState); done-for-the-day + unlisted rows behind PER-GROUP
    // toggles. Collapsed native <details> rows -- summary keeps the default
    // list-item display so the browser's rotating marker is the affordance;
    // inline styles only (style.css is mixed-endings, Hard Rule 2). ---
    const food = (typeof allPlaces !== 'undefined' ? allPlaces : [])
        .filter(p => p && p.placeType === 'food' && placeAudienceVisible(p));
    const stCache = new Map();
    const stOf = p => { if (!stCache.has(p)) stCache.set(p, foodOpenState(p)); return stCache.get(p); };
    const byState = (a,b) => (stOf(a).rank - stOf(b).rank) || a.name.localeCompare(b.name);
    const stTxt = st =>
        st.rank === 0 ? `<span style="color:#15803d;font-weight:700;">Open</span>${st.until !== undefined ? ' · until ' + hoursFmtMins(st.until) : ''}`
      : st.rank === 1 ? `<span style="color:#b45309;font-weight:700;">Opens ${hoursFmtMins(st.opensAt)}</span>`
      : st.rank === 2 ? `<span style="color:#b91c1c;font-weight:700;">Closed</span> today`
      : `<span style="color:var(--text-muted);">Hours unlisted</span>`;
    const sumRow = (label, st) => `<summary style="cursor:pointer;padding:10px 12px;font-size:0.9rem;"><span style="display:inline-flex;width:calc(100% - 22px);justify-content:space-between;align-items:center;gap:8px;vertical-align:middle;"><span style="font-weight:600;">${label}</span><span style="font-size:0.78rem;white-space:nowrap;">${stTxt(st)}</span></span></summary>`;
    const rowFor = p => {
        const hasSp = placesSpecialsItems(placeSlug(p), dayName).length > 0;
        return `<details style="border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);margin:6px 0;">${sumRow(`${p.name}${hasSp ? ' 🏷️' : ''}`, stOf(p))}<div style="padding:0 8px 10px;">${buildFoodCard(p, specials, dayName)}</div></details>`;
    };
    // Cupboard: pinned <details> card RETIRED in v4 (2026-07-31) -- the
    // Cupboard now rides the section-1.5 specials strip like every other
    // special (first line, marauders only). buildCampusCupboardCard still
    // serves the Places page; cupboardTodayVisible still gates pin/lens.
    const closedHdr = `<p style="font-size:0.78rem;font-weight:700;color:var(--text-muted);margin:10px 0 2px;">Closed</p>`;
    const toggleBtn = (grp, on, n) => `<div style="text-align:center;margin:8px 0 12px;"><button onclick="toggleFoodClosed('${grp}')" class="btn btn-sm btn-outline" style="font-size:0.8rem;">${on ? 'Hide closed places' : `Show ${n} closed or unlisted place${n===1?'':'s'}`}</button></div>`;
    let anyRows = false;
    const renderGroup = (label, list, grp, on) => {
        const vis = list.filter(p => stOf(p).rank <= 1).sort(byState);
        const hid = list.filter(p => stOf(p).rank >= 2).sort(byState);
        if (!vis.length && !hid.length) return;
        anyRows = true;
        html += secHdr(label, `${vis.length} open today`);   // 0-open groups keep their header + toggle (v3 -- no more empty-group vanish)
        html += vis.map(rowFor).join('');
        if (on && hid.length) html += closedHdr + hid.map(rowFor).join('');
        if (hid.length) html += toggleBtn(grp, on, hid.length);
    };
    if (isStudent){
        renderGroup('On Campus', food.filter(p => p.onCampus === true), 'on', foodShowClosedOn);
        renderGroup('Off Campus', food.filter(p => p.onCampus !== true), 'off', foodShowClosedOff);
    } else {
        renderGroup('Open Today', food, 'all', foodShowClosedOn && foodShowClosedOff);
    }
    if (!anyRows){
        html += `<p class="empty-state">Nothing's open today.</p>`;
    }

    // --- 3. Food-pantry pointer (townies only). Primary action is the
    // Loft's Calendly scheduling link (hardcoded -- the Cupboard static-info
    // convention; update in place if the link changes); the old map jump
    // stays as a muted fallback link (openPantryOnMap kept). ---
    if (muAffiliation === 'townie'){
        const pantry = (typeof allPlaces !== 'undefined' ? allPlaces : []).find(p => p && /pantry/i.test(p.name || ''));
        if (pantry){
            html += `<div class="app-card" style="border-left:4px solid var(--gold);">
                <span class="card-tag">🥫 Community Resource</span>
                <h3 class="card-title" style="margin-top:6px;">Need food assistance?</h3>
                <p style="font-size:0.85rem;color:var(--text-muted);margin:6px 0 10px;">${escHtml(pantry.name)} offers free food for families in need — schedule a visit online.</p>
                <a href="https://calendly.com/jenna-loftcp/new-meeting" target="_blank" rel="noopener" class="btn btn-sm btn-outline" style="display:block;width:100%;text-align:center;">🗓️ Schedule a visit ↗</a>
                <p style="text-align:center;margin:8px 0 0;"><a href="#" onclick="event.preventDefault();openPantryOnMap('${placeSlug(pantry)}')" style="font-size:0.78rem;color:var(--text-muted);">📍 View on map</a></p>
            </div>`;
        }
    }

    // --- 3.5 SNAP Benefits pointer (marauders only, v4 2026-07-31).
    // Static info per the Cupboard convention -- the two PA COMPASS links
    // (eligibility check vs application) and the on-campus SNAP-station
    // location are hardcoded here; update in place if either moves. Two
    // links means a single sheet website cell can't carry this, so the
    // card stays code-side (no directory row). ---
    if (isStudent){
        html += `<div class="app-card" style="border-left:4px solid var(--gold);">
            <span class="card-tag">💳 Student Resource</span>
            <h3 class="card-title" style="margin-top:6px;">SNAP Benefits (Food Stamps)</h3>
            <p style="font-size:0.85rem;color:var(--text-muted);margin:6px 0 10px;">Monthly grocery money for eligible students. Get in-person help at the SNAP station — SMC Main Floor, upper seating area of Chick-Fil-A.</p>
            <div style="display:flex;gap:8px;">
                <a href="https://www.compass.dhs.pa.gov/intake/#/getstarted" target="_blank" rel="noopener" class="btn btn-sm btn-outline" style="flex:1;text-align:center;">Check eligibility ↗</a>
                <a href="https://www.compass.dhs.pa.gov/home/#/" target="_blank" rel="noopener" class="btn btn-sm btn-outline" style="flex:1;text-align:center;">Apply ↗</a>
            </div>
        </div>`;
    }

    c.innerHTML = html || '<p class="empty-state">No food listings available right now.</p>';
    c.style.alignItems = 'start';   // natural-height cards, same rationale as renderPlaces
}
// Pantry pointer -> /map with that card pulled up + flashed. initPlacesMap is
// lazy in switchView; the CARD exists as soon as renderPlaces has run (initApp),
// so a short settle covers the view transition. scrollToPlaceCard takes the
// place object (it derives the slug itself).
window.openPantryOnMap = function(slug){
    switchView('places');
    const p = (typeof allPlaces !== 'undefined' ? allPlaces : []).find(x => placeSlug(x) === slug);
    if (p) setTimeout(() => window.scrollToPlaceCard(p), 350);
};

window.openSubmitBusiness=function(){
    openAdvertiseForm();
};

// ==================== BUSINESS REVIEWS ====================
// TODO: Replace these with actual Google Form ID and entry IDs after creating the form
const REVIEW_FORM_ID = '1FAIpQLSfhrXMwntQtaSgEru41iDOlsMgD8GrtqkIsbGaL8dwPqODUaA';
// (Review system retired 2026-07 — form, modal, star picker, and ratings removed site-wide.)

function loadMajorClubsMapping() {
    if (majorClubsMapping) return Promise.resolve(majorClubsMapping);
    if (majorClubsMappingLoadPromise) return majorClubsMappingLoadPromise;
    majorClubsMappingLoadPromise = fetch('major-clubs-mapping.json')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            majorClubsMapping = data;
            return data;
        })
        .catch(err => {
            // File missing or malformed isn't a fatal error — picker just
            // hides the major dropdown. Search still works.
            console.warn('Major mapping unavailable:', err);
            majorClubsMapping = null;
            return null;
        });
    return majorClubsMappingLoadPromise;
}

// Match a club against a major spec from the mapping. Returns true if any
// keyword (substring of name or category) matches, OR any of the major's
// listed categories matches one of the club's categories. Case-insensitive.
function clubMatchesMajor(club, majorSpec) {
    if (!club || !majorSpec) return false;
    const nameLower = (club.name || '').toLowerCase();
    const catLower = (club.category || '').toLowerCase();
    const cats = (club.categories || []).map(c => (c || '').toLowerCase());
    // Pool the singular .category string with the .categories array for
    // robust matching — some clubs (especially event-derived ones) only
    // have the singular field populated.
    const allCats = catLower ? [...cats, catLower] : cats;
    const keywords = majorSpec.keywords || [];
    for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        if (nameLower.includes(kwLower)) return true;
        if (catLower.includes(kwLower)) return true;
    }
    const majorCats = (majorSpec.categories || []).map(c => c.toLowerCase());
    for (const mc of majorCats) {
        if (allCats.some(c => c.includes(mc))) return true;
    }
    return false;
}
async function loadClubsDirectory() {
    try {
        const res = await fetch('clubs.json');
        if (!res.ok) return;
        allClubsDirectory = await res.json();
    } catch (e) {
        // Non-fatal — the club browser falls back to events-derived list
        console.log('Clubs directory not available');
    }
}

// Grocery deals popup
let allGroceryDeals = [];
window.showGroceryDeals = function(e) {
    if(e) e.stopPropagation();
    if(allGroceryDeals.length === 0) return;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.onclick = function(ev){ if(ev.target===overlay) overlay.remove(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:480px;width:100%;max-height:80vh;overflow-y:auto;padding:24px;position:relative;';
    const dateRange = allGroceryDeals[0]?.dateRange || '';
    modal.innerHTML = `<button onclick="this.closest('div[style*=fixed]').remove()" class="modal-close-btn">✕</button>
        <h3 style="margin-bottom:4px;">🏷️ John Herr's Weekly Deals</h3>
        ${dateRange ? `<p style="font-size:0.8rem;color:var(--gold);font-weight:600;margin-bottom:12px;">${dateRange}</p>` : ''}
        ${allGroceryDeals.map((d,i) => `<div style="padding:8px 0;${i>0?'border-top:1px solid var(--border);':''}">
            <span style="font-weight:600;">${d.item}</span>
            <span style="color:var(--gold);font-weight:700;float:right;">${d.salePrice}</span>
            ${d.regularPrice ? `<br><span style="font-size:0.75rem;color:var(--text-muted);text-decoration:line-through;">${d.regularPrice}</span>` : ''}
            ${d.savings ? `<span style="font-size:0.75rem;color:#16a34a;margin-left:6px;">${d.savings}</span>` : ''}
        </div>`).join('')}
        <a href="https://www.johnherrsvillagemarket.com/weekly-ad" target="_blank" class="btn btn-sm btn-ticket" style="display:block;text-align:center;margin-top:16px;">View Full Circular</a>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

// Global Search
window.openSearch = function() {
    const overlay = document.createElement('div');
    overlay.id = 'search-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:var(--bg);z-index:9999;display:flex;flex-direction:column;';
    overlay.innerHTML = `
        <div style="padding:16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border);background:var(--surface);">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="search-input" type="text" placeholder="Search events, news, food, services..." autofocus style="flex:1;padding:10px;border:none;font-family:inherit;font-size:1rem;background:transparent;color:var(--text);outline:none;">
            <button onclick="document.getElementById('search-overlay').remove()" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-muted);padding:4px 8px;">✕</button>
        </div>
        <div id="search-results" style="flex:1;overflow-y:auto;padding:16px;"></div>`;
    document.body.appendChild(overlay);
    const input = document.getElementById('search-input');
    // Debounce search input — runSearch does a full filter + DOM rebuild on
    // ~1200 events, which feels laggy on phones for longer queries. 120ms
    // wait gives the user time to finish typing a word before we re-render.
    // Empty input still clears immediately (no debounce on the cleared state)
    // since users tend to expect Backspace-to-clear to feel instant.
    let searchDebounceTimer = null;
    input.addEventListener('input', function(){
        const val = this.value;
        clearTimeout(searchDebounceTimer);
        if (!val) {
            // Cleared input: respond immediately, no delay
            runSearch('');
            return;
        }
        searchDebounceTimer = setTimeout(() => runSearch(val), 120);
    });
    input.addEventListener('keydown', function(ev){ if(ev.key==='Escape') overlay.remove(); });
    document.getElementById('search-results').innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px;">Start typing to search across all content</p>';
    // Focus the input — autofocus attribute isn't reliable for dynamically-injected elements
    // Small delay ensures the browser has painted the overlay before focusing (prevents iOS keyboard jank)
    setTimeout(() => input.focus(), 50);
};

function runSearch(q) {
    const results = document.getElementById('search-results');
    if (!q || q.length < 2) {
        results.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px;">Start typing to search across all content</p>';
        return;
    }
    const ql = q.toLowerCase();
    let html = '';

    // Search Events (non-sport, upcoming)
    const now = new Date();
    const nowMs = now.getTime();
    const eventHits = allEvents.filter(e => {
        if ((e._dateMs || 0) < nowMs) return false;
        const text = (e.title + ' ' + e.location + ' ' + (e.tags||[]).join(' ')).toLowerCase();
        return text.includes(ql);
    }).slice(0, 6);
    if (eventHits.length) {
        html += `<div style="margin-bottom:20px;"><h4 class="modal-section-label">📅 Events</h4>`;
        eventHits.forEach(e => {
            const d = new Date(e.date);
            const src = (e.tags||[])[0] || '';
            const eventKey = getEventKey(e).replace(/"/g, '&quot;').replace(/'/g, "\\'");
            const clickAction = `document.getElementById('search-overlay').remove();window.openEventDetails('${eventKey}');`;
            // "Not in your feed" badge + note, accurate to the viewer's side:
            // student-only (hidden from townies) vs townie-only (hidden from marauders).
            const hiddenForMe = isHiddenForViewer(e);
            const townieView = muAffiliation === 'townie';
            const muOnlyBadge = hiddenForMe
                ? (townieView
                    ? '<span style="display:inline-block;background:var(--gold-soft);color:var(--navy);border:1px solid var(--gold);font-size:0.68rem;font-weight:600;padding:1px 6px;border-radius:10px;margin-left:6px;vertical-align:1px;">🎓 MU students only</span>'
                    : '<span style="display:inline-block;background:var(--gold-soft);color:var(--navy);border:1px solid var(--gold);font-size:0.68rem;font-weight:600;padding:1px 6px;border-radius:10px;margin-left:6px;vertical-align:1px;">🏘️ Townies only</span>')
                : '';
            const hiddenNote = hiddenForMe
                ? (townieView
                    ? '<div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;font-style:italic;">Not shown in your feed — you marked yourself as a townie</div>'
                    : '<div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;font-style:italic;">Not shown in your feed — you marked yourself as a Marauder</div>')
                : '';
            html += `<div class="search-result" onclick="${clickAction}">
                <span style="font-size:0.7rem;color:var(--text-muted);">${src}</span>${muOnlyBadge}
                <p style="font-weight:600;margin:2px 0;">${e.title}</p>
                <span style="font-size:0.8rem;color:var(--text-muted);">${formatDate(d)} · ${cleanLocation(e.location)}</span>
                ${hiddenNote}
            </div>`;
        });
        html += '</div>';
    }

    // Search Sports (upcoming games)
    const sportHits = allEvents.filter(e => {
        const tags = e.tags || [];
        if (!tags.includes('Athletic Competitions') && !tags.includes('Athletics')) return false;
        if ((e._dateMs || 0) < nowMs) return false;
        const text = (e.title + ' ' + e.location + ' ' + tags.join(' ')).toLowerCase();
        return text.includes(ql);
    }).slice(0, 6);
    if (sportHits.length) {
        html += `<div style="margin-bottom:20px;"><h4 class="modal-section-label">🏆 Sports</h4>`;
        sportHits.forEach(e => {
            const d = new Date(e.date);
            const src = (e.tags||[])[0] || '';
            const eventKey = getEventKey(e).replace(/"/g, '&quot;').replace(/'/g, "\\'");
            const clickAction = `document.getElementById('search-overlay').remove();window.openEventDetails('${eventKey}');`;
            html += `<div class="search-result" onclick="${clickAction}">
                <span style="font-size:0.7rem;color:var(--text-muted);">${src}</span>
                <p style="font-weight:600;margin:2px 0;">${e.title}</p>
                <span style="font-size:0.8rem;color:var(--text-muted);">${formatDate(d)} · ${cleanLocation(e.location)}</span>
            </div>`;
        });
        html += '</div>';
    }

    // Search News
    const newsHits = (currentNews||[]).filter(n => {
        // Respect affiliation-based source hiding (marauders don't see PM/Borough
        // news in search unless they've favorited one).
        if (isNewsFromHiddenSource(n)) return false;
        return (n.title + ' ' + n.source).toLowerCase().includes(ql);
    }).slice(0, 5);
    if (newsHits.length) {
        html += `<div style="margin-bottom:20px;"><h4 class="modal-section-label">📰 News</h4>`;
        newsHits.forEach(n => {
            html += `<div class="search-result" onclick="window.open('${n.link}','_blank')">
                <span style="font-size:0.7rem;color:var(--text-muted);">${n.source}</span>
                <p style="font-weight:600;margin:2px 0;">${escHtml(decodeEntities(n.title))}</p>
                <span style="font-size:0.8rem;color:var(--text-muted);">${n.date || ''}</span>
            </div>`;
        });
        html += '</div>';
    }

    // Search Places (food + services)
    const svcHits = (allPlaces||[]).filter(s => {
        return (s.name + ' ' + (s.category||'') + ' ' + (s.cuisine||'') + ' ' + (s.description||'')).toLowerCase().includes(ql);
    }).slice(0, 5);
    if (svcHits.length) {
        html += `<div style="margin-bottom:20px;"><h4 class="modal-section-label">📍 Places</h4>`;
        svcHits.forEach(s => {
            html += `<div class="search-result" onclick="document.getElementById('search-overlay').remove();switchView('places');">
                <p style="font-weight:600;margin:2px 0;">${s.name}</p>
                <span style="font-size:0.8rem;color:var(--text-muted);">${s.category||s.cuisine||''} · ${s.description?.substring(0,60)||''}</span>
            </div>`;
        });
        html += '</div>';
    }

    if (!html) {
        html = `<p style="color:var(--text-muted);text-align:center;margin-top:40px;">No results for "${q}"</p>`;
    }
    results.innerHTML = html;
}

window.refreshCam=function(){const cam=document.getElementById('cam-img');if(cam)cam.src=`/wxcam.php?t=${Date.now()}`;const t=document.getElementById('cam-time');if(t)t.textContent=`Updated: ${new Date().toLocaleTimeString()}`;};

// Advertise Form
window.openAdvertiseForm = function() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
    overlay.onclick = function(ev){ if(ev.target===overlay) overlay.remove(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:520px;width:100%;max-height:90vh;overflow-y:auto;padding:28px;position:relative;';
    modal.innerHTML = `
        <button onclick="this.closest('div[style*=fixed]').remove()" class="modal-close-btn">✕</button>
        <h3 style="margin-bottom:4px;">📢 Advertise With Us</h3>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:16px;">Tell us how we can help and we'll get back to you within 24 hours.</p>
        <div id="adv-form-fields">
            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Business Name *</label>
            <input id="adv-biz" type="text" placeholder="e.g. Joe's Pizza" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Contact Name *</label>
            <input id="adv-name" type="text" placeholder="Your name" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <div style="display:flex;gap:12px;margin-bottom:12px;">
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Email *</label>
                    <input id="adv-email" type="email" placeholder="you@business.com" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Phone *</label>
                    <input id="adv-phone" type="tel" placeholder="717-555-1234" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
            </div>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Website</label>
            <input id="adv-website" type="url" placeholder="https://yourbusiness.com" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:6px;">Audience Preference</label>
            <div id="adv-audience" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
                ${['Locals','University Community','Both'].map(a => `<label style="display:flex;align-items:center;gap:5px;font-size:0.85rem;padding:6px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;background:var(--bg);"><input type="radio" value="${a}" name="adv-aud" style="accent-color:var(--gold);"> ${a}</label>`).join('')}
            </div>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Tell us more</label>
            <textarea id="adv-msg" rows="3" placeholder="What are you looking for? Any questions?" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:16px;resize:vertical;background:var(--bg);color:var(--text);"></textarea>

            <button id="adv-submit-btn" onclick="submitAdvertise()" class="btn btn-sm btn-ticket" style="display:block;width:100%;text-align:center;padding:12px;font-size:0.95rem;">Submit →</button>
        </div>
        <div id="adv-success" style="display:none;text-align:center;padding:24px 0;">
            <p style="font-size:1.5rem;margin-bottom:8px;">✅</p>
            <h3 style="margin-bottom:8px;">We'll Be in Touch!</h3>
            <p style="font-size:0.85rem;color:var(--text-muted);">Thanks for your interest. We'll reach out within 24 hours to discuss the best placement for your business.</p>
        </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

window.submitAdvertise = function() {
    const biz = document.getElementById('adv-biz').value.trim();
    const name = document.getElementById('adv-name').value.trim();
    const email = document.getElementById('adv-email').value.trim();
    const phone = document.getElementById('adv-phone').value.trim();
    const website = document.getElementById('adv-website').value.trim();
    const msg = document.getElementById('adv-msg').value.trim();
    const audEl = document.querySelector('input[name="adv-aud"]:checked');
    const audience = audEl ? audEl.value : '';

    if(!biz || !name || !email || !phone) {
        alert('Please fill in Business Name, Contact Name, Email, and Phone.');
        return;
    }

    const btn = document.getElementById('adv-submit-btn');
    btn.textContent = 'Submitting...';
    btn.disabled = true;

    // The Form has a single "Name" question — combine business + contact into it.
    const formData = new URLSearchParams();
    formData.append('entry.1812391001', biz + ' — ' + name);
    formData.append('entry.2112425545', email);
    formData.append('entry.336196442', phone);
    formData.append('entry.1305587255', website);
    formData.append('entry.1887090090', msg);
    if (audience) formData.append('entry.180355862', audience);

    fetch('https://docs.google.com/forms/d/e/1FAIpQLSfSGk9g9R4YHuEbiIdY537G3UztmlXjzDgYFDgr1X5wsN7rqA/formResponse', {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
    }).then(() => {
        document.getElementById('adv-form-fields').style.display = 'none';
        document.getElementById('adv-success').style.display = 'block';
    }).catch(() => {
        document.getElementById('adv-form-fields').style.display = 'none';
        document.getElementById('adv-success').style.display = 'block';
    });
};

// Submit Event Form
window.openSubmitEvent = function(preselectType) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
    overlay.onclick = function(ev){ if(ev.target===overlay) overlay.remove(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:520px;width:100%;max-height:90vh;overflow-y:auto;padding:28px;position:relative;';
    modal.innerHTML = `
        <button onclick="this.closest('div[style*=fixed]').remove()" class="modal-close-btn">✕</button>
        <h3 style="margin-bottom:4px;">📝 Submit an Event or Signup</h3>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:16px;">Share a community event or registration with Millersville. Submissions are reviewed before publishing.</p>
        <div id="submit-event-form">
            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">What are you submitting? *</label>
            <select id="se-type" onchange="document.getElementById('se-deadline-row').style.display = this.value==='Signup or Registration' ? 'block' : 'none';" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">
                <option value="Event">Event</option>
                <option value="Signup or Registration">Signup or Registration</option>
            </select>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Event / Program Name *</label>
            <input id="se-name" type="text" placeholder="e.g. Spring Community Festival" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Who is this event for? *</label>
            <select id="se-audience" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">
                <option value="">Choose…</option>
                <option value="Millersville Marauders">Millersville Marauders (MU students)</option>
                <option value="Townies">Townies (local community)</option>
                <option value="Both">Both</option>
            </select>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Is this an event for children? *</label>
            <select id="se-kids" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">
                <option value="">Choose…</option>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
            </select>

            <div id="se-deadline-row" style="display:none;">
                <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Registration Deadline *</label>
                <input id="se-deadline" type="date" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">
            </div>

            <div style="display:flex;gap:12px;margin-bottom:12px;">
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Start Date *</label>
                    <input id="se-date" type="date" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Start Time *</label>
                    <input id="se-time" type="time" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
            </div>

            <div style="display:flex;gap:12px;margin-bottom:12px;">
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">End Date</label>
                    <input id="se-end-date" type="date" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">End Time</label>
                    <input id="se-end-time" type="time" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
            </div>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Location *</label>
            <input id="se-location" type="text" placeholder="e.g. Millersville Borough Park" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Description *</label>
            <textarea id="se-desc" rows="3" placeholder="Tell us about the event..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;resize:vertical;background:var(--bg);color:var(--text);"></textarea>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Contact Email *</label>
            <input id="se-email" type="email" placeholder="your@email.com" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Website / Link</label>
            <input id="se-link" type="url" placeholder="https://..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:16px;background:var(--bg);color:var(--text);">

            <button id="se-submit-btn" onclick="submitEvent()" class="btn btn-sm btn-ticket" style="display:block;width:100%;text-align:center;padding:12px;font-size:0.95rem;">Submit Event</button>
        </div>
        <div id="se-success" style="display:none;text-align:center;padding:24px 0;">
            <p style="font-size:1.5rem;margin-bottom:8px;">✅</p>
            <h3 style="margin-bottom:8px;">Event Submitted!</h3>
            <p style="font-size:0.85rem;color:var(--text-muted);">Thanks for sharing! Your event will appear on the site after review.</p>
        </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    if (preselectType) {
        const typeSel = document.getElementById('se-type');
        if (typeSel) {
            typeSel.value = preselectType;
            const dr = document.getElementById('se-deadline-row');
            if (dr) dr.style.display = preselectType === 'Signup or Registration' ? 'block' : 'none';
        }
    }
};

window.submitEvent = function() {
    const name = document.getElementById('se-name').value.trim();
    const date = document.getElementById('se-date').value;
    const time = document.getElementById('se-time').value;
    const endDate = document.getElementById('se-end-date').value;
    const endTime = document.getElementById('se-end-time').value;
    const location = document.getElementById('se-location').value.trim();
    const desc = document.getElementById('se-desc').value.trim();
    const email = document.getElementById('se-email').value.trim();
    const link = document.getElementById('se-link').value.trim();
    const audience = document.getElementById('se-audience').value;
    const kids = document.getElementById('se-kids').value;
    const type = document.getElementById('se-type') ? document.getElementById('se-type').value : 'Event';
    const deadline = document.getElementById('se-deadline') ? document.getElementById('se-deadline').value.trim() : '';

    // Mirror the REQUIRED questions on the Google Form. The POST is mode:'no-cors',
    // so the browser can't see a rejection — if a Form-required field is missing,
    // Google silently discards the whole submission while the user still sees the
    // success screen. The client must enforce the same required set, or submissions
    // vanish without a trace.
    if(!name || !desc || !audience || !kids || !date || !time || !location || !email) {
        alert('Please fill in all required fields: Event Name, Description, Audience, whether it\u2019s for children, Start Date, Start Time, Location, and Contact Email.');
        return;
    }

    if (type === 'Signup or Registration' && !deadline) {
        alert('For a signup or registration, please enter the Registration Deadline.');
        return;
    }

    const btn = document.getElementById('se-submit-btn');
    btn.textContent = 'Submitting...';
    btn.disabled = true;

    // Start/End Date are Date questions and Start/End Time are Time questions on the
    // Form. Post the raw <input> value to the BARE entry ID — entry.885260694=2026-06-19
    // and entry.499967239=05:11 (the form's "Get pre-filled link" generates exactly this).
    // Do NOT use Google's composite entry.NNN_year/_month/_day or _hour/_minute form;
    // these questions don't accept it here and the value gets dropped.
    const formData = new URLSearchParams();
    formData.append('entry.490875700', name);
    formData.append('entry.1500961889', desc);
    formData.append('entry.912188599', audience);        // Audience: Millersville Marauders | Townies | Both
    formData.append('entry.1083341292', kids);           // Is this an event for children? Yes | No
    formData.append('entry.885260694', date);            // Start Date  (Date question, raw YYYY-MM-DD)
    formData.append('entry.499967239', time);            // Start Time  (Time question, raw HH:MM 24h)
    if(endDate) formData.append('entry.884959691', endDate);   // End Date  (Date question)
    if(endTime) formData.append('entry.1349393568', endTime);  // End Time  (Time question)
    formData.append('entry.461670075', location);
    formData.append('entry.6546809', email);
    formData.append('entry.946075783', link);
    formData.append('entry.992070299', type);            // Type: Event | Signup or Registration
    if (deadline) formData.append('entry.1625050499', deadline);  // Registration deadline (signups)

    fetch('https://docs.google.com/forms/d/e/1FAIpQLSeBPjHbqbhZ9YTYK4s5xZzi3nxfPcID_zDKq5HkUlhuh7LWfw/formResponse', {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
    }).then(() => {
        document.getElementById('submit-event-form').style.display = 'none';
        document.getElementById('se-success').style.display = 'block';
    }).catch(() => {
        document.getElementById('submit-event-form').style.display = 'none';
        document.getElementById('se-success').style.display = 'block';
    });
};
