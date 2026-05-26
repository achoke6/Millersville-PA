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
 *   - association.json   (verified members + spotlight rotation, derived from
 *                         the verified/spotlight/audience columns)
 *
 * Run this in the scrape/deploy workflow BEFORE the JSON files are deployed.
 * The app itself is unchanged — it still loads the same static JSON, so the
 * site stays fast and has no live Google dependency.
 *
 * SHEET COLUMNS (header row, exact names, case-insensitive match):
 *   name, type, category, cuisine, address, phone, website, iosLink, status,
 *   onCampus, marauderGold, verified, audience, spotlight, tagline, logo,
 *   description
 *
 *   type:        food | service | institution
 *                (institution = spotlight-only, no directory card — e.g. MU)
 *   onCampus / marauderGold / verified / spotlight: "yes" (anything else = no)
 *   audience:    locals | students | both   (blank = both)
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

  const restaurants = [], services = [], members = [], spotlight = [];
  const seenNames = new Set();
  let warnings = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = get(row, 'name');
    if (!name) continue;
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
      restaurants.push(o);
    } else if (type === 'service') {
      const o = { name, category: get(row, 'category'), address: get(row, 'address'),
                  phone: get(row, 'phone'), description: get(row, 'description') };
      const website = get(row, 'website'); if (website) o.link = website;
      if (yes(get(row, 'marauderGold'))) o.marauderGold = true;
      if (yes(get(row, 'onCampus'))) o.onCampus = true;
      services.push(o);
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
    ['association.json', JSON.stringify(association, null, 2) + '\n'],
  ];
  for (const [file, content] of writes) {
    fs.writeFileSync(path.join(OUT_DIR, file), content);
  }

  console.log('✓ directory sync complete');
  console.log(`  restaurants.json: ${restaurants.length}`);
  console.log(`  services.json:    ${services.length}`);
  console.log(`  association.json: ${members.length} verified, ${spotlight.length} spotlight`);
  if (warnings) console.log(`  ⚠ ${warnings} warning(s) above`);
}

main();
