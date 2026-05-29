#!/usr/bin/env node
/**
 * sync-candidates.js — Build-time sync: Event Candidates Google Sheet -> override JSON.
 *
 * Replaces the old PR-based review for curated events. Cowork appends candidate
 * rows to ONE Google Sheet ("Event Candidates") via the Sheets connector. Adam
 * reviews by putting an X in the Approved column (same habit as the directory's
 * Active column). This script reads the published sheet at build time, takes
 * ONLY approved rows, and routes each by its Source column into the override
 * file the scraper already consumes:
 *
 *   Source "Borough"      -> borough-overrides.json   (create-mode entries)
 *   Source "PM Community"  -> penn-manor-overrides.json (status: approved)
 *   Source "Youth Sports" -> youth-sports-registration.json (status: active)
 *
 * The scraper (scrape.js) is UNCHANGED — we only change how these three files
 * get populated (sheet sync instead of hand-editing / PRs).
 *
 * SHEET COLUMNS (header row, case-insensitive, position-independent):
 *   Approved, Family, Source, Title, Date, Time, Location, Deadline, Link,
 *   Description, Notes
 *
 *   Approved:    non-blank (X) = publish; blank = skip (still a candidate).
 *   Family:      non-blank (X) = kidFriendly:true on the generated event.
 *   Source:      Borough | PM Community | Youth Sports (case-insensitive).
 *   Date:        event date. Accepts ISO (2026-08-04T18:00:00-04:00) or a
 *                plain date (2026-08-04) — if no time, Time column is used.
 *   Time:        optional "6:00 PM" style; merged with Date when Date has no
 *                time component. If both absent, defaults to 18:00 ET.
 *   Deadline:    (Youth Sports + any registration) ISO or plain date; the
 *                registration close date. For Youth Sports this is required.
 *   Link:        register/source URL.
 *
 * USAGE:
 *   CANDIDATES_SHEET_CSV_URL="https://docs.google.com/.../pub?...output=csv" \
 *     node scripts/sync-candidates.js
 *
 * Fails SAFE: on fetch/HTML/parse/empty error it exits non-zero WITHOUT writing,
 * so a bad sheet never wipes good override files. Run with continue-on-error in
 * the workflow.
 *
 * IMPORTANT: this OVERWRITES the three override files with what's in the sheet.
 * Once you adopt this flow, the sheet is the source of truth for curated events
 * — don't hand-edit the JSON (it'll be regenerated on the next sync).
 */

const fs = require('fs');
const path = require('path');

const SHEET_URL = process.env.CANDIDATES_SHEET_CSV_URL;
const OUT_DIR = process.env.CANDIDATES_OUT_DIR || path.join(__dirname, '..');

// --- tiny CSV parser (quoted fields, escaped quotes, embedded newlines) ---
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const clean = v => String(v == null ? '' : v).trim();
const yes = v => clean(v) !== '';

// Map a raw Source cell to the canonical label used in the dashboard's
// pending-by-source breakdown.
const sourceLabel = raw => {
  const s = clean(raw).toLowerCase();
  if (s === 'borough') return 'Borough';
  if (s === 'youth sports') return 'Youth Sports';
  if (s === 'pm community' || s === 'penn manor' || s === 'pm') return 'PM Community';
  return raw ? clean(raw) : 'Unknown';
};

// Parse a Date (+ optional Time) cell into a JS Date. Returns null if unusable.
// If the Date has no time component and a Time is given, merge them. Default
// time is 18:00. We DON'T force a timezone here — if the cell carries an
// offset (ISO), it's respected; otherwise it's parsed in the runner's TZ, so
// the sheet should use ISO-with-offset for precision. The Cowork task instructs
// ISO-with-offset to avoid ambiguity.
function parseDateTime(dateStr, timeStr) {
  dateStr = clean(dateStr);
  timeStr = clean(timeStr);
  if (!dateStr) return null;
  // If it already looks like a full ISO datetime, use as-is.
  if (/\d{4}-\d{2}-\d{2}T/.test(dateStr)) {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }
  // Plain date (YYYY-MM-DD or M/D/YYYY). Merge with Time if present.
  let base = dateStr;
  let timePart = '18:00:00';
  if (timeStr) {
    const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (m) {
      let h = parseInt(m[1], 10); const min = m[2];
      const ap = (m[3] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      timePart = String(h).padStart(2, '0') + ':' + min + ':00';
    }
  }
  // Normalize M/D/YYYY -> YYYY-MM-DD
  const us = base.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) base = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const d = new Date(`${base}T${timePart}`);
  return isNaN(d.getTime()) ? null : d;
}

async function main() {
  if (!SHEET_URL) { console.error('✗ CANDIDATES_SHEET_CSV_URL not set'); process.exit(1); }

  let csvText;
  try {
    const res = await fetch(SHEET_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    csvText = await res.text();
  } catch (e) { console.error('✗ fetch failed:', e.message); process.exit(1); }

  if (/^\s*</.test(csvText) || /<html/i.test(csvText.slice(0, 500))) {
    console.error('✗ sheet response looks like HTML, not CSV — is it published correctly?');
    process.exit(1);
  }

  const rows = parseCSV(csvText).filter(r => r.some(c => c.trim() !== ''));
  if (rows.length < 1) { console.error('✗ empty sheet'); process.exit(1); }

  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = name => header.indexOf(name.toLowerCase());
  const col = (row, name) => { const i = idx(name); return i === -1 ? '' : clean(row[i]); };
  if (idx('source') === -1 || idx('title') === -1) {
    console.error('✗ missing required columns: Source and Title'); process.exit(1);
  }

  const boroughOverrides = [];
  const pmEvents = [];
  const youthRegs = [];
  let approved = 0, badRows = 0;
  // Review-backlog + sheet-hygiene counters (surfaced on the status dashboard).
  // pendingFuture = un-X'd rows still ahead of their date (the real backlog);
  // pendingPast = un-X'd rows already past (dead — safe to delete);
  // stalePast = ANY row (approved or not) whose date has passed (sheet clutter).
  let pendingTotal = 0, pendingFuture = 0, pendingPast = 0, stalePast = 0, staleApprovedSkipped = 0;
  const pendingBySource = {};
  const nowMs = Date.now();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const title = col(row, 'title');
    if (!title) continue;

    const source = col(row, 'source').toLowerCase();
    const dt = parseDateTime(col(row, 'date'), col(row, 'time'));
    const deadlineDt = parseDateTime(col(row, 'deadline'), '');

    // The date that decides whether a row is still relevant: Youth Sports keys
    // off Deadline (it has no Date column), everything else off Date. A row
    // whose date is already in the PAST won't produce a visible event (the
    // scraper/frontend hide past items) — it's just clutter sitting in the sheet.
    const whenDt = (source === 'youth sports') ? deadlineDt : dt;
    const isPastRow = !!(whenDt && whenDt.getTime() < nowMs);
    if (isPastRow) stalePast++;

    // Approval gate. Track the un-X'd rows so the dashboard can show a review
    // backlog, split into still-relevant (future) vs already-past (deletable).
    if (!yes(col(row, 'approved'))) {
      pendingTotal++;
      if (isPastRow) {
        pendingPast++;
      } else {
        pendingFuture++;
        const lbl = sourceLabel(source);
        pendingBySource[lbl] = (pendingBySource[lbl] || 0) + 1;
      }
      continue;
    }

    // Sheet hygiene: an APPROVED row whose date is well in the past (>24h)
    // would only produce an event the site already hides — emitting it just
    // bloats events.json (and the override files) with dead entries. Skip it.
    // The 24h grace keeps anything happening today (incl. all-day events) live
    // for the full day; registration events are also dropped by scrape.js once
    // their deadline passes, so this is belt-and-suspenders for those.
    if (whenDt && (nowMs - whenDt.getTime()) > 24 * 60 * 60 * 1000) {
      staleApprovedSkipped++;
      continue;
    }

    const family = yes(col(row, 'family'));
    const link = col(row, 'link');
    const description = col(row, 'description');
    const location = col(row, 'location');

    if (source === 'youth sports') {
      // Youth sports registration: Deadline is the key field. We pass the
      // sheet's Title through as the display title and always mark these
      // kidFriendly; scrape.js dates the event on the deadline and adds the
      // registration badge/button.
      if (!deadlineDt) { console.warn(`  ⚠ youth-sports "${title}" missing/invalid Deadline — skipped`); badRows++; continue; }
      youthRegs.push({
        status: 'active',
        // Human display title for the signup event — the sheet's Title column.
        // scrape.js uses this verbatim (no "Register by <date>:" prefix); when
        // blank it falls back to org + sport. Keep it short and readable
        // (e.g. "Junior Comets Football & Cheerleading").
        title: title,
        // org stays the full org name (the Location column) — it's used as the
        // event location and the homepage Upcoming Signups sub-line, so it can
        // legitimately differ from the short display title above.
        org: location || title,
        sport: col(row, 'notes') || '',   // optional sport detail from Notes
        deadline: deadlineDt.toISOString(),
        registerLink: link || 'https://www.pennmanor.net/community/',
        note: description || ''
      });
      approved++;
    } else if (source === 'pm community' || source === 'penn manor' || source === 'pm') {
      if (!dt) { console.warn(`  ⚠ PM "${title}" missing/invalid Date — skipped`); badRows++; continue; }
      const e = {
        status: 'approved',
        title,
        date: dt.toISOString(),
        location: location || 'Penn Manor',
        sourceLink: link || 'https://www.pennmanor.net/community/'
      };
      if (description) e.description = description;
      if (family) e.kidFriendly = true;
      if (deadlineDt) { e.registrationRequired = true; e.registrationDeadline = deadlineDt.toISOString(); }
      else if (/registration|register|sign\s*up|rsvp/i.test(description + ' ' + title)) e.registrationRequired = true;
      pmEvents.push(e);
      approved++;
    } else if (source === 'borough') {
      if (!dt) { console.warn(`  ⚠ Borough "${title}" missing/invalid Date — skipped`); badRows++; continue; }
      // Borough events from curation are create-mode (not on the iCal).
      const ov = { date: dt.toISOString(), create: true, newTitle: title };
      if (location) ov.location = location;
      if (description) ov.description = description;
      if (link) ov.sourceLink = link;
      if (family) ov.kidFriendly = true;
      boroughOverrides.push(ov);
      approved++;
    } else {
      console.warn(`  ⚠ unknown Source "${col(row, 'source')}" for "${title}" — skipped`);
      badRows++;
    }
  }

  // --- Merge strategy ---------------------------------------------------
  // The candidate sheet owns the CURATED entries. For Borough we must NOT clobber
  // the hand-maintained enrichment overrides (the ones with matchTitle that fix
  // iCal placeholder titles) — those don't come from the sheet. So we read the
  // existing borough-overrides.json, KEEP its non-create (enrichment) entries,
  // and replace only the create-mode entries with the sheet's. PM and youth
  // files are fully sheet-owned, so we replace them wholesale.

  const boroughPath = path.join(OUT_DIR, 'borough-overrides.json');
  let boroughFile = { overrides: [] };
  try { boroughFile = JSON.parse(fs.readFileSync(boroughPath, 'utf8')); } catch (_) {}
  const keptEnrichment = (boroughFile.overrides || []).filter(o => o.create !== true);
  boroughFile.overrides = [...keptEnrichment, ...boroughOverrides];

  const pmFile = {
    _comment: 'GENERATED by scripts/sync-candidates.js from the Event Candidates sheet. Do not hand-edit — edit the sheet. Only Approved rows appear here.',
    events: pmEvents
  };

  // Youth: preserve the file's _comment/_format if present; replace registrations.
  const youthPath = path.join(OUT_DIR, 'youth-sports-registration.json');
  let youthFile = {};
  try { youthFile = JSON.parse(fs.readFileSync(youthPath, 'utf8')); } catch (_) {}
  youthFile.registrations = youthRegs;

  fs.writeFileSync(boroughPath, JSON.stringify(boroughFile, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'penn-manor-overrides.json'), JSON.stringify(pmFile, null, 2) + '\n');
  fs.writeFileSync(youthPath, JSON.stringify(youthFile, null, 2) + '\n');

  // Review-queue / hygiene metrics for the status dashboard. scrape.js reads
  // this file later in the SAME cron (sync runs before scrape) and folds the
  // numbers into status.json, so the dashboard never depends on this file
  // being deployed. Runtime-only — add it to the lftp excludes in main.yml so
  // it isn't published.
  const candidatesStatus = {
    lastRunAt: new Date().toISOString(),
    approved,
    pendingTotal,
    pendingFuture,
    pendingPast,
    pendingBySource,
    stalePast,
    staleApprovedSkipped,
    totalRows: Math.max(0, rows.length - 1)   // exclude the header row
  };
  try {
    fs.writeFileSync(path.join(OUT_DIR, 'candidates-status.json'), JSON.stringify(candidatesStatus, null, 2) + '\n');
  } catch (e) { console.warn('  ⚠ could not write candidates-status.json:', e.message); }

  console.log('✓ candidate sync complete');
  console.log(`  approved rows:    ${approved}`);
  console.log(`  borough create:   ${boroughOverrides.length} (+${keptEnrichment.length} enrichment kept)`);
  console.log(`  pm community:     ${pmEvents.length}`);
  console.log(`  youth sports:     ${youthRegs.length}`);
  console.log(`  pending (no X):   ${pendingTotal} (${pendingFuture} upcoming, ${pendingPast} past)`);
  if (staleApprovedSkipped) console.log(`  ⏭️ stale approved rows skipped (not emitted): ${staleApprovedSkipped}`);
  if (stalePast) console.log(`  ⚠ stale rows (past-dated, prunable): ${stalePast}`);
  if (badRows) console.log(`  ⚠ skipped (bad/unknown): ${badRows}`);
}

main();
