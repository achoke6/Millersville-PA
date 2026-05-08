#!/usr/bin/env node
// One-shot audit: find near-duplicate events in events.json that the cross-source
// dedupe missed. Run with `node scripts/audit-duplicates.js` after a deploy.
//
// Definition of "near-duplicate":
//   - Different sourceBucket (so we're catching cross-source dupes, not intra-source)
//   - Same calendar day (ET)
//   - One of:
//       a) Levenshtein distance between normalized titles ≤ 5
//       b) One normalized title is a strict substring of the other (≥ 8 chars)
//       c) Both titles share the same first 4 significant words
//
// Output: a list of pair candidates for human review. NOT auto-fixing anything.

const fs = require('fs');
const path = require('path');

// ----- Helpers -----

function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) m[i][0] = i;
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i-1] === b[j-1] ? 0 : 1;
            m[i][j] = Math.min(m[i-1][j] + 1, m[i][j-1] + 1, m[i-1][j-1] + cost);
        }
    }
    return m[a.length][b.length];
}

// Normalize for comparison: lowercase, strip punctuation, collapse whitespace
function norm(s) {
    return (s || '').toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// First N significant words (skipping common short words)
const STOP_WORDS = new Set(['the','a','an','of','and','for','at','in','on','to','with','by']);
function sigWords(s, n) {
    return norm(s).split(' ').filter(w => w.length >= 3 && !STOP_WORDS.has(w)).slice(0, n);
}

// ET day extraction (cheap version — assumes scraper already wrote ISO with offset)
function dayET(iso) {
    if (!iso) return '';
    // Use Intl.DateTimeFormat for robust ET conversion
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso.slice(0, 10);
        const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
        return fmt.format(d);
    } catch { return iso.slice(0, 10); }
}

// Source bucket — mirrors scrape.js logic
function sourceBucket(e) {
    const link = (e.sourceLink || '').toLowerCase();
    const tags = e.tags || [];
    if (link.includes('artsmu.com')) return 'artsmu';
    if (link.includes('getinvolved.millersville.edu')) return 'clubs';
    if (link.includes('millersville.edu/calendar')) return 'mu-cal';
    if (link.includes('millersville.edu/alumni')) return 'mu-alumni';
    if (link.includes('millersvilletechcamps.com')) return 'tech-camp';
    if (link.includes('totalcamps.com') || link.includes('millersvillewomenssoccercamps')) return 'sport-camp';
    if (link.includes('phantompower') || link.includes('eventbrite')) return 'phantompower';
    if (tags.includes('PM')) return 'pm';
    if (tags.includes('Borough')) return 'borough';
    if (tags.includes('VFW')) return 'vfw';
    if (tags.includes('Community')) return 'community';
    if (tags.includes('Clubs/Orgs')) return 'clubs';
    if (tags.includes('Athletics')) return 'athletics';
    if (tags.includes('MU')) return 'mu-cal';
    return 'other';
}

// ----- Main -----

const eventsPath = process.argv[2] || path.join(__dirname, '../events.json');
if (!fs.existsSync(eventsPath)) {
    console.error(`✗ events.json not found at ${eventsPath}`);
    console.error(`  Usage: node scripts/audit-duplicates.js [path/to/events.json]`);
    process.exit(1);
}
const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
console.log(`📥 Loaded ${events.length} events from ${eventsPath}\n`);

// Bucket events by ET day for O(N×M_per_day) instead of O(N²)
const byDay = {};
for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const day = dayET(e.date);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push({ idx: i, e });
}

const candidates = [];

for (const [day, group] of Object.entries(byDay)) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
            const a = group[i].e;
            const b = group[j].e;
            const aBucket = sourceBucket(a);
            const bBucket = sourceBucket(b);
            // Only flag CROSS-source pairs; same-source same-day is normal
            if (aBucket === bBucket) continue;

            const aN = norm(a.title);
            const bN = norm(b.title);
            if (!aN || !bN) continue;
            if (aN === bN) {
                candidates.push({ day, kind: 'EXACT', a, b, aBucket, bBucket });
                continue;
            }

            const dist = levenshtein(aN, bN);
            if (dist <= 5 && Math.min(aN.length, bN.length) >= 8) {
                // Guard against acronym + generic-suffix false positives like
                //   "DMAX Meeting" vs "PTO Meeting"  (LEV-4, but unrelated)
                //   "FSL Meeting" vs "PTO Meeting"   (LEV-3, but unrelated)
                // The shared word ("meeting") is too generic to indicate
                // duplication. Require at least one shared word of length ≥ 5
                // in addition to the small edit distance — that's the
                // distinctive-word constraint, same idea as in the SUBSET
                // rule below.
                const aw = aN.split(' ').filter(w => w.length >= 5);
                const bw = bN.split(' ').filter(w => w.length >= 5);
                const sharedDistinct = aw.filter(w => bw.includes(w));
                if (sharedDistinct.length >= 1) {
                    candidates.push({ day, kind: `LEV-${dist}`, a, b, aBucket, bBucket });
                    continue;
                }
            }

            // Strict substring (one fully contained in other), at least 8 chars
            if (aN.length >= 8 && bN.length >= 8) {
                if (bN.includes(aN) || aN.includes(bN)) {
                    candidates.push({ day, kind: 'SUBSTR', a, b, aBucket, bBucket });
                    continue;
                }
            }

            // "Subset of words" check. Catches cases like:
            //   "Homecoming 2026" vs "Homecoming Weekend 2026"  — shorter ⊂ longer
            //   "MU Football Camp" vs "Football Camp at Millersville" — partial overlap
            // Rule: if every significant word in the SHORTER title appears in
            // the LONGER one, AND at least one shared word is distinctive
            // (length ≥ 5, not stop-list), flag it.
            //
            // The distinctive-word requirement prevents false positives on
            // generic short titles like "Open House" vs "Open House Tour"
            // where the only shared word is "open" or "house" — common and
            // weak signals on their own.
            const aw = sigWords(a.title, 8);
            const bw = sigWords(b.title, 8);
            if (aw.length >= 1 && bw.length >= 1) {
                const shorter = aw.length <= bw.length ? aw : bw;
                const longer  = aw.length <= bw.length ? bw : aw;
                const allInLonger = shorter.every(w => longer.includes(w));
                const sharedDistinctive = shorter.filter(w => w.length >= 5 && longer.includes(w));
                if (allInLonger && sharedDistinctive.length >= 1) {
                    candidates.push({ day, kind: `SUBSET-${sharedDistinctive.length}`, a, b, aBucket, bBucket });
                    continue;
                }
            }
        }
    }
}

if (candidates.length === 0) {
    console.log(`✓ No cross-source duplicate candidates found.\n`);
    process.exit(0);
}

console.log(`⚠️  Found ${candidates.length} cross-source duplicate candidate(s):\n`);
candidates.sort((a, b) => a.day.localeCompare(b.day));
let i = 1;
for (const c of candidates) {
    console.log(`${i}. [${c.day}] kind=${c.kind}`);
    console.log(`   [${c.aBucket}] "${c.a.title}"`);
    console.log(`     date=${c.a.date} link=${c.a.sourceLink || '(none)'}`);
    console.log(`   [${c.bBucket}] "${c.b.title}"`);
    console.log(`     date=${c.b.date} link=${c.b.sourceLink || '(none)'}`);
    console.log('');
    i++;
}

// Summary stats
const byKind = {};
for (const c of candidates) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
console.log(`Summary by kind:`);
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v}  ${k}`);
}
