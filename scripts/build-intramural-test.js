#!/usr/bin/env node
/**
 * build-intramural-test.js — LOCAL TEST HELPER (not part of the cron).
 *
 * Rebuilds ONLY the intramural-signup entries in events.json from
 * imleagues.json, so you can preview the signup cards without running a full
 * scrape. It:
 *   1. reads ./events.json (the array the site fetches) and ./imleagues.json
 *   2. drops any existing IMLeagues entries (idempotent — safe to re-run)
 *   3. rebuilds them using the SAME logic as scrape.js's intramural loader
 *   4. writes events.json back (minified — same wire format as scrape.js)
 *
 * Run from the repo root:
 *     node scripts\build-intramural-test.js
 *
 * NOTE: this produces a LOCAL events.json for previewing only. Don't commit it.
 * Once imleagues.json is committed, the hourly cron rebuilds the real
 * events.json (with intramural included) on its own.
 */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const eventsPath = path.join(root, 'events.json');
const imlPath = path.join(root, 'imleagues.json');

// --- load imleagues.json (required) ---
let imlData;
try {
    imlData = JSON.parse(fs.readFileSync(imlPath, 'utf8'));
} catch (e) {
    console.error(`\u274C Could not read imleagues.json at ${imlPath}`);
    console.error('   Run this from the repo root (where imleagues.json lives).');
    process.exit(1);
}
if (!Array.isArray(imlData)) {
    console.error('\u274C imleagues.json must be a JSON array.');
    process.exit(1);
}

// --- load events.json (optional — start empty if missing) ---
let events = [];
try {
    const parsed = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
    if (Array.isArray(parsed)) events = parsed;
    else console.warn('\u26A0\uFE0F  events.json was not an array — starting fresh.');
} catch (e) {
    console.warn('\u26A0\uFE0F  No existing events.json — creating one with just the intramural test entries.');
}

// --- drop any prior IMLeagues entries so re-runs don't duplicate ---
const before = events.length;
events = events.filter(e => {
    const s = ((e.sourceLink || '') + ' ' + (e.registerLink || '')).toLowerCase();
    return !s.includes('imleagues');
});
const removed = before - events.length;

// --- rebuild intramural events (mirrors scrape.js 6c-2 loader exactly) ---
const now = new Date();
let added = 0, closed = 0, skipped = 0;
for (const reg of imlData) {
    if (reg.status !== 'active') { skipped++; continue; }
    if (!reg.deadline || !reg.title) { skipped++; continue; }
    const dl = new Date(reg.deadline);
    if (isNaN(dl.getTime())) { skipped++; continue; }
    if (dl < now) { closed++; continue; }   // deadline passed — don't create

    const dlLabel = dl.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', timeZone: 'America/New_York'
    });
    events.push({
        title: reg.title,
        date: dl.toISOString(),
        endTime: '',
        location: 'Millersville University',
        tags: ['Other'],
        price: 'Free',
        registerLink: reg.registerLink || '',
        sourceLink: reg.registerLink || 'https://imleagues.com/millersville',
        gameResult: '', gameScore: '', streamLink: '', isLive: false,
        registrationRequired: true,
        registrationDeadline: reg.deadline,
        ...(reg.opens ? { registrationOpens: reg.opens } : {}),
        kidFriendly: false,
        description: [
            reg.season ? `Season runs ${reg.season}.` : '',
            reg.registrationWindow ? `Registration ${reg.registrationWindow}.` : '',
            `Registration closes ${dlLabel}. Sign up at IMLeagues.`
        ].filter(Boolean).join(' ')
    });
    added++;
}

fs.writeFileSync(eventsPath, JSON.stringify(events));
console.log('\u2705 Intramural test rebuild complete.');
console.log(`   removed ${removed} old IMLeagues entr${removed === 1 ? 'y' : 'ies'}, added ${added} open, ${closed} past-deadline (hidden), ${skipped} skipped.`);
console.log(`   events.json now has ${events.length} events. Reload the site to preview.`);
console.log('   \u26A0\uFE0F  Local preview only — don\u2019t commit this events.json; the cron rebuilds the real one.');
