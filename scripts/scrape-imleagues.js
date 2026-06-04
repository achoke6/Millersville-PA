/**
 * scrape-imleagues.js — pull Millersville intramural SIGNUPS from IMLeagues.
 *
 * STANDALONE / MANUAL / ON-DEMAND. Not part of the hourly GitHub Actions cron
 * (IMLeagues blocks the runner IPs, and this needs a real browser). Run it on
 * your machine when you want to refresh intramurals; it writes imleagues.json,
 * which the main scrape.js can then fold in like camps.json / vfw.json.
 *
 * HOW IT WORKS (discovered via imleagues-discover*.js):
 *   The intramural home is an Angular SPA. Its data comes from a POST to
 *     https://www.imleagues.com/Services/AjaxRequestHandler.ashx
 *     ?class=...Intramural.HomeBO&method=Initialize
 *   returning JSON whose `data.sportArea` is an HTML fragment listing each
 *   active sport, its league(s), status, registration window, and season.
 *   Rather than replay that POST (which may lean on a session cookie), we let
 *   a real browser load the page and we CAPTURE the response it already makes —
 *   zero auth/token fragility. Then we parse `sportArea` and map to events.
 *
 *   There is no game SCHEDULE here yet — off-season pages only carry upcoming
 *   signups. When seasons start, games live at the events endpoint; that's a
 *   later add, instrumented the same way once real game data exists.
 *
 * RUN (Windows / PowerShell, from the repo root — the script lives in scripts/):
 *   node scripts/scrape-imleagues.js
 *   (Playwright already installed from the discovery step. Writes imleagues.json
 *    to the repo root, alongside camps.json.)
 *   (Playwright already installed from the discovery step.)
 *
 * OUTPUT: imleagues.json — an array of signup entries (status/sport/league/
 * title/deadline/registrationWindow/season/registerLink, plus optional `opens`
 * when registration has a start date). scrape.js's loader turns each active
 * entry into an event dated on its registration deadline.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const START_URL = 'https://imleagues.com/millersville';
const PUBLIC_HOME = 'https://www.imleagues.com/spa/intramural/a236c8d2deb24f3088c442d4f359f6bd/home';
// Repo root (this script lives in scripts/, so climb one level) — matches where
// scrape.js's loader reads it: path.join(__dirname, '../imleagues.json').
const OUT_FILE = path.join(__dirname, '../imleagues.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---- date parsing: IMLeagues prints dates with NO year ("Aug 24 12:30AM",
// "Sep 10"). We (a) infer the year as the soonest sensible occurrence vs. now,
// and (b) treat the clock time as America/New_York and emit a UTC "...Z" string
// — matching how the pipeline's other curated sources store dates (e.g. an ET
// 2pm becomes "...T18:00:00.000Z"). The ET→UTC offset is computed per-date so
// it's correct across the EDT/EST (DST) boundary, not hardcoded.
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

// Given ET wall-clock components, return the true UTC instant (ms), DST-aware
// and independent of the machine's own timezone.
function etComponentsToUtcMs(y, mon, day, hr, min) {
  const candidate = Date.UTC(y, mon, day, hr, min, 0);
  const dt = new Date(candidate);
  const fmt = (tz) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  });
  const partsToMs = (parts) => {
    const g = (t) => { const p = parts.find(x => x.type === t); return p ? p.value : '0'; };
    return Date.UTC(+g('year'), +g('month') - 1, +g('day'), +g('hour') % 24, +g('minute'), +g('second'));
  };
  const offsetMs = partsToMs(fmt('America/New_York').formatToParts(dt))
                 - partsToMs(fmt('UTC').formatToParts(dt));
  return candidate - offsetMs;
}

function parseOne(s, now) {
  const m = String(s).trim().match(/^([A-Za-z]{3})\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?$/i);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()]; if (mon == null) return null;
  const day = +m[2];
  let hr = 0, min = 0;
  if (m[3]) { hr = +m[3] % 12; if (/PM/i.test(m[5])) hr += 12; min = +m[4]; }
  const y0 = new Date(now).getFullYear();
  for (const y of [y0, y0 + 1, y0 - 1]) {
    const ms = etComponentsToUtcMs(y, mon, day, hr, min);
    if (ms >= now - 60 * 864e5) return new Date(ms);   // not >~60d in the past
  }
  return new Date(etComponentsToUtcMs(y0, mon, day, hr, min));
}

function parseRange(s, now) {
  const parts = String(s).split(/\s*[-\u2013]\s*/);   // hyphen or en-dash
  if (parts.length !== 2) return { start: parseOne(s, now), end: null };
  let endStr = parts[1].trim();
  if (/^\d/.test(endStr)) {                            // "Sep 10 - 14" → borrow month
    const mon = (parts[0].trim().match(/^[A-Za-z]{3}/) || [''])[0];
    endStr = mon + ' ' + endStr;
  }
  return { start: parseOne(parts[0], now), end: parseOne(endStr, now) };
}

// UTC "...Z" string (e.g. "2026-09-10T04:00:00.000Z"), matching the override files.
const toZ = (dt) => dt ? dt.toISOString() : null;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();

  // Capture the HomeBO Initialize response the SPA makes on load.
  let homeBodyText = null;
  page.on('response', async (resp) => {
    const url = resp.url();
    if (/AjaxRequestHandler\.ashx/i.test(url) && /HomeBO/.test(url) && /method=Initialize/.test(url)) {
      try { homeBodyText = await resp.text(); } catch (_) {}
    }
  });

  console.log('Loading IMLeagues Millersville intramural home...');
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // wait until we've captured the data response (poll up to ~25s)
  for (let i = 0; i < 50 && !homeBodyText; i++) await page.waitForTimeout(500);

  if (!homeBodyText) {
    console.error('Did not capture the HomeBO data response. The page structure may have changed —');
    console.error('re-run imleagues-discover2.js and check the AjaxRequestHandler.ashx calls.');
    await browser.close();
    process.exit(1);
  }

  // Unwrap {isDone, code, data, ...}; the markup is data.sportArea.
  let sportAreaHtml = '';
  try {
    const json = JSON.parse(homeBodyText);
    sportAreaHtml = (json.data && json.data.sportArea) || '';
  } catch (e) {
    console.error('HomeBO response was not JSON:', e.message);
    await browser.close();
    process.exit(1);
  }
  if (!sportAreaHtml) { console.error('No sportArea in response — nothing to parse.'); await browser.close(); process.exit(1); }

  // Parse the sportArea fragment using the browser's own DOM (no extra deps).
  // Each league anchors on an element whose id ends in "aLeagueName"; its
  // sibling cells (same repeater prefix) hold status / registration / season.
  // The owning sport is the nearest ancestor containing a /spa/sport/ link.
  const records = await page.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const clean = (el) => el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    const out = [];
    doc.querySelectorAll('[id$="aLeagueName"]').forEach((nameEl) => {
      const base = nameEl.id.slice(0, -('aLeagueName'.length));
      const byId = (suf) => doc.getElementById(base + suf);
      // find owning sport: climb until an ancestor has a sport-home link
      let sportName = '', sportId = '';
      let anc = nameEl;
      while (anc && anc !== doc.body) {
        const link = anc.querySelector && anc.querySelector('a[href*="/spa/sport/"]');
        if (link) {
          sportName = (link.getAttribute('aria-label') || link.textContent || '')
            .replace(/Go to /i, '').replace(/ sport home page/i, '').replace(/\s+/g, ' ').trim();
          const m = link.getAttribute('href').match(/\/spa\/sport\/([0-9a-f]+)/i);
          sportId = m ? m[1] : '';
          break;
        }
        anc = anc.parentElement;
      }
      out.push({
        sport: sportName,
        sportId: sportId,
        league: clean(nameEl),
        status: clean(byId('aLeagueStatus')),
        registration: clean(byId('aRegistration')),
        season: clean(byId('aSeason'))
      });
    });
    return out;
  }, sportAreaHtml);

  console.log(`Parsed ${records.length} active league(s) from IMLeagues.`);

  // ── MAP TO EVENT OBJECTS (matches penn-manor-overrides.json signup shape) ──
  // status pre-set to "approved" so signups publish straight from the scrape.
  // date = season start (when the activity happens); registrationDeadline =
  // registration close (the signup gate). Registration-open + season range are
  // ── EMIT REGISTRATION ENTRIES ───────────────────────────────────────────
  // imleagues.json holds raw signup entries; the loader in scrape.js (modeled
  // on the youth-sports-registration pattern) turns each ACTIVE entry into an
  // event dated ON its registration deadline, auto-hiding once the deadline
  // passes. The season range and registration window live in the description.
  // Dates are UTC "Z" strings (ET converted, DST-aware).
  const now = Date.now();
  const registrations = records.map((r) => {
    const reg = parseRange(r.registration, now);
    const sea = parseRange(r.season, now);
    return {
      status: 'active',                                  // loader gate (like youth-sports)
      sport: r.sport,
      league: r.league,
      title: `Intramural ${r.sport}: ${r.league}`,
      // registration close is the signup gate; fall back to season start.
      deadline: toZ(reg.end || sea.start),
      // Registration OPEN date — the start of the registration window. Only
      // emitted when the window is a real range (start AND end), so a single
      // ambiguous date isn't mistaken for an open date. Optional: scrape.js's
      // loader treats a missing opens as "already open" (prior behavior).
      ...(reg.start && reg.end ? { opens: toZ(reg.start) } : {}),
      registrationWindow: r.registration || '',          // human label for the description
      season: r.season || '',                            // human label for the description
      registerLink: r.sportId
        ? `https://www.imleagues.com/spa/sport/${r.sportId}/home`
        : PUBLIC_HOME
    };
  }).filter(x => x.deadline);                            // can't gate a signup with no date

  fs.writeFileSync(OUT_FILE, JSON.stringify(registrations, null, 2));
  console.log(`\nWrote ${registrations.length} signup entr(y/ies) → ${OUT_FILE}`);
  registrations.forEach(x => console.log(`  • ${x.title}  [${x.opens ? 'opens ' + x.opens + ', ' : ''}deadline ${x.deadline}]`));
  console.log('\nReview imleagues.json; the scrape.js loader turns each into a dated signup event.');

  await browser.close();
})().catch(err => { console.error('IMLeagues scrape failed:', err); process.exit(1); });
