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

const sportsList = ['Baseball', 'Softball', 'Track', 'Soccer', 'Lacrosse', 'Tennis', 'Volleyball', 'Wrestling', 'Basketball', 'Football', 'Field Hockey', 'Golf', 'Cross Country', 'Cheerleading', 'Swimming', 'Rugby', 'Fencing', 'Esports', 'Archery'];

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

// Resolve an org's display short name. Returns the overlay value if present,
// otherwise the original name if it's already short enough (<22 chars), or
// empty string when there's nothing useful to show. The 22-char threshold
// matches the audit threshold I used when building the overlay.
function resolveOrgShortName(orgName) {
    if (!orgName) return '';
    const trimmed = orgName.trim();
    if (shortNameOverlay[trimmed]) return shortNameOverlay[trimmed];
    if (trimmed.length < 22) return trimmed;
    return ''; // Long name with no overlay — frontend falls back to "MU" pill
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

// Extract a linescore (box score) from a Sidearm recap page's HTML. Scans
// every <table> in the document and returns the first one that looks like
// a linescore, defined as:
//
//   - Has a header row whose trailing columns are totals: "R/H/E" (baseball,
//     softball), or "T"/"TOT"/"F"/"Final" (basketball, soccer, etc.)
//   - Has exactly 2 body rows (the two teams)
//   - Numeric period columns in between (1-N, or "1H/2H" for halves)
//
// We match team names against the event's title (to identify which row is
// Millersville vs opponent) and against "vs"/"@" in the title (to identify
// which is home vs away). Returns normalized shape or null on no match.
//
// Not perfect — some sports render linescores inside <div> layouts rather
// than <table> — but covers baseball/softball/basketball/lacrosse/volleyball
// well since they all ship StatCrew-generated tables.
function parseLinescoreFromHTML(html, event) {
    if (!html || !event || !event.title) return null;

    // Rough extractor: find all table blocks, then for each, split by <tr>.
    // Non-greedy + dot-includes-newline for robustness against formatted HTML.
    const tableBlocks = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi) || [];
    if (tableBlocks.length === 0) return null;

    const stripTags = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
    const isNumericLabel = s => /^\d+$/.test(s);
    const isTotalLabel = s => /^(r|h|e|t|tot|final|f|pts)$/i.test(s);
    const isHalfLabel = s => /^(1h|2h|1st|2nd|3rd|4th|ot\d*|ot)$/i.test(s);
    const isValidLabel = s => isNumericLabel(s) || isTotalLabel(s) || isHalfLabel(s);

    // Extract opponent name from event title — we'll use this to identify
    // which team row is MU and which is the opponent. "Softball vs Kutztown"
    // → "Kutztown". "Baseball at Hempfield" → "Hempfield". Title formatting
    // varies, so we fall back to a lax match.
    const oppMatch = event.title.match(/\s(?:vs\.?|@|at)\s+(.+?)(?:\s+(?:-|·|–).*)?$/i);
    const opponent = oppMatch ? oppMatch[1].trim().toLowerCase() : '';
    const titleHasVs = /\bvs\b/i.test(event.title);

    for (const tableHtml of tableBlocks) {
        const rowMatches = tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
        if (rowMatches.length < 3) continue;  // need header + 2 teams

        // Parse each row into { tag: 'th'|'td'|'mixed', cells: [text,...] }
        const rows = rowMatches.map(r => {
            const cellMatches = r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || [];
            return cellMatches.map(c => stripTags(c));
        }).filter(row => row.length > 0);

        if (rows.length < 3) continue;

        // Identify the header row — first row whose non-first cells are
        // mostly valid period/total labels. Some tables have a "Game Info"
        // caption row above the real header; allow up to 2 rows of skip.
        let headerIdx = -1;
        for (let i = 0; i < Math.min(3, rows.length - 2); i++) {
            const candidate = rows[i];
            if (candidate.length < 3) continue;
            // Non-first cells should all be valid labels
            const labelCells = candidate.slice(1);
            if (labelCells.length < 2) continue;
            const validCount = labelCells.filter(isValidLabel).length;
            if (validCount / labelCells.length < 0.7) continue;

            // REJECT player stats tables. A stats table has headers like
            // "Player, AB, R, H, RBI" — our valid-label regex accepts R/H
            // as total-style labels, which gives a false positive. The
            // distinguishing signal: a real linescore has at least one
            // sequential numeric period (1, 2, 3...) or a half label
            // (1H/2H/1st/2nd/OT). A stats table has no periods at all.
            const periodCells = labelCells.filter(c => isNumericLabel(c) || isHalfLabel(c));
            if (periodCells.length < 2) continue;

            // Also require the first-column header cell to be empty (the
            // conventional linescore corner cell) rather than a label like
            // "Player" or "Starters" which would indicate a stats table.
            const cornerCell = candidate[0].trim();
            if (cornerCell.length > 0 && cornerCell.length < 20) continue;

            headerIdx = i;
            break;
        }
        if (headerIdx < 0) continue;

        const labels = rows[headerIdx].slice(1);
        const teamRows = rows.slice(headerIdx + 1).filter(r => r.length === rows[headerIdx].length);
        if (teamRows.length < 2) continue;  // need at least 2 team rows matching the header width

        // Take the first 2 rows. StatCrew tables render "Visitor" then "Home"
        // by convention — the first team row is the away/visitor side.
        const awayRow = teamRows[0];
        const homeRow = teamRows[1];

        const awayName = awayRow[0];
        const homeName = homeRow[0];
        const awayValues = awayRow.slice(1);
        const homeValues = homeRow.slice(1);

        // Sanity check: at least half of the score cells should be numeric
        // (or "X"/"-" for skipped-inning placeholders). If they're mostly
        // text, this isn't a linescore — probably a team-stats table.
        const isDataCell = v => /^(\d+|x|-|—|\.\d+)$/i.test((v || '').trim());
        const allValues = [...awayValues, ...homeValues];
        const numericRatio = allValues.filter(isDataCell).length / (allValues.length || 1);
        if (numericRatio < 0.7) continue;

        // Determine which row is Millersville. Match on name substring.
        const isMU = s => /millersville|marauders/i.test(s);
        let ourTeamSide;
        if (isMU(awayName) && !isMU(homeName)) ourTeamSide = 'away';
        else if (isMU(homeName) && !isMU(awayName)) ourTeamSide = 'home';
        else if (opponent) {
            // Fallback: match opponent to one of the team names.
            if (awayName.toLowerCase().includes(opponent)) ourTeamSide = 'home';
            else if (homeName.toLowerCase().includes(opponent)) ourTeamSide = 'away';
            // Still unknown — use title's vs/at to decide (MU vs OPP = MU home)
            else ourTeamSide = titleHasVs ? 'home' : 'away';
        } else {
            ourTeamSide = titleHasVs ? 'home' : 'away';
        }

        return {
            labels,
            home: { team: homeName, values: homeValues },
            away: { team: awayName, values: awayValues },
            ourTeamSide
        };
    }
    return null;
}

function classifyAudience({ titleText, descText, orgName = '', rawTags = [], tags = [], benefits = [] }) {
    if (benefits.includes('Credit')) return 'mu-only';
    const combinedText = ((titleText || '') + ' ' + (descText || '') + ' ' + (orgName || '')).toLowerCase();

    // Strong mu-only signals — things that are obviously student-facing. Checked FIRST so
    // they override weaker "public" keyword matches (e.g. "our campus community").
    // Kept conservative so we don't false-positive open-to-public recitals or concerts.
    const muOnlyKeywordRegex = /\b(bible study|fellowship(?! hall)|chapter meeting|chapter business|weekly meeting|general body meeting|gbm|e-?board meeting|executive meeting|officer meeting|members only|tabling|orientation|info session|information session|club meeting|resume review|mock interview|study group|study session|homework help|office hours|interest meeting|rush|recruitment night|new member|initiation|brother hood|sister hood|sisterhood|brotherhood)\b/i;
    const muOnlyOrgRegex = /\b(fraternity|sorority|christian fellowship|campus ministry|cru |intervarsity|reformed university fellowship|ruf\b|gsa\b|gender and sexuality alliance|residence hall|housing community)\b/i;
    if (muOnlyKeywordRegex.test(combinedText)) return 'mu-only';
    if (muOnlyOrgRegex.test(orgName.toLowerCase() + ' ' + combinedText)) return 'mu-only';
    // Greek Life category tag → always mu-only
    if (rawTags.some(t => /greek life|residence hall/i.test(t))) return 'mu-only';

    // Public signals (unchanged from prior logic)
    const publicKeywordRegex = /\b(open to (the )?(public|community|all)|community welcome|all (are )?welcome|public event|for the public|blood drive|fundraiser|walkathon|5k|10k|run for|bake sale|festival|fair|concert|performance|recital|exhibition|gallery|benefit (for|concert)|donate|donation|charity|awareness (day|walk|event)|food drive|clothing drive|toy drive|drive for|volunteer|service project|community service|habitat for humanity|red cross|food pantry|soup kitchen)\b/i;
    const publicCategoryRegex = /\b(fundraising|service|community service|performance|sporting|athletic|community|philanthropy|volunteer)\b/i;
    const publicOrgRegex = /\b(red cross|food pantry|habitat for humanity|goodwill|salvation army|special olympics|make[- ]?a[- ]?wish)\b/i;
    if (publicKeywordRegex.test(combinedText)) return 'public';
    if (rawTags.some(t => publicCategoryRegex.test(t))) return 'public';
    if (publicOrgRegex.test(orgName)) return 'public';
    if (tags.includes('Fundraising')) return 'public';
    if (tags.includes('Club Sports') && tags.includes('Home Game Mode')) return 'public';
    return 'mu-only';
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
                eventsArray.push({
                    title: ldData.name, date: eventDate.toISOString(), location: "Phantom Power",
                    tags: ["Other", "Live Music"], price: "Ticket Required",
                    ticketLink: url,
                    sourceLink: url
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
        title = h1Match[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .trim();
    }
    // og:title is a reliable fallback if <h1> has odd nesting or is missing.
    if (!title) {
        const ogMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
        if (ogMatch) title = ogMatch[1].replace(/\s*[|\-–]\s*Eventbrite\s*$/i, '').trim();
    }
    if (!title) return 0;

    eventsArray.push({
        title, date: eventDate.toISOString(), location: "Phantom Power",
        tags: ["Other", "Live Music"], price: "Ticket Required",
        ticketLink: url, sourceLink: url
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
            // Per-row markup is wild and varies; a robust approach is to find every recap
            // anchor and then walk back from it to find the nearest date label. But the
            // date labels in the rendered HTML look like `Feb 7(Sat) 1:00 PM` and the recap
            // URL has the date baked in (`/news/2026/2/7/...`). Since we only need to match
            // on date + sport, we can just extract dates directly from the recap URLs.
            // URL pattern: /news/YYYY/M/D/slug
            const recapRegex = /href="(\/news\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/[^"]+?)"[^>]*>Recap<\/a>/gi;
            let match;
            while ((match = recapRegex.exec(html)) !== null) {
                const [, relHref, yr, mo, dy] = match;
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

        for (const ev of Object.values(pmData)) {
            const eventDate = new Date(ev.start);
            if (isNaN(eventDate.getTime()) || eventDate < pastDate || eventDate >= futureDate) continue;

            const title = ev.summary || 'Penn Manor Event';
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
                // Parse structured description: Sport:, Level:, Site:
                const sportMatch = desc.match(/Sport:\s*(.+?)(?:\\n|\n|$)/i);
                const levelMatch = desc.match(/Level:\s*(.+?)(?:\\n|\n|$)/i);

                let tags = ["PM", "Athletics"];

                // Home vs Away: "vs" = home, "@" = away
                const isHome = lowerTitle.includes(' vs ');
                if (isHome) tags.push("Home Game Mode");

                // Level
                const level = levelMatch ? levelMatch[1].trim() : '';
                if (/varsity/i.test(level) && !/jv/i.test(level)) tags.push('Varsity');
                if (/jv/i.test(level)) tags.push('JV');
                if (/7th|8th|jr high|junior high/i.test(level)) tags.push('Jr High');

                // Gender
                if (/\bboys\b|boy's/i.test(level) || /\bboys\b/i.test(lowerTitle)) tags.push('Boys');
                if (/\bgirls\b|girl's/i.test(level) || /\bgirls\b/i.test(lowerTitle)) tags.push('Girls');
                if (/\bcoed\b/i.test(level) || /\bcoed\b/i.test(lowerTitle)) { tags.push('Boys'); tags.push('Girls'); }

                // Sport type
                sportsList.forEach(s => {
                    if (lowerTitle.includes(s.toLowerCase())) tags.push(s);
                });
                // Catch Track & Field variants
                if (/track\s*&?\s*field/i.test(desc) && !tags.includes('Track')) tags.push('Track');
                if (/bocce/i.test(lowerTitle)) tags.push('Athletics'); // Bocce not in list but keep tagged

                let pmStreamLink = '';

                // Check if game is live
                const eventEnd = ev.end ? new Date(ev.end) : new Date(eventDate.getTime() + 2*60*60*1000);
                const pmIsLive = now >= eventDate && now <= eventEnd && !!pmStreamLink;

                events.push({
                    title, date: eventDate.toISOString(), location: loc,
                    tags: [...new Set(tags)], price: "Free", ticketLink: "",
                    sourceLink: ev.url || "https://www.pennmanor.net/calendar/",
                    gameResult: '', gameScore: '',
                    streamLink: pmStreamLink,
                    isLive: pmIsLive
                });
                pmAthCount++;
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
                else if (/sap meeting|team leader|lunch\s*&?\s*learn|house meeting/i.test(lt)) tags.push('Meetings');
                else tags.push('Other');

                // Skip PM-Other events (uncategorized, not useful)
                if (tags.includes('Other')) continue;

                const pmBoardStream = /board/i.test(lt) ? 'https://www.youtube.com/@PennManorSchoolDistrict/streams' : '';

                events.push({
                    title, date: eventDate.toISOString(), location: loc,
                    tags: [...new Set(tags)], price: "Free", ticketLink: "",
                    sourceLink: ev.url || "https://www.pennmanor.net/calendar/",
                    streamLink: pmBoardStream
                });
                pmGenCount++;
            }
        }
        console.log(`✅ Penn Manor: ${pmAthCount} athletic + ${pmGenCount} general = ${pmAthCount + pmGenCount} events`);
        // Debug: check girls lacrosse coverage
        const girlsLax = events.filter(e => e.tags && e.tags.includes('PM') && e.tags.includes('Girls') && e.tags.includes('Lacrosse'));
        const futureGirlsLax = girlsLax.filter(e => new Date(e.date) >= now);
        console.log(`    🔍 Girls Lacrosse: ${girlsLax.length} total, ${futureGirlsLax.length} future`);
        futureGirlsLax.forEach(e => console.log(`      → ${e.title} (${new Date(e.date).toISOString().split('T')[0]})`));
    } catch (e) { console.error("❌ Penn Manor error:", e.message); }

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
    // MU broadcasts on PSAC Sports Digital Network, which is powered by Hudl TV
    // (BlueFrame was acquired by Hudl in 2022). MU's Hudl schoolId is derived
    // from org ID 12060: base64("School12060") = "U2Nob29sMTIwNjA=".
    //
    // The user-facing PSAC URL is
    //   https://psacsportsdigitalnetwork.com/millersvilleathletics/?B=<broadcastId>
    // where <broadcastId> is the numeric BlueFrame broadcast ID. We haven't
    // verified the mapping from Hudl's `id` or `internalId` to that BlueFrame
    // ID, so we use the same fan.hudl.com URL pattern as the PM block — known
    // to work because BlueFrame's player ultimately embeds vcloud.hudl.com, so
    // both front-ends resolve the same underlying broadcast.
    //
    // This block OVERRIDES the Sidearm streamLink for MU games when Hudl has a
    // broadcast entry. Combined with the earlier defensive filter (which strips
    // generic PSAC URLs from non-live games), the net effect is: upcoming
    // games without a Hudl broadcast show no Watch button; upcoming games with
    // a Hudl broadcast get a working per-game URL; live and past games work
    // the same as before, improved by specific archive URLs where available.
    try {
        console.log("📡 Checking Hudl broadcasts for MU games...");
        const muHudlQuery = `query Web_Fan_GetScheduleEntrySummaries_r1($input: GetScheduleEntryPublicSummariesInput!) {
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
        const muHudlBroadcasts = new Map();  // key -> { id, timeUtc }
        const muHudlAllEntries = new Map();  // key -> { id, timeUtc } (for past highlights)
        let muTotalEntries = 0, muBroadcastCount = 0;

        // Same 30-day paginated chunking as PM block
        const muChunkSize = 30 * 24 * 60 * 60 * 1000;
        let muStart = pastDate.getTime();
        const muEnd = futureDate.getTime();

        while (muStart < muEnd) {
            const chunkEnd = Math.min(muStart + muChunkSize, muEnd);
            let cursor = null;
            let hasMore = true;
            while (hasMore) {
                const inputVars = {
                    sortType: 'SCHEDULE_ENTRY_DATE',
                    schoolIds: ['U2Nob29sMTIwNjA='],
                    filterStartDate: new Date(muStart).toISOString(),
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
                        query: muHudlQuery
                    })
                });
                if (!res.ok) { hasMore = false; break; }
                const data = await res.json();
                const result = data?.data?.scheduleEntryPublicSummaries;
                const items = result?.items || [];
                muTotalEntries += items.length;

                for (const item of items) {
                    const gameDate = new Date(item.timeUtc).toISOString().split('T')[0];
                    const key = `${gameDate}|${item.sportId}|${item.genderId}`;
                    if (!muHudlAllEntries.has(key)) {
                        muHudlAllEntries.set(key, { id: item.id, timeUtc: item.timeUtc });
                    }
                    if (item.broadcastStatus !== null && item.broadcastStatus !== undefined) {
                        muHudlBroadcasts.set(key, { id: item.id, timeUtc: item.timeUtc });
                        muBroadcastCount++;
                    }
                }
                hasMore = result?.pageInfo?.hasNextPage || false;
                cursor = result?.pageInfo?.endCursor || null;
                if (items.length === 0) hasMore = false;
            }
            muStart = chunkEnd;
        }
        console.log(`  📺 MU Hudl: ${muTotalEntries} schedule entries, ${muBroadcastCount} with broadcasts`);

        // Reuse the sport mapping from the PM block via global (set at line above).
        // If for some reason the PM block failed and didn't set it, derive ours here.
        const muSportToHudlId = global._hudlSportToId || (() => {
            const m = { 1:'football', 2:'basketball', 3:'soccer', 4:'volleyball',
                        5:'baseball', 6:'softball', 7:'lacrosse', 8:'field hockey',
                        9:'wrestling', 10:'tennis', 11:'track', 12:'swimming' };
            const out = {};
            for (const [id, name] of Object.entries(m)) out[name] = parseInt(id);
            return out;
        })();

        // Apply MU Hudl broadcasts to MU Athletic Competitions events already in
        // the events array (Sidearm MU block ran earlier in section 2).
        let muMatchCount = 0, muHighlightCount = 0;
        for (const ev of events) {
            if (!ev.tags || !ev.tags.includes('MU')) continue;
            if (!ev.tags.includes('Athletic Competitions')) continue;
            const sportTag = ev.tags.find(t => muSportToHudlId[t.toLowerCase()]);
            if (!sportTag) continue;
            const evDate = new Date(ev.date).toISOString().split('T')[0];
            // MU tag convention is Women's / Men's (not Girls / Boys like PM)
            const gender = ev.tags.includes("Women's") ? 1 : 0;
            const sportId = muSportToHudlId[sportTag.toLowerCase()];
            const key = `${evDate}|${sportId}|${gender}`;

            const broadcast = muHudlBroadcasts.get(key);
            if (broadcast) {
                const watchDate = new Date(broadcast.timeUtc).toISOString();
                ev.streamLink = `https://fan.hudl.com/usa/pa/millersville/organization/12060/millersville/schedule?date=${encodeURIComponent(watchDate)}&range=Day&s=${encodeURIComponent(broadcast.id)}`;
                muMatchCount++;
            } else if (new Date(ev.date) < now) {
                // Past game with no broadcast — link to team schedule day view for
                // any highlight reels that may be available
                const entry = muHudlAllEntries.get(key);
                if (entry) {
                    const watchDate = new Date(entry.timeUtc).toISOString();
                    ev.streamLink = `https://fan.hudl.com/usa/pa/millersville/organization/12060/millersville/schedule?date=${encodeURIComponent(watchDate)}&range=Day&s=${encodeURIComponent(entry.id)}`;
                    muHighlightCount++;
                }
            }

            // Re-evaluate isLive now that streamLink may have been added
            if (ev.streamLink && !ev.isLive) {
                const evStart = new Date(ev.date);
                const evEnd = new Date(evStart.getTime() + 3 * 60 * 60 * 1000);
                if (now >= evStart && now <= evEnd && !ev.gameResult) {
                    ev.isLive = true;
                }
            }
        }
        console.log(`  📺 MU matched ${muMatchCount} broadcasts, ${muHighlightCount} past highlight links`);
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

        if (data.fields && Array.isArray(data.data)) {
            const fields = data.fields.split(',');
            const nameIdx = fields.indexOf('ActivityName');
            const startIdx = fields.indexOf('StartDateTime');
            const bldgIdx = fields.indexOf('BuildingCode');
            const roomIdx = fields.indexOf('RoomName');
            const descIdx = fields.indexOf('EventMeetingByActivityId.Event.Description');
            const linkIdx = fields.findIndex(f => f.toLowerCase().includes('url') || f.toLowerCase().includes('link'));
            const idIdx = fields.indexOf('ActivityId');
            const typeIdx = fields.indexOf('MeetingType:EventMeetingByActivityId.EventMeetingType.Name');
            const customerIdx = fields.indexOf('Customer:EventMeetingByActivityId.Event.Customer.Name');

            let muCount = 0;
            data.data.forEach(row => {
                const eventTitle = row[nameIdx] || "Campus Event";
                const eventType = typeIdx !== -1 ? (row[typeIdx] || '').trim() : '';

                // SKIP Athletic Competitions — we get those from Sidearm now
                if (eventType === 'Athletic Competitions') return;

                let eventLoc = `${row[bldgIdx] || ''} ${row[roomIdx] || ''}`.trim() || "Campus";
                // Clean up building codes
                if (eventLoc === 'AcCALEN') eventLoc = 'Millersville University';
                eventLoc = eventLoc.replace(/^WARE Ware Center$/i, 'Ware Center')
                                   .replace(/^WARE\b/, 'Ware Center')
                                   .replace(/^Ware Center\s+/, 'Ware Center, ');
                const pricing = extractPricing(row[descIdx] || "", eventTitle, eventLoc, linkIdx !== -1 ? (row[linkIdx] || "") : "");

                let tags = ["MU"];
                if (eventType) tags.push(eventType);
                if (customerIdx !== -1 && row[customerIdx]) tags.push(row[customerIdx].trim());

                // RELABEL: "Student Event" from the MU calendar is really the GetInvolved feed
                // being republished on the main calendar, creating duplicates. Treat these as
                // GetInvolved events so they filter/display/dedupe consistently.
                //   - Swap tag: "Student Event" → "GetInvolved" + "Clubs/Orgs"
                //   - Run the audience classifier so townies filter correctly (public stuff like
                //     blood drives / fundraisers stays visible to them, private chapter meetings don't)
                let audience;
                if (tags.includes('Student Event')) {
                    tags = tags.filter(t => t !== 'Student Event');
                    if (!tags.includes('GetInvolved')) tags.push('GetInvolved');
                    if (!tags.includes('Clubs/Orgs')) tags.push('Clubs/Orgs');
                    // Plain-text description for keyword scanning
                    const plainDesc = (row[descIdx] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    const customerName = (customerIdx !== -1 && row[customerIdx]) ? row[customerIdx].trim() : '';

                    // Derived-tag detection — mirrors the logic in the main
                    // GetInvolved API block (search for greekRegex). Cross-source
                    // dedupe prioritizes MU Calendar over GetInvolved; without
                    // this parallel detection, the surviving merged event would
                    // lose its Greek Life / Residence Halls / Fundraising tags
                    // (which only the GetInvolved path knew how to derive).
                    // Townie-side filtering also depends on these tags via
                    // classifyAudience below, so the detection MUST run before
                    // that call for Greek/Residence events to be correctly
                    // marked mu-only instead of public.
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

                const eventId = idIdx !== -1 ? row[idIdx] : "";
                const sourceLink = eventId
                    ? `https://www.millersville.edu/calendar/events/${eventId}`
                    : "https://www.millersville.edu/calendar/";

                const descHtml = row[descIdx] || "";

                // Decorate generic single-word titles ("Practice" / "Meeting" /
                // "Informational") with the customer/org name when available,
                // producing clearer card labels like "Men's Rugby Club Practice".
                // The customerIdx value is the row's associated org on MU Calendar.
                const calCustomerName = (customerIdx !== -1 && row[customerIdx]) ? row[customerIdx].trim() : '';
                const decoratedTitle = decorateGenericTitle(eventTitle, calCustomerName);

                events.push({
                    title: decoratedTitle, date: row[startIdx], location: eventLoc,
                    tags: [...new Set(tags)], price: pricing.price,
                    ticketLink: pricing.link, sourceLink,
                    description: descHtml,
                    ...(calCustomerName ? { orgName: calCustomerName, orgShortName: resolveOrgShortName(calCustomerName) } : {}),
                    ...(audience ? { audience } : {})
                });
                muCount++;
            });
            console.log(`✅ MU Calendar (non-sport): ${muCount} events`);
        } else {
            throw new Error('MU API unexpected structure');
        }
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
        let artsCount = 0, artsSkipped = 0, artsFailed = 0;
        const existingKeys = new Set(events.map(e => (e.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) + '|' + (e.date || '').slice(0, 10)));

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

                // Dedupe against MU Calendar entries
                const key = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) + '|' + eventDate.toISOString().slice(0, 10);
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
    try {
        const campsPath = path.join(__dirname, '../camps.json');
        if (fs.existsSync(campsPath)) {
            const campsData = JSON.parse(fs.readFileSync(campsPath, 'utf-8'));
            if (Array.isArray(campsData)) {
                let campCount = 0, campSkipped = 0;
                const existingKeys4 = new Set(events.map(e => (e.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) + '|' + (e.date || '').slice(0, 10)));
                for (const camp of campsData) {
                    if (!camp.title || !camp.date) { campSkipped++; continue; }
                    const campDate = new Date(camp.date);
                    if (isNaN(campDate.getTime())) { campSkipped++; continue; }
                    if (campDate < pastDate || campDate >= futureDate) { campSkipped++; continue; }
                    const key = camp.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) + '|' + campDate.toISOString().slice(0, 10);
                    if (existingKeys4.has(key)) { campSkipped++; continue; }
                    events.push({
                        title: camp.title,
                        date: campDate.toISOString(),
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
            const orgDisplayName = (item.organizationName || '').trim();
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

        for (const ev of Object.values(boroughData)) {
            if (ev.type !== 'VEVENT') continue;

            const title = ev.summary || 'Borough Event';
            const loc = ev.location || 'Millersville Borough';

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
                                location: loc,
                                tags: ['Borough'],
                                price: 'Free', ticketLink: '',
                                sourceLink: 'https://millersvilleborough.org/resident-info/calendar/',
                                gameResult: '', gameScore: '', streamLink: boroughStream, isLive: false
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
                    location: loc,
                    tags: ['Borough'],
                    price: 'Free', ticketLink: '',
                    sourceLink: ev.url || 'https://millersvilleborough.org/resident-info/calendar/',
                    gameResult: '', gameScore: '',
                    streamLink: /council/i.test(title) ? 'https://www.youtube.com/@MillersvilleBorough/streams' : '',
                    isLive: false
                });
                boroughCount++;
            }
        }
        console.log(`✅ Borough Calendar: ${boroughCount} events (${boroughRecurring} from recurring)`);
    } catch (e) { console.error("❌ Borough Calendar error:", e.message); }


    // ===== 7. VFW POST 7294 (Google Sheet + Anthropic Claude Vision) =====
    try {
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
{"type":"event","name":"Meat Tray Bingo","date":"2026-05-03","time":"1:00 PM","details":"Doors open 12:00 PM, Starter Packs $25","openToPublic":true}

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
                const evDate = evDateStr ? new Date(evDateStr + 'T16:00:00Z') : null;
                if (evDate && !isNaN(evDate.getTime()) && evDate >= pastDate && evDate < futureDate) {
                    const priceTag = parsed.openToPublic ? 'Open to Public' : 'Members Only';
                    events.push({
                        title: parsed.name, date: evDate.toISOString(),
                        location: 'VFW Post 7294, 219 Walnut Hill Rd',
                        tags: ['Other', 'VFW'], price: priceTag, ticketLink: '', sourceLink: postLink,
                        gameResult: '', gameScore: '', streamLink: '', isLive: false, kidFriendly: false
                    });
                    vfwEventCount++;
                    console.log(`    📌 Event: "${parsed.name}" on ${evDateStr}${parsed.time ? ' at ' + parsed.time : ''}`);
                }
            }

          } catch (err) { console.log(`    ⚠️ Error: ${err.message}`); }
        }

        // Save cache + specials
        fs.writeFileSync(cachePath, JSON.stringify(vfwCache, null, 2));
        console.log(`✅ VFW: ${vfwEventCount} events (${vfwApiCalls} API calls, ${Object.keys(vfwCache).length} cached)`);

        // ===== JOHN HERR'S WEEKLY GROCERY DEALS =====
        let groceryDeals = [];
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
                            // have rotated (print page empty), Freshop may
                            // have changed its image CDN pattern breaking our
                            // regex, or the circular layout drifted enough
                            // that Claude can't parse it. Fire /fail so we
                            // hear about it within the hour. This is distinct
                            // from cache-miss (handled by outer try/catch as
                            // transient) and the "cache is warm" path (which
                            // skips this block entirely).
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

            const rows = allRows.slice(1); // skip header
            let communityCount = 0;
            let skippedNoStatus = 0;
            let skippedBadDate = 0;
            let skippedOutOfRange = 0;
            for (const row of rows) {
                if (!row.trim()) continue;
                const cols = parseCSVLine(row);
                if (cols.length < 2) continue;
                // Safer destructuring — don't bail just because cols.length < 9; status might be in col 8
                // but other fields may be present even if status is missing/short.
                const eventName = (cols[1] || '').trim();
                const dateStr = (cols[2] || '').trim();
                const timeStr = (cols[3] || '').trim();
                const location = (cols[4] || '').trim();
                const description = (cols[5] || '').trim();
                const link = (cols[7] || '').trim();
                const status = (cols[8] || '').trim();

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
                // unparseable.
                let timeH = 12, timeM = 0;
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

                events.push({
                    title: eventName,
                    date: eventDate.toISOString(),
                    location: location || 'Millersville',
                    tags: ['Community'],
                    price: 'Free',
                    ticketLink: '',
                    sourceLink: link || '',
                    description: description || ''
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
                    location: 'The HUB',
                    description: 'Free meal for all Millersville University students. Bring student ID. Service runs 11am – 1pm.',
                    tags: ['MU', 'HUB', 'Free Food', 'Other'],
                    audience: 'mu-only',
                    benefits: ['Free Food'],
                    orgName: 'The HUB',
                    orgShortName: 'The HUB',
                    sourceLink: 'https://www.millersville.edu/'
                });
                hubGenerated++;
            }
            // Fri (5): French Toast Friday 9pm-midnight
            if (dayOfWeek === 5) {
                const isoStart = buildEternalISO(y, mo, d, 21, 0);
                hubEvents.push({
                    title: 'French Toast Friday',
                    date: new Date(isoStart).toISOString(),
                    location: 'The HUB',
                    description: 'Free French toast for all Millersville University students, 9pm – midnight. Bring student ID.',
                    tags: ['MU', 'HUB', 'Free Food', 'Other'],
                    audience: 'mu-only',
                    benefits: ['Free Food'],
                    orgName: 'The HUB',
                    orgShortName: 'The HUB',
                    sourceLink: 'https://www.millersville.edu/'
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
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/cross-country/schedule/', sport: 'Cross Country', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/cross-country/girls/schedule/', sport: 'Cross Country', gender: 'Girls' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/swimming/schedule/', sport: 'Swimming', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/swimming/girls/schedule/', sport: 'Swimming', gender: 'Girls' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/track-and-field/schedule/', sport: 'Track', gender: 'Boys' },
            { url: 'https://www.maxpreps.com/pa/millersville/penn-manor-comets/track-and-field/girls/schedule/', sport: 'Track', gender: 'Girls' },
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

    // ===== BOX SCORES (MU via Sidearm recap pages) =====
    // For past MU sport events with a final score and a Sidearm recap URL,
    // fetch the recap page and try to extract the inline linescore (box
    // score) table. We attach it to event.periodScores with a normalized
    // shape { labels, home, away, ourTeamSide } so the frontend can render
    // a clean table regardless of whether it's baseball (1-9 innings + R/H/E)
    // or basketball (1-4 quarters + T) etc.
    //
    // Capped at BOX_SCORE_FETCH_CAP fetches per scrape run to avoid blowing
    // past cron time budget if we have 100+ past games. Silent failure when
    // a page doesn't contain a parseable linescore — periodScores simply
    // stays undefined and the frontend falls back to the summary block.
    try {
        console.log("📡 Fetching MU box scores from Sidearm recap pages...");
        const BOX_SCORE_FETCH_CAP = 30;
        let bsFetched = 0, bsMatched = 0, bsSkipped = 0;

        const pastMUGames = events.filter(ev => {
            const tags = ev.tags || [];
            if (!tags.includes('MU')) return false;
            if (!ev.gameResult || !ev.gameScore) return false;   // must be past + scored
            if (!ev.sourceLink) return false;
            if (!/athletics\.millersville\.edu/i.test(ev.sourceLink)) return false;
            return true;
        });

        // Most-recent-first ordering so if we hit the cap, we get fresh box
        // scores rather than stale ones from months ago.
        pastMUGames.sort((a, b) => new Date(b.date) - new Date(a.date));

        for (const ev of pastMUGames) {
            if (bsFetched >= BOX_SCORE_FETCH_CAP) { bsSkipped++; continue; }
            try {
                const res = await fetch(ev.sourceLink, {
                    headers: baseHeaders,
                    signal: AbortSignal.timeout(8000)
                });
                bsFetched++;
                if (!res.ok) continue;
                const html = await res.text();
                const ps = parseLinescoreFromHTML(html, ev);
                if (ps) {
                    ev.periodScores = ps;
                    bsMatched++;
                }
            } catch (err) {
                // Individual page fetch failures are routine (timeouts,
                // redirects to nonexistent pages, etc.) — swallow silently,
                // the outer try/catch only catches catastrophic errors.
            }
        }
        console.log(`  📋 Box scores: ${bsMatched}/${bsFetched} parsed (${bsSkipped} over cap)`);
    } catch (e) { console.log(`  ⚠️ Box score fetch error: ${e.message}`); }

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

    // Pass 1: exact-match dedupe (unchanged legacy)
    const seen = new Set();
    const exactDupes = [];
    let pass1 = events.filter(e => {
        const key = `${(e.title||'').trim().toLowerCase()}-${e.date}-${(e.location || '').trim().toLowerCase()}`;
        if (seen.has(key)) {
            exactDupes.push({ title: e.title, date: e.date.substring(0,10), source: (e.tags||[])[0] || 'Unknown' });
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

    const normalizedEvents = pass1.map((e, i) => ({
        idx: i,
        event: e,
        norm: normalizeTitle(e.title),
        day: (e.date || '').slice(0, 10),
        time: new Date(e.date || 0).getTime(),
        bucket: sourceBucket(e)
    })).filter(n => n.norm && !CALENDAR_ARTIFACT_PATTERNS.test(n.norm));

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

            let titleMatch;
            if (exactMatch) titleMatch = true;
            else if (isGeneric) titleMatch = false;
            else titleMatch = substringMatch && shorter.length >= 8;

            if (!titleMatch) continue;

            // Time-window check for loose (substring) matches. Two cases:
            //   (a) Short substring match (shorter norm < 10 chars): require times within 30 min —
            //       very short phrases could legitimately occur as multiple sessions.
            //   (b) Long substring match (shorter norm >= 10 chars): title overlap is distinctive
            //       enough that same-day match is almost certainly the same event. Sources often
            //       list different times for the same event (doors-open vs performance-start),
            //       so allow merging regardless of time gap.
            if (!exactMatch) {
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
            // Primary: source priority (MU Calendar > Clubs/Orgs > artsmu)
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
    fs.writeFileSync(path.join(__dirname, '../events.json'), slimJson);
    if (beforeBytes > 0) {
        const reductionPct = Math.round((1 - afterBytes / beforeBytes) * 100);
        console.log(`💾 events.json: ${(afterBytes/1024).toFixed(1)}KB (${reductionPct}% smaller than pretty-printed)`);
    }
    // Sibling metadata file for the frontend's "last updated" display. Kept separate so we
    // don't have to change the events.json array-shape that tons of code reads from.
    const metaPath = path.join(__dirname, '../events-meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        eventCount: deduped.length
    }, null, 2));
    console.log(`📊 Total events saved: ${deduped.length} (${deduped.filter(e=>e.image).length} with images, ${deduped.filter(e=>e.description).length} with descriptions)`);

    // ===== STATUS DASHBOARD DATA =====
    // Companion stats file consumed by /status.html. Computed from the final
    // deduped array so it reflects the TRUE state shipped to users, not raw
    // fetch counts (which would inflate totals before cross-source dedupe).
    // Separate from events-meta.json so the frontend's "last updated" code
    // stays stable on a simple schema while this file grows as we add metrics.
    try {
        const bySourceCount = (sourceTag, extraFilter = () => true) =>
            deduped.filter(e => (e.tags || []).includes(sourceTag) && extraFilter(e)).length;
        const pastSports = deduped.filter(e =>
            (e.tags || []).includes('Athletics') || (e.tags || []).includes('Athletic Competitions')
        ).filter(e => e.gameResult && e.gameScore);
        const status = {
            generatedAt: new Date().toISOString(),
            totalEvents: deduped.length,
            withDescription: deduped.filter(e => e.description).length,
            withImage: deduped.filter(e => e.image).length,
            familyFriendly: deduped.filter(e => e.kidFriendly).length,
            // Per-source counts (after dedupe)
            sources: {
                muAthletics: bySourceCount('MU', e => (e.tags || []).includes('Athletics') || (e.tags || []).includes('Athletic Competitions')),
                muCalendar: bySourceCount('MU', e => !(e.tags || []).includes('Athletics') && !(e.tags || []).includes('Clubs/Orgs')),
                muGetInvolved: bySourceCount('Clubs/Orgs'),
                pennManor: bySourceCount('PM'),
                borough: bySourceCount('Borough'),
                vfw: bySourceCount('VFW'),
                phantomPower: bySourceCount('Phantom Power'),
                community: bySourceCount('Community')
            },
            sports: {
                total: deduped.filter(e =>
                    (e.tags || []).includes('Athletics') || (e.tags || []).includes('Athletic Competitions')
                ).length,
                scored: pastSports.length,
                wins: pastSports.filter(e => e.gameResult === 'W').length,
                losses: pastSports.filter(e => e.gameResult === 'L').length,
                ties: pastSports.filter(e => e.gameResult === 'T' || e.gameResult === 'N').length,
                boxScoresParsed: pastSports.filter(e => e.periodScores).length
            }
        };
        fs.writeFileSync(path.join(__dirname, '../status.json'), JSON.stringify(status, null, 2));
        console.log(`📊 Status file written (${status.totalEvents} events across ${Object.values(status.sources).filter(n => n > 0).length} active sources)`);
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

    // ===== SPONSORS (from Advertise Form response sheet) =====
    try {
        console.log("📡 Fetching sponsor data...");
        const SPONSOR_SHEET_ID = '1XY1eVOlw0n-W_SI-pm4vzHzrIyqpIPEt605qXeX8X1U';
        const sponsorUrl = `https://docs.google.com/spreadsheets/d/${SPONSOR_SHEET_ID}/gviz/tq?tqx=out:csv`;
        const sponsorRes = await fetch(sponsorUrl);
        const sponsorList = [];
        if (sponsorRes.ok) {
            const csvText = await sponsorRes.text();
            const rows = csvText.split('\n').slice(1);
            for (const row of rows) {
                const cols = row.match(/"([^"]*)"/g);
                if (!cols || cols.length < 15) continue;
                const clean = cols.map(c => c.replace(/"/g, '').trim());
                // A:Timestamp B:Business C:Contact D:Email E:Phone F:Message G:Interest
                // H:Tier I:Placements J:CTA K:Link L:Internal M:StartDate N:EndDate O:Active
                const [timestamp, bizName, contact, email, phone, message, interest,
                       tier, placements, cta, link, internal, startDate, endDate, active] = clean;

                if (!active || !/^y/i.test(active)) continue;
                if (!bizName || !tier) continue;

                // Check date range
                const now = new Date();
                if (startDate && new Date(startDate) > now) continue;
                if (endDate && new Date(endDate) < now) continue;

                // Generate ID from business name
                const id = bizName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

                // Tier class mapping
                const tierClassMap = { 'premium': 'sponsor-homepage', 'standard': 'sponsor-featured', 'basic': 'sponsor-basic' };
                const tierClass = tierClassMap[(tier || '').toLowerCase()] || 'sponsor-featured';

                sponsorList.push({
                    id,
                    name: bizName,
                    tier: tier || 'Standard',
                    tierClass,
                    placements: (placements || 'homepage').split(',').map(p => p.trim().toLowerCase()),
                    cta: cta || `Visit ${bizName} ➔`,
                    link: link || '#',
                    internal: /^y/i.test(internal),
                    active: true,
                    startDate: startDate || '',
                    endDate: endDate || ''
                });
            }
        }

        // Sort: Premium first, then Standard, then Basic
        const tierOrder = { 'premium': 0, 'standard': 1, 'basic': 2 };
        sponsorList.sort((a, b) => (tierOrder[a.tier.toLowerCase()] || 9) - (tierOrder[b.tier.toLowerCase()] || 9));

        const sponsorJson = {
            sponsors: sponsorList,
            config: {
                rotateIntervalMs: 15000,
                inlineAdEveryN: 9,
                placements: {
                    homepage: { maxSlots: 3 },
                    events: { maxSlots: 1 },
                    sports: { maxSlots: 1 },
                    news: { maxSlots: 1 },
                    food: { maxSlots: 1 },
                    directory: { maxSlots: 1 }
                }
            }
        };
        fs.writeFileSync(path.join(__dirname, '../sponsors.json'), JSON.stringify(sponsorJson, null, 2));
        console.log(`✅ Sponsors: ${sponsorList.length} active (${sponsorList.filter(s=>s.tier.toLowerCase()==='premium').length} premium, ${sponsorList.filter(s=>s.tier.toLowerCase()==='standard').length} standard, ${sponsorList.filter(s=>s.tier.toLowerCase()==='basic').length} basic)`);
    } catch (e) { console.log(`  ⚠️ Sponsors error: ${e.message}`); }

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
