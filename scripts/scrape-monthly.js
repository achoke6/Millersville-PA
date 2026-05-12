#!/usr/bin/env node
//
// Weekly low-frequency scraper. Cadence is once per week (Sunday 3am ET via
// .github/workflows/scrape-monthly.yml — the file's name is historical).
//
// Two source parsers, both server-rendered HTML so we can fetch and regex
// without needing a headless browser:
//   1. MU Alumni Office events index — millersville.edu/alumni/events/
//   2. MU Tech Camps storefront — millersvilletechcamps.com (WooCommerce)
//
// Output: writes auto-events.json to DreamHost via FTP. The hourly scraper
// fetches that file via HTTPS each run and feeds entries through the
// existing camps.json insertion pipeline (dedup, kid-friendly tagging,
// end-time resolution, etc.). Failure of either parser is non-fatal —
// we still write whatever the OTHER parser produced, so a tech-camps
// markup change doesn't take alumni events offline and vice versa.
//
// Why a separate scraper instead of folding into scrape.js:
//   - Different failure domain. Markup change in either source kills only
//     the weekly job, never the hourly aggregation that powers the site.
//   - Lower cadence. The sources don't change often; running these every
//     hour wastes bandwidth and creates more breakage opportunities.
//   - Simpler dependency story. Hourly scraper has 12+ sources tightly
//     coupled; this one is two HTTP fetches and a JSON write.
//
// Output schema matches camps.json:
//   { title, date, endTime?, location, tags[], price, registrationUrl,
//     description, kidFriendly }
//
// Hand-curated entries in camps.json take precedence — if both files
// produce an entry for the same event on the same day with similar
// titles, the cross-source dedupe in scrape.js will collapse them.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---- Config ----
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const FTP_HOST = process.env.DREAMHOST_SERVER;
const FTP_USER = process.env.DREAMHOST_USERNAME;
const FTP_PASS = process.env.DREAMHOST_PASSWORD;
const FTP_DIR = process.env.DREAMHOST_DIR;

if (!FTP_HOST || !FTP_USER || !FTP_PASS || !FTP_DIR) {
    console.error('❌ Missing FTP env vars. Set DREAMHOST_SERVER/USERNAME/PASSWORD/DIR.');
    process.exit(1);
}

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
};

// ---- HTTP helpers ----

async function fetchHtml(url, label) {
    try {
        const res = await fetch(url, { headers: REQUEST_HEADERS, redirect: 'follow' });
        if (!res.ok) {
            console.log(`  ⚠️ ${label}: HTTP ${res.status} from ${url}`);
            return null;
        }
        const html = await res.text();
        if (!html || html.length < 200) {
            console.log(`  ⚠️ ${label}: response too short (${html ? html.length : 0} bytes) — likely blocked`);
            return null;
        }
        return html;
    } catch (err) {
        console.log(`  ⚠️ ${label}: ${err.message}`);
        return null;
    }
}

// ---- Date parsing ----

const MONTH_NUM = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

// Parse "May 27, 2026" / "Saturday, July 25, 2026" / "Friday, August 21, 2026"
// Returns YYYY-MM-DD or null.
function parseLooseDate(s) {
    if (!s) return null;
    // Normalize whitespace, strip leading day-of-week if present
    let t = s.replace(/\s+/g, ' ').trim();
    t = t.replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+/i, '');
    const m = t.match(/([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})/);
    if (!m) return null;
    const monthNum = MONTH_NUM[m[1].toLowerCase()];
    if (!monthNum) return null;
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    if (year < 2024 || year > 2030) return null;  // sanity
    if (day < 1 || day > 31) return null;
    return `${year}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Build an ISO datetime in ET. We pick a default time when none is known
// (alumni events) — 6pm ET, encoded with the right offset for the date.
// Determining whether a date is in EDT or EST requires knowing US DST rules.
// Approximation: EDT runs roughly second-Sunday-March through first-Sunday-November.
// We don't import a TZ library; this approximation is fine for the YEAR field
// the site publishes (we're not generating to-the-second timestamps).
function isEDT(yyyymmdd) {
    const [y, m, d] = yyyymmdd.split('-').map(n => parseInt(n, 10));
    if (m < 3 || m > 11) return false;
    if (m > 3 && m < 11) return true;
    // March or November — approximate boundary by mid-month
    if (m === 3) return d >= 8;
    if (m === 11) return d <= 7;
    return false;
}
function dateAtHourET(yyyymmdd, hour) {
    const offset = isEDT(yyyymmdd) ? '-04:00' : '-05:00';
    return `${yyyymmdd}T${String(hour).padStart(2, '0')}:00:00${offset}`;
}

// ---- Parser 1: MU Alumni Events ----

async function fetchAlumniEvents() {
    console.log('📡 Fetching MU Alumni Events...');
    const html = await fetchHtml('https://www.millersville.edu/alumni/events/', 'Alumni Events');
    if (!html) return [];

    // The events are in the main content area, each as a heading / list item
    // with an anchor whose text starts with a date. Pattern (observed):
    //   <a href="/alumni/events/gold/index.php">May 27, 2026 — &#39;Ville at the Mill</a>
    // Or with ` --- ` (em dash variant) as the separator. We capture every
    // anchor whose visible text starts with what looks like a date.
    //
    // Defensive choices:
    //   - Both relative (/alumni/...) and absolute (https://...) hrefs allowed
    //   - Date separator is flexible: em dash, en dash, hyphen, ` --- `, `:`
    //   - Skip anchors whose text doesn't parse as a date
    const events = [];
    const seenSlugs = new Set();
    const anchorRegex = /<a\s[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
        const [, hrefRaw, textRaw] = match;
        const text = textRaw.replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
        // Must start with month name + day + year — skip nav links etc.
        const dateMatch = text.match(/^([A-Za-z]+,?\s*)?[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}/);
        if (!dateMatch) continue;
        const dateStr = dateMatch[0];
        const yyyymmdd = parseLooseDate(dateStr);
        if (!yyyymmdd) continue;

        // The text after the date is the title. Strip the date part and any
        // leading separator (em dash, ` - `, ` --- `, ` : `).
        let title = text.substring(dateStr.length).trim();
        title = title.replace(/^[\s\-—–:|]+/, '').trim();
        if (!title || title.length < 4) continue;

        // Resolve href to absolute
        let href = hrefRaw;
        if (href.startsWith('/')) href = 'https://www.millersville.edu' + href;
        // Skip anchor links and obvious non-event hrefs
        if (href.startsWith('#') || href.startsWith('mailto:')) continue;

        // De-dupe within this run by URL slug — alumni page sometimes lists
        // the same event twice (once in the list, once in a featured block)
        const slug = href.split('?')[0].replace(/\/$/, '');
        if (seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);

        // Build the event entry. Time defaults to 6pm ET — most alumni
        // events run evening, and the description on the source page has
        // exact times for users who click through.
        events.push({
            title,
            date: dateAtHourET(yyyymmdd, 18),
            location: 'Millersville University',  // generic — actual location varies
            tags: ['MU', 'Alumni Event'],
            price: '',  // many are free, some ticketed; source page has details
            registrationUrl: href,
            description: `Alumni event hosted by Millersville University. See registration page for full details, exact time, and any ticket requirements.`,
            kidFriendly: false  // most alumni events are 21+, opt-in only when known
        });
    }

    console.log(`  ✓ Alumni Events: ${events.length} events`);
    return events;
}

// ---- Parser 2: Tech Camps ----

async function fetchTechCamps() {
    console.log('📡 Fetching MU Tech Camps...');
    // The shop page lists products. WooCommerce default markup wraps each
    // product in <li class="product"> with a child anchor at the product
    // page and the title in an <h2> or similar. Schema.org JSON-LD is the
    // safest extraction route — most WooCommerce themes embed structured
    // product data, immune to template variations.
    const html = await fetchHtml('https://millersvilletechcamps.com/shop/', 'Tech Camps shop');
    if (!html) return [];

    const events = [];
    const seenSlugs = new Set();

    // First try: extract WooCommerce product anchors. Pattern:
    //   <a href="https://millersvilletechcamps.com/product/<slug>/" class="...">
    // The product title is usually inside a <h2 class="woocommerce-loop-product__title">
    // immediately after.
    const productRegex = /<a[^>]+href="(https:\/\/millersvilletechcamps\.com\/product\/[^"]+?)"[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    let match;
    while ((match = productRegex.exec(html)) !== null) {
        const [, url, titleHtml] = match;
        const title = titleHtml.replace(/<[^>]+>/g, '').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
        if (!title || title.length < 4) continue;
        const slug = url.replace(/\/$/, '');
        if (seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);

        // We don't have the date from the shop listing. The slugs encode
        // a date in M-DD or M-DD-M-DD format — e.g.
        //   build-your-own-robot-6-22-6-26
        // Extract the START date from the slug as our best guess.
        const slugDateMatch = url.match(/(\d{1,2})-(\d{1,2})(?:-\d{1,2}-\d{1,2})?/);
        let yyyymmdd = null;
        if (slugDateMatch) {
            const month = parseInt(slugDateMatch[1], 10);
            const day = parseInt(slugDateMatch[2], 10);
            // Assume current calendar year — tech camps run summer of current year
            const year = new Date().getFullYear();
            if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                yyyymmdd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            }
        }
        // No date parseable from slug — skip. We don't want to publish
        // events with bogus dates. The hand-curated camps.json fills the
        // gap for these cases.
        if (!yyyymmdd) continue;

        // Default time: 9am ET (typical morning camp start). Real time depends
        // on whether camp is morning or afternoon — that's in the description
        // on the product page, but fetching every product page is too much
        // overhead for this weekly job.
        events.push({
            title,
            date: dateAtHourET(yyyymmdd, 9),
            location: 'Millersville University (Tech & Engineering)',
            tags: ['MU', 'Summer Camp', 'Educational'],
            price: 'See registration page',
            registrationUrl: url,
            description: 'Summer tech camp at Millersville University. See registration page for exact session times, age requirements, and pricing.',
            kidFriendly: true
        });
    }

    console.log(`  ✓ Tech Camps: ${events.length} events`);
    return events;
}

// ---- Output ----

async function uploadAutoEvents(events, status) {
    const localEventsPath = '/tmp/auto-events.json';
    const localStatusPath = '/tmp/auto-events-status.json';
    fs.writeFileSync(localEventsPath, JSON.stringify(events, null, 2));
    fs.writeFileSync(localStatusPath, JSON.stringify(status, null, 2));
    const remoteEventsPath = `${FTP_DIR}/auto-events.json`;
    const remoteStatusPath = `${FTP_DIR}/auto-events-status.json`;

    // Single FTP session uploads both files. If the second put fails the
    // first one still landed (DreamHost has no transactional semantics
    // across FTP commands) — that's fine; the status file is informational
    // and the next run will overwrite both.
    const cmd = `lftp -c "
        set sftp:auto-confirm yes;
        set net:max-retries 3;
        set net:timeout 30;
        open -u '${FTP_USER}','${FTP_PASS}' sftp://${FTP_HOST};
        put '${localEventsPath}' -o '${remoteEventsPath}';
        put '${localStatusPath}' -o '${remoteStatusPath}';
        quit;
    "`;
    try {
        execSync(cmd, { stdio: 'pipe' });
        console.log(`📤 Uploaded auto-events.json (${events.length} events, ${fs.statSync(localEventsPath).size} bytes)`);
        console.log(`📤 Uploaded auto-events-status.json`);
    } catch (err) {
        console.error(`❌ FTP upload failed: ${err.message}`);
        process.exit(1);
    }
}

// Upload only the status file. Used when the empty-result safety triggers —
// we don't want to overwrite auto-events.json with an empty array, but we
// DO want the dashboard to show that we tried and failed.
async function uploadStatusOnly(status) {
    const localStatusPath = '/tmp/auto-events-status.json';
    fs.writeFileSync(localStatusPath, JSON.stringify(status, null, 2));
    const remoteStatusPath = `${FTP_DIR}/auto-events-status.json`;
    const cmd = `lftp -c "
        set sftp:auto-confirm yes;
        set net:max-retries 3;
        set net:timeout 30;
        open -u '${FTP_USER}','${FTP_PASS}' sftp://${FTP_HOST};
        put '${localStatusPath}' -o '${remoteStatusPath}';
        quit;
    "`;
    try {
        execSync(cmd, { stdio: 'pipe' });
        console.log(`📤 Uploaded auto-events-status.json (events file skipped — empty result)`);
    } catch (err) {
        console.error(`⚠️  Status FTP upload failed: ${err.message}`);
        // Don't exit non-zero here — the main empty-result handler already does
    }
}

(async () => {
    console.log('🚀 Starting weekly auto-events scraper...\n');
    const runStartedAt = new Date().toISOString();
    const allEvents = [];
    // Per-parser status — surfaced in auto-events-status.json so the status
    // dashboard can show "alumni: 0 events (last error: HTTP 404)" instead
    // of just an opaque "no recent run." Each entry has { name, count,
    // error? } where error is the message if the parser threw.
    const parsers = [];

    try {
        const alumni = await fetchAlumniEvents();
        allEvents.push(...alumni);
        parsers.push({ name: 'alumni', count: alumni.length });
    } catch (err) {
        console.error(`⚠️  Alumni parser threw: ${err.message}`);
        parsers.push({ name: 'alumni', count: 0, error: err.message });
    }

    try {
        const techCamps = await fetchTechCamps();
        allEvents.push(...techCamps);
        parsers.push({ name: 'techCamps', count: techCamps.length });
    } catch (err) {
        console.error(`⚠️  Tech Camps parser threw: ${err.message}`);
        parsers.push({ name: 'techCamps', count: 0, error: err.message });
    }

    console.log(`\n📊 Total: ${allEvents.length} events from auto-scraping`);

    // Empty-result safety: if BOTH parsers returned 0 events, something is
    // wrong upstream (or both sources are simultaneously empty, which is
    // implausible). Refuse to overwrite the existing auto-events.json with
    // an empty array — let the previous week's data stand until the parsers
    // recover. The hourly scraper will keep working with stale-but-real data.
    //
    // We DO still write the status file in this case — the dashboard needs
    // to surface the failure to operators.
    const status = {
        lastRunAt: runStartedAt,
        eventCount: allEvents.length,
        parsers,
        skippedUpload: allEvents.length === 0
    };

    if (allEvents.length === 0) {
        console.error('❌ Both parsers returned 0 events — refusing to overwrite auto-events.json. Investigate parser breakage.');
        await uploadStatusOnly(status);
        process.exit(1);
    }

    await uploadAutoEvents(allEvents, status);
    console.log('\n✓ Weekly scrape complete.');
})().catch(err => {
    console.error(`💥 Fatal: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
