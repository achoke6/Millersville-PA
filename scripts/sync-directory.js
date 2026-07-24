#!/usr/bin/env node
/**
 * sync-directory.js — Build-time sync: Google Sheet -> directory JSON.
 *
 * The directory (businesses + verified/audience/spotlight data) is maintained
 * in ONE flat Google Sheet, one row per business. This script reads that sheet
 * as CSV and regenerates the three files the app consumes:
 *
 *   - restaurants.json   (type=food rows)
 *   - services.json      (type=service rows)
 *   - housing.json       (type=housing rows)
 *   - campus-cupboard.json (type=cupboard row — static info + hours; the
 *                         open/closed logic runs through the same shared
 *                         hours path as every other listing as of 2026-07-23)
 *   - association.json   (verified members + spotlight rotation, derived from
 *                         the verified/spotlight/audience columns)
 *
 * Run this in the scrape/deploy workflow BEFORE the JSON files are deployed.
 * The app itself is unchanged — it still loads the same static JSON, so the
 * site stays fast and has no live Google dependency.
 *
 * SHEET COLUMNS (header row, exact names, case-insensitive match):
 *   name, active, type, category, cuisine, landlord, address, phone, website,
 *   iosLink, status, onCampus, marauderGold, verified, audience, spotlight,
 *   tagline, logo, description, lat, lng, slug, hours_mon..hours_sun,
 *   summer_hours_mon..summer_hours_sun, break_closed
 *
 *   active:      non-blank (e.g. "X") = listed; blank = hidden/skipped entirely.
 *                (If the column is absent, all rows are treated as active.)
 *   type:        food | service | housing | cupboard | institution
 *                  food/service = normal directory cards
 *                  housing      = apartment cards (uses name, landlord, website, description)
 *                  cupboard     = the Campus Cupboard resource (static info +
 *                                 hours here; app.js resolves open/closed via
 *                                 the shared hours path like any listing)
 *                  institution  = spotlight-only, no directory card (e.g. MU)
 *   landlord:    (housing only) leasing company shown as the card subtitle
 *   onCampus / marauderGold / verified / spotlight: "yes" (anything else = no)
 *   audience:    locals | marauders | both   (blank = both; "students"/"townies" also accepted)
 *   lat, lng:    optional decimal coordinates (one-time Nominatim pass; rows
 *                without them simply don't get a map pin). Emitted onto food /
 *                service / housing / cupboard listings only when both parse and
 *                fall inside the local sanity box (GEO below) — bad or
 *                out-of-area values are warned and skipped, never written.
 *   hours_mon..hours_sun: optional per-day business hours (food/service/
 *                cupboard).
 *                Per-day cell values: "HH:MM-HH:MM" (24h ET; end "24:00"
 *                allowed; end < start = past midnight, e.g. "20:00-02:00";
 *                "00:00-24:00" = open 24 hours), comma-joined ranges for
 *                split hours ("11:00-14:00,17:00-21:00"), or "closed".
 *                Blank = unknown → the day is simply omitted from the emitted
 *                object; a row with no valid days emits no `hours` field at
 *                all (the frontend renders nothing — fail-quiet like lat/lng).
 *                Malformed cells are warned + skipped PER DAY, never emitted.
 *   summer_hours_mon..summer_hours_sun: optional per-day SUMMER hours (same
 *                cell format), emitted as `summerHours`. The frontend applies
 *                them only inside MU's computed summer window (day after
 *                spring commencement .. day before fall classes); a blank
 *                summer cell INHERITS that day's regular hours cell, so a
 *                place that only changes weekdays fills 5 cells. A place
 *                closed all summer fills all 7 with "closed" explicitly.
 *   break_closed: "yes" = closed during MU academic breaks (Thanksgiving /
 *                winter / spring break — app.js MU_BREAK_RANGES). Emitted as
 *                `breakClosed: true`. Summer is NOT a break — use the
 *                summer_hours_ cells for summer behavior.
 *
 * USAGE:
 *   DIRECTORY_SHEET_CSV_URL="https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<GID>" \
 *     node scripts/sync-directory.js
 *
 * On any fetch/parse failure the script exits NON-zero WITHOUT writing, so a
 * bad sheet never overwrites good JSON. The workflow should treat a non-zero
 * exit as "keep the committed JSON" (don't fail the whole deploy over it).
 */

const fs = require('fs');
const path = require('path');

const SHEET_URL = process.env.DIRECTORY_SHEET_CSV_URL;
const OUT_DIR = process.env.DIRECTORY_OUT_DIR || '.';

// --- tiny CSV parser (handles quoted fields, commas, escaped quotes, newlines)
// Stable place identity. MIRRORED as slugifyPlace() in app.js — both must
// produce identical slugs (venue-aliases.json keys/values and any explicit
// slug cells depend on the agreement). An optional `slug` sheet column
// (header-read) overrides the derived value — fill a cell only when a
// business is about to be renamed, so its joins survive the rename.
function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^the /, '').replace(/ /g, '-');
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const yes = v => String(v || '').trim().toLowerCase() === 'yes';
const clean = v => String(v || '').trim();

// Sanity box for the lat/lng passthrough (greater Millersville / western
// Lancaster County). Coordinates outside this box are treated as data-entry
// errors: warned and skipped, so a typo can never place a pin in another
// state's Millersville.
const GEO = { latMin: 39.90, latMax: 40.15, lngMin: -76.55, lngMax: -76.15 };

async function main() {
  if (!SHEET_URL) {
    console.error('✗ DIRECTORY_SHEET_CSV_URL not set');
    process.exit(1);
  }

  let csvText;
  try {
    const res = await fetch(SHEET_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    csvText = await res.text();
  } catch (e) {
    console.error('✗ failed to fetch sheet:', e.message);
    process.exit(1);
  }

  // Guard: Google sometimes serves an HTML login/error page instead of CSV.
  if (/^\s*</.test(csvText) || /<html/i.test(csvText.slice(0, 500))) {
    console.error('✗ sheet response looks like HTML, not CSV — is it published/shared correctly?');
    process.exit(1);
  }

  const rows = parseCSV(csvText).filter(r => r.some(c => c.trim() !== ''));
  if (rows.length < 2) { console.error('✗ sheet has no data rows'); process.exit(1); }

  // Map headers (case-insensitive) to column indexes.
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = name => header.indexOf(name.toLowerCase());
  const required = ['name', 'type'];
  for (const col of required) {
    if (idx(col) === -1) { console.error(`✗ missing required column: ${col}`); process.exit(1); }
  }
  const get = (row, col) => { const i = idx(col); return i === -1 ? '' : clean(row[i]); };

  const restaurants = [], services = [], housing = [], cupboard = [], members = [], spotlight = [];
  const seenNames = new Set();
  let warnings = 0;
  let geocoded = 0;
  let hoursListings = 0;
  let summerHoursListings = 0;
  let breakClosedListings = 0;

  // lat/lng passthrough: parse + sanity-check the optional coordinate columns.
  // Returns {lat, lng} rounded to 6 dp, or null. A blank pair = silently no
  // coords (normal for new rows); anything malformed or outside GEO = warn +
  // skip, listing still emitted without coords — a bad cell must never place
  // a pin.
  const coordsFor = (row, name) => {
    const latRaw = get(row, 'lat'), lngRaw = get(row, 'lng');
    if (!latRaw && !lngRaw) return null;
    const lat = parseFloat(latRaw), lng = parseFloat(lngRaw);
    const ok = isFinite(lat) && isFinite(lng) &&
      lat >= GEO.latMin && lat <= GEO.latMax &&
      lng >= GEO.lngMin && lng <= GEO.lngMax;
    if (!ok) {
      console.warn(`  ⚠ bad/out-of-area lat,lng ("${latRaw}", "${lngRaw}") for ${name} — coords skipped`);
      warnings++;
      return null;
    }
    geocoded++;
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  };

  // hours passthrough: optional hours_mon..hours_sun columns (food/service).
  // Per-day values: "HH:MM-HH:MM" (24h; end 24:00 allowed; end<start = past
  // midnight), comma-joined for split hours, or "closed". Blank = unknown
  // (day omitted). Malformed cells are warned + skipped PER DAY, never
  // emitted — a bad cell must never claim a business is open. Returns an
  // {mon..sun} object of the valid days, or null when none (no `hours`
  // field emitted at all, mirroring the coordsFor fail-quiet convention).
  const HOURS_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const HOURS_RANGE_RE = /^([01]\d|2[0-3]):[0-5]\d-(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
  // Shared per-day parser for both hours_ and summer_hours_ column sets —
  // identical cell grammar and per-day warn+skip for both.
  const hoursSetFor = (row, name, prefix) => {
    const out = {};
    let any = false;
    for (const d of HOURS_DAYS) {
      const v = get(row, prefix + d);
      if (!v) continue;
      const parts = v.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length === 1 && parts[0] === 'closed') { out[d] = 'closed'; any = true; continue; }
      if (parts.length > 0 && parts.every(rg => HOURS_RANGE_RE.test(rg))) { out[d] = parts.join(','); any = true; continue; }
      console.warn(`  ⚠ bad ${prefix}${d} ("${v}") for ${name} — day skipped`);
      warnings++;
    }
    return any ? out : null;
  };
  const hoursFor = (row, name) => {
    const h = hoursSetFor(row, name, 'hours_');
    if (h) hoursListings++;
    return h;
  };
  const summerHoursFor = (row, name) => {
    const h = hoursSetFor(row, name, 'summer_hours_');
    if (h) summerHoursListings++;
    return h;
  };
  const breakClosedFor = (row) => {
    const v = yes(get(row, 'break_closed'));
    if (v) breakClosedListings++;   // counted once per emitted row (canary)
    return v;
  };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = get(row, 'name');
    if (!name) continue;

    // Active gate: a row is only included if its "Active" cell is non-blank
    // (an X, or any value). Blank = inactive → skipped entirely: no directory
    // listing, no verified status, no spotlight. Lets you hide a business
    // without deleting its row. If there's no Active column at all, treat
    // every row as active (backward-compatible).
    if (idx('active') !== -1 && !get(row, 'active')) continue;

    if (seenNames.has(name)) { console.warn(`  ⚠ duplicate name skipped: ${name}`); warnings++; continue; }
    seenNames.add(name);

    const type = get(row, 'type').toLowerCase();
    const isVerified = yes(get(row, 'verified'));
    const isSpotlight = yes(get(row, 'spotlight'));
    const audience = get(row, 'audience').toLowerCase() || 'both';

    // Directory listing object (food vs service shapes).
    if (type === 'food') {
      const o = { name, cuisine: get(row, 'cuisine'), description: get(row, 'description'), address: get(row, 'address') };
      const status = get(row, 'status'); if (status) o.status = status;
      const website = get(row, 'website'); if (website) o.link = website;
      const ios = get(row, 'iosLink'); if (ios) o.iosLink = ios;
      if (yes(get(row, 'marauderGold'))) o.marauderGold = true;
      if (yes(get(row, 'onCampus'))) o.onCampus = true;
      const phone = get(row, 'phone'); if (phone) o.phone = phone;
      if (audience !== 'both') o.audience = audience;
      const c = coordsFor(row, name); if (c) { o.lat = c.lat; o.lng = c.lng; } o.slug = slugify(get(row, 'slug') || name);
      const h = hoursFor(row, name); if (h) o.hours = h;
      const sh = summerHoursFor(row, name); if (sh) o.summerHours = sh;
      if (breakClosedFor(row)) o.breakClosed = true;
      restaurants.push(o);
    } else if (type === 'service') {
      const o = { name, category: get(row, 'category'), address: get(row, 'address'),
                  phone: get(row, 'phone'), description: get(row, 'description') };
      const website = get(row, 'website'); if (website) o.link = website;
      if (yes(get(row, 'marauderGold'))) o.marauderGold = true;
      if (yes(get(row, 'onCampus'))) o.onCampus = true;
      if (audience !== 'both') o.audience = audience;
      const c = coordsFor(row, name); if (c) { o.lat = c.lat; o.lng = c.lng; } o.slug = slugify(get(row, 'slug') || name);
      const h = hoursFor(row, name); if (h) o.hours = h;
      const sh = summerHoursFor(row, name); if (sh) o.summerHours = sh;
      if (breakClosedFor(row)) o.breakClosed = true;
      services.push(o);
    } else if (type === 'housing') {
      const o = { name, landlord: get(row, 'landlord'), description: get(row, 'description') };
      const website = get(row, 'website'); if (website) o.link = website;
      if (audience !== 'both') o.audience = audience;
      const c = coordsFor(row, name); if (c) { o.lat = c.lat; o.lng = c.lng; } o.slug = slugify(get(row, 'slug') || name);
      housing.push(o);
    } else if (type === 'cupboard') {
      // Static info + HOURS (2026-07-23): the Cupboard's hours now come from
      // this row's hours_/summer_hours_/break_closed cells like any other
      // listing — app.js resolves open/closed through the shared hours path
      // (placeEffectiveHours). A cupboard row with NO valid hours cells makes
      // the app hide the Cupboard entirely (no claim = closed), so warn LOUD.
      const o = {
        name, description: get(row, 'description'), address: get(row, 'address'),
        onCampus: yes(get(row, 'onCampus'))
      };
      const c = coordsFor(row, name); if (c) { o.lat = c.lat; o.lng = c.lng; } o.slug = slugify(get(row, 'slug') || name);
      const h = hoursFor(row, name); if (h) o.hours = h;
      const sh = summerHoursFor(row, name); if (sh) o.summerHours = sh;
      if (breakClosedFor(row)) o.breakClosed = true;
      if (!h) {
        console.warn(`  ⚠ cupboard row "${name}" has no valid hours_ cells — the app will HIDE the Cupboard entirely`);
        warnings++;
      }
      cupboard.push(o);
    } else if (type === 'institution') {
      // No directory card — only eligible for the spotlight rotation.
    } else {
      console.warn(`  ⚠ unknown type "${type}" for ${name} — skipped`); warnings++; continue;
    }

    // association.json: verified members (directory businesses) + institutions.
    if (isVerified) {
      const m = { name, audience };
      if (type === 'institution') m.spotlightOnly = true;
      const category = get(row, 'category'); if (category) m.category = category;
      members.push(m);
    }

    // Spotlight rotation entry.
    if (isSpotlight) {
      spotlight.push({
        name, audience,
        tagline: get(row, 'tagline'),
        logo: get(row, 'logo'),
        link: get(row, 'website') || '#',
        liveFeed: null
      });
    }
  }

  if (restaurants.length === 0 && services.length === 0) {
    console.error('✗ no valid food/service rows parsed — refusing to write empty directory');
    process.exit(1);
  }

  const association = {
    _comment: 'GENERATED by scripts/sync-directory.js from the directory Google Sheet. Do not hand-edit — edit the sheet instead. Verified businesses + spotlight rotation are derived from the verified/spotlight/audience columns.',
    associationName: 'Millersville.APP Verified Businesses',
    members,
    spotlight
  };

  // Write atomically-ish: build strings first, then write all three.
  const writes = [
    ['restaurants.json', JSON.stringify(restaurants, null, 2) + '\n'],
    ['services.json', JSON.stringify(services, null, 2) + '\n'],
    ['housing.json', JSON.stringify(housing, null, 2) + '\n'],
    ['campus-cupboard.json', JSON.stringify(cupboard[0] || null, null, 2) + '\n'],
    ['association.json', JSON.stringify(association, null, 2) + '\n'],
  ];
  for (const [file, content] of writes) {
    fs.writeFileSync(path.join(OUT_DIR, file), content);
  }

  console.log('✓ directory sync complete');
  console.log(`  restaurants.json: ${restaurants.length}`);
  console.log(`  services.json:    ${services.length}`);
  console.log(`  housing.json:     ${housing.length}`);
  console.log(`  campus-cupboard:  ${cupboard.length ? 'present' : 'none'}`);
  console.log(`  association.json: ${members.length} verified, ${spotlight.length} spotlight`);
  console.log(`  geocoded listings: ${geocoded}`);
  console.log(`  listings with hours: ${hoursListings}`);
  console.log(`  listings with summer hours: ${summerHoursListings}`);
  console.log(`  listings with break closed: ${breakClosedListings}`);
  if (warnings) console.log(`  ⚠ ${warnings} warning(s) above`);
}

main();