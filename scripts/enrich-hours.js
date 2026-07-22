#!/usr/bin/env node
/**
 * enrich-hours.js — one-time directory hours enrichment via Google Places API (New).
 *
 * Reads the directory-sheet CSV export, looks each business up on Google,
 * and writes a copy with 7 structured hours columns + 3 review columns.
 * The sheet stays the source of truth: paste the columns in after review.
 *
 * Usage (PowerShell):
 *   $env:GOOGLE_MAPS_API_KEY = "your-key-here"
 *   node scripts\enrich-hours.js "DIRECTORY  Millersville.APP  directorysheet 2.csv"           # dry run
 *   node scripts\enrich-hours.js "DIRECTORY  Millersville.APP  directorysheet 2.csv" --write   # writes <input>.hours.csv
 *
 * Conventions written into hours_mon..hours_sun:
 *   "11:00-21:00"              one range, 24h clock
 *   "11:00-14:00,17:00-21:00"  split hours, comma-joined, sorted
 *   "20:00-02:00"              closes past midnight (end < start = next day)
 *   "00:00-24:00"              open 24 hours
 *   "closed"                   Google confirms closed that day
 *   ""                         unknown — no match, low confidence, or no hours on file
 *
 * Rules: hours are WITHHELD (left blank) on NO_MATCH / LOW_CONFIDENCE / API errors —
 * the script never guesses. Withheld hours print to the console so you can hand-fill
 * a row if the match was actually right. Rows with any hours_ column already filled
 * are skipped untouched, so re-runs are safe.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const MILLERSVILLE = { latitude: 40.0026, longitude: -76.3544 }; // location bias center
const BIAS_RADIUS_M = 8000;
const DELAY_MS = 150;

const HOURS_COLS = ['hours_mon','hours_tue','hours_wed','hours_thu','hours_fri','hours_sat','hours_sun'];
const REVIEW_COLS = ['google_matched_name','google_address','google_note'];
// Places API day index: 0 = Sunday
const COL_BY_API_DAY = ['hours_sun','hours_mon','hours_tue','hours_wed','hours_thu','hours_fri','hours_sat'];

// ---------- CSV (RFC 4180, handles quoted commas/newlines) ----------
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* consumed with the following \n */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function csvField(v) {
  v = String(v ?? '');
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function toCsv(rows) { return rows.map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n'; }

// ---------- Match confidence ----------
function norm(s) {
  return String(s || '').toLowerCase().replace(/&/g, 'and')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function confident(sheetName, googleName) {
  const A = new Set(norm(sheetName).split(' ').filter(w => w.length > 2));
  const B = new Set(norm(googleName).split(' ').filter(w => w.length > 2));
  if (!A.size || !B.size) return false;
  let hit = 0; for (const w of A) if (B.has(w)) hit++;
  return hit / A.size >= 0.5; // half the sheet name's significant words must appear
}

// ---------- Hours conversion ----------
function hhmm(t) { return String(t.hour || 0).padStart(2, '0') + ':' + String(t.minute || 0).padStart(2, '0'); }
function hoursFromGoogle(regular) {
  if (!regular || !Array.isArray(regular.periods) || !regular.periods.length) return null;
  const out = {};
  for (const k of HOURS_COLS) out[k] = 'closed';
  // 24/7 signature: a single period with an open and no close
  if (regular.periods.length === 1 && regular.periods[0].open && !regular.periods[0].close) {
    for (const k of HOURS_COLS) out[k] = '00:00-24:00';
    return out;
  }
  const byDay = new Map();
  for (const p of regular.periods) {
    if (!p.open) continue;
    const start = hhmm(p.open);
    const end = p.close ? hhmm(p.close) : '24:00';
    const col = COL_BY_API_DAY[p.open.day];
    if (!col) continue;
    if (!byDay.has(col)) byDay.set(col, []);
    byDay.get(col).push(`${start}-${end}`); // overnight close lands on the OPEN day by design
  }
  for (const [col, list] of byDay) {
    list.sort();
    out[col] = list.join(',');
  }
  return out;
}

// ---------- Places API (New) — one call per row ----------
async function lookup(name, address) {
  const textQuery = address && address.trim()
    ? `${name} ${address}` : `${name}, Millersville, PA`;
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.regularOpeningHours',
    },
    body: JSON.stringify({
      textQuery,
      pageSize: 1,
      locationBias: { circle: { center: MILLERSVILLE, radius: BIAS_RADIUS_M } },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.places && j.places[0]) || null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Main ----------
(async () => {
  const [inputPath, ...flags] = process.argv.slice(2);
  const WRITE = flags.includes('--write');
  if (!inputPath) { console.error('Usage: node enrich-hours.js <directory.csv> [--write]'); process.exit(1); }
  if (!API_KEY) { console.error('Set GOOGLE_MAPS_API_KEY first:  $env:GOOGLE_MAPS_API_KEY = "..."'); process.exit(1); }

  const rows = parseCsv(fs.readFileSync(inputPath, 'utf8'));
  const header = rows[0];
  const idx = n => header.findIndex(h => h.trim().toLowerCase() === n);
  const NAME = idx('name'), ADDR = idx('address');
  if (NAME < 0) { console.error('No "name" column found in header.'); process.exit(1); }

  // Append any missing new columns to the header (idempotent)
  for (const col of [...HOURS_COLS, ...REVIEW_COLS]) {
    if (idx(col) < 0) header.push(col);
  }
  const col = {}; for (const c of [...HOURS_COLS, ...REVIEW_COLS]) col[c] = idx(c);
  const pad = r => { while (r.length < header.length) r.push(''); };

  const tally = { filled: 0, closedOnly: 0, noMatch: 0, lowConf: 0, noHours: 0, skipped: 0, errors: 0 };

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; pad(r);
    const name = (r[NAME] || '').trim();
    if (!name) continue;
    if (HOURS_COLS.some(c => (r[col[c]] || '').trim() !== '')) {
      tally.skipped++; console.log(`— SKIP (hours already present): ${name}`); continue;
    }

    let note = '', matched = null;
    try {
      matched = await lookup(name, r[ADDR]);
    } catch (e) {
      tally.errors++; r[col.google_note] = `API_ERROR: ${e.message}`;
      console.log(`✗ API_ERROR         ${name} — ${e.message}`); await sleep(DELAY_MS); continue;
    }
    await sleep(DELAY_MS);

    if (!matched) {
      tally.noMatch++; r[col.google_note] = 'NO_MATCH';
      console.log(`✗ NO_MATCH          ${name}`); continue;
    }
    const gName = matched.displayName && matched.displayName.text || '';
    const gAddr = matched.formattedAddress || '';
    r[col.google_matched_name] = gName;
    r[col.google_address] = gAddr;

    const hours = hoursFromGoogle(matched.regularOpeningHours);
    const isConfident = confident(name, gName);

    if (!isConfident) {
      tally.lowConf++;
      r[col.google_note] = 'LOW_CONFIDENCE — hours withheld; verify match, fill by hand if correct';
      console.log(`? LOW_CONFIDENCE    ${name}  ↛  "${gName}" (${gAddr})`);
      if (hours) console.log(`    withheld: ${HOURS_COLS.map(c => `${c.slice(6)} ${hours[c]}`).join(' | ')}`);
      continue;
    }
    if (!hours) {
      tally.noHours++;
      r[col.google_note] = 'MATCHED_NO_HOURS — Google has no hours on file';
      console.log(`○ NO_HOURS          ${name}  =  "${gName}"`);
      continue;
    }
    for (const c of HOURS_COLS) r[col[c]] = hours[c];
    r[col.google_note] = 'OK';
    tally.filled++;
    console.log(`✓ OK                ${name}  =  "${gName}"`);
    console.log(`    ${HOURS_COLS.map(c => `${c.slice(6)} ${hours[c]}`).join(' | ')}`);
  }

  console.log('\n===== SUMMARY =====');
  console.log(`filled: ${tally.filled}  low-confidence: ${tally.lowConf}  no-match: ${tally.noMatch}  matched-but-no-hours: ${tally.noHours}  skipped: ${tally.skipped}  errors: ${tally.errors}`);

  if (WRITE) {
    const out = path.join(path.dirname(inputPath),
      path.basename(inputPath, path.extname(inputPath)) + '.hours.csv');
    fs.writeFileSync(out, toCsv(rows));
    console.log(`\nWrote: ${out}`);
    console.log('Review google_matched_name/google_address, then paste ONLY the 7 hours_ columns into the sheet.');
  } else {
    console.log('\nDry run — nothing written. Re-run with --write when the matches look right.');
  }
})();