const fs = require('fs');
const path = require('path');
const dns = require('dns');
const ical = require('node-ical');

dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const SCRAPE_HORIZON_DAYS = 60;

const sportsList = ['Baseball', 'Softball', 'Track', 'Soccer', 'Lacrosse', 'Tennis', 'Volleyball', 'Wrestling', 'Basketball', 'Football', 'Field Hockey', 'Golf', 'Cross Country', 'Cheerleading', 'Swimming', 'Bowling', 'Rugby', 'Fencing', 'Esports', 'Archery'];

// Resolve an event's end time for events.json serialization. Returns an ISO
// string when the source carries an explicit end that should be persisted;
// otherwise returns undefined and the consumer (app.js getEventEndTime,
// events_ics.php) falls back to a sport/type default at render time. Rules:
//   - Non-all-day: pass through any explicit end > start.
//   - All-day: skip unless iCal end is materially after start (>25h). Single-
//     day all-day events have iCal end = next-day-midnight per RFC 5545
//     exclusive-end semantics, which would falsely flag them as multi-day on
//     the frontend (where the rule is duration > 12h). True multi-day all-day
//     events (festivals, art shows) sail past the 25h cutoff and pass through.
// For recurring events pass the *occurrence's* start as `instanceStart` and
// the original duration is computed from origStart/origEnd. For non-recurring
// events, instanceStart === origStart and the helper just normalizes the
// existing ev.end into ISO. Returns undefined defensively whenever any input
// is missing or NaN, never throws.
function resolveEndTime({ origStart, origEnd, instanceStart, isAllDay = false }) {
    if (!origEnd || !origStart || !instanceStart) return undefined;
    const startMs = new Date(origStart).getTime();
    const endMs = new Date(origEnd).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
    const durationMs = endMs - startMs;
    if (durationMs <= 0) return undefined;
    if (isAllDay && durationMs <= 25 * 3600 * 1000) return undefined;
    const end = new Date(new Date(instanceStart).getTime() + durationMs);
    if (isNaN(end.getTime())) return undefined;
    return end.toISOString();
}


// Load shortnames-overlay.json once at startup. Used to populate event
// orgShortName fields on the way out, so the marauder home pill can show
// "IAEM" instead of "International Association of Emergency Managers"
// without doing a clubs.json lookup at render time.
let shortNameOverlay = {};
try {
    const overlayPath = path.join(__dirname, '../shortnames-overlay.json');
    if (fs.existsSync(overlayPath)) {
        const overlayData = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
        shortNameOverlay = (overlayData && overlayData.overrides) || {};
        console.log(`📛 Loaded ${Object.keys(shortNameOverlay).length} shortname overrides`);
    }
} catch (err) {
    console.log(`  ⚠️ Shortname overlay load failed: ${err.message}`);
}

// Load org-overrides.json — title-pattern overrides for events that have
// no Customer field set in MU's calendar API. Many events leave the host
// org blank; this file maps event title patterns to their actual host so
// the marauder home pill can show "GSA" instead of "MU" for Lavender
// Legacy, etc. Applied ONLY when customerName is empty — explicit Customer
// values always win.
let orgOverrides = [];
try {
    const orgOverridesPath = path.join(__dirname, '../org-overrides.json');
    if (fs.existsSync(orgOverridesPath)) {
        const data = JSON.parse(fs.readFileSync(orgOverridesPath, 'utf8'));
        const list = (data && data.overrides) || [];
        orgOverrides = list.map(entry => ({
            re: new RegExp(entry.titlePattern, 'i'),
            orgName: entry.orgName
        }));
        console.log(`🏷️ Loaded ${orgOverrides.length} org-name overrides`);
    }
} catch (err) {
    console.log(`  ⚠️ Org overrides load failed: ${err.message}`);
}
function resolveOrgFromTitle(title) {
    if (!title) return '';
    for (const o of orgOverrides) {
        if (o.re.test(title)) return o.orgName;
    }
    return '';
}

// Resolve an org's display short name. Returns the overlay value if present,
// otherwise the original name if it's already short enough (<22 chars), or
// empty string when there's nothing useful to show. The 22-char threshold
// matches the audit threshold I used when building the overlay.
// Compute a canonical "room signature" — building code + room number — used
// to detect when two upstream sources reference the same room in different
// formats. Returns "BLDG|ROOM" (e.g. "SMC|202") or empty string if either
// piece can't be extracted. Empty signatures intentionally don't match each
// other, so generic locations like "Quad" or "Brooks Field" won't get
// accidentally merged with each other or with empty-location events.
function roomSignature(location) {
    if (!location) return '';
    let s = String(location);
    // Expand long-form building names to their short codes so both forms
    // produce the same signature. Add new entries here as they surface.
    const buildingAliases = [
        [/\bStudent Memorial Center\b/i, 'SMC'],
        [/\bWare Center\b/i, 'WARE']
    ];
    for (const [re, code] of buildingAliases) {
        s = s.replace(re, code);
    }
    // Find building code. Try in priority order:
    //   (1) Capitalized word at start of string ("Caputo 130", "McComsey 202").
    //       Anchored to start so it's specific.
    //   (2) All-caps acronym anywhere in string ("SMC Room 202", "WARE 100").
    // Priority matters: "McComsey" must beat the "MC" prefix that the all-caps
    // pattern would otherwise greedily match.
    const capWordMatch = s.match(/^([A-Z][a-zA-Z]{2,})/);
    let bldg = '';
    if (capWordMatch) {
        bldg = capWordMatch[1];
    } else {
        const upperMatch = s.match(/\b([A-Z]{2,6})\b/);
        if (upperMatch) bldg = upperMatch[1];
    }
    if (!bldg) return '';
    // Find room number: digit sequence, optionally with a trailing letter
    // ("100A", "202B"). Pick the LAST one in the string since building codes
    // sometimes have leading numbers we want to skip.
    const roomMatches = s.match(/\b(\d{1,4}[A-Za-z]?)\b/g);
    const room = roomMatches ? roomMatches[roomMatches.length - 1] : '';
    if (!room) return '';
    return `${bldg.toUpperCase()}|${room.toUpperCase()}`;
}

// Parse an event date string into an absolute UTC instant (ms since epoch),
// timezone-aware. The cross-source dedupe needs both halves of a duplicate
// pair to land at the same number even when upstream sources serialize
// differently. Two formats show up in our data:
//
//   "2026-04-22T20:00:00"        — naive (no Z, no offset). MU Calendar emits
//                                   these and intends Eastern Time wall-clock.
//                                   On a UTC runner, `new Date(...)` would
//                                   wrongly treat it as UTC.
//   "2026-04-23T00:00:00.000Z"   — true UTC. GetInvolved emits these. The two
//                                   examples above are the SAME event (8 PM ET
//                                   on Apr 22 = 00:00 UTC on Apr 23).
//
// We detect a TZ marker (Z or ±HH:MM) and parse natively when present;
// otherwise we treat the string as ET wall-clock and back out the ET offset
// for that calendar moment via Intl (DST-aware — handles EDT/EST correctly).
function parseEventInstant(s) {
    if (!s) return NaN;
    const str = String(s).trim();
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(str)) {
        return new Date(str).getTime();
    }
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return NaN;
    const candidate = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    const dt = new Date(candidate);
    const fmt = (tz) => new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    const partsToMs = (parts) => {
        const g = (t) => parts.find(p => p.type === t)?.value || '0';
        return Date.UTC(+g('year'), +g('month') - 1, +g('day'),
                        +g('hour') % 24, +g('minute'), +g('second'));
    };
    const offsetMs = partsToMs(fmt('America/New_York').formatToParts(dt))
                   - partsToMs(fmt('UTC').formatToParts(dt));
    return candidate - offsetMs;
}

// Combine an ISO date ("2026-05-03") with a human clock string ("1:00 PM",
// "10:30am", "5 PM") into a naive ET wall-clock ISO ("2026-05-03T13:00:00")
// suitable for parseEventInstant. Used by VFW Vision extraction where flyers
// publish times like "Bingo 1:00 PM – 5:00 PM" — the date comes from one
// field, the time from another. Returns null on parse failure (caller falls
// back to whatever default the source uses).
function combineDateAndClockTime(dateStr, clockStr) {
    if (!dateStr || !clockStr) return null;
    const s = String(clockStr).trim();
    // Accept "1:00 PM", "1 PM", "13:00", "10:30am", etc.
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?$/);
    if (!m) return null;
    let hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2] || '0', 10);
    const ampm = (m[3] || '').toUpperCase();
    if (ampm === 'PM' && hours < 12) hours += 12;
    else if (ampm === 'AM' && hours === 12) hours = 0;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    // No Z / no offset — parseEventInstant treats this as ET wall-clock and
    // applies the DST-correct offset (EDT or EST as appropriate for the date).
    return `${dateStr}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00`;
}

// Derive the ET calendar day (YYYY-MM-DD) from a UTC instant. Used by the
// dedupe pass to group events occurring on the same Millersville day even
// when one source phrases them as "Apr 22 8pm ET" and another as
// "Apr 23 00:00 UTC" (which crosses the calendar-day boundary in UTC).
function deriveDayET(ms) {
    if (isNaN(ms)) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(ms));
    const g = (t) => parts.find(p => p.type === t)?.value;
    return `${g('year')}-${g('month')}-${g('day')}`;
}

// Build a TZ-correct dedup key for camps and arts events: title-prefix + ET
// calendar day. Both halves resolved via parseEventInstant + deriveDayET so
// that an existing event with naive ET date "2026-07-15T20:00:00" and a
// freshly-built UTC ISO "2026-07-16T00:00:00.000Z" map to the SAME key
// (they're the same wall-clock instant on the same Millersville day). The
// original logic mixed `(e.date||'').slice(0,10)` against
// `toISOString().slice(0,10)`, so any 8pm+ ET event would slip past dedup
// and double-add. Used by both the artsmu camps pass and the camps.json
// hand-maintained pass since they share the same dedup shape.
//
// `dateRef` accepts either a Date object (when callers have already built
// one) or a date string. Falls back to a raw 10-char slice for unparseable
// inputs to preserve legacy behavior.
function buildCampDedupKey(title, dateRef) {
    const ms = dateRef instanceof Date ? dateRef.getTime() : parseEventInstant(dateRef);
    const day = !isNaN(ms) ? deriveDayET(ms)
              : (typeof dateRef === 'string' ? dateRef.slice(0, 10) : '');
    return (title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) + '|' + day;
}

function resolveOrgShortName(orgName) {
    if (!orgName) return '';
    const trimmed = orgName.trim();
    if (shortNameOverlay[trimmed]) return shortNameOverlay[trimmed];
    // Allow names up to 24 chars to flow through unchanged. Examples:
    //   "Advancement Department" (22) — fits a pill cleanly
    //   "Office of the Provost" (21) — fits a pill cleanly
    // Longer names need an explicit overlay mapping or they'd produce
    // awkwardly wide pills, so we return empty and let the frontend fall
    // back to the generic "MU" pill.
    if (trimmed.length <= 24) return trimmed;
    return '';
}

const hGameClubSports = [
    'baseball', 'bowling', 'equestrian', 'fencing', 'ice hockey', 'mma',
    "men's basketball", "men's ice hockey", "men's lacrosse", "men's rugby",
    "men's soccer", "men's volleyball", 'dance team', 'running', 'softball',
    'tennis', 'ultimate frisbee', "women's basketball", "women's rugby",
    "women's soccer", "women's volleyball"
];

// ===== UTILITY FUNCTIONS =====

function extractPricing(desc, title = "", location = "", apiLink = "") {
    // Etix direct ticket links for known MU events
    const etixEvents = [
        { match: /shawan rice/i, url: 'https://www.etix.com/ticket/p/52838436/shawan-rice-the-quiet-riders-lancaster-ware-center-for-the-arts', price: '$15' },
        { match: /making of life on our planet/i, url: 'https://www.etix.com/ticket/p/44575281/the-making-of-life-on-our-planet-lancaster-ware-center-for-the-arts', price: '$8 - $10' },
        { match: /kids.?\s*salsa/i, url: 'https://www.etix.com/ticket/p/34862669/kidssalsa-5-lancaster-ware-center-for-the-arts', price: '$15' },
        { match: /family fun fest.*doodle/i, url: 'https://www.etix.com/ticket/p/55340777/family-fun-fest-doodle-pop-lancaster-ware-center-for-the-arts', price: '$10 - $15' },
        { match: /commercial lab band/i, url: 'https://www.etix.com/ticket/p/69670740/commercial-lab-band-millersville-winter-visual-performing-arts-center', price: '$10' },
        { match: /commercial music ensemble/i, url: 'https://www.etix.com/ticket/p/36061167/commercial-music-ensemble-millersville-winter-visual-performing-arts-center', price: '$10' },
        { match: /xun pan|gabriel chamber/i, url: 'https://www.etix.com/ticket/p/77977956/xun-pan-gabriel-chamber-ensemble-millersville-winter-visual-performing-arts-center', price: 'Tickets Available' },
        { match: /orchestral masterworks/i, url: 'https://www.etix.com/ticket/p/71235627/orchestral-masterworks-millersville-winter-visual-performing-arts-center', price: '$10' },
        { match: /jazz ensembles|jazz.*java/i, url: 'https://www.etix.com/ticket/p/71762678/jazz-ensemblesjazz-java-with-alumni-band-millersville-winter-visual-performing-arts-center', price: '$18' },
        { match: /concert band.*wind ensemble|wind ensemble.*concert band/i, url: 'https://www.etix.com/ticket/p/74152110/concert-band-wind-ensemble-millersville-winter-visual-performing-arts-center', price: '$10' },
        { match: /spring choral concert/i, url: 'https://www.etix.com/ticket/p/42106815/spring-choral-concert-millersville-winter-visual-performing-arts-center', price: '$10' },
    ];

    // Check for direct etix match first
    const etixMatch = etixEvents.find(e => e.match.test(title));
    if (etixMatch) return { price: etixMatch.price, link: etixMatch.url };

    let price = "Free";
    let link = apiLink || "";
    if (desc) {
        const priceRegex = /\$\d+(?:\.\d{2})?(?:\s+(student|public|general|admission|door|advance|mu|adult|child)s?)?/gi;
        const prices = desc.match(priceRegex);
        if (prices) price = [...new Set(prices)].join(' / ');
        else if (/ticket|admission|cover charge|cost:/i.test(desc)) price = "Ticket Required";

        if (!link) {
            const anchorRegex = /<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
            let match, bestLink = null, highestScore = 0;
            while ((match = anchorRegex.exec(desc)) !== null) {
                const url = match[1], anchorText = match[2].toLowerCase(), lowerUrl = url.toLowerCase();
                let score = 0;
                if (/instagram\.com|facebook\.com|twitter\.com|campusgroups\.com\/organization/.test(lowerUrl)) continue;
                if (/etix\.com|universitytickets\.com|muticketsonline\.com|eventbrite\.com/.test(lowerUrl)) score = 3;
                else if (/ticket|register|buy|rsvp|purchase/.test(anchorText)) score = 2;
                else if (/ticket|register|rsvp/.test(lowerUrl)) score = 1;
                if (score > highestScore) { highestScore = score; bestLink = url; }
            }
            if (!bestLink) {
                const rawMatch = desc.match(/(https?:\/\/[^\s"'<]+)/gi);
                if (rawMatch) {
                    const ticketRaw = rawMatch.find(l => /etix\.com|universitytickets|eventbrite/.test(l.toLowerCase()));
                    if (ticketRaw) bestLink = ticketRaw;
                }
            }
            if (bestLink) link = bestLink;
        }
    }
    if (!link && price !== "Free") {
        const lt = title.toLowerCase(), ll = location.toLowerCase();
        if (/winter|lyte/.test(ll) || /concert|recital|theatre/.test(lt)) link = "https://www.etix.com/ticket/v/23659/";
        else if (/pucillo|biemesderfer/.test(ll) || /game|match|tournament/.test(lt)) link = "https://www.etix.com/ticket/v/23684/";
    }
    // Ware Center / Steinman Hall events with admission → etix
    if (!link) {
        const lt = title.toLowerCase(), ll = location.toLowerCase();
        if (/ware|steinman/.test(ll)) {
            if (price !== "Free" || /concert|ensemble|recital|performance|theatre|theater|film|screening|opera|symphony|jazz|music|dance|ballet|on screen|in person/.test(lt)) {
                link = "https://www.etix.com/ticket/v/23659/";
                if (price === "Free") price = "Tickets Available";
            }
        }
        // Winter Center / Lyte events
        if (/winter|lyte/.test(ll) && price === "Free") {
            if (/concert|ensemble|recital|performance|theatre|theater|musical|show/.test(lt)) {
                link = "https://www.etix.com/ticket/v/23659/";
                price = "Tickets Available";
            }
        }
    }
    return { price, link };
}

// Classify whether an event is open to the general public or student-only.
// Used by both the GetInvolved scraper (where it was originally defined inline) and the
// MU Calendar scraper (for "Student Event" items, which we relabel as GetInvolved below).
// Returns 'public' or 'mu-only'. Credit-granting events are always student-only.
//
// Heuristic order:
//   1. Credit events → mu-only (unconditional)
//   2. Strong mu-only signals (bible study, fellowship meeting, chapter meeting, weekly
//      meeting, members only, tabling, orientation, info session) → mu-only even if the
//      text also mentions public-ish words. These are student-facing by nature even when
//      the word "community" appears (e.g. "our club community").
//   3. Public signals (keyword / category / org / fundraising tag) → public
//   4. Everything else → mu-only (default)
// Overly generic event titles ("Practice", "Meeting", "Informational") don't
// identify the event in a mixed feed — a bare "Practice" card is useless when
// the reader hasn't already opened a specific club page. When the source
// provides an owner/org name, prepend it so titles become "Men's Rugby Club
// Practice" or "Greek Life Informational" on cards and the home page.
//
// Covers the common single-word/short-phrase titles posted by student orgs on
// GetInvolved. Extend this list when you spot new offenders.
const GENERIC_CLUB_EVENT_TITLES = /^(practice|rehearsal|meeting|tabling|informational|info session|information session|interest meeting|general meeting|general body meeting|gbm|e-?board|e-?board meeting|executive meeting|officer meeting|chapter meeting|chapter business|weekly meeting|open house|office hours|game night|movie night|social|rush|recruitment|recruitment night|welcome back|orientation|new member|initiation|banquet|cookout|hangout|bible study|fellowship|prayer meeting|worship|study group|study session|workshop|fundraiser)$/i;

function decorateGenericTitle(title, orgName) {
    const t = (title || '').trim();
    const o = (orgName || '').trim();
    if (!t || !o) return t;
    if (!GENERIC_CLUB_EVENT_TITLES.test(t)) return t;
    // Avoid redundancy: if the org name is already somewhere in the title, skip.
    // Prevents "Rugby Club Practice" from becoming "Men's Rugby Club Rugby Club Practice".
    if (t.toLowerCase().includes(o.toLowerCase())) return t;
    return `${o} ${t}`;
}

// Extract a linescore (box score) from a Sidearm recap page's HTML.
// REMOVED 2026-05-09: Sidearm changed markup such that this returned 0/0 for
// every cron for an extended period. Status dashboard tile for box scores
// was removed first. Then we discovered the underlying recap-URL extraction
// was itself broken (regex mismatch with new Sidearm template); fixed that
// 2026-05-08, but the box score parser still didn't yield results because
// Sidearm's recap pages no longer ship StatCrew linescore tables in the
// HTML — they're rendered client-side now.
//
// Rather than rewrite a parser that has very low ROI (a recap link is
// already on the event card and clicking through is one tap), the whole
// feature was retired. The status dashboard tile that surfaced "X/Y box
// scores parsed" was removed earlier; this is the corresponding cleanup
// on the scraper side. The `periodScores` field still flows through the
// frontend rendering code (kept harmless when undefined) so legacy
// events.json files with cached values don't break — they just stop
// being refreshed.

function classifyAudience({ titleText, descText, orgName = '', rawTags = [], tags = [], benefits = [] }) {
    if (benefits.includes('Credit')) return 'mu-only';
    const combinedText = ((titleText || '') + ' ' + (descText || '') + ' ' + (orgName || '')).toLowerCase();

    // ===== Highest-priority public signals =====
    // Public org names ("Red Cross", "Habitat for Humanity") and explicit
    // public-facing event types (blood drive, 5K, food drive). Win over softer
    // mu-only signals like "host org is a fraternity" — a blood drive hosted
    // BY a frat is still genuinely a blood drive open to all.
    const publicOrgRegex = /\b(red cross|food pantry|habitat for humanity|goodwill|salvation army|special olympics|make[- ]?a[- ]?wish)\b/i;
    const publicNamedEventRegex = /\b(blood drive|food drive|clothing drive|toy drive|5k|10k|walkathon|run for|habitat for humanity|red cross|food pantry|soup kitchen)\b/i;
    if (publicNamedEventRegex.test(combinedText)) return 'public';
    if (publicOrgRegex.test(orgName)) return 'public';

    // Fundraising-tagged events. A frat bake sale or sorority charity event
    // is still a fundraiser open to the public — the tag is the signal.
    if (tags.includes('Fundraising')) return 'public';

    // Fundraiser/bake sale/festival keywords in title or description. Same
    // reasoning as the Fundraising tag — these are public-facing event types.
    const publicFundraisingKeywordRegex = /\b(fundraiser|bake sale|festival|fair|charity|donation|donate|benefit (for|concert))\b/i;
    if (publicFundraisingKeywordRegex.test(combinedText)) return 'public';

    // ===== Academic-internal signals =====
    // Run AFTER strong public markers (so "Department of Theatre Public
    // Recital" with explicit "public" still wins as public), but BEFORE the
    // soft public-keyword regex (so "End of Year Celebration" tagged
    // Community doesn't leak). Excludes "Office of Sustainability" since
    // it runs genuinely public events.
    const hasExplicitPublicMarker = /\b(public|open to (the )?(public|community|all)|community welcome|all (are )?welcome)\b/i.test(combinedText);
    const muOnlyAcademicRegex = /\b(college of |department of |school of |office of (?!sustainability)|honors college|honors program|year[- ]end|end of (the )?year|end of (the )?semester|faculty (mixer|concert|event)|senior (recognition|celebration|class)|graduating class|provost'?s|dean'?s (list|reception)|alumni (and student|student)|student[- ]faculty|capstone|thesis defense|comprehensive exam)\b/i;
    if (muOnlyAcademicRegex.test(combinedText) && !hasExplicitPublicMarker) return 'mu-only';

    // ===== Strong mu-only signals (club business) =====
    const muOnlyKeywordRegex = /\b(bible study|fellowship(?! hall)|chapter meeting|chapter business|weekly meeting|general body meeting|gbm|e-?board meeting|executive meeting|officer meeting|members only|tabling|orientation|info session|information session|club meeting|resume review|mock interview|study group|study session|homework help|office hours|interest meeting|rush|recruitment night|new member|initiation|brother hood|sister hood|sisterhood|brotherhood)\b/i;
    const muOnlyOrgRegex = /\b(fraternity|sorority|christian fellowship|campus ministry|cru |intervarsity|reformed university fellowship|ruf\b|gsa\b|gender and sexuality alliance|residence hall|housing community)\b/i;
    if (muOnlyKeywordRegex.test(combinedText)) return 'mu-only';
    if (muOnlyOrgRegex.test(orgName.toLowerCase() + ' ' + combinedText)) return 'mu-only';
    if (rawTags.some(t => /greek life|residence hall/i.test(t))) return 'mu-only';

    // ===== Generic public-language signals =====
    // Run after mu-only-org regex because "fraternity" host can override loose
    // public language; but blood/food drives, fundraising, and explicit public
    // markers already handled above.
    const publicKeywordRegex = /\b(open to (the )?(public|community|all)|community welcome|all (are )?welcome|public event|for the public|concert|performance|recital|exhibition|gallery|awareness (day|walk|event)|volunteer|service project|community service)\b/i;
    if (publicKeywordRegex.test(combinedText)) return 'public';
    if (tags.includes('Club Sports') && tags.includes('Home Game Mode')) return 'public';

    // ===== Loose category-only matches (last resort) =====
    const publicCategoryRegex = /\b(fundraising|service|community service|sporting|athletic|philanthropy|volunteer)\b/i;
    if (rawTags.some(t => publicCategoryRegex.test(t))) return 'public';
    return 'mu-only';
}

// Decode the HTML entities that actually appear in scraped titles/descriptions:
// straight + curly apostrophes and quotes, &, <, >, nbsp. Ampersand is decoded
// LAST so an already-escaped sequence like "&amp;lt;" stays "&lt;" instead of
// collapsing to "<". Idempotent on clean text (a second pass finds no entities).
function decodeEntities(str) {
    return String(str == null ? '' : str)
        .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
        .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
        .replace(/&quot;/g, '"')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#0?38;|&amp;/g, '&');
}

function extractEventbriteEvents(ldData, eventsArray, now, futureLimit, overrideUrl = null) {
    if (Array.isArray(ldData)) {
        ldData.forEach(item => extractEventbriteEvents(item, eventsArray, now, futureLimit, overrideUrl));
    } else if (ldData && typeof ldData === 'object') {
        if (ldData['@type'] === 'Event' && ldData.name && ldData.startDate) {
            const eventDate = new Date(ldData.startDate);
            if (eventDate >= now && eventDate < futureLimit) {
                // Prefer the override (we know exactly which event page we fetched);
                // fall back to the url embedded in the LD-JSON; last resort the organizer.
                const url = overrideUrl || ldData.url || "https://www.eventbrite.com/o/phantom-power-29187724817";
                // schema.org Event.image can be a string URL, an array of URLs,
                // or an ImageObject ({url:...}). Take the first usable form.
                let image = '';
                const rawImg = ldData.image;
                if (typeof rawImg === 'string') image = rawImg;
                else if (Array.isArray(rawImg) && rawImg.length) {
                    image = typeof rawImg[0] === 'string' ? rawImg[0] : (rawImg[0]?.url || '');
                } else if (rawImg && typeof rawImg === 'object') {
                    image = rawImg.url || '';
                }
                eventsArray.push({
                    title: decodeEntities(ldData.name), date: eventDate.toISOString(), location: "Phantom Power",
                    tags: ["Other", "Live Music"], price: "Ticket Required",
                    ticketLink: url,
                    sourceLink: url,
                    ...(image ? { image } : {})
                });
            }
        } else {
            for (let key in ldData) if (typeof ldData[key] === 'object') extractEventbriteEvents(ldData[key], eventsArray, now, futureLimit, overrideUrl);
        }
    }
}

// Parses a single Eventbrite event page HTML. Tries JSON-LD first (if Eventbrite
// ever restores it), then falls back to regex extraction against embedded JSON
// (Next.js __NEXT_DATA__, Apollo state, or any other serialized blob — all of
// which serialize the event shape with "startDate":"..." and "name":"..."). The
// visible <h1> is a very reliable title source because Eventbrite event pages
// have exactly one. Returns number of events added.
function extractPhantomPowerEventFromHTML(html, url, eventsArray, now, futureLimit) {
    const before = eventsArray.length;

    // --- Attempt 1: JSON-LD (primary, preserves old behavior) ---
    const ldMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
    if (ldMatches) {
        ldMatches.forEach(block => {
            try {
                const json = JSON.parse(block.replace(/<script type="application\/ld\+json">|<\/script>/gi, ''));
                extractEventbriteEvents(json, eventsArray, now, futureLimit, url);
            } catch (e) { /* skip malformed blocks silently — very common on real pages */ }
        });
        if (eventsArray.length > before) return eventsArray.length - before;
    }

    // --- Attempt 2: regex over any embedded JSON ---
    // "startDate" in an Eventbrite event page appears inside __NEXT_DATA__ or an
    // Apollo/Relay cache. The first occurrence is the event's own start date.
    const startMatch = html.match(/"startDate":"([^"]+)"/);
    if (!startMatch) return 0;

    const eventDate = new Date(startMatch[1]);
    if (isNaN(eventDate) || eventDate < now || eventDate >= futureLimit) return 0;

    // Title: prefer the <h1> (exactly one on event pages). Strip any nested
    // tags and HTML-decode the basic entities we're likely to encounter.
    let title = null;
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) {
        title = decodeEntities(h1Match[1].replace(/<[^>]+>/g, '')).trim();
    }
    // og:title is a reliable fallback if <h1> has odd nesting or is missing.
    if (!title) {
        const ogMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
        if (ogMatch) title = decodeEntities(ogMatch[1].replace(/\s*[|\-–]\s*Eventbrite\s*$/i, '')).trim();
    }
    if (!title) return 0;

    // og:image: most Eventbrite pages set this even when LD-JSON has been
    // stripped from the page. Cheap fallback for the HTML-regex path so we
    // get image coverage equivalent to the JSON-LD path above.
    let image = '';
    const ogImageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (ogImageMatch) image = ogImageMatch[1];

    eventsArray.push({
        title, date: eventDate.toISOString(), location: "Phantom Power",
        tags: ["Other", "Live Music"], price: "Ticket Required",
        ticketLink: url, sourceLink: url,
        ...(image ? { image } : {})
    });
    return 1;
}

// ===== MAIN SCRAPER =====

async function runScraper() {
    const PAST_DAYS = 90;
    const FUTURE_DAYS = 365;
    console.log(`🚀 Starting Millersville Scraper (${PAST_DAYS}d back + ${FUTURE_DAYS}d forward)...`);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // midnight today
    const pastDate = new Date(today);
    pastDate.setDate(today.getDate() - PAST_DAYS);
    const futureDate = new Date(today);
    futureDate.setDate(today.getDate() + FUTURE_DAYS);
    const startDay = pastDate.toISOString().split('T')[0];
    const endDay = futureDate.toISOString().split('T')[0];

    // ===== WEATHER (MU Station + Open-Meteo combined) =====
    try {
        // Source 1: MU Weather Information Center — hyper-local station data
        let muTemp = null, muHumidity = null, muWindDir = null, muWindSpeed = null, muUpdate = null;
        try {
            const muRes = await fetch('https://snowball.millersville.edu/~cws/current.xml', { headers: baseHeaders });
            if (muRes.ok) {
                const muXml = await muRes.text();
                const gx = (tag) => { const m = muXml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i')); return m ? m[1].trim() : null; };
                muTemp = gx('temp');
                muHumidity = gx('humidity');
                muWindDir = gx('wind_direction');
                muWindSpeed = gx('wind_speed');
                muUpdate = gx('update');
                console.log(`  ✅ MU Station: ${muTemp}°F, Wind ${muWindSpeed} mph ${muWindDir}, Humidity ${muHumidity}%`);
            }
        } catch (e) { console.log(`  ⚠️ MU Station unavailable: ${e.message}`); }

        // Source 2: Open-Meteo — condition text, icon, feels-like (free, no API key)
        let condition = 'Unknown', icon = '🌡️', feelsLike = null;
        try {
            const omUrl = 'https://api.open-meteo.com/v1/forecast?latitude=39.9982&longitude=-76.3541&current=weather_code,apparent_temperature,temperature_2m,wind_speed_10m,relative_humidity_2m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York';
            const omRes = await fetch(omUrl);
            if (omRes.ok) {
                const omData = await omRes.json();
                const c = omData.current;
                const wmoMap = {
                    0:{cond:'Clear sky',icon:'☀️'},1:{cond:'Mainly clear',icon:'🌤️'},2:{cond:'Partly cloudy',icon:'⛅'},3:{cond:'Overcast',icon:'☁️'},
                    45:{cond:'Fog',icon:'🌫️'},48:{cond:'Rime fog',icon:'🌫️'},
                    51:{cond:'Light drizzle',icon:'🌦️'},53:{cond:'Drizzle',icon:'🌦️'},55:{cond:'Dense drizzle',icon:'🌧️'},
                    61:{cond:'Slight rain',icon:'🌦️'},63:{cond:'Rain',icon:'🌧️'},65:{cond:'Heavy rain',icon:'🌧️'},
                    66:{cond:'Freezing rain',icon:'🌧️'},67:{cond:'Heavy freezing rain',icon:'🌧️'},
                    71:{cond:'Light snow',icon:'🌨️'},73:{cond:'Snow',icon:'❄️'},75:{cond:'Heavy snow',icon:'❄️'},77:{cond:'Snow grains',icon:'❄️'},
                    80:{cond:'Light showers',icon:'🌦️'},81:{cond:'Rain showers',icon:'🌧️'},82:{cond:'Heavy showers',icon:'⛈️'},
                    85:{cond:'Snow showers',icon:'🌨️'},86:{cond:'Heavy snow showers',icon:'❄️'},
                    95:{cond:'Thunderstorm',icon:'⛈️'},96:{cond:'Thunderstorm w/ hail',icon:'⛈️'},99:{cond:'Severe thunderstorm',icon:'⛈️'}
                };
                const wmo = wmoMap[c.weather_code] || {cond:'Unknown',icon:'🌡️'};
                condition = wmo.cond;
                icon = wmo.icon;
                feelsLike = Math.round(c.apparent_temperature);
                // Use Open-Meteo as fallback if MU station is down
                if (muTemp === null) {
                    muTemp = Math.round(c.temperature_2m);
                    muHumidity = Math.round(c.relative_humidity_2m);
                    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
                    muWindDir = dirs[Math.round(c.wind_direction_10m / 22.5) % 16];
                    muWindSpeed = Math.round(c.wind_speed_10m);
                    console.log(`  ⚠️ Using Open-Meteo as fallback for readings`);
                }
                console.log(`  ✅ Open-Meteo: ${condition} ${icon}, Feels like ${feelsLike}°F`);
            }
        } catch (e) { console.log(`  ⚠️ Open-Meteo unavailable: ${e.message}`); }

        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify({
            temp: muTemp ? parseInt(muTemp) : '--',
            feelsLike: feelsLike || (muTemp ? parseInt(muTemp) : '--'),
            condition,
            icon,
            wind: muWindSpeed ? `${muWindSpeed} mph ${muWindDir || ''}`.trim() : 'Calm',
            humidity: muHumidity ? muHumidity + '%' : '--',
            stationUpdate: muUpdate || '',
            lastUpdated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }),
            source: muTemp ? 'MU Weather Station + Open-Meteo' : 'Open-Meteo'
        }, null, 2));
        console.log(`✅ Weather saved: ${muTemp || '--'}°F, ${condition}`);
    } catch (e) { console.error("❌ Weather error:", e.message); }
    // ===== MU WEATHER CENTER (forecast, 7-day, observations, discussion, images, videos) =====
    // Scrapes the Millersville University Weather Information Center — plain
    // server-rendered HTML with stable table IDs — and writes weather-mu.json
    // for the weather page to render. Radar/surface-analysis are stable public
    // image URLs (embedded directly, no scrape). Discussion is EXCERPTED with a
    // link back (it's the meteorologist's authored prose — we don't republish it
    // wholesale). All failures are non-fatal so weather-mu.json degrades section
    // by section rather than blocking the cron.
    try {
        const WX_BASE = 'https://www.millersville.edu/weathercenter';
        const wxClean = (s) => (s || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&#160;|&nbsp;/g, ' ')
            .replace(/&#176;|&deg;/g, '\u00B0')
            .replace(/&rsquo;|&#8217;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ').trim();
        const wxRows = (html, id) => {
            const tbl = html.match(new RegExp(`<table[^>]*id="${id}"[^>]*>([\\s\\S]*?)</table>`, 'i'));
            if (!tbl) return [];
            const bm = tbl[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
            const body = bm ? bm[1] : tbl[1];
            const rows = []; let tr; const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
            while ((tr = trRe.exec(body)) !== null) {
                const cells = []; let td; const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
                while ((td = tdRe.exec(tr[1])) !== null) cells.push(wxClean(td[1]));
                if (cells.length) rows.push(cells);
            }
            return rows;
        };
        const wxIssued = (html) => { const m = html.match(/Issued:\s*([^<]+?)\s*(?:<|$)/i); return m ? wxClean(m[1]) : ''; };

        const muWx = {
            forecast: { synopsis: '', issued: '', periods: [] },
            sevenDay: { issued: '', days: [] },
            observations: [],
            discussion: { headline: '', dateLine: '', excerpt: '', url: `${WX_BASE}/forecasts/weather-discussion.php` },
            images: {
                radar: 'https://sirocco.accuweather.com/nx_mosaic_640x480c/RE/inmaREPA_.gif',
                surfaceAnalysis: 'https://www.wpc.ncep.noaa.gov/sfc/radsfcus_exp_new.gif'
            },
            videos: [],
            sourceUrl: `${WX_BASE}/`,
            updated: new Date().toISOString()
        };

        // --- Forecast (synopsis + 2-col table) from the main center page ---
        try {
            const r = await fetch(`${WX_BASE}/`, { headers: baseHeaders });
            if (r.ok) {
                const html = await r.text();
                muWx.forecast.periods = wxRows(html, 'forecast-table')
                    .map(c => ({ period: c[0], text: c[1] })).filter(x => x.period && x.text);
                muWx.forecast.issued = wxIssued(html);
                const before = html.split(/id="forecast-table"/i)[0];
                const ps = [...before.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
                if (ps.length) muWx.forecast.synopsis = wxClean(ps[ps.length - 1][1]);
                console.log(`  ✅ MU forecast: ${muWx.forecast.periods.length} periods`);
            }
        } catch (e) { console.log(`  ⚠️ MU forecast unavailable: ${e.message}`); }

        // --- 7-day outlook ---
        try {
            const r = await fetch(`${WX_BASE}/forecasts/7-day-forecast.php`, { headers: baseHeaders });
            if (r.ok) {
                const html = await r.text();
                const cols = ['period', 'sky', 'weather', 'pop', 'temp', 'conf'];
                muWx.sevenDay.days = wxRows(html, 'sevenday-table').filter(c => c.length >= 6)
                    .map(c => Object.fromEntries(cols.map((k, i) => [k, c[i]])));
                muWx.sevenDay.issued = wxIssued(html);
                console.log(`  ✅ MU 7-day: ${muWx.sevenDay.days.length} rows`);
            }
        } catch (e) { console.log(`  ⚠️ MU 7-day unavailable: ${e.message}`); }

        // --- Observations (past 6 hours) ---
        try {
            const r = await fetch(`${WX_BASE}/observations.php`, { headers: baseHeaders });
            if (r.ok) {
                const html = await r.text();
                const cols = ['time', 'temp', 'dewpoint', 'rh', 'windDir', 'windSpeed', 'precip', 'visibility', 'condition'];
                muWx.observations = wxRows(html, 'obs-table').filter(c => c.length >= 9)
                    .map(c => Object.fromEntries(cols.map((k, i) => [k, c[i]])));
                console.log(`  ✅ MU observations: ${muWx.observations.length} rows`);
            }
        } catch (e) { console.log(`  ⚠️ MU observations unavailable: ${e.message}`); }

        // --- Weather discussion (EXCERPT + link, tweets/scripts stripped) ---
        try {
            const r = await fetch(`${WX_BASE}/forecasts/weather-discussion.php`, { headers: baseHeaders });
            if (r.ok) {
                const html = await r.text();
                let block = (html.match(/<div class="user-markup">([\s\S]*?)<\/div>\s*(?:<\/div>|$)/i) || [null, html])[1]
                    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
                    .replace(/<script[\s\S]*?<\/script>/gi, '');
                const h3 = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
                muWx.discussion.headline = h3 ? wxClean(h3[1]).replace(/^\*\s*a?\s*/i, '').replace(/\s*\*$/, '').trim() : '';
                const paras = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => wxClean(m[1])).filter(Boolean);
                let start = 0;
                if (paras.length && paras[0].length < 60 && /(a\.m\.|p\.m\.|\d{4})/i.test(paras[0])) {
                    muWx.discussion.dateLine = paras[0].replace(/:\s*$/, ''); start = 1;
                }
                const MAX = 480; let ex = '';
                for (let i = start; i < paras.length; i++) {
                    if (ex && ex.length + paras[i].length > MAX) break;
                    ex += (ex ? ' ' : '') + paras[i];
                    if (ex.length >= MAX) break;
                }
                if (ex.length > MAX) {
                    const cut = ex.slice(0, MAX);
                    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
                    ex = (stop > MAX * 0.5 ? cut.slice(0, stop + 1) : cut.trim()) + ' \u2026';
                } else if (start < paras.length) { ex += ' \u2026'; }
                muWx.discussion.excerpt = ex;
                console.log(`  ✅ MU discussion: "${muWx.discussion.headline.slice(0, 40)}..."`);
            }
        } catch (e) { console.log(`  ⚠️ MU discussion unavailable: ${e.message}`); }

        // --- Latest videos via the channel's RSS feed (resolve channelId from the handle) ---
        try {
            const ch = await fetch('https://www.youtube.com/@MUweather', { headers: baseHeaders });
            if (ch.ok) {
                const chHtml = await ch.text();
                const idM = chHtml.match(/"(?:channelId|externalId)":"(UC[\w-]+)"/)
                    || chHtml.match(/\/channel\/(UC[\w-]+)/);
                if (idM) {
                    const rss = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${idM[1]}`, { headers: baseHeaders });
                    if (rss.ok) {
                        const xml = await rss.text();
                        const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 4);
                        muWx.videos = entries.map(e => {
                            const g = (re) => { const m = e[1].match(re); return m ? m[1] : ''; };
                            const vid = g(/<yt:videoId>([^<]+)<\/yt:videoId>/);
                            return {
                                title: wxClean(g(/<title>([^<]+)<\/title>/)),
                                videoId: vid,
                                url: vid ? `https://www.youtube.com/watch?v=${vid}` : '',
                                published: g(/<published>([^<]+)<\/published>/),
                                thumbnail: g(/<media:thumbnail[^>]*url="([^"]+)"/)
                            };
                        }).filter(v => v.videoId);
                        console.log(`  ✅ MU videos: ${muWx.videos.length}`);
                    }
                }
            }
        } catch (e) { console.log(`  ⚠️ MU videos unavailable: ${e.message}`); }

        fs.writeFileSync(path.join(__dirname, '../weather-mu.json'), JSON.stringify(muWx, null, 2));
        console.log(`✅ MU Weather Center saved (forecast ${muWx.forecast.periods.length}, 7-day ${muWx.sevenDay.days.length}, obs ${muWx.observations.length}, videos ${muWx.videos.length})`);
    } catch (e) { console.error('❌ MU Weather Center error:', e.message); }


    let events = [];

    // Cache of recap URLs keyed by "{scheduleSlug}|{YYYY-M-D}". Populated once per scrape
    // by fetching each sport's schedule page HTML and extracting Recap links for past games.
    // Sidearm doesn't expose this in the iCal (their ev.url is a useless composite link),
    // so we parse the schedule HTML directly. A single doubleheader usually shares one recap.
    const muRecapCache = new Map();
    // Fetch and parse one sport's schedule page. Extracts recap URLs keyed by date.
    async function fetchSportRecapMap(scheduleSlug, seasonYear) {
        // seasonYear optional — omit for current season (Sidearm's default view)
        const url = seasonYear
            ? `https://millersvilleathletics.com/sports/${scheduleSlug}/schedule/${seasonYear}`
            : `https://millersvilleathletics.com/sports/${scheduleSlug}/schedule`;
        // 10s timeout so a hung Sidearm host can't block the whole scrape. Stalls here used
        // to silently freeze the GitHub Action until the job's default timeout killed it.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        try {
            const res = await fetch(url, { headers: baseHeaders, signal: ctrl.signal });
            if (!res.ok) return;
            const html = await res.text();
            // Match every anchor whose href is a Sidearm news article URL, then post-filter
            // to keep only the ones whose visible text is the schedule's "Recap" button.
            //
            // Regex changes vs. the previous version:
            //   - href accepts both relative (/news/...) and absolute (https://...millersvilleathletics.com/news/...).
            //     Sidearm switched to absolute URLs at some point and the old regex silently
            //     started returning 0 matches across all 21 sports — a finished game's "Recap"
            //     button on our site fell back to the team's schedule page link.
            //   - inner content uses `[\s\S]*?` instead of `[^>]*` so "Recap" text wrapped in
            //     a child element (e.g. <span>Recap</span>) still gets recognized.
            //
            // Post-filter on innerText is what distinguishes the schedule's small "Recap"
            // button (innerText is literally "Recap", maybe with a trailing arrow) from
            // news cards elsewhere on the page that happen to contain "Recap" in a headline
            // ("Baseball Recap: Marauders dispatch Vulcans"). The 30-char ceiling is generous
            // for the button case and excludes any headline.
            const recapAnchorRegex = /<a\s[^>]*href="(?:https?:\/\/[^"\/]*millersvilleathletics\.com)?(\/news\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/[^"]+?)"[^>]*>([\s\S]*?)<\/a>/gi;
            let match;
            while ((match = recapAnchorRegex.exec(html)) !== null) {
                const [, relHref, yr, mo, dy, innerHtml] = match;
                // Strip tags, collapse whitespace
                const innerText = innerHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (!/\bRecap\b/i.test(innerText)) continue;
                if (innerText.length > 30) continue;  // exclude headlines that contain "Recap"
                const key = `${scheduleSlug}|${parseInt(yr,10)}-${parseInt(mo,10)}-${parseInt(dy,10)}`;
                const fullUrl = 'https://millersvilleathletics.com' + relHref;
                // First one wins if multiple games share a date (doubleheaders share the recap)
                if (!muRecapCache.has(key)) muRecapCache.set(key, fullUrl);
            }
        } catch (err) {
            const reason = err.name === 'AbortError' ? 'timeout after 10s' : err.message;
            console.log(`  ⚠️ Sidearm schedule fetch failed for ${scheduleSlug}: ${reason}`);
        } finally {
            clearTimeout(timer);
        }
    }
    // Pre-fetch all sport schedule pages in parallel so the MU iCal loop below can look up
    // recap URLs synchronously. Covers current season only; past-season games (rare in our
    // 60-day past horizon) still fall back to the schedule-page source link.
    {
        console.log("📡 Pre-fetching MU sport schedule pages for recap URLs...");
        const allSlugs = ['baseball', 'softball', 'football', 'wrestling', 'volleyball',
            'field-hockey', 'swimming', 'womens-basketball', 'mens-basketball',
            'womens-soccer', 'mens-soccer', 'womens-lacrosse', 'womens-tennis',
            'mens-tennis', 'womens-golf', 'mens-golf', 'womens-cross-country',
            'mens-cross-country', 'womens-outdoor-track-and-field',
            'womens-indoor-track-and-field', 'mens-track-and-field'];
        // Parallelize but cap concurrency at a reasonable number to avoid hammering the host
        const chunks = [];
        for (let i = 0; i < allSlugs.length; i += 4) chunks.push(allSlugs.slice(i, i + 4));
        for (const chunk of chunks) {
            await Promise.all(chunk.map(slug => fetchSportRecapMap(slug)));
        }
        console.log(`  ✅ Loaded ${muRecapCache.size} recap URLs across ${allSlugs.length} sports`);
    }

    // ===== 1. MU ATHLETICS (SIDEARM iCAL) =====
    try {
        console.log("📡 Fetching MU Athletics (Sidearm iCal)...");
        const muAthData = await ical.async.fromURL(
            'https://millersvilleathletics.com/api/v2/Calendar/subscribe?type=ics&downloadFile=false',
            { headers: baseHeaders }
        );
        let muAthCount = 0;

        for (const ev of Object.values(muAthData)) {
            if (ev.type !== 'VEVENT') continue;
            const eventDate = new Date(ev.start);
            if (isNaN(eventDate.getTime()) || eventDate < pastDate || eventDate >= futureDate) continue;

            const summary = ev.summary || '';
            const desc = ev.description || '';
            const loc = ev.location || '';

            // Skip past-game results (have [W], [L], [N] prefix)
            // We still include them — they have scores which could be useful
            // But for upcoming games, no prefix exists

            // Determine sport from summary: "Millersville University {Sport} vs/at {Opponent}"
            const sportMatch = summary.match(/Millersville University\s+([\w''&\s]+?)\s+(?:vs|at)\s/i);
            let sportName = sportMatch ? sportMatch[1].trim() : '';
            // Clean prefix like [W], [L], [N]
            let cleanTitle = summary.replace(/^\[.\]\s*/, '').trim();

            // Determine home/away: "vs" = home, "at" = away
            const isHome = /\bvs\b/i.test(summary) || loc.toLowerCase().includes('millersville');

            // Extract ticket link from description
            let ticketLink = '';
            const ticketMatch = desc.match(/Tickets:\s*(https?:\/\/[^\s\\]+)/i);
            if (ticketMatch) ticketLink = ticketMatch[1].replace(/&amp;/g, '&');

            // Extract streaming link
            let streamLink = '';
            const streamMatch = desc.match(/Streaming Video:\s*(https?:\/\/[^\s\\]+)/i);
            if (streamMatch) streamLink = streamMatch[1].replace(/&amp;/g, '&');

            // Build tags
            let tags = ["MU", "Athletic Competitions", "Athletics"];
            if (isHome) tags.push("Home Game Mode");

            // Detect gender
            if (/women's|women's/i.test(sportName)) tags.push("Women's");
            else if (/men's|men's/i.test(sportName)) tags.push("Men's");

            // Map sport name to our standard sport list
            sportsList.forEach(s => {
                if (sportName.toLowerCase().includes(s.toLowerCase())) tags.push(s);
            });
            // Handle "Indoor Track" / "Outdoor Track" → Track
            if (/track/i.test(sportName) && !tags.includes('Track')) tags.push('Track');
            // Handle Golf
            if (/golf/i.test(sportName) && !tags.includes('Golf')) tags.push('Golf');

            // Extract game result and score from summary prefix and description
            // Past games: "[W] Title" with "W 16-7" or "L 4-6" in description
            // Upcoming: no prefix
            let gameResult = '';  // 'W', 'L', 'N', or '' for upcoming
            let gameScore = '';
            const resultPrefix = summary.match(/^\[([WLN])\]/);
            if (resultPrefix) {
                gameResult = resultPrefix[1];
                const scoreMatch = desc.match(/^[WLN]\s+(\d+-\d+)/m);
                if (scoreMatch) gameScore = scoreMatch[1];
            }

            // Check if game is live (happening right now)
            const eventEnd = ev.end ? new Date(ev.end) : new Date(eventDate.getTime() + 3*60*60*1000);
            const isLive = now >= eventDate && now <= eventEnd && !gameResult && !!streamLink;

            // Defensive stream URL filter: Sidearm's iCal publishes a generic
            // PSAC-network landing URL for upcoming/past games (e.g.
            // psacsportsdigitalnetwork.com/millersvilleathletics/) which drops
            // the user on the school index with no way to reach the specific
            // broadcast. Game-specific URLs embed a numeric broadcast/event ID
            // either in the path (.../broadcast/3846663) or in a query param
            // (?B=3846663, ?broadcast=...). For anything that isn't currently
            // live we strip generic URLs so the frontend doesn't render a
            // misleading Watch button. Live games keep the URL regardless —
            // during game time the school landing page auto-features the
            // active broadcast, so even a "generic" URL resolves usefully.
            if (streamLink && !isLive) {
                const hasIdInQuery = /[?&][a-z_]+=\d{4,}/i.test(streamLink);
                const hasIdInPath  = /\/\d{4,}(\?|\/|$)/.test(streamLink);
                if (!hasIdInQuery && !hasIdInPath) streamLink = '';
            }

            // Build source URL: prefer the event's own URL (links to specific game on schedule),
            // fall back to sport schedule page, then composite calendar
            const scheduleSlugMap = {
                'baseball': 'baseball', 'softball': 'softball', 'football': 'football',
                'wrestling': 'wrestling', 'volleyball': 'womens-volleyball',
                'field hockey': 'field-hockey', 'swimming': 'womens-swimming',
                "women's basketball": 'womens-basketball', "men's basketball": 'mens-basketball',
                "women's soccer": 'womens-soccer', "men's soccer": 'mens-soccer',
                "women's lacrosse": 'womens-lacrosse',
                "women's tennis": 'womens-tennis', "men's tennis": 'mens-tennis',
                "women's golf": 'womens-golf', "men's golf": 'mens-golf',
                "women's cross country": 'womens-cross-country', "men's cross country": 'mens-cross-country',
                "women's indoor track & field": 'womens-indoor-track-and-field',
                "women's outdoor track & field": 'womens-outdoor-track-and-field',
                "men's track and field": 'mens-track-and-field',
                "women's track and field": 'womens-track-and-field'
            };
            const sportLower = sportName.toLowerCase();
            let scheduleSlug = scheduleSlugMap[sportLower];
            if (!scheduleSlug) {
                for (const [key, slug] of Object.entries(scheduleSlugMap)) {
                    if (sportLower.includes(key) || key.includes(sportLower)) { scheduleSlug = slug; break; }
                }
            }
            // Source URL strategy:
            //   - Past games with a recap: use the recap article URL from muRecapCache. Links
            //     users to the game story, which is what they actually want.
            //   - Past games without a recap: use the sport's schedule page for the year.
            //   - Upcoming games: use the sport's top page (`/sports/{slug}`) which shows
            //     Upcoming Events first. Much better than `/schedule` which shows the whole
            //     season chronologically with next games buried at the bottom.
            //   - No sport slug match: fall back to composite calendar.
            let sourceUrl;
            if (scheduleSlug) {
                if (gameResult) {
                    // Past game: try recap cache first
                    const gameYear = eventDate.getFullYear();
                    const gameMonth = eventDate.getMonth() + 1;
                    const gameDay = eventDate.getDate();
                    const recapKey = `${scheduleSlug}|${gameYear}-${gameMonth}-${gameDay}`;
                    const recapUrl = muRecapCache.get(recapKey);
                    if (recapUrl) {
                        sourceUrl = recapUrl;
                    } else {
                        // Fall back to season-specific schedule page
                        const currentYear = now.getFullYear();
                        sourceUrl = gameYear === currentYear
                            ? `https://millersvilleathletics.com/sports/${scheduleSlug}/schedule`
                            : `https://millersvilleathletics.com/sports/${scheduleSlug}/schedule/${gameYear}`;
                    }
                } else {
                    // Upcoming game: top page shows upcoming first
                    sourceUrl = `https://millersvilleathletics.com/sports/${scheduleSlug}`;
                }
            } else {
                sourceUrl = 'https://millersvilleathletics.com/calendar';
            }

            events.push({
                title: cleanTitle,
                date: eventDate.toISOString(),
                endTime: resolveEndTime({ origStart: ev.start, origEnd: ev.end, instanceStart: eventDate }),
                location: loc || "TBD",
                tags: [...new Set(tags)],
                price: ticketLink ? "Ticket Required" : "Free",
                ticketLink: ticketLink,
                sourceLink: sourceUrl,
                gameResult,
                gameScore,
                streamLink,
                isLive
            });
            muAthCount++;
        }
        console.log(`✅ MU Athletics: ${muAthCount} events`);
    } catch (e) { console.error("❌ MU Athletics error:", e.message); }

    // ===== 2. PENN MANOR iCAL (PAGINATED — fetch past + future events) =====
    try {
        console.log("📡 Fetching Penn Manor iCal (paginated until " + endDay + ")...");
        let allPMEvents = {};

        // Fetch UPCOMING events (paginated forward)
        const pmFutureUrl = 'https://www.pennmanor.net/events/list/?ical=1&tribe_event_display=list&tribe_paged=';
        let page = 1;
        const maxPages = 20;
        let latestEventDate = null;

        while (page <= maxPages) {
            try {
                const url = pmFutureUrl + page;
                console.log(`  Fetching page ${page}...`);
                const pageData = await ical.async.fromURL(url, { headers: baseHeaders });
                const pageEvents = Object.values(pageData).filter(e => e.type === 'VEVENT');
                console.log(`  → Page ${page}: ${pageEvents.length} VEVENTs`);

                if (pageEvents.length === 0) {
                    console.log(`  → Empty page, stopping.`);
                    break;
                }

                // Merge into allPMEvents, count truly new ones
                let newCount = 0;
                for (const [key, val] of Object.entries(pageData)) {
                    if (val.type === 'VEVENT') {
                        const uid = val.uid || key;
                        if (!allPMEvents[uid]) newCount++;
                        allPMEvents[uid] = val;
                    }
                }

                // Find latest event date on this page
                let pageLatest = null;
                pageEvents.forEach(ev => {
                    const d = new Date(ev.start);
                    if (!isNaN(d.getTime()) && (!pageLatest || d > pageLatest)) pageLatest = d;
                });
                if (pageLatest) {
                    latestEventDate = pageLatest;
                    console.log(`  → Latest: ${pageLatest.toISOString().split('T')[0]} | New unique: ${newCount}`);
                }

                // Stop if we've reached the end of our date range
                if (latestEventDate && latestEventDate >= futureDate) {
                    console.log(`  → Covered full range through ${endDay}, stopping.`);
                    break;
                }
                // Stop if partial page (no more data)
                if (pageEvents.length < 30) {
                    console.log(`  → Partial page (${pageEvents.length} < 30), likely last page.`);
                    break;
                }
                // Stop if no new unique events (all dupes)
                if (newCount === 0) {
                    console.log(`  → No new unique events, stopping.`);
                    break;
                }

                page++;
            } catch (err) {
                console.log(`  → Page ${page} failed: ${err.message}`);
                break;
            }
        }

        const totalFutureRaw = Object.keys(allPMEvents).length;
        const coverageEnd = latestEventDate ? latestEventDate.toISOString().split('T')[0] : 'unknown';
        console.log(`  Future: ${totalFutureRaw} unique across ${page} page(s), coverage through ${coverageEnd}`);

        // Fetch PAST events (paginated backward until we cover PAST_DAYS or run out)
        const pmPastUrl = 'https://www.pennmanor.net/events/list/?ical=1&tribe_event_display=past&tribe_paged=';
        const maxPastPages = 20;
        for (let pp = 1; pp <= maxPastPages; pp++) {
            try {
                const pastPageData = await ical.async.fromURL(pmPastUrl + pp, { headers: baseHeaders });
                const pastPageEvents = Object.values(pastPageData).filter(e => e.type === 'VEVENT');
                if (pastPageEvents.length === 0) break;
                let newPast = 0;
                let oldestDate = null;
                for (const [key, val] of Object.entries(pastPageData)) {
                    if (val.type === 'VEVENT') {
                        const uid = val.uid || key;
                        if (!allPMEvents[uid]) newPast++;
                        allPMEvents[uid] = val;
                        const d = new Date(val.start);
                        if (!oldestDate || d < oldestDate) oldestDate = d;
                    }
                }
                console.log(`  Past page ${pp}: ${pastPageEvents.length} VEVENTs, ${newPast} new`);
                if (newPast === 0) break;
                // Stop if we've reached far enough back
                if (oldestDate && oldestDate < pastDate) { console.log(`  Past coverage reached ${oldestDate.toISOString().split('T')[0]}`); break; }
            } catch (err) { console.log(`  Past page ${pp} failed: ${err.message}`); break; }
        }

        const totalPMRaw = Object.keys(allPMEvents).length;
        console.log(`  Total unique (past+future): ${totalPMRaw}`);

        if (totalPMRaw === 0) throw new Error('Penn Manor returned no events');

        const pmData = allPMEvents;

        // Debug: check raw PM lacrosse events before any processing
        const rawLax = Object.values(pmData).filter(e => /lacrosse/i.test(e.summary || ''));
        const rawGirlsLax = rawLax.filter(e => /girl/i.test(e.summary || ''));
        console.log(`    🔍 Raw iCal lacrosse: ${rawLax.length} total, ${rawGirlsLax.length} girls`);
        rawGirlsLax.filter(e => new Date(e.start) >= now).forEach(e => console.log(`      → ${e.summary} (${new Date(e.start).toISOString().split('T')[0]})`));

        let pmAthCount = 0, pmGenCount = 0;

        // Hand-curated YouTube replay links for PM events streamed live and posted
        // afterward. We can't catch the stream beforehand, so these are added after the
        // fact and render as a "Replay" button once the event is past. Keyed by a title
        // regex + the event's ET date (YYYY-MM-DD) so a recurring title — e.g. next
        // year's Commencement — can't inherit the wrong video. To add one: title pattern,
        // Eastern date, URL.  ⚠️ VERIFY the two URLs below are paired to the right event.
        const PM_REPLAY_LINKS = [
            { match: /commencement/i,  date: '2026-06-03', url: 'https://www.youtube.com/watch?v=Vlpy3RsmlW4' },
            { match: /senior awards/i, date: '2026-05-21', url: 'https://www.youtube.com/watch?v=R7PBpOK-ws8' },
        ];

        for (const ev of Object.values(pmData)) {
            const eventDate = new Date(ev.start);
            if (isNaN(eventDate.getTime()) || eventDate < pastDate || eventDate >= futureDate) continue;

            // Strip a redundant trailing "@6:30pm" style time from the title —
            // the event row already shows the start time in its own column. Only
            // matches @ followed by a time, so away-game "@ <School>" titles are safe.
            const title = (ev.summary || 'Penn Manor Event')
                .replace(/\s*@\s*\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\s*$/i, '')
                .trim();
            const lowerTitle = title.toLowerCase();
            const desc = ev.description || '';
            const loc = ev.location || 'Penn Manor School District';
            const categories = ev.categories ? (Array.isArray(ev.categories) ? ev.categories.join(',') : String(ev.categories)) : '';

            // Skip noise
            if (/cycle day|^start of|^end of/i.test(lowerTitle)) continue;

            // Skip No School/Closings events entirely — not scraped
            if (/no school|snow day|spring break|weather make|school now in session|vacation|closing|closed/i.test(lowerTitle)) continue;

            // Skip internal school events not relevant to community
            if (/\bsap meeting\b|\bfaculty meeting\b|\bstaff meeting\b|\bin-service\b|\bprofessional development\b|\bteam leader meeting\b/i.test(lowerTitle)) continue;
            if (/\bfield trip\b|\btrip to\b|\bgirls on the run\b|\bgotr\b|\bgotc\b|\bbus evacuation\b/i.test(lowerTitle)) continue;
            if (/\bprogress report|report card|early dismissal|late start|delayed opening/i.test(lowerTitle)) continue;
            if (/\bpicture day\b|\bretake\b|\bphoto day\b|\bpicture retake\b|\bspring pictures\b/i.test(lowerTitle)) continue;
            if (/\brehearsal\b|\bappreciation (day|week)\b|\blibrarian day\b|\ball school assembly\b|\bpride assembly\b/i.test(lowerTitle)) continue;

            const isAthletic = categories.toLowerCase().includes('athletics') || desc.toLowerCase().includes('sport:');

            if (isAthletic) {
                // Athletics now come from the dedicated athletics-category feed
                // (section 2a, just below) - comprehensive (swimming, bowling,
                // cross country, ...) and pre-filtered. Skip them here so the
                // general PM feed emits only non-athletic events (no duplicates).
                continue;
            } else {
                // Non-athletic PM event — categorize by title keywords
                let tags = ["PM"];
                const lt = lowerTitle;

                if (/board/i.test(lt)) tags.push('Board/PTO');
                else if (/pto/i.test(lt)) tags.push('Board/PTO');
                else if (/staff|in-service|act 80|faculty/i.test(lt)) continue; // Skip Staff events
                else if (/concert|band|chorus|choir|orchestra|musical|theater|play|string ensemble|showcase/i.test(lt)) tags.push('Music/Arts');
                else if (/pssa|grades?\s+(due|posted|are)|report card|marking period/i.test(lt)) continue; // Skip Testing/Grades events
                else if (/spirit day|dress down|reward day|talent show|pm cares/i.test(lt)) continue; // Skip Spirit/Fun Days
                else if (/field trip|downtown trip|trip to/i.test(lt)) tags.push('Field Trips');
                else if (/gotr|girls on the run|heart & sole|physicals|health/i.test(lt)) tags.push('Health/Wellness');
                else if (/book fair|food fair|picture|assembly|appreciation|librarian/i.test(lt)) tags.push('School Events');
                // End-of-year ceremonies & recognition events families attend (commencement,
                // graduation, senior awards/walk, moving-up, honors night). Without this branch
                // they match no keyword, fall to 'Other' below, and get skipped.
                else if (/commencement|graduation|baccalaureate|senior (awards?|walk|breakfast)|awards? (ceremony|night)|moving[- ]?up|promotion ceremony|class night|honors? (night|ceremony)/i.test(lt)) tags.push('School Events');
                else if (/sap meeting|team leader|lunch\s*&?\s*learn|house meeting/i.test(lt)) tags.push('Meetings');
                else tags.push('Other');

                // Skip PM-Other events (uncategorized, not useful)
                if (tags.includes('Other')) continue;

                // Stream link: a specific hand-curated replay wins; otherwise board
                // meetings get the channel's streams page (live + archived board videos).
                // ET-or-UTC date check tolerates how all-day events land across timezones.
                const pmDayET = deriveDayET(eventDate.getTime());
                const pmDayUTC = eventDate.toISOString().slice(0, 10);
                const pmReplay = PM_REPLAY_LINKS.find(r => r.match.test(lt) && (r.date === pmDayET || r.date === pmDayUTC));
                const pmBoardStream = pmReplay ? pmReplay.url
                    : (/board/i.test(lt) ? 'https://www.youtube.com/@PennManorSchoolDistrict/streams' : '');

                events.push({
                    title, date: eventDate.toISOString(),
                    endTime: resolveEndTime({ origStart: ev.start, origEnd: ev.end, instanceStart: eventDate }),
                    location: loc,
                    tags: [...new Set(tags)], price: "Free", ticketLink: "",
                    sourceLink: ev.url || "https://www.pennmanor.net/calendar/",
                    streamLink: pmBoardStream
                });
                pmGenCount++;
            }
        }
        console.log(`✅ Penn Manor (general): ${pmGenCount} non-athletic events (athletics now come from the athletics-category feed below)`);
    } catch (e) { console.error("❌ Penn Manor error:", e.message); }

    // ===== 2a. PENN MANOR ATHLETICS (dedicated athletics-category iCal) =====
    // Penn Manor athletic SCHEDULES now come straight from the district's
    // "Athletics" category feed (same Tribe/WordPress platform as the general PM
    // calendar in section 2, just pre-filtered to athletics). The old approach of
    // detecting athletics inside the all-categories feed silently dropped sports
    // the AD scheduled but the site didn't surface in its default list (confirmed
    // missing: swimming, bowling). This feed is comprehensive: Cross Country,
    // Swimming, Bowling, Wrestling, Basketball, etc. Varsity + JV ONLY
    // (7th/8th/9th/freshman/jr-high dropped). Each game is emitted with the SAME
    // object shape + tags as the old PM athletic events, so the MaxPreps/Hudl score
    // matchers and the Hudl broadcast check (section 2b, which runs immediately
    // after this) attach scores + stream links with no changes. Runs before 2b on
    // purpose. URL: path form (/events/category/athletics/list/) and the
    // ?tribe_events_cat=athletics query form were both verified to return the same
    // feed; path form chosen to mirror the section-2 general feed. Past + future
    // reuse the same pastDate/futureDate window as everything else, paginated like
    // section 2.
    try {
        console.log("📡 Fetching Penn Manor Athletics (athletics-category iCal)...");
        const allPMAth = {};
        const pmAthFutureUrl = 'https://www.pennmanor.net/events/category/athletics/list/?ical=1&tribe_event_display=list&tribe_paged=';
        const pmAthPastUrl   = 'https://www.pennmanor.net/events/category/athletics/list/?ical=1&tribe_event_display=past&tribe_paged=';

        // Forward (upcoming) pages — stop logic mirrors section 2
        let aLatest = null;
        for (let aPage = 1; aPage <= 20; aPage++) {
            try {
                const pageData = await ical.async.fromURL(pmAthFutureUrl + aPage, { headers: baseHeaders });
                const pageEvents = Object.values(pageData).filter(e => e.type === 'VEVENT');
                if (pageEvents.length === 0) break;
                let newCount = 0;
                for (const [key, val] of Object.entries(pageData)) {
                    if (val.type === 'VEVENT') { const uid = val.uid || key; if (!allPMAth[uid]) newCount++; allPMAth[uid] = val; }
                }
                let pageLatest = null;
                pageEvents.forEach(ev => { const d = new Date(ev.start); if (!isNaN(d.getTime()) && (!pageLatest || d > pageLatest)) pageLatest = d; });
                if (pageLatest) aLatest = pageLatest;
                if (aLatest && aLatest >= futureDate) break;
                if (pageEvents.length < 30) break;
                if (newCount === 0) break;
            } catch (err) { console.log(`  → Athletics page failed: ${err.message}`); break; }
        }
        // Past pages — mirrors section 2's backward pagination
        for (let pp = 1; pp <= 20; pp++) {
            try {
                const pastData = await ical.async.fromURL(pmAthPastUrl + pp, { headers: baseHeaders });
                const pastEvents = Object.values(pastData).filter(e => e.type === 'VEVENT');
                if (pastEvents.length === 0) break;
                let newPast = 0, oldest = null;
                for (const [key, val] of Object.entries(pastData)) {
                    if (val.type === 'VEVENT') { const uid = val.uid || key; if (!allPMAth[uid]) newPast++; allPMAth[uid] = val; const d = new Date(val.start); if (!oldest || d < oldest) oldest = d; }
                }
                if (newPast === 0) break;
                if (oldest && oldest < pastDate) break;
            } catch (err) { console.log(`  → Athletics past page failed: ${err.message}`); break; }
        }

        let pmAthEmit = 0, pmAthDropLevel = 0;
        for (const ev of Object.values(allPMAth)) {
            const eventDate = new Date(ev.start);
            if (isNaN(eventDate.getTime()) || eventDate < pastDate || eventDate >= futureDate) continue;

            const title = (ev.summary || 'Penn Manor Athletics')
                .replace(/\s*@\s*\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\s*$/i, '')
                .trim();
            const lowerTitle = title.toLowerCase();
            const desc = ev.description || '';

            // Feed is games-only, but guard against any non-game rows defensively
            if (/\bpractice\b|\bscrimmage\b|\bopen gym\b|\btryout/i.test(lowerTitle)) continue;

            // Structured description fields: "Sport: X", "Level: <Gender> <Level>", "Site: <venue>"
            const sportRaw = ((desc.match(/Sport:\s*(.+?)(?:\\n|\n|$)/i) || [])[1] || '').trim();
            const levelRaw = ((desc.match(/Level:\s*(.+?)(?:\\n|\n|$)/i) || [])[1] || '').trim();
            const siteRaw  = ((desc.match(/Site:\s*(.+?)(?:\\n|\n|$)/i)  || [])[1] || '').trim();

            // Varsity + JV only — drop 7th/8th/9th/freshman/jr-high
            const isVarsity = /\bvarsity\b/i.test(levelRaw);
            const isJV = /\bjv\b/i.test(levelRaw);
            if (!(isVarsity || isJV)) { pmAthDropLevel++; continue; }

            const tags = ["PM", "Athletics"];
            if (isVarsity && !isJV) tags.push('Varsity');
            if (isJV) tags.push('JV');

            // Gender (Level carries it; fall back to title)
            if (/\bgirls?\b|girl's/i.test(levelRaw) || /\bgirls\b/i.test(lowerTitle)) tags.push('Girls');
            if (/\bboys?\b|boy's/i.test(levelRaw)   || /\bboys\b/i.test(lowerTitle))  tags.push('Boys');

            // Home vs Away: "vs" = home, "@" = away (mirrors section 2)
            if (lowerTitle.includes(' vs ')) tags.push("Home Game Mode");

            // Sport tag from the authoritative Sport: field, normalized to sportsList casing
            const sportCanon = sportsList.find(s => s.toLowerCase() === sportRaw.toLowerCase());
            if (sportCanon) tags.push(sportCanon);
            else if (sportRaw) tags.push('Athletics'); // sport not in sportsList — keep tagged (e.g. Bocce)

            // Display location: prefer the venue name (Site:) over the raw address
            const loc = siteRaw || ev.location || 'Penn Manor School District';

            events.push({
                title, date: eventDate.toISOString(),
                endTime: resolveEndTime({ origStart: ev.start, origEnd: ev.end, instanceStart: eventDate }),
                location: loc,
                tags: [...new Set(tags)], price: "Free", ticketLink: "",
                sourceLink: ev.url || "https://www.pennmanor.net/events/category/athletics/",
                gameResult: '', gameScore: '',
                streamLink: '',
                isLive: false
            });
            pmAthEmit++;
        }
        console.log(`✅ Penn Manor Athletics: ${pmAthEmit} games (Varsity/JV) emitted, ${pmAthDropLevel} sub-varsity dropped`);
    } catch (e) { console.error("❌ Penn Manor Athletics error:", e.message); }

    // ===== 2b. HUDL BROADCAST CHECK (Penn Manor) =====
    try {
        console.log("📡 Checking Hudl broadcasts for PM games...");
        const hudlQuery = `query Web_Fan_GetScheduleEntrySummaries_r1($input: GetScheduleEntryPublicSummariesInput!) {
  scheduleEntryPublicSummaries(input: $input) {
    items {
      gameType genderId id internalId
      opponentDetails { name shortName __typename }
      scheduleEntryId scheduleEntryLocation scheduleEntryOutcome
      score1 score2 sportId teamId timeUtc broadcastStatus
      __typename
    }
    totalCount __typename
  }
}`;
        // Query in weekly chunks to avoid hitting limits
        const hudlBroadcasts = new Map(); // key: YYYY-MM-DD|sportId|genderId -> broadcast info
        const hudlScores = new Map(); // key: YYYY-MM-DD|sportId|genderId -> score info
        const hudlAllEntries = new Map(); // key: YYYY-MM-DD|sportId|genderId -> all tracked games
        let totalHudlEntries = 0, broadcastCount = 0, scoreCount = 0;

        // Query Hudl in chunks, handling pagination
        const chunkSize = 30 * 24 * 60 * 60 * 1000; // 30 days
        let hudlStart = pastDate.getTime();
        const hudlEnd = futureDate.getTime();
        const sportIdsSeen = new Set();

        while (hudlStart < hudlEnd) {
            const chunkEnd = Math.min(hudlStart + chunkSize, hudlEnd);
            let cursor = null;
            let hasMore = true;

            while (hasMore) {
                const inputVars = {
                    sortType: 'SCHEDULE_ENTRY_DATE',
                    schoolIds: ['U2Nob29sNjcyNw=='],
                    filterStartDate: new Date(hudlStart).toISOString(),
                    filterEndDate: new Date(chunkEnd).toISOString(),
                    sortByAscending: true,
                    first: 100
                };
                if (cursor) inputVars.after = cursor;

                const res = await fetch('https://www.hudl.com/api/public/graphql/query', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        operationName: 'Web_Fan_GetScheduleEntrySummaries_r1',
                        variables: { input: inputVars },
                        query: hudlQuery
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    // GraphQL endpoints return 200 OK even on schema errors. The
                    // errors appear in the body's `errors` array. Without logging
                    // this, a schema rejection silently produces zero results —
                    // same shape as "no games scheduled this week." Matches the
                    // pattern used for MU Hudl below.
                    if (data?.errors?.length) {
                        const summary = data.errors.map(e => e.message || JSON.stringify(e)).join(' | ');
                        console.log(`  ⚠️ PM Hudl GraphQL errors: ${summary.substring(0, 300)}`);
                    }
                    const result = data?.data?.scheduleEntryPublicSummaries;
                    const items = result?.items || [];
                    totalHudlEntries += items.length;

                    for (const item of items) {
                        sportIdsSeen.add(`${item.sportId}:g${item.genderId}`);
                        const gameDate = new Date(item.timeUtc).toISOString().split('T')[0];
                        const key = `${gameDate}|${item.sportId}|${item.genderId}`;

                        // Store ALL entries (for highlight links on past games)
                        if (!hudlAllEntries.has(key)) {
                            hudlAllEntries.set(key, {
                                id: item.id,
                                timeUtc: item.timeUtc
                            });
                        }

                        // Store broadcast info (full replays / livestreams)
                        if (item.broadcastStatus !== null && item.broadcastStatus !== undefined) {
                            hudlBroadcasts.set(key, {
                                id: item.id,
                                scheduleEntryId: item.scheduleEntryId,
                                broadcastStatus: item.broadcastStatus,
                                timeUtc: item.timeUtc
                            });
                            broadcastCount++;
                        }

                        // Store scores (for all entries that have them)
                        if (item.score1 !== null && item.score2 !== null) {
                            const outcome = item.scheduleEntryOutcome;
                            const result = outcome === 1 ? 'W' : outcome === 2 ? 'L' : outcome === 3 ? 'T' : '';
                            if (result) {
                                hudlScores.set(key, {
                                    result,
                                    score: `${item.score1}-${item.score2}`,
                                    timeUtc: item.timeUtc
                                });
                                scoreCount++;
                            }
                        }
                    }

                    hasMore = result?.pageInfo?.hasNextPage || false;
                    cursor = result?.pageInfo?.endCursor || null;
                    if (items.length === 0) hasMore = false;
                } else {
                    // Non-2xx response. Log status + a snippet of the body so
                    // schema/auth changes don't silently disappear. Matches
                    // the MU Hudl error-logging pattern below.
                    const body = await res.text().catch(() => '');
                    console.log(`  ⚠️ PM Hudl HTTP ${res.status}: ${body.substring(0, 200)}`);
                    hasMore = false;
                }
            }
            hudlStart = chunkEnd;
        }

        console.log(`  📺 Hudl: ${totalHudlEntries} schedule entries, ${broadcastCount} with broadcasts, ${scoreCount} with scores`);

        // Hudl sportId mapping (confirmed: 2=basketball, 4=volleyball, 7=lacrosse)
        const hudlSportMap = {
            1: 'football', 2: 'basketball', 3: 'soccer', 4: 'volleyball',
            5: 'baseball', 6: 'softball', 7: 'lacrosse', 8: 'field hockey',
            9: 'wrestling', 10: 'tennis', 11: 'track', 12: 'swimming',
            13: 'cross country', 14: 'golf'
        };
        const sportToHudlId = {};
        for (const [id, name] of Object.entries(hudlSportMap)) sportToHudlId[name] = parseInt(id);

        // Match broadcasts AND scores to PM events
        let matchCount = 0, highlightCount = 0;
        for (const ev of events) {
            if (!ev.tags || !ev.tags.includes('PM')) continue;
            const sportTag = ev.tags.find(t => sportToHudlId[t.toLowerCase()]);
            if (!sportTag) continue;

            const evDate = new Date(ev.date).toISOString().split('T')[0];
            const gender = ev.tags.includes('Girls') ? 1 : 0;
            const sportId = sportToHudlId[sportTag.toLowerCase()];
            const key = `${evDate}|${sportId}|${gender}`;

            // Broadcast link (actual stream / livestream)
            const broadcast = hudlBroadcasts.get(key);
            if (broadcast) {
                const watchDate = new Date(broadcast.timeUtc).toISOString();
                ev.streamLink = `https://fan.hudl.com/usa/pa/millersville/organization/6727/penn-manor-high-school/schedule?date=${encodeURIComponent(watchDate)}&range=Day&s=${encodeURIComponent(broadcast.id)}`;
                matchCount++;
            } else {
                // No broadcast — only link past games for potential highlights
                const hudlEntry = hudlAllEntries.get(key);
                if (hudlEntry && new Date(ev.date) < now) {
                    const watchDate = new Date(hudlEntry.timeUtc).toISOString();
                    ev.streamLink = `https://fan.hudl.com/usa/pa/millersville/organization/6727/penn-manor-high-school/schedule?date=${encodeURIComponent(watchDate)}&range=Day&s=${encodeURIComponent(hudlEntry.id)}`;
                    highlightCount++;
                }
            }

            // Update isLive if stream link was added and game is happening now
            if (ev.streamLink && !ev.isLive) {
                const evStart = new Date(ev.date);
                const evEnd = new Date(evStart.getTime() + 2*60*60*1000);
                if (now >= evStart && now <= evEnd && !ev.gameResult) {
                    ev.isLive = true;
                }
            }
        }
        console.log(`  📺 Matched ${matchCount} broadcasts, ${highlightCount} highlight links`);
        // Store for score matching after MaxPreps
        global._hudlScores = hudlScores;
        global._hudlSportToId = sportToHudlId;

    } catch (e) { console.log(`  ⚠️ Hudl broadcast check error: ${e.message}`); }

    // ===== 2c. HUDL BROADCAST CHECK (Millersville University Athletics) =====
    //
    // Hoisted outside the try-block so it survives partial failures (we still
    // record "0 broadcasts matched" in status.sources, which the dashboard's
    // degradation detector compares against the rolling 7-day median to flag
    // silent breakage — same mechanism that protects the per-source counts).
    let muHudlMatchCount = 0;
    //
    // MU broadcasts on PSAC Sports Digital Network (https://psacsportsdigitalnetwork.com/
    // millersvilleathletics/), which is powered by Hudl TV (BlueFrame became Hudl in
    // 2022). The user-facing per-game URL is:
    //
    //   https://psacsportsdigitalnetwork.com/millersvilleathletics/?B=<broadcastId>
    //
    // where <broadcastId> is the numeric ID returned by Hudl's `internalId` field
    // on the Broadcast record.
    //
    // PRIOR APPROACH (broken Apr 2026): we joined `scheduleEntryPublicSummaries`
    // items to events by date+sport+gender, then built a `fan.hudl.com/.../&s=<id>`
    // URL. Two failures:
    //   1. The schedule-entries query started returning empty for MU. PSAC
    //      registers broadcasts directly without back-linking to scheduled entries
    //      (scheduleEntryId is null on every MU broadcast we've seen), so this
    //      query was never going to be a reliable source.
    //   2. Even if it had returned data, the `s=<id>` URL pointed at fan.hudl.com,
    //      not the PSAC-branded site users expect.
    //
    // CURRENT APPROACH: query the broadcasts list directly. We pull all current
    // (LIVE + UPCOMING) broadcasts in one page and a date-bounded page of
    // ARCHIVED broadcasts, parse each broadcast's `title` for sport + opponent +
    // game-number, and match against MU events by (date, sport). Doubleheaders
    // are handled by sorting both broadcasts and events for a given date+sport,
    // then assigning earliest-to-earliest. The output URL is the PSAC-branded
    // form with the `internalId` as the `?B=` value.
    //
    // This block OVERRIDES the Sidearm streamLink for MU games when Hudl has a
    // broadcast entry. Combined with the earlier defensive filter (which strips
    // generic PSAC URLs from non-live games), the net effect is: upcoming
    // games without a Hudl broadcast show no Watch button; upcoming games with
    // a Hudl broadcast get a working per-game URL; live and past games work
    // the same as before, improved by specific archive URLs where available.
    try {
        console.log("📡 Checking Hudl broadcasts for MU games...");
        const muBroadcastQuery = `query Web_Fan_GetBroadcasts_r1($input: GetBroadcastsPaginatedInput!) {
  broadcasts(input: $input) {
    edges {
      node {
        broadcastDateUtc
        broadcastId
        internalId
        siteId
        status
        title
        __typename
      }
      cursor
      __typename
    }
    pageInfo { endCursor hasNextPage __typename }
    totalCount
    __typename
  }
}`;

        // Fetch one page of the broadcasts list. The Hudl API tightened in early
        // 2026 and now requires `x-hudl-usehotchocolate: 100` plus a browser-like
        // origin/referer; without those it returns empty results silently. We
        // send the same headers fan.hudl.com sends.
        const fetchBroadcastPage = async (statusFilter, cursor) => {
            const inputVars = {
                first: 100,
                sortByAscending: false,
                sortType: 'BROADCAST_DATE',
                schoolIds: ['U2Nob29sMTIwNjA='],
                teamIds: [],
                broadcastStatusFilter: statusFilter
            };
            if (cursor) inputVars.after = cursor;

            const res = await fetch('https://www.hudl.com/api/public/graphql/query', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-hudl-usehotchocolate': '100',
                    'origin': 'https://fan.hudl.com',
                    'referer': 'https://fan.hudl.com/',
                    'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36'
                },
                body: JSON.stringify({
                    operationName: 'Web_Fan_GetBroadcasts_r1',
                    variables: { input: inputVars },
                    query: muBroadcastQuery
                })
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                console.log(`  ⚠️ MU Hudl HTTP ${res.status} on ${statusFilter}: ${body.substring(0, 200)}`);
                return null;
            }
            const json = await res.json();
            // GraphQL endpoints return 200 OK even on schema errors. The errors
            // appear in the body's `errors` array. Without logging this, a
            // schema rejection (e.g. removing `durationSeconds` because it
            // wasn't really on the Broadcast type) silently produces zero
            // results — the same shape as "no broadcasts available."
            if (json?.errors?.length) {
                const summary = json.errors.map(e => e.message || JSON.stringify(e)).join(' | ');
                console.log(`  ⚠️ MU Hudl GraphQL errors on ${statusFilter}: ${summary.substring(0, 300)}`);
            }
            return json;
        };

        // Parse a broadcast title into the sport name. Hudl's title format we've
        // observed:
        //   "Baseball vs. West Chester (Game 1)"
        //   "Softball vs. Bloomsburg (Game 2)"
        //   "Lacrosse vs. Bloomsburg"
        //   "Baseball vs. Wilmington "                 (note trailing space)
        //   "Millersville Invite"                      (track meet — no opponent)
        //
        // Returns the lowercased sport word, or null if the title doesn't fit any
        // expected shape. The sport word is matched against event tags in the
        // assignment loop below — anything we can't parse just doesn't get a link.
        const parseBroadcastTitle = (title) => {
            if (!title) return null;
            const t = title.trim();
            // Match "Sport vs. Opponent" / "Sport at Opponent" / "Sport vs Opponent"
            const m = t.match(/^([A-Za-z][A-Za-z ]*?)\s+(?:vs\.?|at)\s+/i);
            if (m) {
                const sport = m[1].trim().toLowerCase();
                // Common multi-word sports — collapse to single canonical token
                if (sport.includes('field hockey'))  return 'field hockey';
                if (sport.includes('cross country')) return 'cross country';
                if (sport.includes('track'))         return 'track';
                return sport;
            }
            // Fallbacks for sports without "vs." in the title (track meets, etc).
            // Order matters — check more-specific tokens first.
            const lower = t.toLowerCase();
            if (/\b(invitational|invite|relays|championships?)\b/.test(lower)) {
                if (/\bswim/.test(lower))             return 'swimming';
                if (/\bcross[- ]country/.test(lower)) return 'cross country';
                if (/\btrack/.test(lower))            return 'track';
                // Generic invite/meet — assume track since that's the most common
                return 'track';
            }
            return null;
        };

        // Pull broadcasts in two passes: current (LIVE/UPCOMING — we always want
        // ALL of these, the count should be small) and ARCHIVED (we cap to our
        // pastDate window so we don't fetch 600+ historical broadcasts each run).
        // ARCHIVED comes back sorted newest-first, so we stop paginating as
        // soon as we cross pastDate.
        const broadcasts = [];   // { sport, dateUtc, internalId, status, title }
        const pastCutoff = pastDate.getTime();
        const futureCutoff = futureDate.getTime();
        let muTotalBroadcasts = 0;

        // Pass 1: anything currently live or scheduled. The set is tiny (typically
        // 0–5 entries) so a single page is enough.
        for (const status of ['LIVE', 'UPCOMING']) {
            const data = await fetchBroadcastPage(status, null);
            const edges = data?.data?.broadcasts?.edges || [];
            for (const edge of edges) {
                muTotalBroadcasts++;
                const node = edge.node;
                const ms = new Date(node.broadcastDateUtc).getTime();
                if (isNaN(ms) || ms < pastCutoff || ms > futureCutoff) continue;
                const sport = parseBroadcastTitle(node.title);
                if (!sport || !node.internalId) continue;
                // durationSeconds may be null/0 for UPCOMING broadcasts (length
                // unknown until the broadcast actually airs). endMs is null in
                // that case; step 7's interval-overlap pairing will fall back
                // to a sport-default duration when endMs is null. We store the
                // raw value (preserving null vs 0 vs missing) for debugging —
                // Number(null) === 0 in JS, so we check rawDur first.
                const rawDur = node.durationSeconds;
                const durSec = (rawDur === null || rawDur === undefined) ? null : Number(rawDur);
                const endMs = (Number.isFinite(durSec) && durSec > 0) ? ms + durSec * 1000 : null;
                broadcasts.push({
                    sport,
                    dateUtc: node.broadcastDateUtc,
                    ms,
                    endMs,
                    durationSeconds: durSec,
                    internalId: node.internalId,
                    status: node.status,
                    title: node.title
                });
            }
        }

        // Pass 2: archived broadcasts within our pastDate window. Paginate until
        // we cross the cutoff (broadcasts come back newest-first, so once we see
        // one older than pastDate we're done — everything after will be older).
        let archCursor = null;
        let archHasMore = true;
        let archPagesFetched = 0;
        const ARCH_PAGE_CAP = 10;  // safety: 100 broadcasts/page × 10 = 1000 max
        while (archHasMore && archPagesFetched < ARCH_PAGE_CAP) {
            const data = await fetchBroadcastPage('ARCHIVED', archCursor);
            archPagesFetched++;
            const result = data?.data?.broadcasts;
            const edges = result?.edges || [];
            if (edges.length === 0) break;
            let crossedCutoff = false;
            for (const edge of edges) {
                muTotalBroadcasts++;
                const node = edge.node;
                const ms = new Date(node.broadcastDateUtc).getTime();
                if (isNaN(ms)) continue;
                if (ms < pastCutoff) { crossedCutoff = true; continue; }
                if (ms > futureCutoff) continue;  // shouldn't happen for archived but defensive
                const sport = parseBroadcastTitle(node.title);
                if (!sport || !node.internalId) continue;
                // ARCHIVED broadcasts have an actual recorded duration. Defensive
                // fallback to null if Hudl returns an unexpected shape — step 7
                // pairing degrades to sport-default duration when null.
                const rawDur = node.durationSeconds;
                const durSec = (rawDur === null || rawDur === undefined) ? null : Number(rawDur);
                const endMs = (Number.isFinite(durSec) && durSec > 0) ? ms + durSec * 1000 : null;
                broadcasts.push({
                    sport,
                    dateUtc: node.broadcastDateUtc,
                    ms,
                    endMs,
                    durationSeconds: durSec,
                    internalId: node.internalId,
                    status: node.status,
                    title: node.title
                });
            }
            archHasMore = (result?.pageInfo?.hasNextPage && !crossedCutoff) || false;
            archCursor = result?.pageInfo?.endCursor || null;
        }
        console.log(`  📺 MU Hudl: ${muTotalBroadcasts} broadcasts queried, ${broadcasts.length} matched our window`);
        // Note: durationSeconds isn't exposed on Hudl's Broadcast GraphQL type
        // (verified empirically when adding the field broke the whole query).
        // We capture rawDur defensively in case the schema changes and starts
        // exposing it later; until then, b.endMs is always null and step 7's
        // interval-overlap pairing uses sport-default durations as fallback —
        // which works fine, just slightly less precise than real durations.
        const withDuration = broadcasts.filter(b => b.durationSeconds !== null).length;
        if (withDuration > 0) {
            console.log(`  ⏱️  MU Hudl durations: ${withDuration}/${broadcasts.length} broadcasts carry durationSeconds`);
        }

        // Group broadcasts by sport only. Day grouping was previously used as
        // a coarse first-cut filter, but it dropped multi-day events: a track
        // meet with DTSTART Apr 28 + DTEND Apr 30 (single event from Sidearm)
        // would land in the Apr 28 bucket, while an Apr 29 broadcast landed
        // in Apr 29's bucket — no pairing. Interval overlap (below) handles
        // multi-day natively, so we drop the day axis entirely.
        const broadcastsBySport = new Map();  // "baseball" -> [b, b, ...]
        for (const b of broadcasts) {
            if (!broadcastsBySport.has(b.sport)) broadcastsBySport.set(b.sport, []);
            broadcastsBySport.get(b.sport).push(b);
        }
        for (const list of broadcastsBySport.values()) {
            list.sort((a, b) => a.ms - b.ms);
        }

        // Sport-default duration in ms — kept in lockstep with SPORT_DEFAULTS
        // in app.js (and ICS_SPORT_DEFAULTS in events_ics.php). Used here only
        // when an event has no explicit endTime; provides a reasonable interval
        // for the overlap test below.
        const SPORT_DURATION_HOURS = {
            'baseball': 3, 'softball': 3, 'football': 3, 'wrestling': 3, 'track': 6,
            'basketball': 2, 'soccer': 2, 'tennis': 2, 'lacrosse': 2,
            'field hockey': 2, 'cross country': 2, 'volleyball': 1.5,
            'swimming': 3, 'golf': 5
        };
        const sportDurationMs = (sport) => (SPORT_DURATION_HOURS[sport] || 2) * 3600 * 1000;

        // Group MU sport events by sport, with start/end ms precomputed for
        // the pairing pass. Event end resolves from explicit endTime (set in
        // step 3 via Sidearm DTEND) when present, otherwise sport-default.
        const eventsBySport = new Map();
        for (const ev of events) {
            if (!ev.tags || !ev.tags.includes('MU')) continue;
            if (!ev.tags.includes('Athletic Competitions')) continue;
            const sportTag = ev.tags.find(t =>
                ['Baseball','Softball','Lacrosse','Volleyball','Football','Basketball',
                 'Soccer','Field Hockey','Tennis','Track','Golf','Swimming','Cross Country',
                 'Wrestling'].includes(t)
            );
            if (!sportTag) continue;
            const evMs = parseEventInstant(ev.date);
            if (isNaN(evMs)) continue;
            const sport = sportTag.toLowerCase();
            let evEndMs;
            if (ev.endTime) {
                const e = parseEventInstant(ev.endTime);
                if (!isNaN(e) && e > evMs) evEndMs = e;
            }
            if (evEndMs === undefined) evEndMs = evMs + sportDurationMs(sport);
            if (!eventsBySport.has(sport)) eventsBySport.set(sport, []);
            eventsBySport.get(sport).push({ ev, ms: evMs, endMs: evEndMs });
        }
        for (const list of eventsBySport.values()) {
            list.sort((a, b) => a.ms - b.ms);
        }

        // Interval-overlap pairing per sport. Walking BROADCASTS in start-time
        // order (not events), each broadcast claims the closest unpaired event
        // whose interval overlaps. Broadcast-centric iteration is the right
        // direction for the cross-contamination case: a multi-day MU Invite
        // (Apr 28–30) and a same-sport single-day PSU game (Apr 29) both
        // overlap an Apr 29 broadcast, but the broadcast is "for" the closer
        // event by start time. Walking events would have the multi-day event
        // greedily claim the broadcast first (events sort by start, MU Invite
        // is earlier) and starve the actually-correct PSU pairing.
        //
        // Half-open interval overlap: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅
        //   ⟺  aStart < bEnd  AND  bStart < aEnd
        //
        // Multi-day events (PSAC track championships, multi-day wrestling
        // tournaments, etc.) get exactly ONE streamLink — the first overlap-
        // ping broadcast wins, since later broadcasts find the event already
        // paired and skip. Result: the card always links to Day 1's broadcast.
        //
        // Whether Hudl auto-redirects a Day-1 broadcast ID to the active
        // session on Days 2+ is unverified. Anecdotally, broadcasts get
        // archived independently, so clicking a Day-1 link mid-Day-2 likely
        // lands on Day 1's archive rather than the live Day-2 stream.
        //
        // We don't fix this yet because we don't know how often it actually
        // matters. The diagnostic block immediately below tracks how many
        // broadcasts get skipped due to multi-day already-paired events, so
        // a few weeks of cron logs will tell us whether moving to a
        // streamLinks[] array (one per session) is worth the engineering.
        const pairedEvents = new WeakSet();
        // Diagnostic: count broadcasts that overlap an already-paired event
        // (typical of Day-2+ broadcasts for multi-day meets like PSAC track
        // championships). High counts here = "users would benefit from
        // streamLinks[] per event"; low counts = current single-link is fine.
        // Decision will be made from cron log data, not speculation.
        const multiDaySkips = []; // [{evTitle, evDate, dayNumber, totalDays}]
        for (const [sport, broadcastList] of broadcastsBySport) {
            const eventList = eventsBySport.get(sport);
            if (!eventList || !eventList.length) continue;
            const fbDur = sportDurationMs(sport);
            for (const b of broadcastList) {
                const bEndMs = b.endMs ?? (b.ms + fbDur);
                let best = null;
                let bestDelta = Infinity;
                // Track if this broadcast overlaps an already-paired event —
                // signal for "would have wanted multiple streamLinks here."
                let overlappedPairedEvent = null;
                for (const er of eventList) {
                    if (pairedEvents.has(er.ev)) {
                        // Check if this paired event overlaps the broadcast
                        if (er.ms < bEndMs && b.ms < er.endMs) {
                            overlappedPairedEvent = er;
                        }
                        continue;
                    }
                    if (er.ms < bEndMs && b.ms < er.endMs) {
                        const delta = Math.abs(b.ms - er.ms);
                        if (delta < bestDelta) { best = er; bestDelta = delta; }
                    }
                }
                if (best) {
                    best.ev.streamLink = `https://psacsportsdigitalnetwork.com/millersvilleathletics/?B=${b.internalId}`;
                    pairedEvents.add(best.ev);
                    muHudlMatchCount++;

                    // Re-evaluate isLive using the precomputed event interval
                    // (may include real endTime from step 3) instead of the old
                    // hardcoded +3h.
                    if (!best.ev.isLive) {
                        const nowMs = now.getTime();
                        if (nowMs >= best.ms && nowMs <= best.endMs && !best.ev.gameResult) {
                            best.ev.isLive = true;
                        }
                    }
                } else if (overlappedPairedEvent) {
                    // No fresh event to pair, but this broadcast overlapped
                    // an event we already paired — that's the multi-day case.
                    const eventSpanMs = overlappedPairedEvent.endMs - overlappedPairedEvent.ms;
                    const eventDays = Math.max(1, Math.round(eventSpanMs / (24 * 60 * 60 * 1000)));
                    multiDaySkips.push({
                        evTitle: overlappedPairedEvent.ev.title || '(untitled)',
                        evDate: new Date(overlappedPairedEvent.ms).toISOString().split('T')[0],
                        eventDays,
                        sport
                    });
                }
            }
        }
        if (multiDaySkips.length > 0) {
            console.log(`  ℹ️  MU Hudl: ${multiDaySkips.length} broadcast(s) overlapped an already-paired multi-day event (Day 2+/championship coverage):`);
            // Group by event title for a cleaner log
            const byEvent = {};
            for (const m of multiDaySkips) {
                const k = `${m.evTitle} (${m.evDate}, ${m.eventDays}d)`;
                byEvent[k] = (byEvent[k] || 0) + 1;
            }
            for (const [evLabel, count] of Object.entries(byEvent)) {
                console.log(`     +${count} skipped: ${evLabel}`);
            }
        }
        // Count unpaired broadcasts for the cron log — useful for spotting
        // schema drift (e.g., parseBroadcastTitle starts returning a sport
        // word that no event ever uses) or genuine away-game broadcasts that
        // we don't have an event record for.
        let unpairedSportBroadcasts = 0;
        for (const [sport, broadcastList] of broadcastsBySport) {
            const eventList = eventsBySport.get(sport) || [];
            for (const b of broadcastList) {
                const matched = eventList.some(er => er.ev.streamLink &&
                    er.ev.streamLink.includes(`?B=${b.internalId}`));
                if (!matched) unpairedSportBroadcasts++;
            }
        }
        if (unpairedSportBroadcasts > 0) {
            console.log(`  ⚠️  MU Hudl: ${unpairedSportBroadcasts} broadcasts had no overlapping event (away games or schema drift)`);
        }
        console.log(`  📺 MU matched ${muHudlMatchCount} broadcasts to events`);
    } catch (e) { console.log(`  ⚠️ MU Hudl broadcast check error: ${e.message}`); }

    // ===== 3. MU CALENDAR (NON-SPORT EVENTS ONLY) =====
    try {
        console.log("📡 Fetching MU Calendar (non-sport events)...");
        const pageRes = await fetch('https://www.millersville.edu/calendar/', { headers: baseHeaders });
        const rawCookies = pageRes.headers.get('set-cookie');
        let cookieHeader = rawCookies ? rawCookies.split(', ').map(c => c.split(';')[0]).join('; ') : '';

        const apiHeaders = {
            ...baseHeaders, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
            'Origin': 'https://www.millersville.edu', 'Referer': 'https://www.millersville.edu/calendar/',
            'Content-Type': 'application/json'
        };
        if (cookieHeader) apiHeaders['Cookie'] = cookieHeader;

        const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', {
            method: 'POST', headers: apiHeaders,
            body: JSON.stringify({ getEvents: true, startDate: startDay, endDate: endDay })
        });
        if (!res.ok) throw new Error(`MU API returned ${res.status}`);
        const data = JSON.parse(await res.text());

        if (!Array.isArray(data.data)) throw new Error('MU API unexpected structure');
        // Loud-fail on an empty feed. A 200 with {data:[]} is the dangerous
        // silent-success shape: the post-deploy smoke test only checks the
        // TOTAL event count, so MU alone going to zero wouldn't trip it.
        // status.html's per-source count is the backstop; throwing here also
        // makes it obvious in the build log instead of a misleading "✅ 0".
        if (data.data.length === 0) throw new Error('MU Calendar returned 0 events — feed empty (body/auth?)');

        let muCount = 0;
        data.data.forEach(obj => {
            const eventTitle = obj.title || "Campus Event";
            // category now plays the old MeetingType role: it drives the athletic
            // skip, the tag, and the "Student Event" relabel below — all unchanged.
            const eventType = (obj.category || '').trim();

            // SKIP Athletic Competitions — we get those from Sidearm now
            if (eventType === 'Athletic Competitions') return;

            // --- TEMP SKIP: bare "Summer Fun Series" calendar phantoms (added 2026-06-24) ---
            // After MU's calendar migration (Ad Astra -> Coursedog, June 2026), the
            // Coursedog feed is publishing Summer Fun Series on the WRONG date (a day
            // early — Wednesday instead of the real Thursday) as a bare, description-less
            // placeholder: title exactly "Summer Fun Series", at "Duncan Alumni House Yard",
            // tagged Public Event / Alumni Engagement. The CORRECT, fully-described copies
            // ("Summer Fun Series: <activity> with <people>", Alumni House Lawn) come from
            // the weekly alumni-events Cowork sync, NOT this calendar — so dropping the
            // calendar copies loses nothing the site doesn't already have from the better
            // source. MU IT estimated ~2 weeks to fix (so ~early July 2026).
            //
            // Matches the BARE title ONLY (optional trailing colon) — the real suffixed
            // titles have text after the colon and are left untouched.
            //
            // REMOVE THIS once MU's calendar dates are corrected: at that point the calendar
            // copy lands on the same Thursday instant as the curated copy, sharing the
            // "Summer Fun Series" title-head, and dedupeEvents() in app.js collapses the
            // pair on its own (richer copy wins) — so this skip becomes redundant.
            if (/^\s*summer fun series\s*:?\s*$/i.test(eventTitle)) {
                console.log(`⏭️  Skipped bare 'Summer Fun Series' calendar phantom (${obj.startDate || 'no date'})`);
                return;
            }

            // Build location from the split named fields (building + roomName +
            // roomNumber). The proxy also returns a pre-combined location, but we
            // compose from the parts to keep the existing cleanups working.
            const bldg = obj.building || '';
            const roomName = obj.roomName || '';
            const roomNum = obj.roomNumber || '';
            let eventLoc = [bldg, roomName, roomNum].filter(Boolean).join(' ').trim() || "Campus";
            // Strip the AcCALEN placeholder building code (campus-wide markers with
            // no real venue). Case-insensitive, matches anywhere in the string.
            if (/\bAccalen\b/i.test(eventLoc)) {
                eventLoc = eventLoc.replace(/\bAccalen\b\s*/gi, '').trim();
                if (!eventLoc) eventLoc = 'Millersville University';
            }
            eventLoc = eventLoc.replace(/^WARE Ware Center$/i, 'Ware Center')
                               .replace(/^WARE\b/, 'Ware Center')
                               .replace(/^Ware Center\s+/, 'Ware Center, ');

            // Description lives in the proxy's positional columns (index 11,
            // duplicated at 2) — there is NO named key for it. Empty string when
            // the event carries none. This is the one field read positionally,
            // so a column reorder upstream would surface as blank/garbage desc
            // (not 0 events) — worth watching.
            const descHtml = obj['11'] || obj['2'] || '';
            const pricing = extractPricing(descHtml, eventTitle, eventLoc, '');

            let tags = ["MU"];
            if (eventType) tags.push(eventType);
            const custName = (obj.customerName || '').trim();
            if (custName) tags.push(custName);

            // RELABEL: "Student Event" from the MU calendar is really the GetInvolved feed
            // being republished on the main calendar, creating duplicates. Treat these as
            // GetInvolved events so they filter/display/dedupe consistently.
            let audience;
            if (tags.includes('Student Event')) {
                tags = tags.filter(t => t !== 'Student Event');
                if (!tags.includes('GetInvolved')) tags.push('GetInvolved');
                if (!tags.includes('Clubs/Orgs')) tags.push('Clubs/Orgs');
                // Plain-text description for keyword scanning
                const plainDesc = descHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                const customerName = custName;

                // Derived-tag detection — mirrors the GetInvolved API block
                // (greekRegex). Cross-source dedupe prioritizes MU Calendar over
                // GetInvolved, so without this the merged event would lose its
                // Greek Life / Residence Halls / Fundraising tags. classifyAudience
                // below depends on these, so detection MUST run first.
                const greekRegex = /^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)\b/i;
                const orgLower = customerName.toLowerCase();
                const titleLower = (eventTitle || '').toLowerCase();
                if (/housing and residential|residence hall/.test(orgLower)) {
                    if (!tags.includes('Residence Halls')) tags.push('Residence Halls');
                }
                if (/greek council/.test(orgLower) || greekRegex.test(orgLower) || greekRegex.test(titleLower)) {
                    if (!tags.includes('Greek Life')) tags.push('Greek Life');
                }
                if (/fundrais/i.test(eventTitle) || /fundrais/i.test(plainDesc)) {
                    if (!tags.includes('Fundraising')) tags.push('Fundraising');
                }

                audience = classifyAudience({
                    titleText: eventTitle,
                    descText: plainDesc,
                    orgName: customerName,
                    rawTags: tags,
                    tags,
                    benefits: []
                });
            }

            const eventId = obj.eventId || obj.activityId || "";
            const sourceLink = eventId
                ? `https://www.millersville.edu/calendar/events/${eventId}`
                : "https://www.millersville.edu/calendar/";

            // Decorate generic single-word titles ("Practice"/"Meeting") with the
            // org name when available. Title-pattern override wins over whatever
            // generic customerName the calendar carries.
            let calCustomerName = custName;
            const titleOverride = resolveOrgFromTitle(eventTitle);
            if (titleOverride) calCustomerName = titleOverride;
            const decoratedTitle = decorateGenericTitle(eventTitle, calCustomerName);

            // startDate is naive Eastern, no seconds ("…T18:00"). Append ":00" to
            // match the prior StartDateTime format the rest of the pipeline (dedup,
            // TZ handling) expects. Stored WITHOUT a Z — read as ET downstream.
            const startRaw = obj.startDate
                ? (obj.startDate.length === 16 ? obj.startDate + ':00' : obj.startDate)
                : '';

            events.push({
                title: decoratedTitle, date: startRaw, location: eventLoc,
                tags: [...new Set(tags)], price: pricing.price,
                ticketLink: pricing.link, sourceLink,
                description: descHtml,
                ...(calCustomerName ? { orgName: calCustomerName, orgShortName: resolveOrgShortName(calCustomerName) } : {}),
                ...(audience ? { audience } : {})
            });
            muCount++;
        });
        console.log(`✅ MU Calendar (non-sport): ${muCount} events`);
    } catch (e) { console.error("❌ MU Calendar error:", e.message); }

    // ===== 3b. ARTSMU.COM (WARE CENTER / WINTER CENTER — supplements MU Calendar) =====
    try {
        console.log("📡 Fetching artsmu.com events...");
        // Fetch multiple list pages to cover regular events + summer camps
        const listPages = [
            'https://artsmu.com/events/',
            'https://artsmu.com/arts-smarts-camps/'
        ];
        const eventUrls = new Set();
        for (const listUrl of listPages) {
            try {
                const listRes = await fetch(listUrl, { headers: baseHeaders, signal: AbortSignal.timeout(30000) });
                if (!listRes.ok) { console.log(`  ⚠️ ${listUrl} returned ${listRes.status}`); continue; }
                const listHtml = await listRes.text();
                // Extract event URLs matching the pattern
                const urlRegex = /https:\/\/artsmu\.com\/event\/[a-z0-9-]+\/(?:the-ware-center|winter-visual-performing-arts-center)\/?/gi;
                let pageTotal = 0, pageNew = 0;
                for (const m of listHtml.matchAll(urlRegex)) {
                    const cleanUrl = m[0].replace(/\/$/, '') + '/';
                    pageTotal++;
                    if (!eventUrls.has(cleanUrl)) { eventUrls.add(cleanUrl); pageNew++; }
                }
                const pageLabel = listUrl.split('/').slice(-2,-1)[0];
                console.log(`  🔗 ${pageLabel}: ${pageTotal} URLs found (${pageNew} unique new)`);
            } catch (e) {
                console.log(`  ⚠️ ${listUrl} fetch failed: ${e.message}`);
            }
        }
        console.log(`  🔗 Total ${eventUrls.size} unique artsmu event URLs to check`);

        // Stage 2: Fetch each event page and parse structured data
        const monthMap = {January:0,February:1,March:2,April:3,May:4,June:5,July:6,August:7,September:8,October:9,November:10,December:11};
        let artsCount = 0, artsFailed = 0, artsSkipped = 0;
        // Dedup against MU Calendar entries already in `events`. Uses the
        // shared buildCampDedupKey helper (module scope) so artsmu and
        // camps.json apply identical TZ-aware key logic.
        const existingKeys = new Set(events.map(e => buildCampDedupKey(e.title, e.date)));

        for (const eventUrl of eventUrls) {
            try {
                const evRes = await fetch(eventUrl, { headers: baseHeaders, signal: AbortSignal.timeout(15000) });
                if (!evRes.ok) { artsFailed++; continue; }
                const evHtml = await evRes.text();

                // Extract title from <title> or h1
                const titleMatch = evHtml.match(/<h1[^>]*>([^<]+)<\/h1>/i);
                if (!titleMatch) { artsFailed++; continue; }
                let title = titleMatch[1].trim()
                    .replace(/&#0?38;/g, '&').replace(/&#0?39;/g, "'").replace(/&#8217;/g, "'")
                    .replace(/&#8220;|&#8221;/g, '"').replace(/&#8211;/g, '–')
                    .replace(/&amp;/g, '&').replace(/&quot;/g, '"');
                if (/^CANCELLED:/i.test(title)) { artsSkipped++; continue; }

                // Date: "Friday, May 01, 2026" pattern near the top of the event page
                const dateMatch = evHtml.match(/(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/);
                if (!dateMatch) { artsFailed++; continue; }
                const [, , monthName, day, year] = dateMatch;

                // Time: "Performance: 7:30 pm" or "Performance: 5 pm"
                let hour = 19, min = 0;
                const timeMatch = evHtml.match(/Performance:\s*(\d{1,2})(?::(\d{2}))?\s*([ap])m/i);
                if (timeMatch) {
                    hour = parseInt(timeMatch[1]);
                    min = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
                    if (timeMatch[3].toLowerCase() === 'p' && hour !== 12) hour += 12;
                    if (timeMatch[3].toLowerCase() === 'a' && hour === 12) hour = 0;
                }

                // Build date with explicit ET offset so timezone-unaware runners (UTC on GitHub Actions)
                // don't produce wrong times. Use -04:00 (EDT) for DST months, -05:00 (EST) otherwise.
                // Rough US DST: second Sunday of March through first Sunday of November.
                const yearNum = parseInt(year);
                const monthNum = monthMap[monthName]; // 0-indexed
                const dayNum = parseInt(day);
                // DST window approximation: months 3-10 (April-October) are always DST;
                // March and November depend on date — use day-of-month heuristics.
                let isDST;
                if (monthNum >= 3 && monthNum <= 9) isDST = true;           // Apr..Oct
                else if (monthNum === 2) isDST = dayNum >= 8;                // March: second Sunday ≥ day 8
                else if (monthNum === 10) isDST = dayNum < 8;                // November: first Sunday < day 8
                else isDST = false;                                          // Dec, Jan, Feb
                const offset = isDST ? '-04:00' : '-05:00';
                const pad = n => String(n).padStart(2, '0');
                const iso = `${year}-${pad(monthNum + 1)}-${pad(dayNum)}T${pad(hour)}:${pad(min)}:00${offset}`;
                const eventDate = new Date(iso);

                // Date range filter
                if (eventDate < pastDate || eventDate >= futureDate) { artsSkipped++; continue; }

                // Venue
                const venue = eventUrl.includes('winter-visual') ? 'Winter Visual & Performing Arts Center' : 'The Ware Center';

                // Price: "$10" or "$8 to $10" — grab text between key markers
                const priceMatch = evHtml.match(/\$\d+(?:\s*to\s*\$\d+)?/);
                const price = priceMatch ? priceMatch[0] : '';

                // Ticket link: Etix URL
                const etixMatch = evHtml.match(/https:\/\/www\.etix\.com\/ticket\/p\/\d+\/[^"\s?&<]+/);
                const ticketLink = etixMatch ? etixMatch[0] : '';

                // Description: look for content between known markers — keep short
                let description = '';
                const descMatch = evHtml.match(/<div[^>]*class="[^"]*event[_-]?description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
                if (descMatch) description = descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);

                // Dedupe against MU Calendar entries (TZ-aware via buildCampDedupKey)
                const key = buildCampDedupKey(title, eventDate);
                if (existingKeys.has(key)) { artsSkipped++; continue; }

                // Tag: art exhibit events are different from performances
                const tags = ['MU'];
                if (/exhibit|gallery|on display/i.test(title + ' ' + description)) tags.push('Art Exhibit');
                else tags.push('Arts Concert / Performance');

                events.push({
                    title, date: eventDate.toISOString(), location: venue,
                    tags, price: price || 'Open To Public',
                    ticketLink, sourceLink: eventUrl, description
                });
                existingKeys.add(key);
                artsCount++;
            } catch (e) {
                artsFailed++;
            }
        }
        console.log(`✅ artsmu.com: ${artsCount} new events (${artsSkipped} skipped, ${artsFailed} failed)`);
    } catch (e) { console.error("❌ artsmu.com error:", e.message); }
    // ===== 3d. HAND-MAINTAINED CAMPS (camps.json) =====
    // For camps where automated scraping fails (e.g., TotalCamps API blocks GHA IPs).
    // Edit /camps.json in the repo root to add/update camps. They'll appear on the site within the hour.
    // Dedup set for the camps.json loader below: keyed off what's already
    // in the events array so a camp that duplicates an existing event
    // (same title, same day) is skipped. The loader mutates it as it adds entries.
    const existingKeys4 = new Set(events.map(e => buildCampDedupKey(e.title, e.date)));
    try {
        const campsPath = path.join(__dirname, '../camps.json');
        if (fs.existsSync(campsPath)) {
            const campsData = JSON.parse(fs.readFileSync(campsPath, 'utf-8'));
            if (Array.isArray(campsData)) {
                let campCount = 0, campSkipped = 0;
                // Same dedup shape as artsmu — shared helper keeps both passes
                // aligned. Critical for camps where existing events from MU
                // Calendar arrive as naive ET strings and the new Date()
                // we build below resolves to a UTC instant.
                for (const camp of campsData) {
                    if (!camp.title || !camp.date) { campSkipped++; continue; }
                    const campDate = new Date(camp.date);
                    if (isNaN(campDate.getTime())) { campSkipped++; continue; }
                    if (campDate < pastDate || campDate >= futureDate) { campSkipped++; continue; }
                    const key = buildCampDedupKey(camp.title, campDate);
                    if (existingKeys4.has(key)) { campSkipped++; continue; }
                    // Pass through endTime if specified — needed for non-camp events
                    // (like the Summer Fun Series, which are 6-7pm slots, not full-day
                    // camps that fallback durations would handle correctly). Field is
                    // optional; when absent, the same TYPE_DEFAULTS fallback used for
                    // every other source applies.
                    let resolvedEndTime;
                    if (camp.endTime) {
                        const endDate = new Date(camp.endTime);
                        if (!isNaN(endDate.getTime())) resolvedEndTime = endDate.toISOString();
                    }
                    events.push({
                        title: camp.title,
                        date: campDate.toISOString(),
                        endTime: resolvedEndTime,
                        location: camp.location || 'Millersville University',
                        tags: Array.isArray(camp.tags) ? camp.tags : ['MU', 'Summer Camp'],
                        price: camp.price || '',
                        ticketLink: camp.registrationUrl || camp.ticketLink || '',
                        sourceLink: camp.sourceLink || camp.registrationUrl || '',
                        description: camp.description || '',
                        kidFriendly: camp.kidFriendly !== false
                    });
                    existingKeys4.add(key);
                    campCount++;
                }
                console.log(`✅ Hand-maintained camps: ${campCount} loaded from camps.json (${campSkipped} skipped)`);
            }
        } else {
            console.log(`ℹ️  camps.json not found at ${campsPath} — skipping hand-maintained camps`);
        }
    } catch (e) { console.error("❌ camps.json error:", e.message); }

    // ===== 4. CLUBS/ORGS (ANTHOLOGY / GETINVOLVED API) =====
    try {
        console.log("📡 Fetching Clubs/Orgs...");
        // Fetch future events (from today forward) and past events separately
        const giUrlFuture = `https://getinvolved.millersville.edu/api/discovery/event/search?endsAfter=${today.toISOString().split('T')[0]}T00:00:00-04:00&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=200`;
        const giUrlPast = `https://getinvolved.millersville.edu/api/discovery/event/search?endsAfter=${startDay}T00:00:00-04:00&endsBefore=${today.toISOString().split('T')[0]}T00:00:00-04:00&orderByField=endsOn&orderByDirection=descending&status=Approved&take=100`;

        // Extra fetches purely to discover org names — events from the past 2 years.
        // We don't use these events for the timeline; we only mine org names from them.
        // Split into chunks to work around any per-request row limits.
        const twoYearsAgo = new Date(today.getTime() - 730 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const oneYearAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const giUrlOrgDiscovery1 = `https://getinvolved.millersville.edu/api/discovery/event/search?endsAfter=${twoYearsAgo}T00:00:00-04:00&endsBefore=${oneYearAgo}T00:00:00-04:00&orderByField=endsOn&orderByDirection=descending&status=Approved&take=400`;
        const giUrlOrgDiscovery2 = `https://getinvolved.millersville.edu/api/discovery/event/search?endsAfter=${oneYearAgo}T00:00:00-04:00&endsBefore=${startDay}T00:00:00-04:00&orderByField=endsOn&orderByDirection=descending&status=Approved&take=400`;

        const [giFuture, giPast, giOrgDisc1, giOrgDisc2] = await Promise.allSettled([
            fetch(giUrlFuture, { headers: baseHeaders }).then(r => r.json()),
            fetch(giUrlPast, { headers: baseHeaders }).then(r => r.json()),
            fetch(giUrlOrgDiscovery1, { headers: baseHeaders }).then(r => r.json()),
            fetch(giUrlOrgDiscovery2, { headers: baseHeaders }).then(r => r.json())
        ]);

        const giItems = [
            ...((giFuture.status === 'fulfilled' ? giFuture.value.value : []) || []),
            ...((giPast.status === 'fulfilled' ? giPast.value.value : []) || [])
        ];
        // Items used only for org-name mining (not added to events timeline)
        const giOrgDiscoveryItems = [
            ...((giOrgDisc1.status === 'fulfilled' ? giOrgDisc1.value.value : []) || []),
            ...((giOrgDisc2.status === 'fulfilled' ? giOrgDisc2.value.value : []) || [])
        ];
        let clubCount = 0;

        // Track orgs seen in events so we can build a clubs.json from this dataset
        // (the dedicated /organization/search endpoint returns HTTP 500 for anonymous callers,
        //  so deriving from events is the reliable alternative).
        if (!global._orgsFromEvents) global._orgsFromEvents = new Map();
        const orgsMap = global._orgsFromEvents;
        // Record every org seen in giItems regardless of event date, so orgs with
        // only old events still appear in the directory.
        // Also include the deep-past org-discovery items to catch orgs that host events rarely.
        const orgSourceLists = [giItems, giOrgDiscoveryItems];
        orgSourceLists.forEach(list => {
            list.forEach(item => {
                if (!item.organizationName) return;
                const orgName = item.organizationName.trim();
                if (orgName && !orgsMap.has(orgName)) {
                    orgsMap.set(orgName, {
                        name: orgName,
                        category: (item.categoryNames && item.categoryNames[0]) || '',
                        categories: item.categoryNames || [],
                        shortName: '',
                        id: ''
                    });
                }
            });
        });

        giItems.forEach(item => {
            const eventDate = new Date(item.startsOn);
            if (eventDate < pastDate || eventDate >= futureDate) return;

            // Display tags start with internal markers (MU/Clubs/Orgs are hidden
            // by frontend) + GetInvolved + the org name. Theme and categoryNames
            // are deliberately NOT pushed to display tags — end users don't
            // benefit from seeing "Educational Program", "ThoughtfulLearning",
            // "Tabling", "GroupBusiness", etc. on cards. Those values still
            // feed the classifyAudience logic via rawTags below, and a small
            // set of derived labels (Fundraising, Greek Life, Residence Halls,
            // Club Sports) are still added when the theme/category patterns
            // match.
            let tags = ["MU", "GetInvolved", "Clubs/Orgs"];
            let orgDisplayName = (item.organizationName || '').trim();
            // Title-pattern override beats upstream organizationName — same
            // reasoning as the MU Calendar path. Allows curated mappings like
            // "Lavender Legacy" → "GSA" to work regardless of which scraper
            // path the event arrives through.
            const titleOverrideGI = resolveOrgFromTitle(item.name || '');
            if (titleOverrideGI) orgDisplayName = titleOverrideGI;
            if (orgDisplayName) tags.push(orgDisplayName);

            // rawTags retained for classifyAudience (greek life, residence hall,
            // service/community/fundraising signals) — not for display.
            let rawTags = [];
            if (orgDisplayName) rawTags.push(orgDisplayName);
            if (item.theme && item.theme !== "Not Applicable") rawTags.push(item.theme.trim());
            (item.categoryNames || []).forEach(c => rawTags.push(c.trim()));

            // Extract student perks/benefits
            const benefits = [];
            (item.benefitNames || []).forEach(b => {
                const bl = b.toLowerCase();
                if (bl.includes('food')) benefits.push('Free Food');
                else if (bl.includes('free stuff') || bl.includes('swag') || bl.includes('giveaway')) benefits.push('Free Stuff');
                else if (bl.includes('credit')) benefits.push('Credit');
            });
            // Also scan description & title for free food / swag signals (some events don't set benefits)
            const descText = (item.description || '').toLowerCase();
            const nameText = (item.name || '').toLowerCase();
            const combined = nameText + ' ' + descText;
            if (!benefits.includes('Free Food') && /\bfree (food|pizza|snacks|refreshments|lunch|dinner|breakfast|coffee|drinks)\b|\bpizza (will be )?provided\b|\bfood (will be )?(served|provided)\b/i.test(combined)) {
                benefits.push('Free Food');
            }
            if (!benefits.includes('Free Stuff') && /\bfree (t.?shirt|shirts|swag|merch|giveaway|prize)\b|\braffle\b|\bprize drawing\b/i.test(combined)) {
                benefits.push('Free Stuff');
            }

            const name = (item.name || "").toLowerCase();
            const orgName = (item.organizationName || "").toLowerCase();
            const greekRegex = /^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)\b/i;

            rawTags.forEach(t => {
                const lt = t.toLowerCase();
                // Skip athletics/competition noise — Sidearm is the source of truth
                // for those, and GetInvolved often double-tags club sports games.
                if (/athletics|^competition$|^competitions$/.test(lt)) return;
                // Normalize fundraising/greek patterns into clean display tags.
                // Any other rawTag is classification-only and is NOT surfaced.
                if (/fundrais/.test(lt)) { if (!tags.includes('Fundraising')) tags.push('Fundraising'); }
                else if (/fraternity|sorority|greek/.test(lt)) { if (!tags.includes('Greek Life')) tags.push('Greek Life'); }
            });

            if (/housing and residential|residence hall/.test(orgName)) tags.push('Residence Halls');
            if (/greek council/.test(orgName) || greekRegex.test(orgName) || greekRegex.test(name)) tags.push('Greek Life');

            // Use word-boundary matching, NOT String.includes — short tokens
            // like "mma" otherwise false-match inside words like "scriMMAge",
            // pulling Mock Trial Club's "Internal Scrimmage" onto the Sports
            // page. The escaped-and-anchored regex requires the sport name
            // to appear as its own whole word(s).
            const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const sportWordMatch = (haystack, needle) => new RegExp(`\\b${escapeRe(needle)}\\b`, 'i').test(haystack);
            let isPermittedSport = hGameClubSports.some(s => sportWordMatch(name, s) || sportWordMatch(orgName, s));

            // Only classify as Club Sports if the event looks like an actual game/match
            // Practices, fundraisers, trips, community service etc. stay as regular events
            const isCompetitiveGame = /\bvs\.?\b|\bversus\b|\bgame\b|\bmatch\b|\btournament\b|\binvitational\b|\bchampionship\b|\bscrimmage\b|@\s*[A-Z]/i.test(name);

            if ((isPermittedSport || tags.some(t => t.toLowerCase().includes('club sport'))) && isCompetitiveGame) {
                tags.push("Club Sports");
                if (/men's|mens/.test(name)) tags.push("Men's");
                if (/women's|womens/.test(name)) tags.push("Women's");
                // Same word-boundary safety on the sportsList categorization —
                // without it, "tennis" would match inside e.g. "antennis" (less
                // realistic but still safer to be strict).
                sportsList.forEach(s => { if (sportWordMatch(name, s)) tags.push(s); });

                // Home game detection for club sports
                const loc = (item.location || '').toLowerCase();
                const homeWords = ['pucillo', 'chryst', 'biemesderfer', 'cooper park', 'seaber', 'mccomsey', 'anttonen', 'millersville', 'comet'];
                if (homeWords.some(k => loc.includes(k)) || /\bvs\b/.test(name)) tags.push("Home Game Mode");
            }

            // Audience classification: default mu-only (student-only), promote to public if signals match.
            // Logic lives in classifyAudience() helper since MU Calendar Student Events reuse it below.
            const audience = classifyAudience({
                titleText: nameText, descText, orgName,
                rawTags, tags, benefits
            });

            events.push({
                title: decorateGenericTitle(item.name || "Student Event", orgDisplayName),
                date: eventDate.toISOString(),
                location: item.location || "Campus", tags: [...new Set(tags)],
                price: "Free",
                ticketLink: "",
                sourceLink: `https://getinvolved.millersville.edu/event/${item.id}`,
                description: item.description || "",
                // CampusLabs CDN URL. The discovery API returns just a bare
                // filename in `imagePath` (e.g. "62a129db-...PNG"), not a
                // resolvable URL. The canonical CDN path is
                //   https://se-images.campuslabs.com/clink/images/<filename>
                // The `?preset=med-w` query gets the 600×300 medium-width
                // variant — renders inline as an <img> rather than the
                // 1300×780 original which downloads as a file. Empty when
                // imagePath is missing; SLIM_FIELDS strips it downstream.
                image: item.imagePath
                    ? `https://se-images.campuslabs.com/clink/images/${item.imagePath}?preset=med-w`
                    : '',
                benefits: benefits,
                audience: audience,
                ...(orgDisplayName ? { orgName: orgDisplayName, orgShortName: resolveOrgShortName(orgDisplayName) } : {})
            });
            clubCount++;
        });
        const giEvents = events.filter(e => (e.tags||[]).includes('GetInvolved'));
        const publicCount = giEvents.filter(e => e.audience === 'public').length;
        const muOnlyCount = giEvents.filter(e => e.audience === 'mu-only').length;
        console.log(`✅ Clubs/Orgs: ${clubCount} events (${publicCount} public, ${muOnlyCount} MU-only)`);
    } catch (e) { console.error("❌ Clubs/Orgs error:", e.message); }

    // ===== 5. PHANTOM POWER (JamBase primary + Eventbrite enrichment) =====
    //
    // Phantom Power's own website only promotes 1-3 featured shows at a time and
    // its Eventbrite organizer page is SPA-rendered (unscrapable). JamBase, a
    // concert aggregator, maintains a server-rendered public venue page with
    // the full upcoming calendar — typically 15-20 shows out 6 months. That's
    // our primary source.
    //
    // Eventbrite still matters because it owns the ticket URL. We do a second,
    // cheap fetch of phantompower.net to harvest its 1-3 featured Eventbrite
    // URLs, then overlay those onto JamBase entries by fuzzy-matching artist
    // name + date. Shows with no Eventbrite match fall back to the JamBase show
    // page URL — users can click through to JamBase which redirects to tickets.
    //
    // Default time: Phantom Power's standard door time is 8pm ET. Some shows
    // start earlier (6pm / 7pm) but JamBase only publishes dates, not times.
    // This is good enough for event cards — the UI shows the date prominently
    // and users are expected to verify time on the ticket page.
    let ppCount = 0;
    try {
        // Phantom Power scrape strategy (as of Apr 2026):
        //
        //   PRIMARY:   Eventbrite organizer page (ID 29187724817) — Phantom
        //              Power's own published calendar, 30+ upcoming shows.
        //              We scrape the organizer listing page HTML for event
        //              URLs, then hit each event page for details.
        //   SECONDARY: phantompower.net homepage — catches 1-3 featured
        //              shows that might be promoted outside Eventbrite.
        //   TERTIARY:  JamBase venue page — used to be primary but started
        //              returning HTTP 403 "Host not in allowlist" on our
        //              scraper IP around Apr 2026. Attempted silently now;
        //              when it comes back online we'll pick up extra dates
        //              automatically without any code change.
        //
        // Each source contributes URLs to a single ebUrls Set (de-duped),
        // then one fetch-per-URL pass extracts event details. Emits events
        // with ticketLink = sourceLink = the Eventbrite event page.

        const allEventbriteUrls = new Set();  // Deduped across all sources

        // ---- SOURCE 1: Eventbrite organizer listing (PRIMARY) ----
        console.log("📡 Fetching Phantom Power events via Eventbrite organizer...");
        try {
            const orgRes = await fetch('https://www.eventbrite.com/o/phantom-power-29187724817', {
                headers: baseHeaders,
                signal: AbortSignal.timeout(15000)
            });
            if (orgRes.ok) {
                const orgHtml = await orgRes.text();
                // Organizer pages render a list of event cards each with an
                // /e/...-<eventId> link. Pull unique event IDs — regex captures
                // both the trailing 11-12 digit ID and the full URL.
                const evRe = /https:\/\/www\.eventbrite\.com\/e\/([^"'\s<>)]+?-(\d{10,13}))/g;
                const seenIds = new Set();
                let em;
                while ((em = evRe.exec(orgHtml)) !== null) {
                    if (seenIds.has(em[2])) continue;
                    seenIds.add(em[2]);
                    allEventbriteUrls.add(em[1] ? `https://www.eventbrite.com/e/${em[1]}` : em[0]);
                }
                console.log(`   Organizer page: ${seenIds.size} Eventbrite URL(s)`);
            } else {
                console.log(`   ⚠️  Eventbrite organizer page returned HTTP ${orgRes.status}`);
            }
        } catch (e) {
            console.log(`   ⚠️  Eventbrite organizer fetch failed: ${e.message}`);
        }

        // ---- SOURCE 2: phantompower.net homepage (SECONDARY) ----
        try {
            const ppRes = await fetch('https://www.phantompower.net/', {
                headers: baseHeaders,
                signal: AbortSignal.timeout(10000)
            });
            if (ppRes.ok) {
                const ppHtml = await ppRes.text();
                const urlRe = /https:\/\/www\.eventbrite\.com\/e\/[^"'\s<>)]+?-(\d+)/g;
                let prevSize = allEventbriteUrls.size;
                const seenIdsPP = new Set();
                let em;
                while ((em = urlRe.exec(ppHtml)) !== null) {
                    if (seenIdsPP.has(em[1])) continue;
                    seenIdsPP.add(em[1]);
                    allEventbriteUrls.add(em[0]);
                }
                const added = allEventbriteUrls.size - prevSize;
                console.log(`   phantompower.net: ${seenIdsPP.size} URL(s) found, ${added} new`);
            }
        } catch (e) { /* best-effort — homepage down is non-critical */ }

        // ---- SOURCE 3: JamBase venue page (TERTIARY, may be blocked) ----
        const jbSeen = new Map(); // url -> { title, date } — used when JamBase works
        try {
            const jbRes = await fetch('https://www.jambase.com/venue/phantom-power', {
                headers: baseHeaders,
                signal: AbortSignal.timeout(15000)
            });
            if (jbRes.ok) {
                const jbHtml = await jbRes.text();
                const showRe = /<a[^>]*href="((?:https:\/\/[^"]+)?\/show\/[^"]*-phantom-power-(\d{4})(\d{2})(\d{2}))"[^>]*>([\s\S]*?)<\/a>/g;
                let m;
                while ((m = showRe.exec(jbHtml)) !== null) {
                    const [, hrefPart, yyyy, mm, dd, rawText] = m;
                    const url = hrefPart.startsWith('http') ? hrefPart : `https://www.jambase.com${hrefPart}`;
                    const text = rawText.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
                    if (!text || text.length < 2) continue;
                    if (/^(Tickets & Info|Calendar|Buy Tickets|More Info)$/i.test(text)) continue;
                    if (jbSeen.has(url)) continue;
                    jbSeen.set(url, { title: text, date: new Date(`${yyyy}-${mm}-${dd}T20:00:00-04:00`) });
                }
                console.log(`   JamBase: ${jbSeen.size} show(s)`);
            } else {
                // 403 "Host not in allowlist" is the known failure mode as of
                // Apr 2026 — log at debug level, not warning, since it's no
                // longer the primary source.
                console.log(`   JamBase: HTTP ${jbRes.status} (source tertiary, not fatal)`);
            }
        } catch (e) { /* silent — JamBase is best-effort */ }

        // ---- EMIT EVENTS: fetch each Eventbrite URL, extract details ----
        console.log(`   Processing ${allEventbriteUrls.size} unique Eventbrite URL(s)...`);
        const ebEventsEmitted = [];
        for (const ebUrl of allEventbriteUrls) {
            try {
                const res = await fetch(ebUrl, { headers: baseHeaders, signal: AbortSignal.timeout(10000) });
                if (!res.ok) continue;
                const ebHtml = await res.text();
                const before = events.length;
                extractPhantomPowerEventFromHTML(ebHtml, ebUrl, events, today, futureDate);
                if (events.length > before) {
                    ebEventsEmitted.push({ url: ebUrl, title: events[events.length - 1].title, date: new Date(events[events.length - 1].date) });
                    ppCount++;
                }
            } catch (e) { /* individual fetch failures are routine */ }
            // Rate limit: Eventbrite is tolerant but we're still polite.
            await new Promise(r => setTimeout(r, 200));
        }

        // Merge JamBase-only shows (not represented in Eventbrite URLs) as
        // events with JamBase as the source link. Rare — most shows have an
        // Eventbrite URL too — but ensures we don't lose a show just because
        // Phantom Power didn't link its Eventbrite equivalent.
        const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        let jbOnlyCount = 0;
        for (const [jbUrl, jb] of jbSeen.entries()) {
            if (jb.date < today || jb.date >= futureDate) continue;
            // Skip if we already emitted a matching Eventbrite event for this show.
            const jbTitleNorm = norm(jb.title);
            const firstWord = jbTitleNorm.split(' ')[0];
            const dupe = ebEventsEmitted.some(eb => {
                const ebNorm = norm(eb.title);
                const titleMatch = firstWord.length >= 3 &&
                    (ebNorm.startsWith(firstWord) || jbTitleNorm.startsWith(ebNorm.split(' ')[0]));
                const dayDiff = Math.abs(eb.date - jb.date) / 86400000;
                return titleMatch && dayDiff <= 2;
            });
            if (dupe) continue;
            events.push({
                title: jb.title,
                date: jb.date.toISOString(),
                location: "Phantom Power",
                tags: ["Other", "Live Music"],
                price: "Ticket Required",
                ticketLink: jbUrl,
                sourceLink: jbUrl
            });
            ppCount++;
            jbOnlyCount++;
        }

        console.log(`✅ Phantom Power: ${ppCount} events (${ebEventsEmitted.length} via Eventbrite, ${jbOnlyCount} JamBase-only)`);

        // ---- DATA QUALITY: alert only on TOTAL pipeline failure ----
        // Earlier version pinged /fail whenever JamBase alone was empty. Now
        // that JamBase is optional, ping only when BOTH Eventbrite sources
        // (organizer + phantompower.net) yielded zero usable events. That's
        // the true "we lost our concert feed" state.
        if (ppCount === 0) {
            console.warn(`⚠️  DATA QUALITY: All Phantom Power sources returned 0 events. Eventbrite organizer, phantompower.net, and JamBase all failed or returned empty.`);
            const healthUrl = process.env.HEALTHCHECK_URL;
            if (healthUrl) {
                try {
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), 5000);
                    await fetch(`${healthUrl}/fail`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/plain' },
                        body: 'Phantom Power scrape produced 0 events — Eventbrite organizer, phantompower.net, and JamBase all unreachable or empty.',
                        signal: ctrl.signal
                    }).catch(() => {});
                    clearTimeout(timer);
                    console.log("   🚨 Fired /fail ping to healthchecks.io");
                } catch (_) { /* never break the scrape on monitoring failure */ }
            }
        }
    } catch (e) { console.error("❌ Phantom Power error:", e.message); }

    // ===== 6. MILLERSVILLE BOROUGH (Google Calendar iCal — with recurring event expansion) =====
    try {
        console.log("📡 Fetching Borough Calendar...");
        const boroughData = await ical.async.fromURL(
            'https://calendar.google.com/calendar/ical/millersville%40millersvilleborough.org/public/basic.ics',
            { headers: baseHeaders }
        );
        let boroughCount = 0;
        let boroughRecurring = 0;
        let boroughCollectionSkipped = 0;
        let boroughSpamSkipped = 0;

        // Recurring municipal collection days (trash/recycling, woody yard waste,
        // appliance/tire) are intentionally NOT surfaced on the app — Adam's
        // call. We drop them here at the source so they never enter events.json
        // (this also keeps them out of the iCal feed, the dashboard counts, and
        // the JSON-LD). Matched narrowly by title so borough MEETINGS, office
        // closings, elections, and park reservations are unaffected. This is
        // anchored on the exact recurring titles from the borough calendar:
        //   "Regular Trash & Recycling Collection"
        //   "Woody Yard Waste Collection"
        //   "Appliance/Tire Collection"
        const BOROUGH_COLLECTION_RE = /\b(trash\s*&?\s*recycling|woody\s*yard\s*waste|appliance\s*\/?\s*tire)\b.*\bcollection\b|\bcollection\b.*\b(trash|recycling|yard waste|appliance|tire)\b/i;

        // Vendor/transaction spam guard. The borough's calendar has an
        // email→event bridge that has twice turned vendor emails into public
        // "events" (an antivirus-renewal notice; a "...Service Bundle Renewed |
        // Payment USD470.77 Processed" receipt). These never describe a real
        // public happening, so we drop them at the source. Three independent
        // signals, ANY of which skips the VEVENT:
        //   1) a money amount WITH cents — "$470.77", "USD470.77", "US$1,200.00".
        //      The required ".dd" is deliberate: a bare "$50" fee is NOT matched,
        //      only formatted transaction totals.
        //   2) payment-status phrasing — "Payment ... Processed/Received/
        //      Confirmed/Declined/..." within a short span.
        //   3) vendor-commerce nouns a community calendar never lists — antivirus,
        //      service bundle, license key, software/subscription renewal,
        //      auto-renew, order/invoice/receipt number.
        // Tuned to spare legitimate municipal items: it matches "software
        // renewal"/"subscription renewal"/"auto-renew" but never bare "renewal",
        // so a "Dog License Renewal" or permit-renewal event survives. Extend the
        // noun list here if a new spam pattern appears. Source-level skip, so it's
        // NOT a Hard-Rule-7 triplicated change (junk never reaches events.json).
        const BOROUGH_SPAM_RE = /(?:USD|EUR|GBP|US\$|\$)\s?\d[\d,]*\.\d{2}\b|\bpayment\b[\s\S]{0,30}\b(?:processed|received|confirmed|successful|completed|declined)\b|\b(?:antivirus|service\s+bundle|license\s+key|software\s+(?:renewal|license)|subscription\s+(?:renewal|renewed)|auto-?renew(?:al|ed)?|(?:order|invoice|receipt)\s+(?:number|#))\b/i;

        for (const ev of Object.values(boroughData)) {
            if (ev.type !== 'VEVENT') continue;

            const title = ev.summary || 'Borough Event';
            const loc = ev.location || 'Millersville Borough';

            // Skip the recurring collection days (see note above). One check
            // here covers BOTH the RRULE-expansion and single-event paths below.
            if (BOROUGH_COLLECTION_RE.test(title)) { boroughCollectionSkipped++; continue; }

            // Drop vendor/transaction spam the borough's email→calendar bridge
            // republishes as public events (see BOROUGH_SPAM_RE). One check here
            // covers BOTH the RRULE and single-event paths, like the collection
            // skip above. Logged WITH the title so any false positive is visible
            // in the Action log.
            if (BOROUGH_SPAM_RE.test(title)) {
                boroughSpamSkipped++;
                console.log(`  🚫 Borough spam filtered: "${title}"`);
                continue;
            }

            // Handle recurring events (RRULE)
            if (ev.rrule) {
                try {
                    const occurrences = ev.rrule.between(pastDate, futureDate);
                    for (const occ of occurrences) {
                        const origStart = new Date(ev.start);
                        
                        // Get the date from the occurrence (UTC components = intended local date)
                        const occYear = occ.getUTCFullYear();
                        const occMonth = occ.getUTCMonth();
                        const occDay = occ.getUTCDate();
                        
                        // Detect all-day events: they have midnight UTC start or the ical 'datetype' is 'date-time' vs 'date'
                        const isAllDay = (origStart.getUTCHours() === 0 && origStart.getUTCMinutes() === 0) ||
                                         (ev.start && ev.start.dateOnly) ||
                                         (ev.datetype === 'date');
                        
                        // For all-day events, use noon UTC so the date stays correct in Eastern time
                        // For timed events, use the original UTC time
                        const origHour = isAllDay ? 12 : origStart.getUTCHours();
                        const origMin = isAllDay ? 0 : origStart.getUTCMinutes();
                        
                        const eventDate = new Date(Date.UTC(occYear, occMonth, occDay, origHour, origMin, 0));

                        // Check for exceptions/modifications (EXDATE)
                        const occKey = `${occYear}-${String(occMonth+1).padStart(2,'0')}-${String(occDay).padStart(2,'0')}`;
                        if (ev.exdate) {
                            const exdates = Object.values(ev.exdate).map(d => {
                                const ed = new Date(d);
                                return `${ed.getUTCFullYear()}-${String(ed.getUTCMonth()+1).padStart(2,'0')}-${String(ed.getUTCDate()).padStart(2,'0')}`;
                            });
                            if (exdates.includes(occKey)) continue;
                        }

                        // Check if this occurrence has been modified (RECURRENCE-ID)
                        if (ev.recurrences && ev.recurrences[occKey]) {
                            const mod = ev.recurrences[occKey];
                            const modTitle = mod.summary || title;
                            const boroughStream = /council/i.test(modTitle) ? 'https://www.youtube.com/@MillersvilleBorough/streams' : '';
                            events.push({
                                title: modTitle,
                                date: new Date(mod.start).toISOString(),
                                endTime: resolveEndTime({ origStart: mod.start, origEnd: mod.end, instanceStart: mod.start, isAllDay }),
                                location: mod.location || loc,
                                tags: ['Borough'],
                                price: 'Free', ticketLink: '',
                                sourceLink: 'https://millersvilleborough.org/resident-info/calendar/',
                                gameResult: '', gameScore: '', streamLink: boroughStream, isLive: false
                            });
                        } else {
                            const boroughStream = /council/i.test(title) ? 'https://www.youtube.com/@MillersvilleBorough/streams' : '';
                            events.push({
                                title,
                                date: eventDate.toISOString(),
                                endTime: resolveEndTime({ origStart: ev.start, origEnd: ev.end, instanceStart: eventDate, isAllDay }),
                                location: loc,
                                tags: ['Borough'],
                                price: 'Free', ticketLink: '',
                                sourceLink: 'https://millersvilleborough.org/resident-info/calendar/',
                                gameResult: '', gameScore: '', streamLink: boroughStream, isLive: false,
                                ...(isAllDay ? { allDay: true } : {})
                            });
                        }
                        boroughCount++;
                        boroughRecurring++;
                    }
                } catch (rrErr) {
                    console.log(`  ⚠️ RRULE expansion failed for "${title}": ${rrErr.message}`);
                }
            } else {
                // Single (non-recurring) event
                let eventDate = new Date(ev.start);
                if (isNaN(eventDate.getTime()) || eventDate < pastDate || eventDate >= futureDate) continue;

                // Fix all-day events: midnight UTC → noon UTC so date stays correct in Eastern
                const singleIsAllDay = (eventDate.getUTCHours() === 0 && eventDate.getUTCMinutes() === 0) ||
                                       (ev.start && ev.start.dateOnly) || (ev.datetype === 'date');
                if (singleIsAllDay) {
                    eventDate = new Date(Date.UTC(eventDate.getUTCFullYear(), eventDate.getUTCMonth(), eventDate.getUTCDate(), 12, 0, 0));
                }

                events.push({
                    title,
                    date: eventDate.toISOString(),
                    endTime: resolveEndTime({ origStart: ev.start, origEnd: ev.end, instanceStart: eventDate, isAllDay: singleIsAllDay }),
                    location: loc,
                    tags: ['Borough'],
                    price: 'Free', ticketLink: '',
                    sourceLink: ev.url || 'https://millersvilleborough.org/resident-info/calendar/',
                    gameResult: '', gameScore: '',
                    streamLink: /council/i.test(title) ? 'https://www.youtube.com/@MillersvilleBorough/streams' : '',
                    isLive: false,
                    ...(singleIsAllDay ? { allDay: true } : {})
                });
                boroughCount++;
            }
        }
        console.log(`✅ Borough Calendar: ${boroughCount} events (${boroughRecurring} from recurring)`);
        if (boroughCollectionSkipped) console.log(`  ⏭️ skipped ${boroughCollectionSkipped} recurring collection day(s) (trash/yard-waste/appliance — intentionally hidden)`);
        if (boroughSpamSkipped) console.log(`  🚫 filtered ${boroughSpamSkipped} vendor/transaction spam event(s) from Borough calendar`);

        // Apply hand-maintained borough-overrides.json. Format:
        //   {"overrides": [{
        //       "date": "2026-06-22T18:00:00-04:00",
        //       "matchTitle": "Reserve Public Meeting Room",
        //       "newTitle": "Conestoga River Community Lecture",
        //       "description": "...",
        //       "sourceLink": "https://millersvilleborough.org/conestoga-river-community-lecture/"
        //   }]}
        //
        // Maintained weekly via Claude Cowork — scan borough's blog/news for
        // upcoming events whose iCal entry uses a generic placeholder title
        // like "Reserve Public Meeting Room", add an override entry to fix
        // the in-app display. Lightweight curation beats the alternative of
        // building a fuzzy-matching enrichment pipeline that we'd only use
        // a handful of times per year.
        //
        // Matching: same calendar-day in ET, time within ±60 minutes, title
        // contains matchTitle (case-insensitive). Two conditions guard
        // against the override accidentally hitting an unrelated event with
        // the same generic title on a different day or time.
        //
        // Stale entries (date >30 days past) are skipped — no need to prune
        // manually, but the file can be cleaned up during the same weekly
        // session if it grows unwieldy.
        try {
            const overridesPath = path.join(__dirname, '../borough-overrides.json');
            let overridesData = null;
            try {
                overridesData = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
            } catch (_) { /* no overrides file — that's the default state */ }

            if (overridesData && Array.isArray(overridesData.overrides)) {
                const now = new Date();
                const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                let applied = 0, stale = 0, unmatched = 0, created = 0;

                for (const ov of overridesData.overrides) {
                    // Enrichment overrides need date + matchTitle + newTitle.
                    // Create-mode overrides (create:true) don't match anything,
                    // so they only need date + newTitle.
                    if (!ov.date || !ov.newTitle) continue;
                    if (!ov.create && !ov.matchTitle) continue;
                    const ovDate = new Date(ov.date);
                    if (isNaN(ovDate.getTime())) continue;
                    if (ovDate < cutoff) { stale++; continue; }

                    // Find the Borough event(s) in the day's window. We
                    // iterate `events` (the final flat list) rather than a
                    // borough-specific subset because by the time this code
                    // runs the borough events have already been pushed.
                    const matchLower = (ov.matchTitle || '').toLowerCase();
                    let matchedThisOverride = false;
                    // Only attempt enrichment-matching when there's a matchTitle.
                    // Create-mode entries skip straight to the creation branch.
                    if (matchLower) for (const e of events) {
                        if (!e.tags || !e.tags.includes('Borough')) continue;
                        if (!(e.title || '').toLowerCase().includes(matchLower)) continue;
                        const eDate = new Date(e.date);
                        if (isNaN(eDate.getTime())) continue;
                        const minDiff = Math.abs(eDate.getTime() - ovDate.getTime()) / 60000;
                        if (minDiff > 60) continue;  // outside ±60min window

                        // Match found — apply override fields. Preserve
                        // everything else (date, location, tags, etc.) since
                        // those come from the authoritative iCal feed.
                        e.title = ov.newTitle;
                        if (ov.description) e.description = ov.description;
                        if (ov.sourceLink) e.sourceLink = ov.sourceLink;
                        if (ov.image) e.image = ov.image;
                        matchedThisOverride = true;
                        applied++;
                        break;  // one override → one event, even if multiple match
                    }

                    if (!matchedThisOverride) {
                        // Creation mode: an override flagged `create: true` that
                        // matched nothing is treated as a standalone event that
                        // lives ONLY in a borough blog post (never on the iCal) —
                        // e.g. National Night Out. Push it as a real Borough event
                        // from the override's own fields. Requires date + newTitle
                        // (already validated above). Without the explicit flag, an
                        // unmatched override stays a harmless no-op, so a renamed
                        // enrichment entry can never accidentally spawn a phantom.
                        if (ov.create === true) {
                            const createdDate = new Date(ov.date);
                            events.push({
                                // Internal marker (stripped before write): flags
                                // this as a create-override so the override-
                                // collision dedupe pass lets it absorb a matching
                                // event the borough may LATER add to its iCal.
                                _overrideCreated: true,
                                title: ov.newTitle,
                                date: createdDate.toISOString(),
                                endTime: ov.endTime ? new Date(ov.endTime).toISOString() : '',
                                location: ov.location || 'Millersville Borough',
                                tags: ['Borough'],
                                price: 'Free', ticketLink: '',
                                sourceLink: ov.sourceLink || 'https://millersvilleborough.org/news/',
                                gameResult: '', gameScore: '', streamLink: '', isLive: false,
                                ...(ov.description ? { description: ov.description } : {}),
                                ...(ov.image ? { image: ov.image } : {})
                            });
                            created++;
                            console.log(`  ➕ Borough override CREATED standalone event: "${ov.newTitle}" (${ov.date})`);
                        } else {
                            unmatched++;
                        }
                    }
                }

                if (applied > 0 || unmatched > 0 || created > 0) {
                    console.log(`  ✅ Borough overrides: ${applied} applied, ${created} created, ${unmatched} unmatched, ${stale} stale`);
                }
                if (unmatched > 0) {
                    // Detail unmatched entries so the next Cowork session
                    // can see which overrides got out of sync with the iCal.
                    // Common causes: borough renamed the calendar entry,
                    // moved the event to a different date, or the override
                    // typo-ed the date.
                    for (const ov of overridesData.overrides) {
                        if (!ov.date || !ov.matchTitle || !ov.newTitle) continue;
                        const ovDate = new Date(ov.date);
                        if (isNaN(ovDate.getTime()) || ovDate < cutoff) continue;
                        const matchLower = ov.matchTitle.toLowerCase();
                        const found = events.some(e =>
                            (e.tags || []).includes('Borough') &&
                            (e.title || '').toLowerCase().includes(matchLower) &&
                            !isNaN(new Date(e.date).getTime()) &&
                            Math.abs(new Date(e.date).getTime() - ovDate.getTime()) / 60000 <= 60
                        );
                        if (!found) {
                            console.log(`     ⚠️  unmatched override: "${ov.newTitle}" expected on ${ov.date}`);
                        }
                    }
                }
            }
        } catch (e) { console.log(`  ⚠️ Borough overrides error: ${e.message}`); }
    } catch (e) { console.error("❌ Borough Calendar error:", e.message); }


    // ===== 6d. MANOR TOWNSHIP (The Events Calendar iCal — municipal meetings) =====
    // Manor Township is the other municipality covering part of the area; its public
    // calendar is government meetings (Supervisors, Planning Commission, Zoning Hearing
    // Board, Traffic Commission) — townie-side civic content. Same Events Calendar
    // platform as Penn Manor, so we reuse the paginated iCal pattern, simplified:
    // upcoming only, single 'Manor' tag (the frontend gates it to townies and renders
    // the "Manor Twp." source pill). NOTE: if recurring meetings only show their next
    // instance, the feed is exporting an RRULE instead of expanded VEVENTs — add
    // recurrence expansion here (mirrors the Borough expansion block above).
    try {
        console.log("📡 Fetching Manor Township iCal...");
        let allManorEvents = {};
        const manorUrl = 'https://manortownship.net/calendar/list/?ical=1&tribe_event_display=list&tribe_paged=';
        const manorMaxPages = 10;
        for (let page = 1; page <= manorMaxPages; page++) {
            try {
                const pageData = await ical.async.fromURL(manorUrl + page, { headers: baseHeaders });
                const pageEvents = Object.values(pageData).filter(e => e.type === 'VEVENT');
                console.log(`  → Manor page ${page}: ${pageEvents.length} VEVENTs`);
                if (pageEvents.length === 0) break;
                let newCount = 0;
                for (const [key, val] of Object.entries(pageData)) {
                    if (val.type === 'VEVENT') {
                        const uid = val.uid || key;
                        if (!allManorEvents[uid]) newCount++;
                        allManorEvents[uid] = val;
                    }
                }
                if (pageEvents.length < 30 || newCount === 0) break;  // partial/last page or all dupes
            } catch (err) {
                console.log(`  → Manor page ${page} failed: ${err.message}`);
                break;
            }
        }

        let manorCount = 0;
        for (const ev of Object.values(allManorEvents)) {
            const eventDate = new Date(ev.start);
            if (isNaN(eventDate.getTime()) || eventDate < pastDate || eventDate >= futureDate) continue;
            const title = (ev.summary || 'Manor Township Event').trim();
            events.push({
                title,
                date: eventDate.toISOString(),
                endTime: resolveEndTime({ origStart: ev.start, origEnd: ev.end, instanceStart: eventDate }),
                location: ev.location || 'Manor Township Municipal Building',
                description: ev.description || '',
                tags: ['Manor'], price: "Free", ticketLink: "",
                sourceLink: ev.url || "https://manortownship.net/calendar/"
            });
            manorCount++;
        }
        console.log(`✅ Manor Township: ${manorCount} events`);
    } catch (e) { console.error("❌ Manor Township error:", e.message); }


    // ===== 6e. RANEY CELLARS BREWING (The Events Calendar iCal) =====
    // Raney Cellars is a local brewery at 11 Manor Ave, Millersville. Their
    // WordPress site runs The Events Calendar plugin (same platform as Penn Manor
    // and Manor Township), exposing a clean iCal feed. Content is food trucks,
    // trivia nights, and live music — townie-side community/entertainment content.
    // Hidden from Marauders by default (feed pref 'raney-cellars-all').
    // iCal URL: https://www.raneycellarsbrewing.com/?ical=1
    // No RRULE expansion needed — feed exports individual VEVENTs only.
    // No price field set: events are community happenings, not free admissions.
    try {
        console.log("📡 Fetching Raney Cellars iCal...");
        let allRaneyEvents = {};
        const raneyUrl = 'https://www.raneycellarsbrewing.com/?ical=1&tribe_event_display=list&tribe_paged=';
        const raneyMaxPages = 5;
        for (let page = 1; page <= raneyMaxPages; page++) {
            try {
                const pageData = await ical.async.fromURL(raneyUrl + page, { headers: baseHeaders });
                const pageEvents = Object.values(pageData).filter(e => e.type === 'VEVENT');
                console.log(`  → Raney page ${page}: ${pageEvents.length} VEVENTs`);
                if (pageEvents.length === 0) break;
                let newCount = 0;
                for (const [key, val] of Object.entries(pageData)) {
                    if (val.type === 'VEVENT') {
                        const uid = val.uid || key;
                        if (!allRaneyEvents[uid]) newCount++;
                        allRaneyEvents[uid] = val;
                    }
                }
                if (pageEvents.length < 30 || newCount === 0) break;
            } catch (err) {
                console.log(`  → Raney page ${page} failed: ${err.message}`);
                break;
            }
        }

        let raneyCount = 0;
        for (const ev of Object.values(allRaneyEvents)) {
            const eventDate = new Date(ev.start);
            if (isNaN(eventDate.getTime()) || eventDate < pastDate || eventDate >= futureDate) continue;
            const title = (ev.summary || 'Raney Cellars Event').trim();
            events.push({
                title,
                date: eventDate.toISOString(),
                endTime: (() => {
                    const resolved = resolveEndTime({ origStart: ev.start, origEnd: ev.end, instanceStart: eventDate });
                    if (!resolved) return undefined;
                    // Guard against WordPress data-entry errors (e.g. end date accidentally
                    // set to next day). Cap timed Raney events at 12h; anything longer is
                    // treated as no explicit end and falls back to the render-time default.
                    const durMs = new Date(resolved).getTime() - eventDate.getTime();
                    return durMs <= 12 * 60 * 60 * 1000 ? resolved : undefined;
                })(),
                location: ev.location || 'Raney Cellars Brewing',
                description: ev.description || '',
                tags: ['Raney Cellars'], price: '', ticketLink: '',
                sourceLink: ev.url || 'https://www.raneycellarsbrewing.com/events/'
            });
            raneyCount++;
        }
        console.log(`✅ Raney Cellars: ${raneyCount} events`);
    } catch (e) { console.error("❌ Raney Cellars error:", e.message); }


    // ===== 6b. PENN MANOR COMMUNITY EVENTS — hand-curated overrides =====
    //
    // Penn Manor's community page (https://www.pennmanor.net/community/) lists
    // datebound community events as prose announcements with no machine-readable
    // calendar feed. These are community-aggregated events (Girl Scouts, soccer
    // camps, Bible2School, etc.) — not Penn Manor School District proper — so
    // they tag as "Other" alongside the concerts/trivia bucket, not "PM" which
    // is reserved for school district content (school events, board, athletics).
    //
    // Cowork weekly reads that page, extracts candidate events, and opens a PR
    // adding them to penn-manor-overrides.json with status: "pending". User
    // reviews the PR on GitHub mobile, flips the status to "approved" (or
    // rejects by closing the PR) before merging.
    //
    // ONLY entries with status: "approved" become real events. Anything else —
    // "pending", missing, "rejected", typo'd — is silently skipped. This makes
    // the file safe to have unreviewed candidates sitting in it; merging a PR
    // with status:"pending" still adds nothing to the site.
    //
    // Stale entries (>30 days past) are auto-skipped, same as Borough.
    try {
        const pmPath = path.join(__dirname, '../penn-manor-overrides.json');
        let pmData = null;
        try {
            pmData = JSON.parse(fs.readFileSync(pmPath, 'utf8'));
        } catch (_) { /* file may not exist yet — that's fine */ }

        if (pmData && Array.isArray(pmData.events)) {
            const now = new Date();
            const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            let added = 0, pending = 0, stale = 0, skipped = 0;

            for (const ev of pmData.events) {
                if (!ev.date || !ev.title) { skipped++; continue; }
                const evDate = new Date(ev.date);
                if (isNaN(evDate.getTime())) { skipped++; continue; }
                if (evDate < cutoff) { stale++; continue; }

                // The approval gate.
                if (ev.status !== 'approved') {
                    if (ev.status === 'pending') pending++;
                    else skipped++;
                    continue;
                }

                // Registration deadline gate: if a deadline is set and has
                // passed, hide the event entirely. The whole reason this exists
                // is so users don't see camps/classes after registration closed
                // and click through to a dead end. Use end-of-deadline-day in
                // ET so "register by June 1" doesn't expire at midnight UTC
                // (which is 8pm ET the previous evening).
                if (ev.registrationDeadline) {
                    const deadline = new Date(ev.registrationDeadline);
                    if (!isNaN(deadline.getTime()) && deadline < now) {
                        skipped++;
                        console.log(`     ⏰ skipping "${ev.title}" — registration closed ${ev.registrationDeadline}`);
                        continue;
                    }
                }

                const pushed = {
                    title: ev.title,
                    date: evDate.toISOString(),
                    endTime: ev.endTime ? new Date(ev.endTime).toISOString() : '',
                    location: ev.location || 'Penn Manor',
                    tags: ['Other'],
                    price: ev.price || 'Free',
                    ticketLink: '',
                    sourceLink: ev.sourceLink || 'https://www.pennmanor.net/community/',
                    gameResult: '', gameScore: '', streamLink: '', isLive: false,
                    ...(ev.description ? { description: ev.description } : {}),
                    ...(ev.image ? { image: ev.image } : {})
                };
                // Pass through the registrationRequired flag if set, so the
                // card render layer can display the "Registration required"
                // badge. The field is intentionally a top-level boolean (not
                // hidden in description) so the front-end can style it.
                if (ev.registrationRequired === true) {
                    pushed.registrationRequired = true;
                }
                // Carry the registration close/open dates through so PM Community
                // registrations behave like full signups: they surface in Upcoming
                // Signups with a countdown (and the three-state "Opens <date>" when
                // a future open date is set). The deadline skip-check above already
                // hides the event once registration has closed, so anything pushed
                // here is still open (or has no deadline at all).
                if (ev.registrationDeadline) pushed.registrationDeadline = ev.registrationDeadline;
                if (ev.registrationOpens) pushed.registrationOpens = ev.registrationOpens;
                events.push(pushed);
                added++;
            }

            if (added > 0 || pending > 0 || stale > 0 || skipped > 0) {
                console.log(`  ✅ Penn Manor community: ${added} added, ${pending} pending review, ${stale} stale, ${skipped} skipped`);
            }
        }
    } catch (e) { console.log(`  ⚠️ Penn Manor overrides error: ${e.message}`); }


    // ===== 6c. YOUTH SPORTS REGISTRATION DEADLINES =====
    //
    // Local youth sports orgs (Penn Manor Youth Baseball/Softball, Penn Manor
    // Soccer Club, etc.) have registration windows that townies with kids care
    // about. youth-sports-registration.json holds these; each ACTIVE entry whose
    // deadline hasn't passed becomes an event dated ON the deadline, using the
    // entry's human title (e.g. "Junior Comets Football & Cheerleading"). It's a
    // signup deadline, not an event you attend — the 📝 "Registration required"
    // badge and "Register Now" button make that clear. registrationDeadline auto-hides
    // it the moment the deadline passes. The homepage "Upcoming Signups" section
    // reads the SAME file client-side (see app.js renderHomeUI) to surface these
    // to townies starting 2 weeks out — that part is front-end, not here.
    try {
        const ysrPath = path.join(__dirname, '../youth-sports-registration.json');
        let ysrData = null;
        try { ysrData = JSON.parse(fs.readFileSync(ysrPath, 'utf8')); } catch (_) {}

        if (ysrData && Array.isArray(ysrData.registrations)) {
            const now = new Date();
            let added = 0, closed = 0, skipped = 0;
            for (const reg of ysrData.registrations) {
                if (reg.status !== 'active') { skipped++; continue; }
                if (!reg.deadline || !reg.org) { skipped++; continue; }
                const dl = new Date(reg.deadline);
                if (isNaN(dl.getTime())) { skipped++; continue; }
                if (dl < now) { closed++; continue; }  // deadline passed — don't create

                // Human-readable deadline date (e.g. "Feb 28") for the description.
                const dlLabel = dl.toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', timeZone: 'America/New_York'
                });
                // Title: prefer an explicit, human-written title from the entry
                // (the sheet's Title column flows into reg.title via
                // sync-candidates.js). Otherwise fall back to the org name plus
                // the sport, appending the sport only when the org doesn't
                // already say it (avoids "Youth Baseball & Softball Baseball &
                // Softball"). We deliberately DON'T prefix "Register by <date>:"
                // anymore — the deadline is already communicated by the 📝
                // "Registration required" badge, the homepage "Upcoming Signups"
                // reminder, and the "Register Now" button — so repeating it in
                // the title just made these titles long.
                const orgLower = (reg.org || '').toLowerCase();
                const sportPart = (reg.sport && !orgLower.includes(reg.sport.toLowerCase()))
                    ? ` ${reg.sport}` : '';
                const eventTitle = (reg.title && reg.title.trim())
                    ? reg.title.trim()
                    : `${reg.org}${sportPart}`;
                events.push({
                    title: eventTitle,
                    date: dl.toISOString(),
                    endTime: '',
                    location: reg.org,
                    tags: ['Other'],
                    price: 'Free',
                    // Registration events carry a dedicated registerLink (NOT a
                    // ticketLink) so the UI renders "📝 Register Now" → signup
                    // page rather than a "🎟 Tickets" affordance. sourceLink
                    // mirrors it as a harmless fallback for older consumers.
                    registerLink: reg.registerLink || '',
                    sourceLink: reg.registerLink || 'https://www.pennmanor.net/community/',
                    gameResult: '', gameScore: '', streamLink: '', isLive: false,
                    registrationRequired: true,
                    registrationDeadline: reg.deadline,
                    ...(reg.opens ? { registrationOpens: reg.opens } : {}),
                    kidFriendly: true,
                    description: [
                        reg.season ? `${reg.season} season.` : '',
                        reg.ageRange ? `${reg.ageRange}.` : '',
                        reg.note || '',
                        `Registration closes ${dlLabel}. Sign up via the link.`
                    ].filter(Boolean).join(' ')
                });
                added++;
            }
            if (added > 0 || closed > 0 || skipped > 0) {
                console.log(`  ✅ Youth sports registration: ${added} open, ${closed} closed, ${skipped} skipped`);
            }
        }
    } catch (e) { console.log(`  ⚠️ Youth sports registration error: ${e.message}`); }
	
	// ===== 6c-2. INTRAMURAL SIGNUPS (imleagues.json) =====
    //
    // MU intramural signups, scraped manually via scripts/scrape-imleagues.js
    // (IMLeagues is an Angular SPA that blocks GHA IPs, so it can't run in this
    // cron — run locally, commit imleagues.json). Same model as youth sports
    // above: each ACTIVE entry whose deadline hasn't passed becomes an event
    // dated ON the deadline, with the 📝 "Registration required" badge. Unlike
    // youth sports these are MU-student events (kidFriendly:false). Season +
    // registration window live in the description.
    //
    // imleagues.json is a flat array of:
    //   { status:"active", sport, league, title, deadline (ISO Z),
    //     registrationWindow, season, registerLink }
    try {
        const imlPath = path.join(__dirname, '../imleagues.json');
        let imlData = null;
        try { imlData = JSON.parse(fs.readFileSync(imlPath, 'utf8')); } catch (_) {}

        if (Array.isArray(imlData)) {
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
            if (added > 0 || closed > 0 || skipped > 0) {
                console.log(`  ✅ Intramural signups: ${added} open, ${closed} closed, ${skipped} skipped`);
            }
        }
    } catch (e) { console.log(`  ⚠️ Intramural signups (imleagues.json) error: ${e.message}`); }


    // ===== 7. VFW POST 7294 — hand-maintained via vfw.json + Cowork =====
    //
    // PREVIOUSLY: Google Sheet of image URLs → Anthropic Vision API extracted
    // structured event/specials data → cached in vfw-cache.json. The Vision
    // pipeline worked but had recurring edge cases (expired specials slipping
    // through, calendar images returning useless event lists, dollar-cost
    // creep) and required Adam to manually post images to the sheet weekly
    // anyway. The simpler answer is to skip the API call entirely and
    // transcribe the data from the VFW blog (https://www.vfwpost7294.org/)
    // during the same weekly Cowork session.
    //
    // The Vision code is preserved below in `if (false) { ... }` rather than
    // deleted — easy to re-enable if Cowork doesn't pan out. To fully remove
    // later: delete the dead block, delete vfw-cache.json, remove
    // VFW_SHEET_ID / GOOGLE_VISION_API_KEY secrets from GitHub Actions.
    try {
        let vfwEventCount = 0;
        let vfwWeeklySpecials = [], vfwSpecialsDateRange = '';

        // ===== HAND-MAINTAINED LOADER (active path) =====
        try {
            const vfwPath = path.join(__dirname, '../vfw.json');
            const vfwData = JSON.parse(fs.readFileSync(vfwPath, 'utf8'));

            // Weekly specials: only show if still valid. validThrough is an
            // exclusive end date (the day AFTER the last day specials are
            // good for) so the entry disappears at midnight ET the morning
            // after expiration. If validThrough is missing, treat as
            // permanently expired — better to show nothing than stale data.
            if (vfwData.weeklySpecials && Array.isArray(vfwData.weeklySpecials.items)) {
                const validThrough = vfwData.weeklySpecials.validThrough
                    ? new Date(vfwData.weeklySpecials.validThrough + 'T00:00:00-04:00')
                    : null;
                const isCurrent = validThrough && new Date() < validThrough;
                if (isCurrent) {
                    vfwSpecialsDateRange = vfwData.weeklySpecials.dateRange || '';
                    // Parse "Item Name – $Price (Fri only)" → { name, price, fridayOnly }.
                    // The dash is the en-dash (–), matching what the Vision
                    // pipeline used to produce. Plain hyphen is also accepted.
                    vfwWeeklySpecials = vfwData.weeklySpecials.items.map(line => {
                        const fridayOnly = /\((Fri|Friday)\s+only\)/i.test(line);
                        const cleaned = line.replace(/\((Fri|Friday)\s+only\)/i, '').trim();
                        const m = cleaned.match(/^(.+?)\s*[–-]\s*(\$?[\d.,]+)\s*$/);
                        if (m) return { name: m[1].trim(), price: m[2].trim(), fridayOnly };
                        // Couldn't parse price — keep whole string as name, no price
                        return { name: cleaned, price: '', fridayOnly };
                    });
                    console.log(`  🍽️ VFW specials: ${vfwWeeklySpecials.length} items (${vfwData.weeklySpecials.dateRange})`);
                } else if (validThrough) {
                    console.log(`  ⏭️  VFW specials expired (validThrough ${vfwData.weeklySpecials.validThrough}) — skipping`);
                }
            }

            // Events: each entry becomes a future event in the main feed,
            // filtered by date window. Tags are ['Other', 'VFW'] matching
            // the old Vision pipeline so frontend filtering stays consistent.
            const vfwEventsArr = Array.isArray(vfwData.events) ? vfwData.events : [];
            for (const ev of vfwEventsArr) {
                if (!ev.title || !ev.date) continue;
                const evDate = new Date(ev.date);
                if (isNaN(evDate.getTime())) continue;
                if (evDate < pastDate || evDate >= futureDate) continue;
                const evEnd = ev.endTime && !isNaN(new Date(ev.endTime).getTime())
                    ? new Date(ev.endTime).toISOString()
                    : undefined;
                events.push({
                    title: ev.title,
                    date: evDate.toISOString(),
                    endTime: evEnd,
                    location: 'VFW Post 7294, 219 Walnut Hill Rd',
                    tags: ['Other', 'VFW'],
                    price: ev.price || 'Free',
                    ticketLink: '',
                    sourceLink: 'https://www.vfwpost7294.org/',
                    description: ev.description || '',
                    gameResult: '', gameScore: '', streamLink: '', isLive: false
                });
                vfwEventCount++;
            }
            console.log(`✅ VFW: ${vfwEventCount} events from vfw.json (Cowork-maintained)`);
        } catch (e) {
            console.error(`❌ VFW vfw.json load error: ${e.message}`);
        }

        // ===== LEGACY VISION PIPELINE (disabled, preserved for reference) =====
        if (false) {
        console.log("📡 Fetching VFW Post 7294 images from Google Sheet...");
        const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
        if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');

        const VFW_SHEET_ID = process.env.VFW_SHEET_ID || '';
        const cachePath = path.join(__dirname, '../vfw-cache.json');
        let vfwCache = {};
        try {
            vfwCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            for (const [key, val] of Object.entries(vfwCache)) {
                if (!val || (typeof val === 'string' && val.trim().length === 0)) delete vfwCache[key];
            }
        } catch (e) { /* no cache yet */ }

        let vfwEventCount = 0, vfwApiCalls = 0;
        let vfwWeeklySpecials = [], vfwSpecialsDateRange = '';

        // Fetch image URLs from Google Sheet
        let sheetImages = [];
        if (VFW_SHEET_ID) {
            try {
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${VFW_SHEET_ID}/gviz/tq?tqx=out:csv`;
                const sheetRes = await fetch(sheetUrl);
                if (sheetRes.ok) {
                    const csvText = await sheetRes.text();
                    for (const row of csvText.split('\n').slice(1)) {
                        const cols = row.match(/"([^"]*)"/g);
                        if (!cols || cols.length < 1) continue;
                        const imgUrl = cols[0].replace(/"/g, '').trim();
                        const postDate = cols[1] ? cols[1].replace(/"/g, '').trim() : '';
                        if (imgUrl && /^https?:\/\//.test(imgUrl)) {
                            sheetImages.push({ url: imgUrl, date: postDate });
                        }
                    }
                    console.log(`  📋 Google Sheet: ${sheetImages.length} image(s)`);
                }
            } catch (e) { console.log(`  ⚠️ Sheet error: ${e.message}`); }
        } else {
            console.log(`  ⚠️ VFW_SHEET_ID not set — skipping`);
        }

        // Process each image with Claude Vision
        for (const si of sheetImages) {
          try {
            // Check cache first
            let parsed = vfwCache[si.url];
            if (parsed && typeof parsed === 'object' && parsed.type) {
                console.log(`  📱 Image (${si.date || 'no date'}): cached as ${parsed.type}`);
            } else {
                // Convert Google Drive URLs to direct download
                let downloadUrl = si.url;
                const driveMatch = si.url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
                const driveMatch2 = si.url.match(/drive\.google\.com\/open\?id=([^&]+)/);
                const driveId = driveMatch?.[1] || driveMatch2?.[1];
                if (driveId) {
                    downloadUrl = `https://drive.google.com/uc?export=download&id=${driveId}`;
                }

                // Download image
                const isFacebookCDN = downloadUrl.includes('fbcdn.net') || downloadUrl.includes('facebook.com');
                const dlHeaders = isFacebookCDN ? {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://www.facebook.com/',
                    'Sec-Fetch-Dest': 'image',
                    'Sec-Fetch-Mode': 'no-cors',
                    'Sec-Fetch-Site': 'cross-site'
                } : baseHeaders;
                const imgRes = await fetch(downloadUrl, { headers: dlHeaders, signal: AbortSignal.timeout(15000), redirect: 'follow' });
                if (!imgRes.ok) {
                    if (isFacebookCDN) {
                        console.log(`    ⚠️ Facebook CDN expired (403) — save image to Google Drive and update sheet URL`);
                        console.log(`      URL: ${si.url.substring(0, 100)}...`);
                    } else {
                        console.log(`    ⚠️ Download failed: ${imgRes.status} (${si.url.substring(0, 80)})`);
                    }
                    continue;
                }
                const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
                if (imgBuffer.length < 1000) { console.log(`    ⚠️ Tiny image, skipping`); continue; }

                // Detect media type
                const isJpeg = imgBuffer[0] === 0xFF && imgBuffer[1] === 0xD8;
                const isPng = imgBuffer[0] === 0x89 && imgBuffer[1] === 0x50;
                const mediaType = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : 'image/jpeg';

                // Send to Claude Vision API
                const prompt = `Analyze this VFW Post 7294 image. Today is ${today.toISOString().split('T')[0]}. Determine the type and extract structured data.

Respond ONLY with valid JSON (no markdown, no backticks), using one of these formats:

If it's a MONTHLY CALENDAR with events:
{"type":"calendar","month":"April","year":2026,"events":[{"name":"Music Bingo","date":"2026-04-10"},{"name":"Trivia Night","date":"2026-04-15"}]}
Only include special events like Bingo, Trivia, Meetings, Parties, BBQ, Paint nights, Concerts. Do NOT include recurring food nights (Shrimp Night, Wing Night, Taco Night, Burger Night) or daily food specials.

If it's a WEEKLY SPECIALS flyer:
{"type":"specials","dateRange":"Tuesday, April 7 through Saturday, April 11","items":[{"name":"Tuna Melt","price":"$12.95","fridayOnly":false},{"name":"Prime Rib","price":"$17.95","fridayOnly":true}]}
Extract food item names, prices, and whether they are Friday-only.

If it's an EVENT FLYER/ANNOUNCEMENT:
{"type":"event","name":"Meat Tray Bingo","date":"2026-05-03","time":"1:00 PM","endTime":"5:00 PM","details":"Doors open 12:00 PM, Starter Packs $25","openToPublic":true}
- "time" is the start time when shown (use "H:MM AM/PM" format).
- "endTime" is the end time, ONLY when explicitly shown on the flyer (e.g. "5pm-9pm", "from 6 to 10", "1:00 PM - 5:00 PM"). Use the same "H:MM AM/PM" format. Omit the field entirely if no end time is shown — do NOT guess or estimate.

Respond with ONLY the JSON object.`;

                const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': ANTHROPIC_KEY,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: 'claude-sonnet-4-20250514',
                        max_tokens: 1024,
                        messages: [{
                            role: 'user',
                            content: [
                                { type: 'image', source: { type: 'base64', media_type: mediaType, data: imgBuffer.toString('base64') } },
                                { type: 'text', text: prompt }
                            ]
                        }]
                    })
                });

                if (!claudeRes.ok) {
                    const err = await claudeRes.text();
                    console.log(`    ⚠️ Claude API error: ${err.substring(0, 200)}`);
                    continue;
                }

                const claudeData = await claudeRes.json();
                const responseText = claudeData.content?.[0]?.text || '';
                vfwApiCalls++;

                try {
                    // Strip any markdown fences if present
                    const cleanJson = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
                    parsed = JSON.parse(cleanJson);
                    vfwCache[si.url] = parsed;
                    console.log(`  📱 Image (${si.date || 'no date'}): ${parsed.type}`);
                } catch (jsonErr) {
                    console.log(`    ⚠️ Failed to parse Claude response: ${responseText.substring(0, 200)}`);
                    continue;
                }
            }

            const postLink = 'https://www.facebook.com/VFWPost7294';

            // ===== CALENDAR =====
            if (parsed.type === 'calendar' && parsed.events) {
                console.log(`    📅 Calendar: ${parsed.month} ${parsed.year}, ${parsed.events.length} events`);
                for (const evt of parsed.events) {
                    if (!evt.date || !evt.name) continue;
                    const evDate = new Date(evt.date + 'T16:00:00Z');
                    if (isNaN(evDate.getTime()) || evDate < pastDate || evDate >= futureDate) continue;
                    // Skip recurring food nights
                    if (/^(wing night|taco night|burger night|shrimp night)$/i.test(evt.name)) continue;
                    events.push({
                        title: evt.name, date: evDate.toISOString(),
                        location: 'VFW Post 7294, 219 Walnut Hill Rd',
                        tags: ['Other', 'VFW'], price: 'Members Only', ticketLink: '', sourceLink: postLink,
                        gameResult: '', gameScore: '', streamLink: '', isLive: false, kidFriendly: false
                    });
                    vfwEventCount++;
                    console.log(`    📌 Event: "${evt.name}" on ${evt.date}`);
                }

            // ===== WEEKLY SPECIALS =====
            } else if (parsed.type === 'specials' && parsed.items && vfwWeeklySpecials.length === 0) {
                console.log(`    🍽️ Weekly specials: ${parsed.items.length} items`);
                if (parsed.dateRange) console.log(`    📅 Range: ${parsed.dateRange}`);

                // Check if current week
                let isCurrent = true;
                if (parsed.dateRange) {
                    const months = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11};
                    const sm = parsed.dateRange.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i);
                    const em = parsed.dateRange.match(/through\s+\w+,?\s*(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(\d{1,2})/i);
                    if (sm && em) {
                        const yr = today.getFullYear();
                        const sM = months[sm[1].toLowerCase()], sD = parseInt(sm[2]);
                        const eM = months[(em[1] || sm[1]).toLowerCase()], eD = parseInt(em[2]);
                        if (today < new Date(yr, sM, sD) || today > new Date(yr, eM, eD, 23, 59, 59)) {
                            isCurrent = false;
                            console.log(`    ⏭️ Expired (${parsed.dateRange})`);
                        }
                    }
                }

                if (isCurrent) {
                    vfwWeeklySpecials = parsed.items.map(s => ({
                        name: s.name, price: s.price || '', fridayOnly: s.fridayOnly || false,
                        dateRange: parsed.dateRange || ''
                    }));
                    vfwSpecialsDateRange = parsed.dateRange || '';
                    parsed.items.forEach(s => console.log(`    🍽️ ${s.name} – ${s.price}${s.fridayOnly ? ' (Fri only)' : ''}`));
                    console.log(`    ✅ Current week specials`);
                }

            // ===== EVENT FLYER =====
            } else if (parsed.type === 'event' && parsed.name) {
                const evDateStr = parsed.date || '';
                // Prefer the flyer's stated start time when present; fall back to
                // the noon-ET placeholder used for date-only events. Same pattern
                // for end time: only set endTime when the flyer explicitly shows
                // an end time (Vision is told not to guess).
                const startStrET = combineDateAndClockTime(evDateStr, parsed.time);
                const startMs = startStrET ? parseEventInstant(startStrET)
                                           : (evDateStr ? new Date(evDateStr + 'T16:00:00Z').getTime() : NaN);
                let endMs = NaN;
                if (parsed.endTime) {
                    const endStrET = combineDateAndClockTime(evDateStr, parsed.endTime);
                    if (endStrET) {
                        endMs = parseEventInstant(endStrET);
                        // Cross-midnight handling: a flyer that says "10pm-1am"
                        // means the end is on the next calendar day. If endMs
                        // isn't strictly after startMs, bump 24h.
                        if (!isNaN(endMs) && !isNaN(startMs) && endMs <= startMs) {
                            endMs += 24 * 3600 * 1000;
                        }
                    }
                }
                if (!isNaN(startMs) && startMs >= pastDate.getTime() && startMs < futureDate.getTime()) {
                    const priceTag = parsed.openToPublic ? 'Open to Public' : 'Members Only';
                    events.push({
                        title: parsed.name,
                        date: new Date(startMs).toISOString(),
                        endTime: !isNaN(endMs) ? new Date(endMs).toISOString() : undefined,
                        location: 'VFW Post 7294, 219 Walnut Hill Rd',
                        // The flyer image itself, courtesy of the Google Sheet
                        // upload pipeline. Stored even though the frontend
                        // doesn't render images on event cards yet — gets us a
                        // real withImage% on the status dashboard, and unlocks
                        // future image-rendering UI without re-scraping.
                        image: si.url || '',
                        tags: ['Other', 'VFW'], price: priceTag, ticketLink: '', sourceLink: postLink,
                        gameResult: '', gameScore: '', streamLink: '', isLive: false, kidFriendly: false
                    });
                    vfwEventCount++;
                    console.log(`    📌 Event: "${parsed.name}" on ${evDateStr}${parsed.time ? ' at ' + parsed.time : ''}${parsed.endTime ? '–' + parsed.endTime : ''}`);
                }
            }

          } catch (err) { console.log(`    ⚠️ Error: ${err.message}`); }
        }

        // Save cache + specials
        fs.writeFileSync(cachePath, JSON.stringify(vfwCache, null, 2));
        console.log(`✅ VFW: ${vfwEventCount} events (${vfwApiCalls} API calls, ${Object.keys(vfwCache).length} cached)`);
        } // ===== END LEGACY VISION PIPELINE =====

        // ===== JOHN HERR'S WEEKLY GROCERY DEALS =====
        //
        // PREVIOUSLY: print page → image downloads → Anthropic Vision API
        // extracted top 15-20 deals as structured JSON → cached weekly in
        // grocery-cache.json with a Thursday refresh trigger. The pipeline
        // worked but cost one Vision call per week (~$0.15-$0.40 per run)
        // and was the LAST Vision call in the scraper after VFW switched
        // to hand-maintained data.
        //
        // NOW: hand-maintained grocery.json populated via Cowork. Transcribe
        // ~15 top deals from the weekly circular into the JSON. Same
        // dateRange + validThrough auto-expiry pattern as vfw.json.
        //
        // Vision pipeline preserved below in `if (false)` for easy
        // re-enable if Cowork doesn't pan out. To fully remove later:
        // delete the dead block, delete grocery-cache.json, optionally
        // remove ANTHROPIC_API_KEY from secrets (also used by no other
        // scraper paths after this change — verify before removal).
        let groceryDeals = [];

        // ===== HAND-MAINTAINED LOADER (active path) =====
        try {
            const groceryPath = path.join(__dirname, '../grocery.json');
            const groceryData = JSON.parse(fs.readFileSync(groceryPath, 'utf8'));

            // Only show deals if still valid. validThrough is the exclusive
            // end date — deals disappear at midnight ET the day after.
            const validThrough = groceryData.validThrough
                ? new Date(groceryData.validThrough + 'T00:00:00-04:00')
                : null;
            const isCurrent = validThrough && new Date() < validThrough;

            if (isCurrent && Array.isArray(groceryData.deals) && groceryData.deals.length > 0) {
                const dateRange = groceryData.dateRange || '';
                // The downstream specials.json writer expects each deal to
                // have a dateRange field on the object itself (not on a
                // parent). Spread + add to match the Vision pipeline shape.
                groceryDeals = groceryData.deals.map(d => ({
                    item: d.item || '',
                    salePrice: d.salePrice || '',
                    regularPrice: d.regularPrice || '',
                    savings: d.savings || '',
                    dateRange
                }));
                console.log(`✅ John Herr's: ${groceryDeals.length} deals from grocery.json (${dateRange})`);
            } else {
                // grocery.json missing, empty, or expired. Try the legacy
                // Vision-pipeline cache as a fallback so the site doesn't
                // go blank between deploy and first Cowork update. The cache
                // file ages out naturally once it stops being refreshed;
                // when it expires we honestly have nothing to show, which
                // is the right state to surface (rather than stale prices).
                try {
                    const legacyCache = JSON.parse(fs.readFileSync(path.join(__dirname, '../grocery-cache.json'), 'utf8'));
                    if (legacyCache.deals && legacyCache.deals.length > 0) {
                        groceryDeals = legacyCache.deals;
                        console.log(`  📦 John Herr's: ${groceryDeals.length} deals from legacy cache (grocery.json ${validThrough ? 'expired' : 'empty'} — Cowork update needed)`);
                    }
                } catch (_) { /* no legacy cache — silent */ }

                if (groceryDeals.length === 0) {
                    if (validThrough) {
                        console.log(`  ⏭️  John Herr's deals expired (validThrough ${groceryData.validThrough}), no legacy cache — skipping`);
                    } else {
                        console.log(`  ⏭️  John Herr's deals missing validThrough, no legacy cache — skipping (Cowork update needed)`);
                    }
                }
            }
        } catch (e) {
            console.log(`  ⚠️ John Herr's grocery.json load error: ${e.message}`);
        }

        // ===== LEGACY VISION PIPELINE (disabled, preserved for reference) =====
        if (false) {
        try {
            const groceryCachePath = path.join(__dirname, '../grocery-cache.json');
            let groceryCache = {};
            try { groceryCache = JSON.parse(fs.readFileSync(groceryCachePath, 'utf8')); } catch(e) {}

            // Determine if we need to refresh: cache empty, or it's Thursday+ and cache is from before this Thursday
            const now = new Date();
            const cacheTime = groceryCache.timestamp ? new Date(groceryCache.timestamp) : null;
            const dayOfWeek = now.getDay(); // 0=Sun, 4=Thu
            // Find most recent Thursday (circular release day)
            const daysSinceThu = (dayOfWeek + 7 - 4) % 7;
            const lastThu = new Date(now); lastThu.setDate(now.getDate() - daysSinceThu); lastThu.setHours(0,0,0,0);
            const cacheIsStale = !cacheTime || cacheTime < lastThu;
            const cacheHasDeals = groceryCache.deals && groceryCache.deals.length > 0;

            if (cacheHasDeals && !cacheIsStale) {
                // Use cached deals
                groceryDeals = groceryCache.deals;
                console.log(`📡 John Herr's: using cached deals (${groceryDeals.length} deals, cached ${cacheTime.toLocaleDateString()})`);
            } else {
                console.log(`📡 Fetching John Herr's weekly circular...${cacheIsStale ? ' (cache stale, refreshing)' : ' (no cache)'}`);
                const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
                // Stable print page for John Herr's Village Market (store ID: 54348)
                const printPageUrl = 'https://www.familyownedmarkets.com/print-weekly-specials/?circularstoreidentifier=54348';

                if (ANTHROPIC_KEY) {
                    // Step 1: Fetch print page and extract image URLs
                    const pageRes = await fetch(printPageUrl, { signal: AbortSignal.timeout(30000) });
                    if (!pageRes.ok) throw new Error(`Print page fetch failed: ${pageRes.status}`);
                    const html = await pageRes.text();
                    const imageUrls = [...html.matchAll(/https:\/\/familyownedmarketsdata\.shoptocook\.com\/shoptocook\/Content\/SimpleCircular\/\d+\/\d+_max\.jpg/g)].map(m => m[0]);
                    const uniqueImages = [...new Set(imageUrls)];
                    console.log(`  📄 Found ${uniqueImages.length} circular pages`);

                    if (uniqueImages.length === 0) throw new Error('No circular images found on print page');

                    // Step 2: Download each image and convert to base64
                    const imageBlocks = [];
                    for (const imgUrl of uniqueImages) {
                        try {
                            const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20000) });
                            if (!imgRes.ok) continue;
                            const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
                            imageBlocks.push({
                                type: 'image',
                                source: { type: 'base64', media_type: 'image/jpeg', data: imgBuffer.toString('base64') }
                            });
                        } catch (e) {
                            console.log(`    ⚠️ Image download failed: ${e.message}`);
                        }
                    }
                    console.log(`  🖼️ Downloaded ${imageBlocks.length}/${uniqueImages.length} images (total ${(imageBlocks.reduce((sum,b)=>sum+b.source.data.length,0)/1024).toFixed(0)}KB base64)`);

                    if (imageBlocks.length === 0) throw new Error('All image downloads failed');

                    // Step 3: Send all images to Claude Vision
                    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': ANTHROPIC_KEY,
                            'anthropic-version': '2023-06-01'
                        },
                        body: JSON.stringify({
                            model: 'claude-sonnet-4-20250514',
                            max_tokens: 2048,
                            messages: [{
                                role: 'user',
                                content: [
                                    ...imageBlocks,
                                    { type: 'text', text: `These images are pages from the weekly grocery circular for John Herr's Village Market. Extract the TOP 15-20 best deals across all pages — items with the biggest savings, lowest prices, or best value (BOGO, buy-one-get-one, manager's specials, etc).

IMPORTANT: Order the deals from BEST to worst. The first 5 should be the absolute best deals — the ones a savvy shopper would be most excited about.

For each deal, provide the item name, sale price, and original/regular price if shown.

Also find the valid date range for this circular (usually Thursday through Wednesday).

Respond ONLY with valid JSON (no markdown, no backticks):
{"dateRange":"Thu Apr 16 - Wed Apr 22","deals":[{"item":"Boneless Chicken Breast","salePrice":"$1.99/lb","regularPrice":"$4.99/lb","savings":"60% off"},{"item":"Strawberries 1lb","salePrice":"$2.50","regularPrice":"","savings":"Great price"}]}

Focus on the most impressive deals a shopper would want to know about. Include meats, produce, dairy, pantry staples. Skip minor items like 10 cents off a can of beans. Respond with ONLY the JSON.` }
                                ]
                            }]
                        })
                    });

                    if (claudeRes.ok) {
                        const claudeData = await claudeRes.json();
                        const responseText = claudeData.content?.[0]?.text || '';
                        try {
                            const cleanJson = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
                            const parsed = JSON.parse(cleanJson);
                            groceryDeals = parsed.deals || [];
                            const dateRange = parsed.dateRange || '';
                            console.log(`  ✅ John Herr's: ${groceryDeals.length} top deals (${dateRange})`);
                            groceryDeals.forEach(d => console.log(`    🏷️ ${d.item} – ${d.salePrice}${d.savings ? ' (' + d.savings + ')' : ''}`));
                            groceryDeals = groceryDeals.map(d => ({ ...d, dateRange }));

                            // Data-quality assertion. If the full pipeline ran
                            // (cache stale, ANTHROPIC_KEY set, print page
                            // fetched OK, Claude returned 200) but extracted
                            // ZERO deals, something's broken: store ID might
                            // have rotated (print page empty), the shoptocook
                            // image CDN may have changed its URL pattern
                            // breaking our regex, or the circular layout
                            // drifted enough that Claude can't parse it. Fire
                            // /fail so we hear about it within the hour. This
                            // is distinct from cache-miss (handled by outer
                            // try/catch as transient) and the "cache is warm"
                            // path (which skips this block entirely).
                            if (groceryDeals.length === 0) {
                                console.warn(`⚠️  DATA QUALITY: John Herr's Vision pipeline ran but extracted 0 deals. Likely store ID rotation, CDN change, or circular layout drift.`);
                                const healthUrl = process.env.HEALTHCHECK_URL;
                                if (healthUrl) {
                                    try {
                                        const ctrl = new AbortController();
                                        const timer = setTimeout(() => ctrl.abort(), 5000);
                                        await fetch(`${healthUrl}/fail`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'text/plain' },
                                            body: "John Herr's grocery deals extracted 0 items from circular despite full pipeline success — likely store ID 54348 rotation or circular layout drift.",
                                            signal: ctrl.signal
                                        }).catch(() => {});
                                        clearTimeout(timer);
                                        console.log("   🚨 Fired /fail ping to healthchecks.io");
                                    } catch (_) { /* never break the scrape on monitoring failure */ }
                                }
                            }

                            // Save to cache
                            fs.writeFileSync(groceryCachePath, JSON.stringify({ timestamp: now.toISOString(), deals: groceryDeals }, null, 2));
                            console.log(`  💾 Grocery deals cached`);
                        } catch (jsonErr) {
                            console.log(`    ⚠️ Failed to parse deals: ${responseText.substring(0, 200)}`);
                        }
                    } else {
                        const err = await claudeRes.text();
                        console.log(`    ⚠️ Claude API error: ${err.substring(0, 200)}`);
                    }
                } else {
                    console.log(`    ⚠️ ANTHROPIC_API_KEY not set — skipping grocery deals`);
                }

                // Fallback to cached deals if API failed
                if (groceryDeals.length === 0 && cacheHasDeals) {
                    groceryDeals = groceryCache.deals;
                    console.log(`  📦 Using cached grocery deals as fallback (${groceryDeals.length} deals)`);
                }
            }
        } catch (e) { console.log(`  ⚠️ John Herr's error: ${e.message}`); }
        } // ===== END LEGACY VISION PIPELINE =====

        const specials = {
            "House of Pizza": {
                note: "Dine-in & Carryout Only · Mon-Fri till 2 PM · Not for Delivery",
                daily: {
                    "Monday": ["2 Slices & MD Drink – $4.50", "Soup & Sandwich – $5.99", "Turkey Sub – $5.25"],
                    "Tuesday": ["2 Slices & MD Drink – $4.50", "Ham Sub – $5.00", "Pork BBQ Sandwich w/Fries – $5.99"],
                    "Wednesday": ["2 Slices & MD Drink – $4.50", "Soup & Sandwich – $5.99", "Italian Sub – $5.25"],
                    "Thursday": ["2 Slices & MD Drink – $4.50", "Soup & Sandwich – $5.99", "¼ Lb. Cheeseburger & Fries – $4.50", "🍺 Miller Lite Draft (Pint) – $1.50 (all day till midnight)"],
                    "Friday": ["2 Slices & MD Drink – $4.50", "Meatball Sub – $5.50", "Shrimp Basket & Fries – $5.75"]
                }
            },
            "VFW Post 7294": {
                note: "Members & Guests · Weekly specials change each week",
                weekly: vfwWeeklySpecials.map(s => {
                    let label = s.name;
                    if (s.price) label += ` – ${s.price}`;
                    if (s.fridayOnly) label += ' (Friday only)';
                    return label;
                }),
                weeklyDateRange: vfwSpecialsDateRange,
                recurring: {
                    "Tuesday": "Shrimp Night",
                    "Wednesday": "Wing Night",
                    "Thursday": "Taco Night",
                    "Friday": "Special (varies weekly)",
                    "Saturday": "Burger Night"
                }
            },
            "John Herr's Village Market": {
                note: groceryDeals.length > 0 && groceryDeals[0].dateRange ? `Weekly deals: ${groceryDeals[0].dateRange}` : "Weekly deals · Thu–Wed",
                weekly: groceryDeals.slice(0, 5).map(d => {
                    let label = `${d.item} – ${d.salePrice}`;
                    if (d.savings) label += ` (${d.savings})`;
                    return label;
                }),
                weeklyDateRange: groceryDeals.length > 0 ? groceryDeals[0].dateRange : '',
                rawDeals: groceryDeals.map(d => ({
                    item: d.item, salePrice: d.salePrice,
                    regularPrice: d.regularPrice || '', savings: d.savings || '',
                    dateRange: d.dateRange || ''
                }))
            }
        };
        fs.writeFileSync(path.join(__dirname, '../specials.json'), JSON.stringify(specials, null, 2));
        console.log(`✅ Specials saved (VFW: ${vfwWeeklySpecials.length}, Grocery: ${groceryDeals.length})`);
    } catch (e) { console.error("❌ VFW/Specials error:", e.message); }

    // ===== 8. COMMUNITY EVENT SUBMISSIONS (Google Sheet) =====
    // Sheet columns (expected order, based on the Google Form):
    //   0: Timestamp  1: Event Name  2: Date  3: Time  4: Location
    //   5: Description  6: Email  7: Link  8: Status (manually added)
    // An event is imported if its Status column is Approved / Yes / Y / ✓ / true.
    try {
        console.log("📡 Fetching community event submissions...");
        const SUBMIT_SHEET_ID = '1VRI55lrSl_MKoWjMPAfaOtJq2HrmU9NGn2R2waDXMCc';
        const submitUrl = `https://docs.google.com/spreadsheets/d/${SUBMIT_SHEET_ID}/gviz/tq?tqx=out:csv`;
        const submitRes = await fetch(submitUrl);
        if (submitRes.ok) {
            const csvText = await submitRes.text();

            // Proper CSV parser: handles quoted cells, escaped quotes (""), and UNQUOTED cells.
            // The previous regex-based approach only matched `"..."` blocks and silently dropped
            // rows where any column (like status = Yes) was exported without quotes.
            function parseCSVLine(line) {
                const result = [];
                let cur = '';
                let inQuotes = false;
                for (let i = 0; i < line.length; i++) {
                    const ch = line[i];
                    if (inQuotes) {
                        if (ch === '"') {
                            if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
                            else inQuotes = false;
                        } else { cur += ch; }
                    } else {
                        if (ch === '"') inQuotes = true;
                        else if (ch === ',') { result.push(cur); cur = ''; }
                        else cur += ch;
                    }
                }
                result.push(cur);
                return result.map(s => s.trim());
            }

            // Split on newlines but respect embedded newlines inside quoted cells.
            const allRows = [];
            {
                let cur = '';
                let inQuotes = false;
                for (let i = 0; i < csvText.length; i++) {
                    const ch = csvText[i];
                    if (ch === '"') inQuotes = !inQuotes;
                    if (ch === '\n' && !inQuotes) {
                        allRows.push(cur);
                        cur = '';
                    } else {
                        cur += ch;
                    }
                }
                if (cur) allRows.push(cur);
            }

            // Resolve columns by HEADER NAME, not fixed position. The response
            // sheet's columns track the Google Form's question order, so adding
            // or reordering questions silently shifts fixed indices and makes us
            // read the wrong cells (this happened when the Audience / children /
            // end-date-time questions were added). Matching the header row
            // survives that. Names are normalized (lowercased, whitespace-
            // collapsed), matched exact-first then by substring as a fallback.
            const headerCells = parseCSVLine(allRows[0] || '');
            const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const findCol = (...names) => {
                for (const n of names) {
                    const i = headerCells.findIndex(h => norm(h) === norm(n));
                    if (i !== -1) return i;
                }
                for (const n of names) {
                    const i = headerCells.findIndex(h => norm(h).includes(norm(n)));
                    if (i !== -1) return i;
                }
                return -1;
            };
            const COL = {
                name:     findCol('Event Name'),
                desc:     findCol('Description'),
                audience: findCol('Audience'),
                kids:     findCol('Is this an event for children?', 'children'),
                date:     findCol('Start Date', 'Date'),
                time:     findCol('Start Time', 'Time'),
                endDate:  findCol('End Date'),
                endTime:  findCol('End Time'),
                location: findCol('Location'),
                link:     findCol('Website/Link', 'Website', 'Link'),
                status:   findCol('Approved', 'Status', 'Approve', 'Publish'),
            };

            const rows = allRows.slice(1); // skip header
            let communityCount = 0;
            let skippedNoStatus = 0;
            let skippedBadDate = 0;
            let skippedOutOfRange = 0;
            for (const row of rows) {
                if (!row.trim()) continue;
                const cols = parseCSVLine(row);
                if (cols.length < 2) continue;
                const get = i => (i >= 0 && i < cols.length ? (cols[i] || '').trim() : '');
                const eventName = get(COL.name);
                const dateStr = get(COL.date);
                const timeStr = get(COL.time);
                const location = get(COL.location);
                const description = get(COL.desc);
                const link = get(COL.link);
                const status = get(COL.status);
                const audienceRaw = get(COL.audience);
                const kidsRaw = get(COL.kids);
                const endDateStr = get(COL.endDate);
                const endTimeStr = get(COL.endTime);

                // Accept multiple "approved" signals: Approved, Yes, Y, ✓, true, 1
                const statusApproved = /^(approved|yes|y|true|1|✓|✔)$/i.test(status);
                if (!statusApproved) {
                    if (eventName && dateStr) skippedNoStatus++;
                    continue;
                }
                if (!eventName || !dateStr) continue;

                // Parse date (format from Google Forms: MM/DD/YYYY or YYYY-MM-DD).
                // CRITICAL: GitHub Actions runs in UTC, so naive Date construction
                // here would treat the cell value as a UTC moment. When user
                // browsers in Eastern Time then render the ISO string, they'd
                // see times shifted 4-5 hours earlier ("5pm" → "1pm"). This was
                // the production bug. Fix: build an explicit Eastern-offset ISO
                // string so the moment we save is the moment the user intended.
                let yyyy, mm, dd;
                const mdyMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                if (mdyMatch) {
                    yyyy = parseInt(mdyMatch[3]);
                    mm = parseInt(mdyMatch[1]);
                    dd = parseInt(mdyMatch[2]);
                } else {
                    // Fallback for non-MDY (e.g. "2026-04-27"). Take the local
                    // calendar interpretation and pull components.
                    const fallbackD = new Date(dateStr);
                    if (isNaN(fallbackD.getTime())) { skippedBadDate++; continue; }
                    yyyy = fallbackD.getFullYear();
                    mm = fallbackD.getMonth() + 1;
                    dd = fallbackD.getDate();
                }
                if (!yyyy || !mm || !dd) { skippedBadDate++; continue; }

                // Eastern Time DST rule: starts 2nd Sunday in March, ends 1st
                // Sunday in November. Compute the boundary dates for this
                // event's year, then pick offset accordingly. Approximate
                // around boundary days (±1 hour drift) but exact for typical
                // events that aren't scheduled at 2am on a DST switch day.
                function isEasternDST(y, monthIdx, dayOfMonth) {
                    // monthIdx is 0-based (Jan=0). Quick rejects:
                    if (monthIdx < 2) return false;       // Jan-Feb: no DST
                    if (monthIdx > 10) return false;      // Dec: no DST
                    if (monthIdx > 2 && monthIdx < 10) return true;  // Apr-Oct: yes
                    // March: DST starts on the 2nd Sunday. Find it.
                    if (monthIdx === 2) {
                        const firstOfMonth = new Date(Date.UTC(y, 2, 1)).getUTCDay(); // 0=Sun
                        const firstSunday = firstOfMonth === 0 ? 1 : (8 - firstOfMonth);
                        const secondSunday = firstSunday + 7;
                        return dayOfMonth >= secondSunday;
                    }
                    // November: DST ends on the 1st Sunday.
                    if (monthIdx === 10) {
                        const firstOfMonth = new Date(Date.UTC(y, 10, 1)).getUTCDay();
                        const firstSunday = firstOfMonth === 0 ? 1 : (8 - firstOfMonth);
                        return dayOfMonth < firstSunday;
                    }
                    return false;
                }

                // Parse time. Same format-detection as before (H:MM[:SS]
                // [AM|PM] / 24h / fraction-of-day / shorthand). Output is
                // {h, m} both 0-23 / 0-59. Falls back to 12:00 noon if
                // unparseable. Track whether a time was provided at all so
                // we can emit an explicit allDay flag on the event — needed
                // because the frontend used to guess "all-day" by checking
                // for noon, which falsely categorized real noon meetings.
                let timeH = 12, timeM = 0;
                let timeProvided = false;
                if (timeStr) {
                    let parsed = null;
                    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
                    if (timeMatch) {
                        let h = parseInt(timeMatch[1]);
                        const mn = parseInt(timeMatch[2]);
                        const ampm = (timeMatch[3] || '').toUpperCase();
                        if (ampm === 'PM' && h < 12) h += 12;
                        else if (ampm === 'AM' && h === 12) h = 0;
                        else if (!ampm && h >= 1 && h <= 7) h += 12;
                        parsed = { h, m: mn };
                    } else {
                        const shortMatch = timeStr.match(/^(\d{1,2})\s*(am|pm)$/i);
                        if (shortMatch) {
                            let h = parseInt(shortMatch[1]);
                            const ampm = shortMatch[2].toUpperCase();
                            if (ampm === 'PM' && h < 12) h += 12;
                            if (ampm === 'AM' && h === 12) h = 0;
                            parsed = { h, m: 0 };
                        } else {
                            const decMatch = timeStr.match(/^0?\.\d+$/);
                            if (decMatch) {
                                const totalMinutes = Math.round(parseFloat(timeStr) * 24 * 60);
                                parsed = { h: Math.floor(totalMinutes / 60), m: totalMinutes % 60 };
                            }
                        }
                    }
                    if (parsed) {
                        timeH = parsed.h;
                        timeM = parsed.m;
                        timeProvided = true;
                        console.log(`  📅 Submission time: "${timeStr}" → ${timeH}:${String(timeM).padStart(2,'0')} ET`);
                    } else {
                        console.log(`  ⚠️ Submission time unparsed: "${timeStr}" — defaulting to noon ET`);
                    }
                }
                // Build an explicit Eastern-offset ISO string. Bypasses the
                // setHours() trap where the runtime's local TZ contaminates
                // the result. Format: "2026-04-27T17:00:00-04:00".
                const dst = isEasternDST(yyyy, mm - 1, dd);
                const offset = dst ? '-04:00' : '-05:00';
                const isoStr = `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T${String(timeH).padStart(2,'0')}:${String(timeM).padStart(2,'0')}:00${offset}`;
                const eventDate = new Date(isoStr);
                if (isNaN(eventDate.getTime())) { skippedBadDate++; continue; }

                // Skip events outside our date range
                if (eventDate < pastDate || eventDate >= futureDate) { skippedOutOfRange++; continue; }

                // ── Audience: map the Form answer to the site's event model.
                //   'mu-only'     → students only, hidden from townies.
                //   'townie-only' → community only, hidden from marauders.
                //   'public'      → everyone ("Both").
                let audience = '';
                const audLow = audienceRaw.toLowerCase();
                if (audLow.includes('marauder')) audience = 'mu-only';
                else if (audLow.includes('townie')) audience = 'townie-only';
                else if (audienceRaw) audience = 'public';   // Both (or any other non-empty answer)

                // ── End time: build an ISO end moment when an end TIME is given
                // (end date defaults to the start date if blank). Same Eastern-
                // offset construction as the start, so DST is handled.
                let endTimeIso = '';
                if (endTimeStr) {
                    const etm = endTimeStr.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
                    if (etm) {
                        let eh = parseInt(etm[1]); const emin = parseInt(etm[2]);
                        const eap = (etm[3] || '').toUpperCase();
                        if (eap === 'PM' && eh < 12) eh += 12;
                        else if (eap === 'AM' && eh === 12) eh = 0;
                        let ey = yyyy, emo = mm, ed = dd;
                        const edm = endDateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                        if (edm) { ey = parseInt(edm[3]); emo = parseInt(edm[1]); ed = parseInt(edm[2]); }
                        else if (endDateStr) { const fd = new Date(endDateStr); if (!isNaN(fd.getTime())) { ey = fd.getFullYear(); emo = fd.getMonth() + 1; ed = fd.getDate(); } }
                        const eoff = isEasternDST(ey, emo - 1, ed) ? '-04:00' : '-05:00';
                        const cand = `${ey}-${String(emo).padStart(2,'0')}-${String(ed).padStart(2,'0')}T${String(eh).padStart(2,'0')}:${String(emin).padStart(2,'0')}:00${eoff}`;
                        if (!isNaN(new Date(cand).getTime())) endTimeIso = cand;
                    }
                }

                events.push({
                    title: eventName,
                    date: eventDate.toISOString(),
                    location: location || 'Millersville',
                    tags: ['Community'],
                    price: 'Free',
                    ticketLink: '',
                    sourceLink: link || '',
                    description: description || '',
                    ...(audience ? { audience } : {}),
                    ...(/^yes$/i.test(kidsRaw) ? { kidFriendly: true } : {}),
                    ...(endTimeIso ? { endTime: endTimeIso } : {}),
                    ...(timeProvided ? {} : { allDay: true })
                });
                communityCount++;
            }
            console.log(`✅ Community submissions: ${communityCount} approved events` +
                (skippedNoStatus || skippedBadDate || skippedOutOfRange
                    ? ` (skipped: ${skippedNoStatus} not-approved, ${skippedBadDate} bad date, ${skippedOutOfRange} out of range)`
                    : ''));
        } else {
            console.log(`  ⚠️ Community sheet fetch failed: ${submitRes.status}`);
        }
    } catch (e) { console.log(`  ⚠️ Community submissions error: ${e.message}`); }

    // ===== FAMILY-FRIENDLY TAGGING =====
    const familyKeywords = /\bfamily\b|families|\bkids?\b|\bchild(ren)?\b|\byouth\b|\ball ages\b|\bopen house\b|\bparade\b|\bfestival\b|\bfun run\b|\begg hunt\b|\btrick.or.treat\b|\bstory ?time\b|\bfun fest\b|\bdoodle\b|\bpuppet\b|\bmagic show\b|\barts smarts\b|\bsalsa\b.*\b5\+/i;
    const familyDescKeywords = /\bfamily[- ]friendly\b|\bfor (kids|children|families)\b|\ball ages\b|\bages?\s*\d+\s*(\+|and up|and older)\b|\byoung audiences?\b|\bkids?\s*(welcome|invited|event)\b|\bnon[- ]verbal show\b|\binteractive\b.*\b(kids|children|animation)\b|\bfamily fun\b/i;
    const notFamilyKeywords = /\brehersal\b|\brehearsal\b|\bpractice\b|\btraining\b|\bsap meeting\b|\bstaff\b|\bfaculty\b|\bin-service\b|\bboard\b|\bpto\b/i;
    const notFamilyMUKeywords = /\bjob\b|\binternship\b|\bcareer fair\b|\bemployment\b|\brecruitment\b|\bhiring\b|\bresume\b|\bworkshop\b.*\bprofessional\b|\bgraduate\b|\bthesis\b/i;
    const familyPMKeywords = /\bconcert\b|\bensemble\b|\bshowcase\b|\bspring show\b|\bmusical\b|\bplay\b|\btalent show\b|\bassembly\b|\bbook fair\b|\bfood fair\b|\bpicture\b/i;
    // MU event types that are almost always family-friendly
    const familyMUTypes = /family fun fest|arts smarts|kids.?\s*salsa/i;
    let famCount = 0;
    events.forEach(e => {
        const tags = e.tags || [];
        const src = tags[0] || '';
        const title = e.title || '';
        const titleLower = title.toLowerCase();
        const desc = (e.description || '').toLowerCase();
        const loc = (e.location || '').toLowerCase();
        const allText = titleLower + ' ' + desc;

        let isFamilyFriendly = false;

        // Respect pre-set kidFriendly for events that already declared themselves (e.g. Summer Camps, Athletic Camps)
        if ((tags.includes('Summer Camp') || tags.includes('Athletic Camp')) && e.kidFriendly === true) {
            famCount++;
            return;
        }

        // Skip all sporting events (they're on the Sports page, not Events)
        if (tags.includes('Athletic Competitions') || tags.includes('Athletics') || tags.includes('Club Sports')) {
            e.kidFriendly = false;
            return;
        }

        // Clubs/Orgs — almost always for college students, NOT families
        // Only tag as family-friendly if description EXPLICITLY invites families with children
        if (src === 'Clubs/Orgs' || tags.includes('Clubs/Orgs')) {
            if (tags.includes('Club Sports')) { e.kidFriendly = false; return; }
            const clubFamilySignals = /\bfamilies with (children|kids)\b|\binvites?\s+(all\s+)?families\b|\bfor (kids|children)\b|\bbring your (kids|children)\b|\bchildren\s+ages?\s*[2-9]\s*[-–]\s*\d|\bkids?\s*(camp|day|workshop|class|event|welcome|invited|from the area)\b|\bhosting\s+kids\b|\byouth\s+(camp|workshop|event|day)\b/i;
            if (clubFamilySignals.test(desc)) {
                e.kidFriendly = true; famCount++;
            } else {
                e.kidFriendly = false;
            }
            return;
        }

        // Borough events → NOT family friendly (trash collection, meetings, etc.)
        if (src === 'Borough') {
            isFamilyFriendly = false;
        }
        // PM events — selective
        else if (src === 'PM') {
            if (tags.includes('Board/PTO') || tags.includes('Meetings') || tags.includes('School Events') || tags.includes('Field Trips')) {
                isFamilyFriendly = false;
            }
            else if (notFamilyKeywords.test(titleLower)) {
                isFamilyFriendly = false;
            }
            else if (familyPMKeywords.test(titleLower)) {
                isFamilyFriendly = true;
            }
            else {
                isFamilyFriendly = false;
            }
        }
        // Phantom Power / bar events → NOT family friendly
        else if (tags.includes('Other') && tags.includes('Live Music')) {
            isFamilyFriendly = false;
        }
        // MU events — check title, description, event type, and venue
        else if (src === 'MU') {
            if (notFamilyMUKeywords.test(titleLower)) {
                isFamilyFriendly = false;
            }
            // Known family event types (Family Fun Fest, Arts Smarts, Kids' Salsa)
            else if (familyMUTypes.test(title)) {
                isFamilyFriendly = true;
            }
            // Check title keywords
            else if (familyKeywords.test(title)) {
                isFamilyFriendly = true;
            }
            // Check description for family-friendly signals
            else if (familyDescKeywords.test(desc)) {
                isFamilyFriendly = true;
            }
            // Ware Center events with playful/kids content in description
            else if (/ware|steinman/i.test(loc) && /\b(playful|imaginati|wonder|interactive|puppet|animation)\b/i.test(desc)) {
                isFamilyFriendly = true;
            }
        }
        // VFW events — check for open-to-public family events
        else if (tags.includes('VFW')) {
            if (familyKeywords.test(title) || /open to the public/i.test(title)) {
                isFamilyFriendly = true;
            }
        }
        // Other sources — keyword match on title or description
        else if (familyKeywords.test(title) || familyDescKeywords.test(desc)) {
            isFamilyFriendly = true;
        }

        e.kidFriendly = isFamilyFriendly;
        if (isFamilyFriendly) famCount++;
    });
    console.log(`👨‍👩‍👧 Family-friendly tagged: ${famCount} of ${events.length} events`);

    // ===== THE HUB — RECURRING FREE MEALS =====
    // The HUB serves free meals to MU students Tue/Thu lunch 11am-1pm and
    // Fri "French Toast Friday" 9pm-midnight during the academic year. Meal
    // service pauses for summer (~May 11 – Aug 24); Campus Cupboard stays
    // open year-round but is handled separately as a "place," not an event.
    //
    // We generate a rolling 4-week window so the timeline always shows the
    // upcoming free meals. Past instances roll off naturally with the rest
    // of the events.
    //
    // All events tagged audience: mu-only so townies don't see them on the
    // home/events feed (food is members-only). Tagged Other for the picker
    // category (under the Other section's heading-style group).
    try {
        const hubEvents = [];
        const now = new Date();
        const startDate = new Date(now); startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(now); endDate.setDate(endDate.getDate() + 28);

        // Approximate term-window check. Spring ends ~May 10, fall starts
        // ~Aug 25. Inside this summer pause, meal service is off (Campus
        // Cupboard handled separately). Approximate; misses Thanksgiving
        // and spring break, but those are minor mismatches — the event
        // description tells students to bring student ID, so a confused
        // visit during a break is recoverable.
        const isHubMealServicePaused = (d) => {
            const m = d.getMonth() + 1, day = d.getDate();
            // Pause from May 11 through Aug 24 inclusive
            if (m === 5 && day >= 11) return true;
            if (m === 6 || m === 7) return true;
            if (m === 8 && day < 25) return true;
            return false;
        };

        // Same Eastern-offset ISO helper as community submissions to avoid
        // the GitHub-Actions-runs-in-UTC timezone bug.
        const isEasternDST = (y, monthIdx, dayOfMonth) => {
            if (monthIdx < 2) return false;
            if (monthIdx > 10) return false;
            if (monthIdx > 2 && monthIdx < 10) return true;
            if (monthIdx === 2) {
                const firstOfMonth = new Date(Date.UTC(y, 2, 1)).getUTCDay();
                const firstSunday = firstOfMonth === 0 ? 1 : (8 - firstOfMonth);
                return dayOfMonth >= firstSunday + 7;
            }
            if (monthIdx === 10) {
                const firstOfMonth = new Date(Date.UTC(y, 10, 1)).getUTCDay();
                const firstSunday = firstOfMonth === 0 ? 1 : (8 - firstOfMonth);
                return dayOfMonth < firstSunday;
            }
            return false;
        };
        const buildEternalISO = (y, mo, d, h, min) => {
            const offset = isEasternDST(y, mo - 1, d) ? '-04:00' : '-05:00';
            return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00${offset}`;
        };

        let hubGenerated = 0, hubSkippedSummer = 0;
        for (let cursor = new Date(startDate); cursor <= endDate; cursor.setDate(cursor.getDate() + 1)) {
            if (isHubMealServicePaused(cursor)) { hubSkippedSummer++; continue; }
            const dayOfWeek = cursor.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
            const y = cursor.getFullYear();
            const mo = cursor.getMonth() + 1;
            const d = cursor.getDate();

            // Tue (2) or Thu (4): Free Lunch 11am-1pm
            if (dayOfWeek === 2 || dayOfWeek === 4) {
                const isoStart = buildEternalISO(y, mo, d, 11, 0);
                hubEvents.push({
                    title: 'Free Lunch',
                    date: new Date(isoStart).toISOString(),
                    location: '121 N George St, Millersville',
                    description: 'Free meal for all Millersville University students at The HUB (121 N George St, across from the Dillworth Building). Bring student ID. Service runs 11am – 1pm.',
                    tags: ['MU', 'HUB', 'Free Food', 'Other'],
                    audience: 'mu-only',
                    benefits: ['Free Food'],
                    orgName: 'The HUB',
                    orgShortName: 'The HUB',
                    sourceLink: 'https://www.hubmu.org/free-meals'
                });
                hubGenerated++;
            }
            // Fri (5): French Toast Friday 9pm-midnight
            if (dayOfWeek === 5) {
                const isoStart = buildEternalISO(y, mo, d, 21, 0);
                hubEvents.push({
                    title: 'French Toast Friday',
                    date: new Date(isoStart).toISOString(),
                    location: '121 N George St, Millersville',
                    description: 'Free French toast & sausage for all Millersville University students at The HUB (121 N George St). 9pm – midnight, with live music.',
                    tags: ['MU', 'HUB', 'Free Food', 'Other'],
                    audience: 'mu-only',
                    benefits: ['Free Food'],
                    orgName: 'The HUB',
                    orgShortName: 'The HUB',
                    sourceLink: 'https://www.hubmu.org/free-meals'
                });
                hubGenerated++;
            }
        }
        if (hubGenerated > 0) {
            events.push(...hubEvents);
            console.log(`🥪 The HUB: ${hubGenerated} recurring free meals generated for next 4 weeks${hubSkippedSummer ? ` (${hubSkippedSummer} summer-paused days skipped)` : ''}`);
        } else {
            console.log(`🥪 The HUB: 0 events generated — within summer pause (May 11 – Aug 24)`);
        }
    } catch (e) {
        console.log(`  ⚠️ HUB events error: ${e.message}`);
    }

    // ===== PENN MANOR SCORES FROM MAXPREPS =====
    try {
        console.log("📡 Fetching Penn Manor scores from MaxPreps...");
        // Expanded list — MaxPreps URLs that may return 404 (out-of-season or missing team)
        // are handled gracefully by the fetch block below, which logs a warning and skips.
        // We err on the side of over-requesting so that in-season sports are always covered
        // regardless of the time of year.
        const maxPrepsSports = [
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/baseball/schedule/', sport: 'Baseball', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/softball/schedule/', sport: 'Softball', gender: 'Girls' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/lacrosse/schedule/', sport: 'Lacrosse', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/lacrosse/girls/schedule/', sport: 'Lacrosse', gender: 'Girls' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/volleyball/boys/schedule/', sport: 'Volleyball', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/volleyball/schedule/', sport: 'Volleyball', gender: 'Girls' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/tennis/schedule/', sport: 'Tennis', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/tennis/girls/schedule/', sport: 'Tennis', gender: 'Girls' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/soccer/schedule/', sport: 'Soccer', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/soccer/girls/schedule/', sport: 'Soccer', gender: 'Girls' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/football/schedule/', sport: 'Football', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/basketball/schedule/', sport: 'Basketball', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/basketball/girls/schedule/', sport: 'Basketball', gender: 'Girls' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/field-hockey/schedule/', sport: 'Field Hockey', gender: 'Girls' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/wrestling/schedule/', sport: 'Wrestling', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/golf/schedule/', sport: 'Golf', gender: 'Boys' },
            // Cross Country and Swimming intentionally OMITTED — Penn Manor
            // doesn't run varsity teams in those sports on MaxPreps. The
            // school's MaxPreps team page lists Baseball, Basketball, Football,
            // Golf, Lacrosse, Soccer, Tennis, Track & Field, Volleyball,
            // Wrestling for boys (and the equivalent girls set). Hitting the
            // CC/Swimming URLs returned HTTP 500 every cron — MaxPreps'
            // misleading way of saying "no team here" — and produced log
            // noise for data that was never going to appear. Dropped 2026-05-06.
            // If Penn Manor adds these teams later, MaxPreps will provide a
            // page at /cross-country/schedule/ and /swimming/schedule/ and
            // we can re-add the entries here.
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/track-field/schedule/', sport: 'Track', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/track-field/girls/schedule/', sport: 'Track', gender: 'Girls' },
        ];

        let pmScoreCount = 0;
        const pmScores = [];

        for (const mp of maxPrepsSports) {
            try {
                const res = await fetch(mp.url, { headers: baseHeaders, signal: AbortSignal.timeout(10000) });
                if (!res.ok) { console.log(`  ⚠️ ${mp.gender} ${mp.sport}: HTTP ${res.status}`); continue; }
                const html = await res.text();

                // MaxPreps renders schedule as HTML table or markdown-like content
                // Results appear as: "W 3-0" or "L 1-3" near dates like "3/20" or "4/2"
                // Strategy: extract all text, find date+result pairs
                
                // Strip HTML tags to get clean text
                const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
                
                // Find all results: date followed eventually by W/L + score
                // Pattern: "3/20" ... "L 3-0" or "W 3-0"
                const allResults = [...text.matchAll(/(\d{1,2})\/(\d{1,2})\s+[^]*?([WLT])\s+(\d+-\d+)/g)];
                
                // That greedy regex won't work well. Use a different approach:
                // Split text into chunks around W/L results, then look backwards for the date
                const resultMatches = [...text.matchAll(/\b([WLT])\s+(\d{1,2}-\d{1,2})\b/g)];
                
                for (const rm of resultMatches) {
                    const result = rm[1];
                    const score = rm[2];
                    const beforeText = text.substring(Math.max(0, rm.index - 200), rm.index);
                    
                    // Find the closest date before this result
                    const dateMatches = [...beforeText.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)];
                    if (dateMatches.length === 0) continue;
                    
                    const lastDate = dateMatches[dateMatches.length - 1];
                    const m = parseInt(lastDate[1]);
                    const d = parseInt(lastDate[2]);
                    if (m < 1 || m > 12 || d < 1 || d > 31) continue;
                    
                    // Determine year
                    let gameYear = today.getFullYear();
                    if (m >= 8 && today.getMonth() < 6) gameYear--;
                    
                    const gameDate = `${gameYear}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                    
                    // Avoid duplicate entries for same date+sport
                    if (pmScores.some(s => s.date === gameDate && s.sport === mp.sport && s.gender === mp.gender)) continue;
                    
                    pmScores.push({ date: gameDate, sport: mp.sport, gender: mp.gender, result, score });
                }
                
                const sportScores = pmScores.filter(s => s.sport === mp.sport && s.gender === mp.gender);
                if (sportScores.length > 0) {
                    console.log(`  ✅ ${mp.gender} ${mp.sport}: ${sportScores.length} results`);
                    sportScores.forEach(s => console.log(`     ${s.date}: ${s.result} ${s.score}`));
                }
            } catch (e) {
                console.log(`  ⚠️ ${mp.gender} ${mp.sport}: ${e.message}`);
            }
        }

        // Match scores to PM events
        if (pmScores.length > 0) {
            console.log(`  📊 Total MaxPreps results found: ${pmScores.length}`);
            for (const ev of events) {
                const tags = ev.tags || [];
                if (!tags.includes('PM') || !tags.includes('Athletics')) continue;
                if (ev.gameResult) continue;
                // MaxPreps only tracks varsity — skip JV and Jr High
                if (tags.includes('JV') || tags.includes('Jr High')) continue;
                
                const evDate = ev.date.substring(0, 10);
                const evTitle = (ev.title || '').toLowerCase();
                
                for (const sc of pmScores) {
                    if (sc.date !== evDate) continue;
                    
                    const sportLower = sc.sport.toLowerCase();
                    const titleHasSport = evTitle.includes(sportLower) || 
                                          (sportLower === 'football' && evTitle.includes('football')) ||
                                          (sportLower === 'field hockey' && (evTitle.includes('field hockey') || evTitle.includes('hockey')));
                    const tagHasSport = tags.some(t => t.toLowerCase() === sportLower);
                    
                    if (titleHasSport || tagHasSport) {
                        const genderMatch = 
                            (sc.gender === 'Boys' && (tags.includes('Boys') || evTitle.includes('boys') || evTitle.includes('men'))) ||
                            (sc.gender === 'Girls' && (tags.includes('Girls') || evTitle.includes('girls') || evTitle.includes('women'))) ||
                            (!tags.includes('Boys') && !tags.includes('Girls'));
                        
                        if (genderMatch) {
                            ev.gameResult = sc.result;
                            ev.gameScore = sc.score;
                            pmScoreCount++;
                            console.log(`     🏆 Matched: ${ev.title} (${evDate}) → ${sc.result} ${sc.score}`);
                            break;
                        }
                    }
                }
            }
            console.log(`🏆 PM scores matched: ${pmScoreCount} games updated`);
        } else {
            console.log(`  ⚠️ No MaxPreps results found`);
        }
    } catch (e) { console.error("❌ MaxPreps scores error:", e.message); }

    // ===== HUDL SCORES (fill gaps not covered by MaxPreps) =====
    try {
        const hudlScores = global._hudlScores;
        const sportToHudlId = global._hudlSportToId;
        if (hudlScores && hudlScores.size > 0 && sportToHudlId) {
            let hudlScoreMatches = 0;
            for (const ev of events) {
                if (ev.gameResult) continue; // Already has a score from MaxPreps
                if (!ev.tags || !ev.tags.includes('PM')) continue;
                // Hudl scores are varsity-level — skip JV and Jr High
                if (ev.tags.includes('JV') || ev.tags.includes('Jr High')) continue;
                const sportTag = ev.tags.find(t => sportToHudlId[t.toLowerCase()]);
                if (!sportTag) continue;

                const evDate = new Date(ev.date).toISOString().split('T')[0];
                const gender = ev.tags.includes('Girls') ? 1 : 0;
                const sportId = sportToHudlId[sportTag.toLowerCase()];
                const key = `${evDate}|${sportId}|${gender}`;

                const hudlScore = hudlScores.get(key);
                if (hudlScore) {
                    ev.gameResult = hudlScore.result;
                    ev.gameScore = hudlScore.score;
                    hudlScoreMatches++;
                }
            }
            console.log(`📺 Hudl scores filled: ${hudlScoreMatches} games (supplementing MaxPreps)`);
        }
    } catch (e) { console.log(`  ⚠️ Hudl scores error: ${e.message}`); }

    // ===== BOX SCORES (retired) =====
    // Sidearm changed recap-page markup so the inline linescore tables we
    // used to parse no longer exist as static HTML. The feature was retired
    // 2026-05-09 along with the parseLinescoreFromHTML function above. The
    // status dashboard tile that showed "X/Y parsed" was removed earlier.
    // Users still get the recap link via event.sourceLink and can tap it
    // to see the full recap on millersvilleathletics.com.

    // ===== DEDUPLICATION & SAVE =====
    // Two-pass dedupe:
    //   Pass 1: exact match (title + full date + location) — legacy behavior
    //   Pass 2: cross-source match (normalized title + same day). Handles cases where the same event
    //           is posted by MU Calendar AND GetInvolved, or has slight title variations like
    //           "Family Fun Fest – Doodle POP" vs "Doodle POP"
    //
    // Source priority: Clubs/Orgs > MU Calendar > artsmu. GetInvolved events have richer metadata
    // (category tags, org names, benefits, descriptions), so they're preferred when a duplicate
    // exists. The old order favored MU Calendar because it had ticket links, but field-merging
    // (ticketLink inherits from loser) already handles that case — the winner can be the GetInvolved
    // version and still pick up the ticketLink from the MU Calendar duplicate during merge.

    const normalizeTitle = s => (s || '').toLowerCase()
        .replace(/&/g, ' and ')      // treat "&" and "and" the same
        .replace(/[^\w\s]/g, ' ')    // strip remaining punctuation
        .replace(/\s+/g, ' ')
        .trim();

    const sourceRank = e => {
        const tags = e.tags || [];
        // Highest: Clubs/Orgs (GetInvolved) — richest metadata, org context, benefits
        if (tags.includes('Clubs/Orgs')) return 3;
        // MU Calendar proper: tagged MU without Clubs/Orgs or artsmu signals
        if (tags.includes('MU') && !tags.includes('Clubs/Orgs')
            && !tags.includes('Arts Concert / Performance') && !tags.includes('Art Exhibit')) return 2;
        // artsmu — fills in what MU Calendar sometimes misses
        if (tags.includes('Arts Concert / Performance') || tags.includes('Art Exhibit')) return 1;
        return 0;
    };

    const hasBenefits = e => (e.benefits && e.benefits.length > 0);

    // Pass 1: exact-match dedupe. The date component runs through
    // parseEventInstant so that the SAME wall-clock event from the SAME source
    // formatted two different ways (naive ET vs UTC Z) collapses correctly —
    // same root cause as the RUF Bible Study Pass 2 bug, just at the earlier
    // pass. Uses ms-since-epoch as the key fragment instead of the raw string;
    // collisions on the same instant always indicate a true duplicate.
    // Falls back to the raw string for unparseable dates (preserves legacy).
    const seen = new Set();
    const exactDupes = [];
    let pass1 = events.filter(e => {
        const ms = parseEventInstant(e.date);
        const dateKey = !isNaN(ms) ? String(ms) : (e.date || '');
        const key = `${(e.title||'').trim().toLowerCase()}-${dateKey}-${(e.location || '').trim().toLowerCase()}`;
        if (seen.has(key)) {
            exactDupes.push({ title: e.title, date: (e.date || '').substring(0,10), source: (e.tags||[])[0] || 'Unknown' });
            return false;
        }
        seen.add(key);
        return true;
    });

    // Pass 2: cross-source dedupe — group by (normalized title, same day) and pick the best one.
    // Four safeguards against false positives:
    //   1) Only merge across DIFFERENT sources (same-source events on the same day are real
    //      separate events — doubleheaders, recurring meetings, morning/afternoon sessions).
    //   2) Generic meeting titles ("General Meeting", "PTO Meeting", "Studio Hours", etc.) require
    //      EXACT match — substring matching creates false positives when many groups have meetings
    //      with the same generic name on the same day.
    //   3) Calendar artifact titles starting with "Setup Window for" / "Teardown" never match real
    //      events — these are back-of-house calendar entries, not the real event.
    //   4) Times must be within 30 minutes OR titles must match exactly. This protects morning/afternoon
    //      camp sessions, doubleheader games, and multiple showings on the same day (e.g. Concert
    //      Band 10:30 AM and 2:00 PM are different performances even if they're cross-source).

    // Titles that are too generic to substring-match. Require exact match for these.
    const GENERIC_MEETING_TITLES = /^(general meeting|board meeting|staff meeting|pto meeting|committee meeting|studio hours|game night|meeting|practice|rehearsal|office hours|open house|book club|prayer meeting|tabling)$/i;
    const CALENDAR_ARTIFACT_PATTERNS = /^(setup window|teardown|breakdown|prep for|rehearsal for)\b/i;
    const ONE_HALF_HOUR_MS = 30 * 60 * 1000;

    // Get a "source bucket" for same-source detection. Within a bucket, don't merge.
    // URL is checked BEFORE tags because the Clubs/Orgs tag is attached to BOTH
    // GetInvolved API events AND MU Calendar "Student Event" relabels (for
    // consistent frontend filtering). Bucketing by tag would treat them as the
    // same source and block their dedupe — but they ARE the duplication we want
    // to collapse, from two genuinely different upstream feeds publishing the
    // same event. The sourceLink URL reliably distinguishes them.
    const sourceBucket = e => {
        const link = (e.sourceLink || '').toLowerCase();
        const tags = e.tags || [];
        if (link.includes('artsmu.com')) return 'artsmu';
        if (link.includes('getinvolved.millersville.edu')) return 'clubs';
        if (link.includes('millersville.edu/calendar')) return 'mu';
        // Fall back to tag-based detection for sources without distinctive URLs
        // (PM iCal, Borough iCal, etc.). Clubs/Orgs tag check is kept as a
        // last resort for the rare case where a Clubs/Orgs event lacks a
        // recognizable sourceLink.
        if (tags.includes('PM')) return 'pm';
        if (tags.includes('Borough')) return 'borough';
        if (tags.includes('Clubs/Orgs')) return 'clubs';
        if (tags.includes('MU')) return 'mu';
        return 'other';
    };

    const normalizedEvents = pass1.map((e, i) => {
        // Resolve the absolute instant first, then derive day from it in ET.
        // Doing both via parseEventInstant keeps naive-vs-Z duplicates aligned
        // (see comment on parseEventInstant for the format mismatch we're
        // accommodating). Falls back to the raw 0-10 slice if parsing fails,
        // which preserves legacy behavior for anything we can't recognize.
        const ms = parseEventInstant(e.date);
        const day = !isNaN(ms) ? deriveDayET(ms) : (e.date || '').slice(0, 10);
        const time = !isNaN(ms) ? ms : new Date(e.date || 0).getTime();
        return {
            idx: i,
            event: e,
            norm: normalizeTitle(e.title),
            day,
            time,
            bucket: sourceBucket(e)
        };
    }).filter(n => n.norm && !CALENDAR_ARTIFACT_PATTERNS.test(n.norm));

    const groups2 = [];

    for (const ne of normalizedEvents) {
        let matched = null;
        for (const g of groups2) {
            const seed = g[0];
            if (seed.day !== ne.day) continue;

            // Fix #1: require different source buckets — same-source events on the same day
            // are real separate events (doubleheaders, recurring meetings, multiple sessions).
            if (g.some(m => m.bucket === ne.bucket)) continue;

            // Title match logic: generic titles need EXACT match, others allow substring
            const shorter = seed.norm.length < ne.norm.length ? seed.norm : ne.norm;
            const exactMatch = seed.norm === ne.norm;
            const substringMatch = seed.norm.includes(ne.norm) || ne.norm.includes(seed.norm);
            const isGeneric = GENERIC_MEETING_TITLES.test(shorter);

            // Whitespace-insensitive equality. Catches cases like "Teatime"
            // vs "Tea time" — same event, source-side typesetting difference.
            // After collapsing whitespace, both normalize to "teatimeandslime"
            // and match. Cheaper than Levenshtein and more conservative
            // (only fires when the letter sequences are IDENTICAL modulo
            // whitespace).
            const seedNoWs = seed.norm.replace(/\s+/g, '');
            const neNoWs   = ne.norm.replace(/\s+/g, '');
            const noWsMatch = seedNoWs === neNoWs && seedNoWs.length >= 8;

            // Sorted-significant-words equality. Catches word-order reorderings
            // like "Mentorship Recruitment and Recognition Day" vs "Mentorship
            // Recognition and Recruitment Day" — same event, sources just
            // listed components in different order. We compare sets of words
            // with length ≥ 4 (filters stop words and generic short tokens
            // that could collide on unrelated events). Requires ≥3 words to
            // fire — pairs of 1-2 word titles are too fragile to merge this
            // way.
            const sortedDistinctive = norm => norm.split(' ').filter(w => w.length >= 4).sort().join(' ');
            const seedSorted = sortedDistinctive(seed.norm);
            const neSorted = sortedDistinctive(ne.norm);
            const sortedWordCount = seedSorted.split(' ').filter(Boolean).length;
            const sortedMatch = seedSorted && seedSorted === neSorted && sortedWordCount >= 3;

            // Fuzzy match: find the longest contiguous shared word run between
            // the two normalized titles. Catches cases like
            //   "kenston curtis lafleur the light in the dark"
            //   "the light in the dark by kenston lafleur"
            // where neither is a substring of the other but they share a 6-word
            // distinctive phrase. Threshold: 4+ words AND ≥18 chars AND the
            // shared run is mostly content words (not just stop words). Both
            // conditions together are protective against false positives —
            // two unrelated events on the same day from different sources
            // essentially never share a phrase that distinctive.
            let fuzzyMatch = false;
            if (!exactMatch && !substringMatch && !isGeneric) {
                const stopWords = new Set(['the','a','an','of','and','or','for','to','in','on','at','by','with','from']);
                const seedWords = seed.norm.split(' ');
                const neWords = ne.norm.split(' ');
                let bestRun = '';
                for (let i = 0; i < seedWords.length; i++) {
                    for (let j = 0; j < neWords.length; j++) {
                        let k = 0;
                        while (i + k < seedWords.length && j + k < neWords.length && seedWords[i + k] === neWords[j + k]) k++;
                        if (k >= 4) {
                            const run = seedWords.slice(i, i + k).join(' ');
                            if (run.length > bestRun.length) bestRun = run;
                        }
                    }
                }
                if (bestRun.length >= 18) {
                    const runWords = bestRun.split(' ');
                    const contentWords = runWords.filter(w => !stopWords.has(w));
                    // Require at least 2 content words so "the of in and to a" can't pass
                    if (contentWords.length >= 2) fuzzyMatch = true;
                }
            }

            let titleMatch;
            if (exactMatch || noWsMatch || sortedMatch) titleMatch = true;
            else if (isGeneric) titleMatch = false;
            else titleMatch = (substringMatch && shorter.length >= 8) || fuzzyMatch;

            // Same-org-same-time-same-room rule: when two events share
            // orgName + location signature + nearly-identical time, they're
            // the same event regardless of title differences. Catches cases
            // where one org publishes the same event twice with different
            // naming conventions (e.g. "Co-Ed Bible Study" + "RUF Wednesday
            // Night Bible Study", both hosted by RUF in SMC Room 202 at 8pm).
            //
            // Location matching uses a canonical "room signature" (building
            // code + room number) instead of string equality, since upstream
            // sources express the same room differently:
            //   "SMC Meeting Room 202" → "SMC|202"
            //   "Student Memorial Center, Room 202" → "SMC|202"
            //   "SMC, Room 202" → "SMC|202"
            // Risk is low — a single org doesn't host two simultaneous events
            // in the same room.
            if (!titleMatch) {
                const aOrg = (seed.event.orgName || '').toLowerCase().trim();
                const bOrg = (ne.event.orgName || '').toLowerCase().trim();
                const aSig = roomSignature(seed.event.location);
                const bSig = roomSignature(ne.event.location);
                const FIFTEEN_MIN_MS = 15 * 60 * 1000;
                if (aOrg && aOrg === bOrg && aSig && aSig === bSig &&
                    Math.abs(seed.time - ne.time) <= FIFTEEN_MIN_MS) {
                    titleMatch = true;
                }
            }

            if (!titleMatch) continue;

            // Time-window check for loose (substring) matches. Two cases:
            //   (a) Short substring match (shorter norm < 10 chars): require times within 30 min —
            //       very short phrases could legitimately occur as multiple sessions.
            //   (b) Long substring match (shorter norm >= 10 chars): title overlap is distinctive
            //       enough that same-day match is almost certainly the same event. Sources often
            //       list different times for the same event (doors-open vs performance-start),
            //       so allow merging regardless of time gap.
            //
            // noWsMatch and sortedMatch are skipped entirely — those are
            // letter-identical or word-set-identical, strong enough to
            // cross-source merge regardless of time gap (different sources
            // legitimately publish the same event with different start times).
            if (!exactMatch && !noWsMatch && !sortedMatch) {
                const timeDiff = Math.abs(ne.time - seed.time);
                if (shorter.length < 10 && timeDiff > ONE_HALF_HOUR_MS) continue;
            }

            matched = g;
            break;
        }
        if (matched) matched.push(ne);
        else groups2.push([ne]);
    }

    const kept = new Set();
    const crossDupes = [];
    pass1.forEach((_, i) => kept.add(i)); // start by keeping all

    groups2.forEach((candidates) => {
        if (candidates.length <= 1) return; // no duplicates in this group
        // Rank candidates — best first
        candidates.sort((a, b) => {
            // Primary: prefer the version with a meaningfully richer description.
            // When two sources have the same event but very different description
            // depth (e.g. artsmu has 200-char gallery blurb, MU Calendar has 20
            // chars), the user-visible value is richer with the longer one.
            // Threshold: longer must be at least 3x the shorter to flip — small
            // differences shouldn't beat source-priority ordering.
            const aDescLen = (a.event.description || '').length;
            const bDescLen = (b.event.description || '').length;
            if (aDescLen > 50 && aDescLen > bDescLen * 3) return -1;
            if (bDescLen > 50 && bDescLen > aDescLen * 3) return 1;

            // Source priority (MU Calendar > Clubs/Orgs > artsmu)
            const rankDiff = sourceRank(b.event) - sourceRank(a.event);
            if (rankDiff !== 0) return rankDiff;
            // Tiebreaker: whichever has a ticketLink wins (more useful for users)
            const aHasTicket = !!a.event.ticketLink;
            const bHasTicket = !!b.event.ticketLink;
            if (aHasTicket && !bHasTicket) return -1;
            if (bHasTicket && !aHasTicket) return 1;
            // Final tiebreaker: whichever has student benefits wins
            const aHasBenefits = hasBenefits(a.event);
            const bHasBenefits = hasBenefits(b.event);
            if (aHasBenefits && !bHasBenefits) return -1;
            if (bHasBenefits && !aHasBenefits) return 1;
            return 0;
        });
        // Merge useful fields from losers into the winner, then drop losers.
        // This preserves context (benefits, kid-friendly flag, ticket links) that
        // would otherwise be lost when the lower-priority duplicate is removed.
        const winner = candidates[0].event;
        for (let i = 1; i < candidates.length; i++) {
            const loser = candidates[i];

            // Merge benefits (union, no dupes) — preserves 🍕 Free Food / 🎁 Free Stuff / 📚 Credit badges
            if (loser.event.benefits && loser.event.benefits.length > 0) {
                const existingBenefits = new Set(winner.benefits || []);
                loser.event.benefits.forEach(b => existingBenefits.add(b));
                winner.benefits = Array.from(existingBenefits);
            }
            // Propagate kid-friendly signal — if ANY source says it's family-friendly, it is
            if (loser.event.kidFriendly === true && winner.kidFriendly !== true) {
                winner.kidFriendly = true;
            }
            // Inherit ticket link if winner lacks one (rare since ticketLink is a sort tiebreaker, but possible)
            if (!winner.ticketLink && loser.event.ticketLink) {
                winner.ticketLink = loser.event.ticketLink;
            }
            // Merge audience — if any duplicate says the event is public-facing, keep it public.
            // This helps MU Calendar entries (which have no audience field) pick up the 'public'
            // signal from the GetInvolved duplicate that was being merged in.
            if (loser.event.audience === 'public' && winner.audience !== 'public') {
                winner.audience = 'public';
            }

            kept.delete(loser.idx);
            crossDupes.push({
                title: loser.event.title,
                date: (loser.event.date || '').substring(0, 10),
                source: (loser.event.tags || [])[0] || 'Unknown',
                replacedBy: winner.title + ' [' + ((winner.tags || [])[0] || '?') + ']',
                merged: [
                    loser.event.benefits?.length ? `benefits:${loser.event.benefits.join(',')}` : '',
                    loser.event.kidFriendly && !winner.kidFriendly ? 'kidFriendly' : '',
                    !winner.ticketLink && loser.event.ticketLink ? 'ticketLink' : '',
                    loser.event.audience === 'public' && winner.audience === 'public' && candidates[0].event.audience !== 'public' ? 'audience:public' : ''
                ].filter(Boolean).join('+')
            });
        }
    });

    const deduped = pass1.filter((_, i) => kept.has(i));

    // Prefix-title dedup for same-venue + same-datetime events. Some sources
    // (notably Eventbrite) list one show twice — a plain title and a
    // "<title> w. <opener>" variant — with different IDs, so ID-based dedup
    // misses them. When two events share venue+datetime AND one title is a
    // clean prefix of the other (followed by a separator or "w."/"with"/
    // "feat"), they're the same event; keep the longer, more descriptive one.
    // Scoped tightly to the prefix relationship so legitimate same-slot pairs
    // (Varsity/JV, Boys/Girls, trash/yard-waste) are NOT merged.
    const prefixDupeIdx = new Set();
    const isPrefixDupe = (a, b) => {
        const x = (a || '').trim().toLowerCase(), y = (b || '').trim().toLowerCase();
        if (!x || !y) return false;
        if (x === y) return true;
        const short = x.length <= y.length ? x : y;
        const long = x.length <= y.length ? y : x;
        return long.startsWith(short) &&
            /^[\s:\-–(]*(w[.\/]|with\b|feat|ft\.|$)/i.test(long.slice(short.length));
    };
    const venueGroups = {};
    deduped.forEach((ev, i) => {
        if (!ev.location || !ev.date) return;
        const k = ev.location + '|' + ev.date;
        (venueGroups[k] = venueGroups[k] || []).push(i);
    });
    let prefixMerged = 0;
    Object.values(venueGroups).forEach(idxs => {
        for (let a = 0; a < idxs.length; a++) {
            for (let b = a + 1; b < idxs.length; b++) {
                const i = idxs[a], j = idxs[b];
                if (prefixDupeIdx.has(i) || prefixDupeIdx.has(j)) continue;
                if (isPrefixDupe(deduped[i].title, deduped[j].title)) {
                    // Drop the shorter-titled one (less descriptive).
                    const drop = (deduped[i].title || '').length < (deduped[j].title || '').length ? i : j;
                    prefixDupeIdx.add(drop);
                    prefixMerged++;
                    console.log(`   ✕ prefix-dupe: "${deduped[drop].title}" (kept the longer variant)`);
                }
            }
        }
    });
    if (prefixMerged > 0) {
        console.log(`🔗 Removed ${prefixMerged} prefix-title duplicate(s)`);
    }
    // Rebuild deduped without the prefix dupes.
    const dedupedFinal = deduped.filter((_, i) => !prefixDupeIdx.has(i));
    deduped.length = 0;
    Array.prototype.push.apply(deduped, dedupedFinal);

    // Override-collision dedupe. A create-mode borough override is the curated
    // source of truth for an event that originated in a blog post (e.g.
    // National Night Out, created before it was on any calendar). When the
    // borough LATER adds that same event to its Google Calendar, the iCal feed
    // produces a second copy — and because BOTH copies are tagged Borough
    // (same source), neither the exact pass (different time and/or location)
    // nor the cross-source pass (which only merges across DIFFERENT sources)
    // removes it. So we resolve it here: for each create-override event, drop
    // any OTHER event on the same ET day whose title the override "absorbs" —
    // exact normalized match, OR the feed title is the override title followed
    // by a trailing suffix (e.g. "National Night Out" absorbs "National Night
    // Out 6-8pm"). The override wins, so its curated title, time, and location
    // survive (this is also why NNO keeps its correct 6 PM time instead of the
    // iCal copy's all-day-artifact time). Guardrails keep it safe: only
    // create-override events trigger it; only same-ET-day matches are removed;
    // a non-exact (prefix) absorb requires the override title to be multi-word
    // so a short/generic override can't swallow unrelated events; and another
    // create-override is never dropped. Legitimate separate same-day events
    // (trash vs yard-waste collection, back-to-back meetings) are untouched
    // because none of them is a create-override and none shares a title.
    const overrideCollisionIdx = new Set();
    const titleAbsorbs = (ovTitle, otherTitle) => {
        const o = normalizeTitle(ovTitle), x = normalizeTitle(otherTitle);
        if (!o || !x) return false;
        if (o === x) return true;
        // Feed title == override title + trailing suffix. Require the override
        // title to be multi-word so e.g. a "Concert" override can't absorb
        // "Concert Band Showcase".
        return o.includes(' ') && x.startsWith(o + ' ');
    };
    const collisionDay = e => {
        const ms = parseEventInstant(e.date);
        return !isNaN(ms) ? deriveDayET(ms) : (e.date || '').slice(0, 10);
    };
    const overrideCollisions = [];
    deduped.forEach((ovEv, oi) => {
        if (!ovEv._overrideCreated) return;
        const ovDay = collisionDay(ovEv);
        deduped.forEach((other, xi) => {
            if (xi === oi || other._overrideCreated) return;     // skip self + other overrides
            if (overrideCollisionIdx.has(xi)) return;
            if (collisionDay(other) !== ovDay) return;
            if (titleAbsorbs(ovEv.title, other.title)) {
                overrideCollisionIdx.add(xi);
                overrideCollisions.push({ dropped: other.title, kept: ovEv.title, day: ovDay });
            }
        });
    });
    if (overrideCollisions.length > 0) {
        console.log(`🔗 Removed ${overrideCollisions.length} override-collision duplicate(s):`);
        overrideCollisions.forEach(c => console.log(`   ✕ [Borough] "${c.dropped}" (${c.day}) → kept curated "${c.kept}"`));
        const afterCollision = deduped.filter((_, i) => !overrideCollisionIdx.has(i));
        deduped.length = 0;
        Array.prototype.push.apply(deduped, afterCollision);
    }
    // Strip the internal marker so it never lands in events.json.
    deduped.forEach(e => { if (e._overrideCreated) delete e._overrideCreated; });

    if (exactDupes.length > 0) {
        console.log(`⚠️ Removed ${exactDupes.length} exact duplicates:`);
        exactDupes.forEach(d => console.log(`   ✕ [${d.source}] ${d.title} (${d.date})`));
    }
    if (crossDupes.length > 0) {
        console.log(`🔗 Removed ${crossDupes.length} cross-source duplicates:`);
        crossDupes.forEach(d => {
            const mergedNote = d.merged ? ` [merged: ${d.merged}]` : '';
            console.log(`   ✕ [${d.source}] ${d.title} (${d.date}) → kept ${d.replacedBy}${mergedNote}`);
        });
    }

    deduped.sort((a, b) => new Date(a.date) - new Date(b.date));
    // Preserve descriptions for the card-detail modal on home/search. Truncate aggressively
    // to keep events.json size manageable — 600 chars is enough for a useful preview.
    deduped.forEach(e => {
        if (e.description && typeof e.description === 'string') {
            // Strip HTML tags and collapse whitespace
            const plain = e.description.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
            e.description = plain.length > 600 ? plain.slice(0, 600).trim() + '…' : plain;
            if (!e.description) delete e.description;
        } else {
            delete e.description;
        }
    });
    // Slim pass before write: events.json gets fetched by every page load and
    // is the largest file the frontend downloads. Strip empty/redundant fields
    // and drop pretty-printing — the file is consumed by code, not humans, so
    // 2-space indent on a 1200-event array adds ~25KB of pure whitespace.
    //
    // Fields removed if empty/falsy: description (already handled above),
    // image, location, ticketLink, streamLink, sourceLink, price,
    // categories (redundant with tags array), benefits (rarely populated),
    // periodScores when no labels, gameScore/gameResult on future games.
    //
    // Don't touch: title, date, tags, audience, _dateMs (added at runtime
    // anyway, but harmless if scraper accidentally emits it).
    const SLIM_FIELDS = ['image', 'location', 'ticketLink', 'streamLink', 'sourceLink', 'price', 'benefits', 'org', 'orgName', 'orgShortName', 'category', 'categories', 'kidFriendly', 'isLive', 'periodScores'];
    let beforeBytes = 0, afterBytes = 0;
    try { beforeBytes = JSON.stringify(deduped, null, 2).length; } catch(_) {}
    for (const ev of deduped) {
        for (const field of SLIM_FIELDS) {
            const val = ev[field];
            if (val === '' || val === null || val === undefined) {
                delete ev[field];
            } else if (Array.isArray(val) && val.length === 0) {
                delete ev[field];
            } else if (field === 'kidFriendly' && val === false) {
                // Default-false; only emit when true (saves a key per non-kidFriendly event).
                delete ev[field];
            } else if (field === 'isLive' && val === false) {
                delete ev[field];
            } else if (field === 'periodScores' && (!val.labels || val.labels.length === 0)) {
                delete ev[field];
            }
        }
    }
    const slimJson = JSON.stringify(deduped);  // No pretty-print — wire format
    afterBytes = slimJson.length;
	// Strip C0/C1 control chars from all event string fields before writing.
	// A stray char like U+0002 (a mangled "multi-day") is valid once JSON-escaped,
	// but Google's structured-data parser rejects it ("Incorrect value type"), and
	// it renders as a gap on cards. Keep tab/newline/CR.
	const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
	for (const ev of events) for (const k in ev) if (typeof ev[k] === 'string') ev[k] = ev[k].replace(CTRL, ' ');
    fs.writeFileSync(path.join(__dirname, '../events.json'), slimJson);
    if (beforeBytes > 0) {
        const reductionPct = Math.round((1 - afterBytes / beforeBytes) * 100);
        console.log(`💾 events.json: ${(afterBytes/1024).toFixed(1)}KB (${reductionPct}% smaller than pretty-printed)`);
    }

    // --- schema.org Event JSON-LD for Google rich results -----------------
    // Generate an ItemList of upcoming events and bake it into index.html
    // between the <!-- JSONLD:START --> / <!-- JSONLD:END --> markers. We do
    // this at build time (not in app.js) because Google needs the structured
    // data present in the served HTML — the client-side render isn't reliably
    // crawled. Marker-bounded string replacement ONLY: we never sed/regex the
    // whole HTML (a prior sed incident truncated tags), and if the markers are
    // missing we log and skip rather than touching the file, so a future
    // index.html edit that drops the markers can't corrupt the page or fail
    // the deploy.
    try {
        const { generateEventJsonLd } = require('../lib/eventJsonLd.js');
        const jsonld = generateEventJsonLd(deduped, { now: Date.now() });
        const idxPath = path.join(__dirname, '../index.html');
        const START = '<!-- JSONLD:START -->';
        const END = '<!-- JSONLD:END -->';
        let html = fs.readFileSync(idxPath, 'utf8');
        const sIdx = html.indexOf(START);
        const eIdx = html.indexOf(END);
        if (sIdx === -1 || eIdx === -1 || eIdx < sIdx) {
            console.warn('⚠ JSON-LD markers not found in index.html — skipped (no events markup injected)');
        } else if (!jsonld) {
            console.warn('⚠ no qualifying events for JSON-LD — leaving markers empty');
            // Clear any stale content between markers.
            const before = html.slice(0, sIdx + START.length);
            const after = html.slice(eIdx);
            const cleared = before + '\n    ' + after;
            if (cleared !== html) fs.writeFileSync(idxPath, cleared);
        } else {
            const before = html.slice(0, sIdx + START.length);
            const after = html.slice(eIdx);
			const injected = before + '\n    <script type="application/ld+json" id="events-jsonld">' + jsonld + '</script>\n    ' + after;
            fs.writeFileSync(idxPath, injected);
            const count = (jsonld.match(/"@type":"Event"/g) || []).length;
            console.log(`🔎 JSON-LD: injected ${count} upcoming events into index.html (${(Buffer.byteLength(jsonld, 'utf8') / 1024).toFixed(1)} KB)`);
        }
    } catch (e) {
        // Never let SEO markup break the scrape/deploy.
        console.warn('⚠ JSON-LD generation/injection failed (continuing):', e.message);
    }
    // Sibling metadata file for the frontend's "last updated" display. Kept separate so we
    // don't have to change the events.json array-shape that tons of code reads from.
    const metaPath = path.join(__dirname, '../events-meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        eventCount: deduped.length
    }, null, 2));
    console.log(`📊 Total events saved: ${deduped.length} (${deduped.filter(e=>e.image).length} with images, ${deduped.filter(e=>e.description).length} with descriptions)`);

    // ===== EVENT DIFF TRACKING (operator self-check) =====
    // Track what's new run-over-run. Each cron compares current event keys
    // against the previous run's snapshot; truly new keys get added to a
    // rolling 7-day "recently added" list with the source + start date so the
    // status dashboard can show "the scraper is actively finding new stuff."
    //
    // Storage: events-snapshot.json (gitignored from deploy via excludes —
    // it's runtime state, not source). Schema:
    //   {
    //     lastSnapshotAt: ISO,
    //     currentKeys: [string],
    //     recentlyAdded: [{ key, firstSeenAt, title, source, date }]
    //   }
    //
    // First-run handling: if no snapshot file exists, we record the current
    // snapshot but skip the diff — otherwise the very first deploy would
    // falsely report all ~1000 events as "new." A `firstSeenAt: snapshot
    // creation time` is fine for later runs since at that point everything
    // older than 7 days falls out of the window naturally.
    let recentlyAddedForStatus = [];
    let addedThisRun = 0;
    try {
        const snapshotPath = path.join(__dirname, '../events-snapshot.json');
        const evKey = (e) => (e.title || '') + '|' + (e.date || '');

        let previous = null;
        try {
            previous = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
            if (!previous || !Array.isArray(previous.currentKeys)) previous = null;
        } catch (_) { /* first run or corrupt — fall through */ }

        const currentKeys = deduped.map(evKey);
        const currentKeySet = new Set(currentKeys);

        // Carry forward recentlyAdded entries that are still within the
        // 7-day window AND still present in the current scrape (i.e. haven't
        // been deduped away or rolled past their date). Prune the rest.
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const carryForward = (previous?.recentlyAdded || []).filter(entry => {
            if (!entry.firstSeenAt || !entry.key) return false;
            const seenMs = new Date(entry.firstSeenAt).getTime();
            if (isNaN(seenMs) || seenMs < sevenDaysAgo) return false;
            return currentKeySet.has(entry.key);
        });

        // Compute deltas. New keys = current - previous. Skip on first run.
        let newEntries = [];
        if (previous) {
            const previousKeySet = new Set(previous.currentKeys);
            const carriedKeys = new Set(carryForward.map(c => c.key));
            const nowIso = new Date().toISOString();
            for (const ev of deduped) {
                const k = evKey(ev);
                if (previousKeySet.has(k) || carriedKeys.has(k)) continue;
                // Determine source for display. First tag is usually the
                // canonical source (MU/PM/Borough/etc.); fall back to
                // 'Other' if no tags.
                const source = (ev.tags && ev.tags[0]) || 'Other';
                newEntries.push({
                    key: k,
                    firstSeenAt: nowIso,
                    title: ev.title || '(untitled)',
                    source,
                    date: ev.date || null
                });
            }
            addedThisRun = newEntries.length;
            if (newEntries.length > 0) {
                console.log(`📥 ${newEntries.length} new event(s) since last cron`);
            }
        } else {
            console.log(`📥 First run — recording baseline snapshot (no diff)`);
        }

        // Merge carried-forward + new, sorted newest-first.
        const merged = [...newEntries, ...carryForward];
        merged.sort((a, b) => (b.firstSeenAt || '').localeCompare(a.firstSeenAt || ''));

        // Persist for next run. Keep top 200 recently-added entries to
        // bound file size; at ~150 bytes each that's ~30KB.
        const snapshot = {
            lastSnapshotAt: new Date().toISOString(),
            currentKeys,
            recentlyAdded: merged.slice(0, 200)
        };
        fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));

        // Pass top 10 to the status writer below for dashboard display.
        recentlyAddedForStatus = merged.slice(0, 10);
    } catch (e) {
        console.log(`  ⚠️ Event diff tracking error: ${e.message}`);
    }

    // ===== STATUS DASHBOARD DATA =====
    // Companion stats file consumed by /status.html. Computed from the final
    // deduped array so it reflects the TRUE state shipped to users, not raw
    // fetch counts (which would inflate totals before cross-source dedupe).
    // Separate from events-meta.json so the frontend's "last updated" code
    // stays stable on a simple schema while this file grows as we add metrics.
    try {
        const bySourceCount = (sourceTag, extraFilter = () => true) =>
            deduped.filter(e => (e.tags || []).includes(sourceTag) && extraFilter(e)).length;
        // Per-source date range. For each source filter, find the earliest and
        // latest event start date and emit ISO date strings. Powers the
        // "what time window does this number cover?" annotation on the status
        // dashboard — "351 events" is opaque, "351 events from Sep 15 → Aug
        // 30" tells you whether a source is providing 11 months of forward
        // visibility or just last week.
        // Returns null when no events match the filter (so the dashboard can
        // skip the line cleanly rather than rendering "—" placeholders).
        // Note: parses e.date here rather than reading a precomputed _dateMs
        // because _dateMs is an app.js runtime annotation, not part of the
        // events.json schema. The N=~1500 events make this trivial.
        const dateRangeFor = (sourceTag, extraFilter = () => true) => {
            const matched = deduped.filter(e => (e.tags || []).includes(sourceTag) && extraFilter(e));
            if (matched.length === 0) return null;
            let minMs = Infinity, maxMs = -Infinity;
            for (const e of matched) {
                const ms = new Date(e.date).getTime();
                if (!Number.isFinite(ms)) continue;
                if (ms < minMs) minMs = ms;
                if (ms > maxMs) maxMs = ms;
            }
            if (!Number.isFinite(minMs)) return null;
            return {
                earliest: new Date(minMs).toISOString(),
                latest: new Date(maxMs).toISOString()
            };
        };
        const pastSports = deduped.filter(e =>
            (e.tags || []).includes('Athletics') || (e.tags || []).includes('Athletic Competitions')
        ).filter(e => e.gameResult && e.gameScore);
        const status = {
            generatedAt: new Date().toISOString(),
            totalEvents: deduped.length,
            withDescription: deduped.filter(e => e.description).length,
            withImage: deduped.filter(e => e.image).length,
            familyFriendly: deduped.filter(e => e.kidFriendly).length,
            // Events happening TODAY in Eastern Time. Surfaces what users see
            // when they open the app right now — useful sanity check after a
            // scrape ("did Friday's slate land?") and a more operationally
            // meaningful number than a 1-year forward count for daily ops.
            // Computed via deriveDayET so the cutoff matches user-facing date
            // logic (no UTC drift on late-night runs).
            eventsToday: (() => {
                const todayET = deriveDayET(Date.now());
                return deduped.filter(e => {
                    const ms = parseEventInstant(e.date);
                    if (isNaN(ms)) return false;
                    return deriveDayET(ms) === todayET;
                }).length;
            })(),
            // Per-source counts (after dedupe)
            sources: {
                muAthletics: bySourceCount('MU', e => (e.tags || []).includes('Athletics') || (e.tags || []).includes('Athletic Competitions')),
                muCalendar: bySourceCount('MU', e => !(e.tags || []).includes('Athletics') && !(e.tags || []).includes('Clubs/Orgs')),
                muGetInvolved: bySourceCount('Clubs/Orgs'),
                pennManor: bySourceCount('PM'),
                borough: bySourceCount('Borough'),
                vfw: bySourceCount('VFW'),
                // Phantom Power events are tagged ['Other', 'Live Music'] — there's
                // no 'Phantom Power' tag. Count by `location === 'Phantom Power'`
                // instead, which is how the scraper actually identifies them
                // (set in both the Eventbrite-LD-JSON and JamBase emit sites).
                // This used to incorrectly read 0 because we were looking for a
                // tag that doesn't exist; the events were always being scraped,
                // just not counted on the dashboard.
                phantomPower: deduped.filter(e => e.location === 'Phantom Power').length,
                community: bySourceCount('Community'),
                manor: bySourceCount('Manor'),
                raneyCellars: bySourceCount('Raney Cellars'),
                // Enrichment count (not events). Number of MU athletic events
                // that got a Hudl/PSAC streamLink this run. Watched by the
                // status dashboard's per-source degradation detector — the
                // entire Hudl block silently broke once already (returned 0
                // schedule entries for months) and the existing source-count
                // monitors couldn't catch it because Hudl is enrichment, not
                // a source. This metric closes that blind spot.
                muHudlBroadcasts: muHudlMatchCount
            },
            // Per-source date ranges — earliest and latest event start in each
            // source. Keys mirror `sources` above so the status dashboard can
            // join them by key. muHudlBroadcasts is excluded since it's an
            // enrichment count, not a set of events with their own dates.
            sourceDateRanges: {
                muAthletics: dateRangeFor('MU', e => (e.tags || []).includes('Athletics') || (e.tags || []).includes('Athletic Competitions')),
                muCalendar: dateRangeFor('MU', e => !(e.tags || []).includes('Athletics') && !(e.tags || []).includes('Clubs/Orgs')),
                muGetInvolved: dateRangeFor('Clubs/Orgs'),
                pennManor: dateRangeFor('PM'),
                borough: dateRangeFor('Borough'),
                vfw: dateRangeFor('VFW'),
                phantomPower: (() => {
                    const m = deduped.filter(e => e.location === 'Phantom Power');
                    if (m.length === 0) return null;
                    const stamps = m.map(e => new Date(e.date).getTime()).filter(Number.isFinite);
                    if (stamps.length === 0) return null;
                    return {
                        earliest: new Date(Math.min(...stamps)).toISOString(),
                        latest: new Date(Math.max(...stamps)).toISOString()
                    };
                })(),
                community: dateRangeFor('Community'),
                manor: dateRangeFor('Manor'),
                raneyCellars: dateRangeFor('Raney Cellars')
            },
            // Stale-source detection. For each source, compute the newest event
            // date currently in the data, then compare against the same source's
            // newest date from prior days in status-history.json. If it hasn't
            // moved in N days, the source has likely stopped publishing — even
            // though count-based monitoring (compareSource above) is still
            // happy because the count itself is steady.
            //
            // This catches the failure mode where Borough's iCal feed stops
            // updating but already had 200+ events in the buffer: count stays
            // at 200, every count-based monitor reads "healthy", but in fact
            // no new events have appeared in weeks and the source is dead.
            //
            // Per-source thresholds tuned to expected publish cadence — sparse
            // sources get longer windows so they don't false-positive during
            // their natural dry spells. Tuning is conservative; better to miss
            // a slow real-world stall than nag about VFW being quiet for a few
            // weeks (it normally is).
            //
            // Returns null entries for sources with no events (avoids divide-by-
            // missing-data edge cases in status.html). status.html renders the
            // value as a hint when daysSinceMoved exceeds the threshold.
            staleness: (() => {
                const out = {};
                const newestPerSource = {
                    muAthletics: dateRangeFor('MU', e => (e.tags || []).includes('Athletics') || (e.tags || []).includes('Athletic Competitions'))?.latest,
                    muCalendar: dateRangeFor('MU', e => !(e.tags || []).includes('Athletics') && !(e.tags || []).includes('Clubs/Orgs'))?.latest,
                    muGetInvolved: dateRangeFor('Clubs/Orgs')?.latest,
                    pennManor: dateRangeFor('PM')?.latest,
                    borough: dateRangeFor('Borough')?.latest,
                    vfw: dateRangeFor('VFW')?.latest,
                    phantomPower: (() => {
                        const m = deduped.filter(e => e.location === 'Phantom Power');
                        if (m.length === 0) return null;
                        const stamps = m.map(e => new Date(e.date).getTime()).filter(Number.isFinite);
                        return stamps.length === 0 ? null : new Date(Math.max(...stamps)).toISOString();
                    })(),
                    community: dateRangeFor('Community')?.latest,
                    manor: dateRangeFor('Manor')?.latest,
                    raneyCellars: dateRangeFor('Raney Cellars')?.latest
                };
                for (const [key, latestIso] of Object.entries(newestPerSource)) {
                    if (!latestIso) { out[key] = null; continue; }
                    out[key] = { newest: latestIso.slice(0, 10) };
                }
                return out;
            })(),
            sports: {
                total: deduped.filter(e =>
                    (e.tags || []).includes('Athletics') || (e.tags || []).includes('Athletic Competitions')
                ).length,
                scored: pastSports.length,
                wins: pastSports.filter(e => e.gameResult === 'W').length,
                losses: pastSports.filter(e => e.gameResult === 'L').length,
                ties: pastSports.filter(e => e.gameResult === 'T' || e.gameResult === 'N').length
            },
            // Open registrations — youth sports signups + PM community events
            // that carry a registrationDeadline. The scraper has already dropped
            // any whose deadline passed, so every one of these is currently open.
            // `next2Weeks` mirrors exactly what the homepage "Upcoming Signups"
            // section surfaces to townies, so a 0 here when signups are expected
            // is an early warning that the upstream source (the Event Candidates
            // sheet / youth-sports-registration.json) went empty.
            registrations: (() => {
                const now = Date.now();
                const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
                const regs = deduped
                    .filter(e => e.registrationDeadline)
                    .map(e => new Date(e.registrationDeadline).getTime())
                    .filter(Number.isFinite);
                const next2Weeks = regs.filter(dl => dl >= now && (dl - now) <= TWO_WEEKS).length;
                const nextClose = regs.length
                    ? new Date(Math.min(...regs)).toISOString().slice(0, 10)
                    : null;
                // Open-ended registrations (closesTBA) aren't events, so they're
                // not in `deduped` — count them straight from the registrations
                // file. These never auto-expire (no deadline), so surfacing the
                // count keeps evergreen entries from being forgotten in the sheet.
                let openNoDeadline = 0;
                try {
                    const ysr = JSON.parse(fs.readFileSync(path.join(__dirname, '../youth-sports-registration.json'), 'utf8'));
                    openNoDeadline = (ysr.registrations || [])
                        .filter(r => r && r.status === 'active' && r.closesTBA === true).length;
                } catch (_) {}
                return { open: regs.length, next2Weeks, nextClose, openNoDeadline };
            })(),
            // Review queue — read from candidates-status.json, which
            // sync-candidates.js writes earlier in this same cron (sync runs
            // before scrape). Lets the dashboard show how many Event Candidates
            // sheet rows await approval and how many past-dated rows are clutter.
            // Reading it here (and folding into status.json) means the dashboard
            // never depends on candidates-status.json being deployed. If the
            // file is missing (sync skipped/failed this run) the field is null
            // and the dashboard hides the card.
            reviewQueue: (() => {
                try {
                    const cs = JSON.parse(fs.readFileSync(path.join(__dirname, '../candidates-status.json'), 'utf8'));
                    return {
                        pendingFuture: cs.pendingFuture ?? null,
                        pendingPast: cs.pendingPast ?? null,
                        pendingBySource: cs.pendingBySource || {},
                        stalePast: cs.stalePast ?? null,
                        lastSyncAt: cs.lastRunAt || null
                    };
                } catch (_) { return null; }
            })(),
            // Event diff tracking — operator self-check. recentlyAdded is up
            // to 10 events first seen in the last 7 days (most recent first).
            // addedLastRun is the count of events new since the previous cron
            // run, useful for spotting a stuck scraper (consistently 0 across
            // many runs = something probably broken upstream).
            recentlyAdded: recentlyAddedForStatus,
            addedLastRun: addedThisRun
        };
        fs.writeFileSync(path.join(__dirname, '../status.json'), JSON.stringify(status, null, 2));
        console.log(`📊 Status file written (${status.totalEvents} events across ${Object.values(status.sources).filter(n => n > 0).length} active sources)`);

        // Maintain a 7-day rolling history of per-source counts. Used by
        // status.html to flag sources whose count silently dropped vs typical
        // — a source returning 0 events while the overall scrape succeeds and
        // the hero badge reads "Healthy" would otherwise hide a real upstream
        // failure (auth break, schema change, blocked IP, etc).
        //
        // Schema: { lastUpdated, days: [{ date: 'YYYY-MM-DD', ts, totalEvents, sources }] }
        // - One entry per ET calendar day. Hourly cron means we overwrite
        //   today's entry each run with the latest snapshot.
        // - Ordered chronologically, capped at 7 entries (older drop off).
        // - ET-anchored day grouping via deriveDayET so the runner's UTC clock
        //   doesn't fragment late-night runs into "tomorrow" prematurely.
        try {
            const historyPath = path.join(__dirname, '../status-history.json');
            let history = { days: [] };
            if (fs.existsSync(historyPath)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
                    if (parsed && Array.isArray(parsed.days)) history = parsed;
                } catch { /* corrupt file — start fresh */ }
            }
            const todayET = deriveDayET(Date.now());
            // Capture today's newest-event-date per source for stale-source
            // detection. We persist this alongside counts so future runs can
            // compare and surface "newest event hasn't moved in N days." The
            // value is just the YYYY-MM-DD slice of the latest event per
            // source — exactly what status.staleness already computed.
            const newestDates = {};
            for (const [key, info] of Object.entries(status.staleness || {})) {
                if (info && info.newest) newestDates[key] = info.newest;
            }
            const snapshot = {
                date: todayET,
                ts: status.generatedAt,
                totalEvents: status.totalEvents,
                sources: status.sources,
                newestDates
            };
            const idx = history.days.findIndex(d => d.date === todayET);
            if (idx >= 0) history.days[idx] = snapshot;
            else history.days.push(snapshot);
            // Sort chronologically and keep only the last 90 days. Cap exists
            // so the file doesn't grow unbounded, but we need enough history
            // for stale-source detection thresholds (up to 90d for sparse
            // sources like Community submissions). At ~600 bytes/day this
            // tops out around 55KB — trivial.
            history.days.sort((a, b) => a.date.localeCompare(b.date));
            if (history.days.length > 90) history.days = history.days.slice(-90);
            history.lastUpdated = status.generatedAt;
            fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

            // Now that history is updated, compute "days since newest event
            // date moved" for each source. Walks backward through history's
            // days array — each entry stores the newest-event-date as it was
            // ON that day. We find the most recent day where the value
            // differed from today's, then the gap (in days) is how long it's
            // been static. If history has only one day or all days agree, we
            // record null (not enough data to be diagnostic). If a source's
            // newest date matches one observed many days ago, the source is
            // probably stalled.
            //
            // Status.html applies the per-source threshold and renders a hint.
            // We don't apply the threshold here so the threshold can change
            // without re-running the scrape.
            try {
                for (const [key, info] of Object.entries(status.staleness || {})) {
                    if (!info || !info.newest) continue;
                    const todayNewest = info.newest;
                    // Walk history oldest → newest, find the earliest day
                    // whose newestDates[key] is the SAME as today's newest.
                    // Days since that day == days since the source last moved.
                    let earliestSameDay = null;
                    for (const day of history.days) {
                        const dn = day.newestDates && day.newestDates[key];
                        if (dn === todayNewest) { earliestSameDay = day.date; break; }
                    }
                    if (!earliestSameDay) {
                        info.daysSinceMoved = 0;
                        continue;
                    }
                    const earliestMs = new Date(earliestSameDay + 'T00:00:00Z').getTime();
                    const todayMs = new Date(todayET + 'T00:00:00Z').getTime();
                    const days = Math.round((todayMs - earliestMs) / 86400000);
                    info.daysSinceMoved = days;
                }
                // Re-write status.json with daysSinceMoved fields back-filled.
                fs.writeFileSync(path.join(__dirname, '../status.json'), JSON.stringify(status, null, 2));
            } catch (staleErr) {
                console.log(`  ⚠️ Stale-source computation error: ${staleErr.message}`);
            }
        } catch (histErr) {
            // History is informational. Same defensive posture as the status
            // block itself — never break a scrape over a stats failure.
            console.log(`  ⚠️ Status history error: ${histErr.message}`);
        }
    } catch (statsErr) {
        // Stats are informational — don't let a stats error break the scrape.
        console.log(`  ⚠️ Status file error: ${statsErr.message}`);
    }

    // ===== CLUBS DIRECTORY (all MU organizations from GetInvolved) =====
    // Fetches the full org list from the Engage "discovery/search/organizations" endpoint
    // (the same one the GetInvolved web UI uses to render its browse-organizations page).
    // NOTE: The correct path is `/api/discovery/search/organizations` with `top=N`; an earlier
    //       guess of `/api/discovery/organization/search` with `take=N` returned HTTP 500.
    //
    // If the fetch fails entirely, we fall back to org names mined from the event feed
    // (`global._orgsFromEvents`) plus an optional manual seed at v3/clubs-manual.json.
    try {
        console.log("📡 Fetching all MU organizations from GetInvolved...");
        // Try the ordered query first; if that rejects the orderBy param, fall back to
        // the plain top=500, then the facets-only probe that the frontend uses.
        const orgCandidates = [
            'https://getinvolved.millersville.edu/api/discovery/search/organizations?top=500&orderBy%5B0%5D=name%20asc',
            'https://getinvolved.millersville.edu/api/discovery/search/organizations?top=500',
            'https://getinvolved.millersville.edu/api/discovery/search/organizations?top=0&facets%5B0%5D=BranchId%2Ccount%3A100%2Csort%3Avalue&facets%5B1%5D=CategoryIds%2Ccount%3A100%2Csort%3Avalue'
        ];
        let orgData = null;
        for (let i = 0; i < orgCandidates.length; i++) {
            try {
                const res = await fetch(orgCandidates[i], { headers: baseHeaders });
                if (res.ok) {
                    orgData = await res.json();
                    console.log(`  ✓ Candidate ${i + 1} succeeded`);
                    break;
                } else {
                    console.log(`  ⚠️ HTTP ${res.status} for candidate ${i + 1}`);
                }
            } catch (fetchErr) {
                console.log(`  ⚠️ Fetch error on candidate ${i + 1}: ${fetchErr.message}`);
            }
        }

        // Merge sources: API response (primary) + event-derived orgs + manual seed
        const orgsMap = (global._orgsFromEvents instanceof Map) ? new Map(global._orgsFromEvents) : new Map();
        let apiCount = 0;

        if (orgData) {
            // Response shape varies — try common container fields
            const rawItems = orgData.value || orgData.Value || orgData.items || orgData.Items || orgData.results || [];
            if (rawItems.length > 0) {
                console.log(`  ℹ️ First item fields: ${Object.keys(rawItems[0]).slice(0, 10).join(', ')}`);
            }
            rawItems.forEach(o => {
                // Field names vary by API version — handle both casings
                const name = (o.Name || o.name || '').trim();
                if (!name) return;
                if (!orgsMap.has(name)) {
                    orgsMap.set(name, {
                        name,
                        category: (o.CategoryNames && o.CategoryNames[0]) || (o.categoryNames && o.categoryNames[0]) || '',
                        categories: o.CategoryNames || o.categoryNames || [],
                        shortName: (o.ShortName || o.shortName || '').trim(),
                        id: o.WebsiteKey || o.websiteKey || o.Id || o.id || ''
                    });
                    apiCount++;
                }
            });
        }

        // Merge in optional manual seed list (won't override API results)
        const manualPath = path.join(__dirname, '../v3/clubs-manual.json');
        let manualCount = 0;
        try {
            if (fs.existsSync(manualPath)) {
                const manualList = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
                if (Array.isArray(manualList)) {
                    manualList.forEach(entry => {
                        const name = (typeof entry === 'string' ? entry : (entry && entry.name) || '').trim();
                        if (!name) return;
                        if (!orgsMap.has(name)) {
                            orgsMap.set(name, {
                                name,
                                category: (entry && entry.category) || '',
                                categories: (entry && entry.categories) || [],
                                shortName: (entry && entry.shortName) || '',
                                id: (entry && entry.id) || ''
                            });
                            manualCount++;
                        }
                    });
                }
            }
        } catch (manualErr) {
            console.log(`  ⚠️ Couldn't load manual clubs seed: ${manualErr.message}`);
        }

        let orgs = [...orgsMap.values()].sort((a, b) => a.name.localeCompare(b.name));

        // ===== APPLY SHORTNAME OVERLAY =====
        // shortnames-overlay.json maps full org names → curated short names.
        // Applied AFTER orgsMap is populated so all sources (GetInvolved API,
        // event-mined, manual seed) get the same treatment. Existing
        // shortNames from the GetInvolved API are kept unless explicitly
        // overridden in the overlay file. Missing file is not fatal — orgs
        // without a shortName just won't have one (frontend falls back to
        // name truncation or "MU" pill).
        try {
            const overlayPath = path.join(__dirname, '../shortnames-overlay.json');
            if (fs.existsSync(overlayPath)) {
                const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
                const map = (overlay && overlay.overrides) || {};
                let applied = 0;
                for (const o of orgs) {
                    if (map[o.name]) {
                        o.shortName = map[o.name];
                        applied++;
                    }
                }
                console.log(`📛 Shortname overlay: applied ${applied} of ${Object.keys(map).length} mappings`);
            }
        } catch (err) {
            console.log(`  ⚠️ Shortname overlay error: ${err.message}`);
        }

        // ===== DEDUPE PASS =====
        // The GetInvolved directory + event-mined org list + manual seed often produce
        // near-duplicates with wording variations:
        //   "ADAPT" vs "ADAPT at Millersville Univeristy"
        //   "American Chemical Society" vs "American Chemical Society - Millersville University Student Chapter"
        //   "All Campus Musical Organization" vs "All-Campus Musical Organization"
        //   "Super Smash Club" vs "Super Smash Club at MU"
        //   "Yoga Club" vs "The Yoga Club At Millersville University"
        // Collapse these to a single canonical entry while PROTECTING legitimate look-alikes:
        //   "Women's Basketball" (varsity) vs "Women's Club Basketball" (club sport) — KEEP BOTH
        //   "Acacia" vs "Acacia Fraternity" — different category signals but same org — merge
        const normalizeClubName = (name) => {
            return (name || '')
                .toLowerCase()
                // Strip common Millersville suffix phrases (expanded to cover "of" and "at"
                // plus variations like "Student Chapter", college radio station, etc.)
                .replace(/\s*[-–]\s*millersville university.*$/i, '')
                .replace(/\s*[-–]\s*mu'?s?\s+college radio station.*$/i, '')
                .replace(/\s+(at|of)\s+millersville(\s+univ(e?rsity|ersity)?)?\b.*$/i, '')
                .replace(/\s+millersville\s+university\s+student\s+chapter\b.*$/i, '')
                .replace(/\s+at\s+mu\b.*$/i, '')
                // Strip leading "Millersville " / "MU " / "The " prefix
                .replace(/^millersville\s+/i, '')
                .replace(/^mu\s+/i, '')
                .replace(/^the\s+/i, '')
                // Normalize hyphens/dashes to spaces
                .replace(/[-–—]/g, ' ')
                // Strip apostrophes so "Women's" and "Womens" collapse
                .replace(/'/g, '')
                // Normalize comma-reversed forms: "Club Soccer, Womens" -> "womens club soccer"
                .replace(/^(.+?),\s*(womens?|mens?)$/i, '$2 $1')
                // Strip trailing "Fraternity"/"Sorority" (Acacia / Acacia Fraternity)
                .replace(/\s+(fraternity|sorority)\s*$/i, '')
                // Collapse whitespace
                .replace(/\s+/g, ' ')
                .trim();
        };

        // Check if two normalized names represent a varsity-vs-club-sport distinction that should NOT merge
        const isVarsityVsClubConflict = (nameA, nameB) => {
            const a = nameA.toLowerCase();
            const b = nameB.toLowerCase();
            const varsitySports = ['baseball','softball','basketball','soccer','volleyball','football','lacrosse','field hockey','tennis','track','golf','swimming','wrestling','rugby','cross country'];
            for (const sport of varsitySports) {
                const aHas = a.includes(sport);
                const bHas = b.includes(sport);
                if (!aHas || !bHas) continue;
                const aIsClub = /\bclub\b/.test(a);
                const bIsClub = /\bclub\b/.test(b);
                // One has "club", the other doesn't → varsity vs club sport, keep separate
                if (aIsClub !== bIsClub) return true;
            }
            return false;
        };

        // Pick the "better" of two entries to keep as canonical
        const nameNoisiness = (name) => {
            // Higher score = noisier (less preferred as display name)
            const lower = (name || '').toLowerCase();
            let score = 0;
            if (/\bat millersville/i.test(lower)) score += 10;
            if (/\bat mu\b/i.test(lower)) score += 10;
            if (/student chapter/i.test(lower)) score += 10;
            if (/college radio station/i.test(lower)) score += 10;
            if (/^the\s+/i.test(name)) score += 1; // mild preference against leading "The"
            return score;
        };
        const pickWinner = (a, b) => {
            // Prefer the one with a non-empty id (authoritative GetInvolved API entry)
            if (a.id && !b.id) return { winner: a, loser: b };
            if (b.id && !a.id) return { winner: b, loser: a };
            // Prefer the cleaner name (lower noisiness score)
            const aNoise = nameNoisiness(a.name);
            const bNoise = nameNoisiness(b.name);
            if (aNoise !== bNoise) return aNoise < bNoise ? { winner: a, loser: b } : { winner: b, loser: a };
            // Tiebreaker: more filled-in categories
            const aCats = (a.categories || []).length;
            const bCats = (b.categories || []).length;
            if (aCats !== bCats) return aCats > bCats ? { winner: a, loser: b } : { winner: b, loser: a };
            // Tiebreaker: shorter name
            return a.name.length <= b.name.length ? { winner: a, loser: b } : { winner: b, loser: a };
        };

        // Build groups by normalized name
        const groups = new Map(); // normalizedName -> [entries]
        for (const org of orgs) {
            const key = normalizeClubName(org.name);
            if (!key) continue;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(org);
        }

        const dedupedOrgs = [];
        const mergeLog = [];
        for (const [key, entries] of groups) {
            if (entries.length === 1) { dedupedOrgs.push(entries[0]); continue; }

            // Check if any pair in the group is a varsity-vs-club conflict
            // If so, split the group: one bucket has "club" names, the other doesn't
            const anyConflict = entries.some((e1, i) =>
                entries.slice(i + 1).some(e2 => isVarsityVsClubConflict(e1.name, e2.name))
            );
            if (anyConflict) {
                const clubBucket = entries.filter(e => /\bclub\b/i.test(e.name));
                const nonClubBucket = entries.filter(e => !/\bclub\b/i.test(e.name));
                [clubBucket, nonClubBucket].forEach(bucket => {
                    if (bucket.length === 0) return;
                    if (bucket.length === 1) { dedupedOrgs.push(bucket[0]); return; }
                    let merged = bucket[0];
                    for (let i = 1; i < bucket.length; i++) {
                        const { winner, loser } = pickWinner(merged, bucket[i]);
                        merged = mergeTwoOrgs(winner, loser);
                        mergeLog.push(`  • "${loser.name}" → "${merged.name}"`);
                    }
                    dedupedOrgs.push(merged);
                });
                continue;
            }

            // Standard merge: collapse all entries into one
            let merged = entries[0];
            for (let i = 1; i < entries.length; i++) {
                const { winner, loser } = pickWinner(merged, entries[i]);
                merged = mergeTwoOrgs(winner, loser);
                mergeLog.push(`  • "${loser.name}" → "${merged.name}"`);
            }
            dedupedOrgs.push(merged);
        }

        function mergeTwoOrgs(winner, loser) {
            const mergedCategories = [...new Set([...(winner.categories || []), ...(loser.categories || [])])];
            return {
                name: winner.name,
                category: winner.category || loser.category || '',
                categories: mergedCategories,
                shortName: winner.shortName || loser.shortName || '',
                id: winner.id || loser.id || ''
            };
        }

        dedupedOrgs.sort((a, b) => a.name.localeCompare(b.name));
        const dedupedCount = orgs.length - dedupedOrgs.length;
        if (dedupedCount > 0) {
            console.log(`  🔀 Merged ${dedupedCount} near-duplicate org entries:`);
            mergeLog.slice(0, 20).forEach(l => console.log(l));
            if (mergeLog.length > 20) console.log(`  ... and ${mergeLog.length - 20} more`);
        }
        orgs = dedupedOrgs;

        fs.writeFileSync(path.join(__dirname, '../clubs.json'), JSON.stringify(orgs, null, 2));
        const eventDerivedCount = orgs.length - apiCount - manualCount;
        console.log(`✅ Clubs directory: ${orgs.length} organizations saved (${apiCount} from API + ${eventDerivedCount} from events + ${manualCount} manual, ${dedupedCount} merged)`);
    } catch (e) {
        console.error("❌ Clubs directory error:", e.message);
    }

    // ===== NEWS =====
    try {
        let news = [];

        // Helper to parse RSS items WITH optional category extraction
        function parseRSSItems(xml, sourceCategory, source, maxItems, options = {}) {
            const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
            const results = [];
            const skipCats = options.skipCategories || false;
            for (let i = 0; i < Math.min(maxItems, items.length); i++) {
                const t = items[i].match(/<title>([\s\S]*?)<\/title>/i);
                const l = items[i].match(/<link>([\s\S]*?)<\/link>/i);
                const d = items[i].match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
                // Extract RSS <category> tags for sub-categories
                let cats = [];
                if (!skipCats) {
                    const catRegex = /<category[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/gi;
                    let cm;
                    while ((cm = catRegex.exec(items[i])) !== null) {
                        const cat = cm[1].trim();
                        if (cat && !cats.includes(cat)) cats.push(cat);
                    }
                }
                if (t && l) {
                    const pubDate = d ? new Date(d[1]) : null;
                    results.push({
                        category: sourceCategory, source,
                        subCategory: cats.length > 0 ? cats[0] : '',
                        tags: cats,
                        title: t[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim(),
                        link: l[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim(),
                        date: pubDate ? pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : "",
                        sortDate: pubDate ? pubDate.toISOString() : "1970-01-01T00:00:00.000Z"
                    });
                }
            }
            return results;
        }

        // MU Official News (all posts — no sub-categories, too granular)
        try {
            const xml = await (await fetch('https://blogs.millersville.edu/news/feed/', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "MU", "Millersville News", 15, { skipCategories: true }));
            console.log(`  ✅ MU News: ${Math.min(15, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ MU News RSS error:", e.message); }

        // The Snapper — scrape each section page for proper categorization
        try {
            const snapperSections = [
                { url: 'https://thesnapper.com/news/', sub: 'News' },
                { url: 'https://thesnapper.com/opinion/', sub: 'Opinion' },
                { url: 'https://thesnapper.com/features/', sub: 'Features' },
                { url: 'https://thesnapper.com/arts-and-culture/', sub: 'Arts & Culture' },
                { url: 'https://thesnapper.com/sports/', sub: 'Sports' }
            ];
            let snapperTotal = 0;
            for (const section of snapperSections) {
                try {
                    const html = await (await fetch(section.url, { headers: baseHeaders })).text();
                    const articleRegex = /<h[23][^>]*>\s*<a\s+class="primary-link"\s+href="(https:\/\/thesnapper\.com\/[^"]+)">([^<]+)<\/a>/g;
                    const dateRegex = /<div[^>]*class="[^"]*publish-info[^"]*"[^>]*>[\s\S]*?<\/p>\s*<span[^>]*>[\s\S]*?<\/span>\s*<p>([^<]+)<\/p>/g;

                    const articles = [];
                    let match;
                    while ((match = articleRegex.exec(html)) !== null) {
                        const url = match[1], title = match[2].trim();
                        if (url.includes('/author/') || url.includes('/tag/') || title === 'View All') continue;
                        articles.push({ url, title });
                    }
                    const dates = [];
                    while ((match = dateRegex.exec(html)) !== null) dates.push(match[1].trim());

                    const max = Math.min(5, articles.length);
                    for (let i = 0; i < max; i++) {
                        const dateStr = dates[i] || '';
                        const parsed = dateStr ? new Date(dateStr) : null;
                        news.push({
                            category: "MU", source: "The Snapper",
                            subCategory: section.sub,
                            tags: [section.sub],
                            title: articles[i].title,
                            link: articles[i].url,
                            date: dateStr,
                            sortDate: parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : "1970-01-01T00:00:00.000Z"
                        });
                        snapperTotal++;
                    }
                } catch (e) { /* section failed, continue */ }
            }
            console.log(`  ✅ The Snapper: ${snapperTotal} articles across ${snapperSections.length} sections`);
        } catch (e) { console.error("❌ Snapper scrape error:", e.message); }

        // Millersville Borough News & Alerts
        try {
            const xml = await (await fetch('https://millersvilleborough.org/category/news-alerts/feed/', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "Borough", "Millersville Borough", 10));
            console.log(`  ✅ Borough News: ${Math.min(10, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ Borough News RSS error:", e.message); }

        // Penn Manor School District News
        try {
            const xml = await (await fetch('https://www.pennmanor.net/blog/feed/', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "PM", "Penn Manor News", 10));
            console.log(`  ✅ PM News: ${Math.min(10, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ PM News RSS error:", e.message); }

        // MU Athletics News (Sidearm RSS)
        try {
            const xml = await (await fetch('https://millersvilleathletics.com/rss', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "MU", "MU Athletics", 15));
            console.log(`  ✅ MU Athletics: ${Math.min(15, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ MU Athletics News RSS error:", e.message); }

        // MU The Review (magazine)
        try {
            const xml = await (await fetch('https://blogs.millersville.edu/news/category/the-review/feed/', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "MU", "MU Review", 10, { skipCategories: true }));
            console.log(`  ✅ MU Review: ${Math.min(10, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ The Review RSS error:", e.message); }

        // Deduplicate news by link
        const seenLinks = new Set();
        news = news.filter(n => {
            if (seenLinks.has(n.link)) return false;
            seenLinks.add(n.link);
            return true;
        });

        // Sort by date, most recent first
        news.sort((a, b) => new Date(b.sortDate || 0) - new Date(a.sortDate || 0));

        fs.writeFileSync(path.join(__dirname, '../news.json'), JSON.stringify(news, null, 2));
        console.log(`✅ News: ${news.length} total items (${news.filter(n=>n.image).length} with images)`);
    } catch (e) { console.error("❌ News/specials error:", e.message); }

    // ===== COMMUNITY BOARD (Google Sheet) =====
    //
    // Expiration policy: posts get a category-specific time-to-live, falling
    // back to 30 days. If the sheet ever gains an explicit "Expires" column
    // (9th column, optional date string), that overrides the category TTL.
    // Rationales per category:
    //   Lost Pet / Found Pet — should resolve within 2 weeks; stale posts
    //     depress the feed and imply the pet is still missing
    //   Free Stuff — goes fast, week-old post is almost certainly claimed
    //   Yard Sale — most sales within 3 weeks of the posting; covers this
    //     weekend + next weekend + slack
    //   Help Wanted / For Sale / Community Notice — standard 30-day shelf life
    try {
        console.log("📡 Fetching community board posts...");
        const BOARD_SHEET_ID = '1FZ-eFzLYFAgNd7aBCrU5uwb5wMQ2x9tBf_KLGa6GJS0';
        const BOARD_TTL_DAYS = {
            'Lost Pet': 14,
            'Found Pet': 14,
            'Free Stuff': 7,
            'Yard Sale': 21,
            'Help Wanted': 30,
            'For Sale': 30,
            'Community Notice': 30,
        };
        const DEFAULT_BOARD_TTL_DAYS = 30;
        const boardUrl = `https://docs.google.com/spreadsheets/d/${BOARD_SHEET_ID}/gviz/tq?tqx=out:csv`;
        const boardRes = await fetch(boardUrl);
        const boardPosts = [];
        let expiredCount = 0;
        if (boardRes.ok) {
            const csvText = await boardRes.text();
            const rows = csvText.split('\n').slice(1);
            for (const row of rows) {
                const cols = row.match(/"([^"]*)"/g);
                if (!cols || cols.length < 6) continue;
                const clean = cols.map(c => c.replace(/"/g, '').trim());
                // Schema (extensible): Timestamp, Category, Title, Description,
                // Contact Info, Location, Image URL, Status, [Expires?]
                const [timestamp, category, title, description, contact, location, imageUrl, status, expiresRaw] = clean;

                if (!status || !/approved/i.test(status)) continue;
                if (!title) continue;

                const postDate = timestamp ? new Date(timestamp) : new Date();
                const nowMs = Date.now();
                const cat = category || 'Community Notice';

                // Explicit expiration (column 9) wins if present and parseable
                let expiresAt;
                const explicitExpires = expiresRaw ? new Date(expiresRaw) : null;
                if (explicitExpires && !isNaN(explicitExpires)) {
                    expiresAt = explicitExpires;
                } else {
                    const ttlDays = BOARD_TTL_DAYS[cat] ?? DEFAULT_BOARD_TTL_DAYS;
                    expiresAt = new Date(postDate.getTime() + ttlDays * 24 * 60 * 60 * 1000);
                }
                if (expiresAt.getTime() <= nowMs) { expiredCount++; continue; }

                boardPosts.push({
                    category: cat,
                    title,
                    description: description || '',
                    contact: contact || '',
                    location: location || '',
                    image: imageUrl || '',
                    // Human-readable posted date (kept for backward compatibility
                    // with existing frontend rendering at board.json consumers)
                    date: postDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                    // New ISO fields for UI features like "posted N days ago" or
                    // "expiring soon" badges. Safe to ignore on older frontends.
                    postedAt: postDate.toISOString(),
                    expiresAt: expiresAt.toISOString(),
                });
            }
        }
        // Newest first — previously preserved spreadsheet order, which for a
        // Google Form-backed sheet happens to be oldest-first (forms append).
        // Flipping here means freshly-approved posts appear at the top of the
        // board without the frontend having to re-sort.
        boardPosts.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
        fs.writeFileSync(path.join(__dirname, '../board.json'), JSON.stringify(boardPosts, null, 2));
        console.log(`✅ Community Board: ${boardPosts.length} active, ${expiredCount} expired`);
    } catch (e) { console.log(`  ⚠️ Community Board error: ${e.message}`); }

    // ===== BUSINESS REVIEWS =====
    try {
        const REVIEW_SHEET_ID = process.env.REVIEW_SHEET_ID || '1-E7fJ6PyC1o-n5RpqKvkyGtvvxwqUrHnNRTvN5RWICc';
        if (REVIEW_SHEET_ID) {
            console.log('📡 Fetching business reviews...');
            const reviewUrl = `https://docs.google.com/spreadsheets/d/${REVIEW_SHEET_ID}/gviz/tq?tqx=out:csv`;
            const reviewRes = await fetch(reviewUrl, { headers: baseHeaders, signal: AbortSignal.timeout(10000) });
            if (reviewRes.ok) {
                const reviewCsv = await reviewRes.text();
                const reviewRows = reviewCsv.split('\n').slice(1); // skip header
                const bizReviews = {}; // { businessName: { total: N, sum: N, reviews: [] } }

                for (const row of reviewRows) {
                    if (!row.trim()) continue;
                    // CSV: timestamp, business, rating, review text, reviewer name
                    const cols = row.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g);
                    if (!cols || cols.length < 3) continue;
                    const business = (cols[1] || '').replace(/"/g, '').trim();
                    const rating = parseFloat((cols[2] || '').replace(/"/g, '').trim());
                    if (!business || isNaN(rating) || rating < 1 || rating > 5) continue;
                    const reviewText = cols[3] ? cols[3].replace(/"/g, '').trim() : '';
                    const reviewer = cols[4] ? cols[4].replace(/"/g, '').trim() : 'Anonymous';

                    if (!bizReviews[business]) bizReviews[business] = { total: 0, sum: 0 };
                    bizReviews[business].total++;
                    bizReviews[business].sum += rating;
                }

                // Read current services.json and merge ratings
                const servicesPath = path.join(__dirname, '../services.json');
                let services = [];
                try { services = JSON.parse(fs.readFileSync(servicesPath, 'utf8')); } catch (e) {}

                let updated = 0;
                for (const svc of services) {
                    const rev = bizReviews[svc.name];
                    if (rev && rev.total > 0) {
                        svc.rating = (rev.sum / rev.total).toFixed(1);
                        svc.reviewCount = rev.total;
                        updated++;
                    }
                }

                fs.writeFileSync(servicesPath, JSON.stringify(services, null, 2));
                console.log(`✅ Reviews: ${Object.keys(bizReviews).length} businesses reviewed, ${updated} ratings updated`);
            } else {
                console.log(`  ⚠️ Reviews sheet fetch failed: ${reviewRes.status}`);
            }
        }
    } catch (e) { console.log(`  ⚠️ Reviews error: ${e.message}`); }

    // Dead-man switch ping. If the GitHub Action secret HEALTHCHECK_URL is set, ping it
    // when the scrape completes. If the scrape never finishes (hang, crash, GitHub Actions
    // outage, etc.) the healthchecks.io service will email the admin after the configured
    // grace period. Fails silently if the URL isn't configured or the ping fails — we
    // don't want monitoring to ever break the scrape itself.
    const healthUrl = process.env.HEALTHCHECK_URL;
    if (healthUrl) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 5000);
            await fetch(healthUrl, { signal: ctrl.signal }).catch(() => {});
            clearTimeout(timer);
            console.log("🫀 Healthcheck ping sent");
        } catch (_) { /* never break the scrape on monitoring failure */ }
    }

    console.log("✅ All data compilations complete.");
}

runScraper();
