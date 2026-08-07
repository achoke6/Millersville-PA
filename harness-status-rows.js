// harness-status-rows.js — behavioral + structural verification for the
// status source-row split (D1/D2b/D3/D4). NOT for the repo.
// Extracts the REAL isArtsmuEvent / isCampsAlumniEvent from patched
// scripts/scrape.js and asserts feed routing; then structural checks on
// scrape.js's three mirrored structures and status.html's edits, and a
// syntax check of status.html's inline <script>.
const fs = require('fs');
const src = fs.readFileSync('scripts/scrape.js', 'utf8');
const html = fs.readFileSync('status.html', 'utf8');

function slice(name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name}: unbalanced braces`);
}
const fns = new Function(
  `${slice('isArtsmuEvent')}; ${slice('isCampsAlumniEvent')}; return { isArtsmuEvent, isCampsAlumniEvent };`
)();
const { isArtsmuEvent, isCampsAlumniEvent } = fns;

let pass = 0, fail = 0;
function T(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

// ---- Synthetic events, one per real feed shape ----
const evArts = { title: 'MUth presents Radium Girls', tags: ['MU', 'Arts Concert / Performance'], sourceLink: 'https://artsmu.com/event/radium-girls/the-ware-center/' };
const evArtsCamp = { title: 'Arts Smarts Camp', tags: ['MU', 'Summer Camp'], sourceLink: 'https://artsmu.com/event/arts-smarts/the-ware-center/' };
const evCampsJson = { title: 'MU Soccer Camp', tags: ['MU', 'Summer Camp'], sourceLink: 'https://www.millersville.edu/camps/soccer' };
const evAlumniSync = { title: 'Philadelphia Union Millersville Takeover', tags: ['MU', 'Alumni Event'], sourceLink: 'https://www.millersville.edu/alumni/events.php' };
const evSFS = { title: 'Summer Fun Series: Yoga with Alumni', tags: ['MU', 'Summer Fun Series'], sourceLink: 'https://www.millersville.edu/alumni/events.php' };
const evCalAlumniTwin = { title: 'Alumni Night at the Philadelphia Union', tags: ['MU', 'Alumni Event', 'Alumni Engagement'], sourceLink: 'https://www.millersville.edu/calendar/events/abc123' };
const evCalPublic = { title: '3 Legacies Wrestling', tags: ['MU', 'Public Event'], sourceLink: 'https://www.millersville.edu/calendar/events/y0hKuFBunSGNjCzwqDbx' };
const evGetInv = { title: 'Wednesday Night Dinner', tags: ['MU', 'GetInvolved', 'Clubs/Orgs'], sourceLink: 'https://getinvolved.millersville.edu/event/12345' };
const evAthletics = { title: 'MU Football vs Kutztown', tags: ['MU', 'Athletics'], sourceLink: 'https://millersvilleathletics.com/x' };
const evBorough = { title: 'Borough Council', tags: ['Borough'], sourceLink: '' };
const evNoFields = {};

// ---- isArtsmuEvent ----
T('artsmu event → artsmu', isArtsmuEvent(evArts), true);
T('artsmu camp → artsmu', isArtsmuEvent(evArtsCamp), true);
T('camps.json → not artsmu', isArtsmuEvent(evCampsJson), false);
T('calendar event → not artsmu', isArtsmuEvent(evCalPublic), false);
T('empty object safe (artsmu)', isArtsmuEvent(evNoFields), false);

// ---- isCampsAlumniEvent ----
T('camps.json camp → camps row', isCampsAlumniEvent(evCampsJson), true);
T('alumni-office row (Alumni Event tag) → camps row', isCampsAlumniEvent(evAlumniSync), true);
T('SFS curated copy → camps row', isCampsAlumniEvent(evSFS), true);
T('CALENDAR alumni twin → stays calendar row (link guard)', isCampsAlumniEvent(evCalAlumniTwin), false);
T('artsmu camp → stays artsmu row (artsmu guard)', isCampsAlumniEvent(evArtsCamp), false);
T('plain calendar event → not camps', isCampsAlumniEvent(evCalPublic), false);
T('GetInvolved event → not camps', isCampsAlumniEvent(evGetInv), false);
T('borough event → not camps', isCampsAlumniEvent(evBorough), false);
T('empty object safe (camps)', isCampsAlumniEvent(evNoFields), false);

// ---- Mutual exclusivity across the whole synthetic set ----
const all = [evArts, evArtsCamp, evCampsJson, evAlumniSync, evSFS, evCalAlumniTwin, evCalPublic, evGetInv, evAthletics, evBorough];
T('no event is in both new rows', all.every(e => !(isArtsmuEvent(e) && isCampsAlumniEvent(e))), true);

// ---- muCalendar exclusion simulation (mirrors the patched predicate) ----
const muCalendarPred = e => (e.tags || []).includes('MU')
    && !(e.tags || []).includes('Athletics') && !(e.tags || []).includes('Clubs/Orgs')
    && !isArtsmuEvent(e) && !isCampsAlumniEvent(e);
T('every MU event lands in exactly one row',
  all.filter(e => (e.tags || []).includes('MU')).every(e => {
    const rows = [muCalendarPred(e), isArtsmuEvent(e), isCampsAlumniEvent(e),
                  (e.tags || []).includes('Clubs/Orgs'), (e.tags || []).includes('Athletics')];
    return rows.filter(Boolean).length === 1;
  }), true);
T('calendar alumni twin counted under muCalendar', muCalendarPred(evCalAlumniTwin), true);
T('3 Legacies counted under muCalendar', muCalendarPred(evCalPublic), true);

// ---- Structural: scrape.js three-mirror consistency ----
const excl = "!isArtsmuEvent(e) && !isCampsAlumniEvent(e)";
T('muCalendar exclusion present at all 3 sites', (src.match(new RegExp(excl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 3);
T('sources has artsmu key', src.includes('artsmu: deduped.filter(isArtsmuEvent).length'), true);
T('sources has campsAlumni key', src.includes('campsAlumni: deduped.filter(isCampsAlumniEvent).length'), true);
T('ranges has artsmu key', src.includes('artsmu: dateRangeForPred(isArtsmuEvent),'), true);
T('ranges has campsAlumni key', src.includes('campsAlumni: dateRangeForPred(isCampsAlumniEvent),'), true);
T('staleness has artsmu key', src.includes('artsmu: dateRangeForPred(isArtsmuEvent)?.latest,'), true);
T('staleness has campsAlumni key', src.includes('campsAlumni: dateRangeForPred(isCampsAlumniEvent)?.latest,'), true);

// ---- Structural: status.html edits ----
T('html: artsmu row', html.includes("key: 'artsmu'"), true);
T('html: campsAlumni row', html.includes("key: 'campsAlumni'"), true);
T('html: community relabeled', html.includes("Community & place events") && !html.includes("'Community submissions'"), true);
T('html: artsmu seasonal-low', /artsmu:\s+\[6, 7, 8\]/.test(html), true);
T('html: legend present outside #grid', html.indexOf('What feeds this page') > html.indexOf('<div id="grid"'), true);

// ---- Syntax-check status.html's inline <script> blocks ----
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let jsOk = true;
for (const s of scripts) {
  try { new Function(s); } catch (e) { jsOk = false; console.log('   script parse error:', e.message); }
}
T('status.html inline JS parses', jsOk && scripts.length > 0, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
