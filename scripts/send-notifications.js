/**
 * scripts/send-notifications.js — Daily morning push notifications.
 *
 * Runs from GitHub Actions at 7am ET (year-round, DST-disambiguated by the
 * workflow). Sends each subscribed device a notification listing today's
 * events that match their feedPrefs.
 *
 * Pipeline:
 *   1. Fetch events.json from millersville.app
 *   2. FTP-pull subscriptions.json from DreamHost
 *   3. For each subscription, filter today's events by their feedPrefs
 *      using a port of eventMatchesFeed (see WARNING below)
 *   4. Send a Web Push payload with the count + sample titles
 *   5. Track 410 Gone responses to identify dead subscriptions
 *   6. Write the cleaned subscriptions.json back to DreamHost
 *
 * If steps 1 or 2 fail outright, exits non-zero so GitHub Actions flags the
 * run as failed and the existing healthchecks.io /fail ping fires.
 *
 * Exit code 0 means the script ran end-to-end, even if no pushes were sent
 * (e.g. zero subscriptions, or zero users had matching events). Distinct
 * from "ran but everything failed" which exits 1.
 *
 * ============================================================================
 * WARNING — eventMatchesFeed is duplicated from app.js
 * ============================================================================
 * The function below mirrors the logic of `eventMatchesFeed` in app.js. They
 * MUST stay in lockstep. If you add a new feed type, sport mapping, or
 * cs-* / mu-* / pm-* prefix to one, update the other in the same commit.
 * Acceptable-but-real drift risk; the alternative was extracting both files'
 * shared logic into a module, which would have required a non-trivial app.js
 * refactor (it's currently a single global-state file). Future enhancement:
 * extract to lib/eventMatch.js when next opportunity arises.
 * Last sync: 2026-05-06.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const webpush = require('web-push');

const EVENTS_URL = 'https://millersville.app/events.json';
const SUBSCRIPTIONS_REMOTE_PATH = 'subscriptions.json';
const SUBSCRIPTIONS_LOCAL_PATH = '/tmp/subscriptions.json';

// VAPID keys — public is hardcoded in app.js too (it's literally meant to
// be public). Private comes from GH secrets and only ever lives on the
// runner, never in the repo.
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = 'mailto:admin@millersville.app';

// FTP creds — same secrets the deploy step uses.
const FTP_USER = process.env.DREAMHOST_USERNAME;
const FTP_PASS = process.env.DREAMHOST_PASSWORD;
const FTP_HOST = process.env.DREAMHOST_SERVER;
const FTP_DIR  = process.env.DREAMHOST_DIR;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error('❌ VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars required');
    process.exit(1);
}
if (!FTP_USER || !FTP_PASS || !FTP_HOST || !FTP_DIR) {
    console.error('❌ DreamHost FTP credentials env vars required');
    process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ============================================================================
// eventMatchesFeed — KEEP IN LOCKSTEP WITH app.js (see warning above)
// ============================================================================
function eventMatchesFeed(e, feedPrefs) {
    if (!feedPrefs || feedPrefs.length === 0) return true;
    const tags = e.tags || [];

    if (feedPrefs.includes('family-events') && e.kidFriendly) return true;

    const sportMap = {baseball:'baseball',softball:'softball',lacrosse:'lacrosse',volleyball:'volleyball',
        football:'football',basketball:'basketball',soccer:'soccer','field hockey':'fieldhockey',
        tennis:'tennis',track:'track',golf:'golf',swimming:'swimming','cross country':'crosscountry'};

    if (tags.includes('PM') && (tags.includes('Athletics') || tags.includes('Athletic Competitions'))) {
        for (const [sport, feedSuffix] of Object.entries(sportMap)) {
            if (tags.some(t => t.toLowerCase() === sport) && feedPrefs.includes('pm-' + feedSuffix)) return true;
        }
        return false;
    }
    if (tags.includes('PM')) {
        if (tags.includes('Music/Arts') && feedPrefs.includes('pm-music')) return true;
        if (tags.includes('Board/PTO') && feedPrefs.includes('pm-board')) return true;
        if ((tags.includes('School Events') || tags.includes('Health/Wellness') || tags.includes('Meetings')) && feedPrefs.includes('pm-board')) return true;
        return false;
    }

    if (tags.includes('MU') && (tags.includes('Athletics') || tags.includes('Athletic Competitions'))) {
        for (const [sport, feedSuffix] of Object.entries(sportMap)) {
            if (tags.some(t => t.toLowerCase() === sport) && feedPrefs.includes('mu-' + feedSuffix)) return true;
        }
        if (feedPrefs.includes('mu-arts') || feedPrefs.includes('mu-public')) return false;
        return false;
    }

    if (tags.includes('Clubs/Orgs')) {
        if (feedPrefs.includes('clubs-all')) return true;
        if (feedPrefs.includes('clubs-social') && tags.includes('Social')) return true;
        if (feedPrefs.includes('clubs-arts') && tags.includes('Arts')) return true;
        if (feedPrefs.includes('clubs-sports') && tags.includes('Club Sports')) return true;
        if (feedPrefs.includes('clubs-greek') && tags.includes('Greek Life')) return true;
        if (feedPrefs.includes('clubs-service') && (tags.includes('Service') || tags.includes('Cultural'))) return true;
        if (tags.includes('Club Sports')) {
            if (feedPrefs.includes('cs-baseball') && tags.includes('Baseball')) return true;
            if (feedPrefs.includes('cs-bowling') && /bowling/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-equestrian') && /equestrian/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-fencing') && tags.includes('Fencing')) return true;
            if (feedPrefs.includes('cs-icehockey') && /ice hockey/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-mma') && /\bmma\b/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-basketball-mens') && tags.includes('Basketball') && tags.includes("Men's")) return true;
            if (feedPrefs.includes('cs-basketball-womens') && tags.includes('Basketball') && tags.includes("Women's")) return true;
            if (feedPrefs.includes('cs-lacrosse') && tags.includes('Lacrosse')) return true;
            if (feedPrefs.includes('cs-rugby-mens') && tags.includes('Rugby') && tags.includes("Men's")) return true;
            if (feedPrefs.includes('cs-rugby-womens') && tags.includes('Rugby') && tags.includes("Women's")) return true;
            if (feedPrefs.includes('cs-soccer-mens') && tags.includes('Soccer') && tags.includes("Men's")) return true;
            if (feedPrefs.includes('cs-soccer-womens') && tags.includes('Soccer') && tags.includes("Women's")) return true;
            if (feedPrefs.includes('cs-volleyball-mens') && tags.includes('Volleyball') && tags.includes("Men's")) return true;
            if (feedPrefs.includes('cs-volleyball-womens') && tags.includes('Volleyball') && tags.includes("Women's")) return true;
            if (feedPrefs.includes('cs-dance') && /dance team/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-running') && /\brunning\b/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-softball') && tags.includes('Softball')) return true;
            if (feedPrefs.includes('cs-tennis') && tags.includes('Tennis')) return true;
            if (feedPrefs.includes('cs-frisbee') && /ultimate frisbee/i.test(e.title || '')) return true;
        }
        for (const pref of feedPrefs) {
            if (pref.startsWith('club:') && tags.includes(pref.substring(5))) return true;
        }
        return false;
    }

    if (tags.includes('MU')) {
        if (tags.includes('Arts Concert / Performance') && feedPrefs.includes('mu-arts')) return true;
        if (tags.includes('Public Event') && feedPrefs.includes('mu-public')) return true;
        return false;
    }

    if (tags.includes('Borough') && feedPrefs.includes('borough-all')) return true;

    if (tags.includes('VFW') && feedPrefs.includes('other-vfw')) return true;
    if (tags.includes('Live Music') && feedPrefs.includes('other-phantom')) return true;
    if (tags.includes('Community') && feedPrefs.includes('other-community')) return true;

    return false;
}
// ============================================================================
// END LOCKSTEP REGION
// ============================================================================

/**
 * Fetch events.json from production. Bails the whole script on failure —
 * without events we can't compute anything to send.
 */
async function fetchEvents() {
    console.log(`📡 Fetching ${EVENTS_URL}`);
    const res = await fetch(EVENTS_URL);
    if (!res.ok) throw new Error(`events.json fetch failed: HTTP ${res.status}`);
    const events = await res.json();
    if (!Array.isArray(events)) throw new Error('events.json is not an array');
    console.log(`   ${events.length} events loaded`);
    return events;
}

/**
 * Pull subscriptions.json from DreamHost via lftp. Uses the same SFTP
 * credentials as the deploy step. Returns [] on missing-file (first run
 * or no one's subscribed yet).
 */
function pullSubscriptions() {
    console.log(`📥 Pulling subscriptions from DreamHost`);
    try {
        // -e runs a series of commands and quits. `get -e` errors on
        // missing-file but we want to treat that as "empty list" not a
        // hard failure. Check existence first via ls.
        const remotePath = `${FTP_DIR}/${SUBSCRIPTIONS_REMOTE_PATH}`;
        const cmd = `lftp -c "
            set sftp:auto-confirm yes;
            set net:max-retries 3;
            set net:timeout 30;
            open -u '${FTP_USER}','${FTP_PASS}' sftp://${FTP_HOST};
            get '${remotePath}' -o '${SUBSCRIPTIONS_LOCAL_PATH}';
            quit;
        "`;
        execSync(cmd, { stdio: 'pipe' });
    } catch (err) {
        // lftp returns non-zero if the remote file doesn't exist. Treat
        // that as "no subscriptions yet" — log and continue.
        const stderr = (err.stderr || '').toString();
        if (/No such file|access failed|550/.test(stderr)) {
            console.log('   No subscriptions.json on remote — first run or no subscribers yet');
            return [];
        }
        throw err;
    }
    if (!fs.existsSync(SUBSCRIPTIONS_LOCAL_PATH)) return [];
    const raw = fs.readFileSync(SUBSCRIPTIONS_LOCAL_PATH, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) {
        console.log('   subscriptions.json is malformed — treating as empty');
        return [];
    }
    console.log(`   ${list.length} subscriptions loaded`);
    return list;
}

/**
 * Push the cleaned subscriptions list back to DreamHost. Only called when
 * the in-memory list differs from what we pulled (i.e. dead subs were
 * pruned). Avoids wasted FTP round-trips on no-op runs.
 */
function pushSubscriptions(list) {
    console.log(`📤 Writing back ${list.length} subscriptions to DreamHost`);
    fs.writeFileSync(SUBSCRIPTIONS_LOCAL_PATH, JSON.stringify(list, null, 2));
    const remotePath = `${FTP_DIR}/${SUBSCRIPTIONS_REMOTE_PATH}`;
    const cmd = `lftp -c "
        set sftp:auto-confirm yes;
        set net:max-retries 3;
        set net:timeout 30;
        open -u '${FTP_USER}','${FTP_PASS}' sftp://${FTP_HOST};
        put '${SUBSCRIPTIONS_LOCAL_PATH}' -o '${remotePath}';
        quit;
    "`;
    execSync(cmd, { stdio: 'pipe' });
}

/**
 * Filter `events` to today's events (in America/New_York calendar) that
 * match the user's feedPrefs. Returns an array sorted by start time.
 */
function eventsForUserToday(events, feedPrefs) {
    // "Today" means the calendar day in America/New_York where the recipient
    // lives. The cron runs at 11/12 UTC = 7am ET, so we want events whose
    // local-ET date matches the cron's local-ET date. Use Intl.DateTimeFormat
    // with the timezone set explicitly — the runner's TZ is UTC so naïve
    // Date methods would give wrong day boundaries.
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const todayET = fmt.format(new Date());  // e.g. "2026-05-06"

    return events
        .filter(e => {
            const evMs = new Date(e.date).getTime();
            if (!Number.isFinite(evMs)) return false;
            const evDateET = fmt.format(new Date(evMs));
            return evDateET === todayET;
        })
        .filter(e => eventMatchesFeed(e, feedPrefs))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/**
 * Build the push payload (title + body + tap-target URL). Title is short
 * and scannable from a notification tray; body lists 1-2 sample titles.
 *
 * The tap-target URL embeds the user's source preferences so opening the
 * notification lands them on /events filtered to what they care about.
 * Per shareable-URL contract: src=Borough,MU style, omitted when "all".
 */
function buildPayload(matches, feedPrefs) {
    const count = matches.length;
    const sample = matches.slice(0, 2).map(e => {
        // Strip "Millersville University " prefix and clean up titles for
        // the small notification body. Browsers truncate at ~120 chars.
        const t = (e.title || '')
            .replace(/^Millersville University\s*/i, '')
            .replace(/^\[.\]\s*/, '');  // strip [W]/[L] result markers
        return t.length > 50 ? t.slice(0, 47) + '…' : t;
    });

    const title = `📅 Today on Millersville.APP`;
    const body = count === 1
        ? `1 event from your favorites today: ${sample[0]}`
        : count <= 2
            ? `${count} events from your favorites: ${sample.join(', ')}`
            : `${count} events from your favorites today, including ${sample.join(', ')}`;

    // Build the click-target URL. Try to extract source-level prefs from
    // feedPrefs to feed the URL state filter (src=MU,PM,Borough). If the
    // user has only sub-source prefs (e.g. baseball without mu/pm), fall
    // back to /events with no filter — better to show too many than zero.
    const sources = new Set();
    for (const p of (feedPrefs || [])) {
        if (typeof p !== 'string') continue;
        if (p.startsWith('mu-') || p.startsWith('cs-') || p.startsWith('clubs-')) sources.add('MU');
        if (p.startsWith('pm-')) sources.add('PM');
        if (p.startsWith('borough-')) sources.add('Borough');
        if (p.startsWith('other-') || p === 'family-events') sources.add('Other');
    }
    let url = 'https://millersville.app/events';
    if (sources.size > 0 && sources.size < 4) {
        const ordered = ['MU', 'PM', 'Borough', 'Other'].filter(s => sources.has(s));
        url += `?src=${ordered.join(',')}`;
    }

    return { title, body, url };
}

/**
 * Send a single push. Returns { ok, dead } where `dead` indicates the
 * subscription should be removed from the list (410 Gone or 404).
 */
async function sendPush(subscription, payload) {
    try {
        await webpush.sendNotification(
            { endpoint: subscription.endpoint, keys: subscription.keys },
            JSON.stringify(payload),
            { TTL: 6 * 3600 }  // 6h: morning notif relevance window
        );
        return { ok: true, dead: false };
    } catch (err) {
        // statusCode 410 = subscription expired/unsubscribed at the push
        // service level. 404 = invalid endpoint. Both mean prune.
        // 4xx other than these = malformed payload, not the sub's fault.
        // 5xx = transient server issue; leave the sub alone, retry tomorrow.
        const code = err.statusCode || 0;
        const dead = code === 410 || code === 404;
        console.log(`   ⚠️  push failed (${code}): ${err.body || err.message}`);
        return { ok: false, dead };
    }
}

(async () => {
    let events, subs;
    try {
        events = await fetchEvents();
    } catch (err) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
    }
    try {
        subs = pullSubscriptions();
    } catch (err) {
        console.error(`❌ Failed to pull subscriptions: ${err.message}`);
        process.exit(1);
    }

    if (subs.length === 0) {
        console.log('✓ No subscriptions — nothing to send. Exiting.');
        process.exit(0);
    }

    let sent = 0;
    let skipped = 0;
    let pruned = 0;
    const survivors = [];

    for (const sub of subs) {
        const matches = eventsForUserToday(events, sub.feedPrefs || []);
        if (matches.length === 0) {
            // Don't spam users with "no events today" notifications.
            // Skip silently. Subscription stays alive.
            skipped++;
            survivors.push(sub);
            continue;
        }
        const payload = buildPayload(matches, sub.feedPrefs);
        const { ok, dead } = await sendPush(sub, payload);
        if (ok) {
            sent++;
            survivors.push(sub);
        } else if (dead) {
            pruned++;
            // dropped from survivors list
        } else {
            // transient — keep the sub, retry tomorrow
            survivors.push(sub);
        }
    }

    console.log(`📊 Sent: ${sent}  Skipped (no matches): ${skipped}  Pruned (dead): ${pruned}`);

    // Only push back if we actually pruned something — saves an FTP round
    // trip on the common case where every sub is still alive.
    if (pruned > 0) {
        try {
            pushSubscriptions(survivors);
        } catch (err) {
            console.error(`⚠️  Failed to write back cleaned subscriptions: ${err.message}`);
            // Don't exit non-zero — pushes already went out, the cleanup
            // can retry tomorrow. Logging is enough.
        }
    }

    // Write a small status file so the /status.html dashboard can show
    // notification health (subscriber count, last run time, last run results).
    // The status page polls every minute; this file changes only when the
    // cron runs (once daily after DST guard), so the dashboard naturally
    // reflects "data is N hours old" via the lastRunAt timestamp.
    //
    // Failure here is non-fatal — pushes already went out, the dashboard
    // just won't see updated stats this run. Cron retries tomorrow.
    try {
        const statusPayload = {
            lastRunAt: new Date().toISOString(),
            subscribers: survivors.length,
            lastRunSent: sent,
            lastRunSkipped: skipped,
            lastRunPruned: pruned
        };
        const statusLocalPath = '/tmp/notifications-status.json';
        fs.writeFileSync(statusLocalPath, JSON.stringify(statusPayload, null, 2));
        const remotePath = `${FTP_DIR}/notifications-status.json`;
        const cmd = `lftp -c "
            set sftp:auto-confirm yes;
            set net:max-retries 3;
            set net:timeout 30;
            open -u '${FTP_USER}','${FTP_PASS}' sftp://${FTP_HOST};
            put '${statusLocalPath}' -o '${remotePath}';
            quit;
        "`;
        execSync(cmd, { stdio: 'pipe' });
        console.log(`📤 Wrote notifications-status.json`);
    } catch (err) {
        console.error(`⚠️  Failed to write notification status: ${err.message}`);
    }
})();
