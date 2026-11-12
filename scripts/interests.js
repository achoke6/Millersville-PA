// scripts/interests.js — scrape-time interest tagging (2026-11-12, interests build step 2)
//
// Writes `e.interests = ['music', …]` on non-sport events so the /events chip row
// can offer cross-source lenses ("Music", "Kids & Family", "Meetings & Civic") instead
// of per-source sub-categories. One pass, run right after the family pass in scrape.js.
//
// Keys are the contract with app.js (labels/icons live there) and, in phase 2, with
// lib/eventMatch.js + events.ics.php (`interest:<key>` feed prefs — Hard Rule 7).
// Never rename a key without touching all three.
//
//   music   concerts, live music, recitals, school ensembles
//   arts    plays, dance, galleries, film, the Ware Center season
//   crafts  craft nights, workshops, make-and-take, crochet / jewelry guilds
//   food    food trucks, fish fries, tastings, trivia nights at a bar/winery
//   causes  drives, fundraisers, cleanups, volunteering
//   active  5Ks, hikes, rides, yoga, wellness
//   learn   lectures, author talks, panels, info sessions
//   civic   council / supervisors / school board / PTO meetings (Borough, Manor, PM only)
//   greek   Greek Life (MU tag passthrough)
//   reshall Residence Halls (MU tag passthrough)
//
// Family is NOT an interest key: the Kids & Family chip reads `kidFriendly`, which
// has its own curated lanes (sheet Family column, camps.json, vfw.json) and its own
// three `family-events` matchers. Free Food / Free Stuff stay on `benefits`.
//
// Precedence, per event:
//   1. curated — a non-empty `interests` array already on the row (camps.json,
//      vfw.json, a future sheet column) wins outright; the classifier does not run.
//   2. athletics / club sports → no interests (they live on the Sports page).
//   3. tag / venue / org signals (high precision), then
//   4. title + description keywords, each key with its own negative list.
//   At most 3 keys per event, in the order above.
'use strict';

const KEYS = ['music', 'arts', 'crafts', 'food', 'causes', 'active', 'learn', 'civic', 'greek', 'reshall'];
const MAX_PER_EVENT = 3;

const SPORT_TAGS = new Set(['Athletics', 'Athletic Competitions', 'Club Sports', 'Home Game Mode']);
const ARTS_TAGS = new Set(['Arts Concert / Performance', 'The Ware Center', 'Visual & Performing Arts', 'Art & Design', 'University Theatre', 'Communication & Theatre', 'Music/Arts']);
const CIVIC_SOURCES = new Set(['Borough', 'Manor', 'PM', 'Community']);

// A performance whose medium is music — used to split the arts/music tag families.
const MUSIC_PERF = /\b(concert|recital|live music|open mic|karaoke|jazz|orchestra|choir|chorale|chorus|a cappella|acappella|band|ensemble|symphony|marimba|quartet|quintet|brass|strings|songwriter|singer|vocal|bluegrass|celtic music|zydeco|choral)\b/;
const MUSIC_NEG = /\b(rehearsals?|auditions?|tryouts?|lessons?|band camp|marching band practice)\b/;
// titles whose medium is plainly not music, used when the music split falls back to the description
const NOT_MUSIC_TITLE = /\b(film|screening|movie|documentary|exhibit|exhibition|gallery|play|plays|theatre|theater|dance|workshop|magic|comedy|improv)\b/;

const ARTS_KW = /\b(theatre|theater|musical|play|plays|gallery|exhibit|exhibition|art show|art fair|dance|film|screening|improv|comedy|comedian|photograph|photography|sculpture|poetry|ballet|opera|drag show|magician|magic show|puppet|storytelling)\b/;
const ARTS_NEG = /\b(art therapy|play ?ground|playoff|playoffs|play-off|dance team practice|film club meeting|health screening|screenings?|screening and)\b/;

const CRAFTS_KW = /\b(crochet|crocheting|knit|knitting|craft|crafts|crafting|sewing|quilt|quilting|pottery|ceramic|ceramics|woodwork|woodworking|macram[eé]|paint night|paint & sip|paint and sip|make.and.take|diy|jewelry|beading|scrapbook|origami|wreath|ornament)\b/;
const CRAFTS_NEG = /\b(craft beer|craft brew|craft cocktail|minecraft|witchcraft|aircraft|spacecraft|craft fair vendor registration)\b/;

const FOOD_KW = /\b(fish fry|food truck|food trucks|dinner|breakfast|brunch|luncheon|lunch|tasting|wine|beer|brew|brewery|bbq|barbecue|cook-?off|chili cook|bake sale|potluck|pancake|spaghetti|taco|tacos|pizza|ice cream|wings|crab feast|pig roast|oyster|soup sale|hoagie)\b/;
const FOOD_NEG = /\b(food (drive|pantry|bank|collection)|canned food|lunch and learn|lunch & learn|brown bag|dinner meeting|for staff|staff appreciation|board breakfast|teacher appreciation)\b/;
const FOOD_VENUE_TAGS = new Set(['Raney Cellars', "Jack's Tavern", 'Jack’s Tavern', 'VFW', 'HUB', 'Jesus Dogs']);
const BAR_TRIVIA = /\b(trivia|bingo|happy hour)\b/;

const CAUSES_KW = /\b(volunteer|volunteers|volunteering|cleanup|clean-up|clean up day|drive|donation|donations|donate|fundraiser|fundraising|fund raiser|blood drive|charity|charitable|benefit|toy drive|coat drive|food drive|adopt-a|extragive|giving day|giving tuesday|service day|day of service|relay for life|walk for)\b/;
// the description is only trusted for the unambiguous words
const CAUSES_DESC = /\b(fundraiser|fundraising|volunteers? needed|blood drive|proceeds (benefit|go to|support)|donations? (accepted|welcome|of)|cleanup|clean-up)\b/;
const CAUSES_NEG = /\b(benefits fair|employee benefits|drive-?thru|drive-?in|driveway|driver|driving|disk drive|benefit of|sex drive)\b/;

const ACTIVE_KW = /\b(5k|10k|fun run|run\/walk|hike|hiking|bike|biking|cycling|trail|yoga|zumba|fitness|outdoor|outdoors|gardening|nature walk|birding|fishing|kayak|kayaking|trot|turkey trot|walkathon|walk-a-thon|wellness|pickleball open play|open gym)\b/;
const ACTIVE_NEG = /\b(home run|dry run|run of show|trail of lights|treat trail|trick-or-treat|health screening)\b/;

const LEARN_KW = /\b(lecture|lectures|speaker|guest speaker|panel|seminar|symposium|colloquium|author|author talk|book club|book talk|books & banter|books and banter|info session|information session|webinar|workshop|teach-in|q&a|roundtable|presentation|talk)\b/;
const LEARN_NEG = /\b(staff meeting|faculty meeting|in-service|inservice|training|real estate seminar|sales presentation|talk show)\b/;

const CIVIC_NEG = /\b(breakfast|luncheon|appreciation|dinner|picnic)\b/;
const CIVIC_KW = /\b(borough council|council meeting|town council|supervisors|board of supervisors|planning commission|zoning|hearing board|civil service commission|school board|pto meeting|pto & pta|board meeting|town hall|public meeting|public hearing|committee meeting|authority meeting|sewer authority|water authority|budget hearing|work session)\b/;

// Org → interests. Names as they appear in e.orgName / the org tag after overrides.
const ORG_MAP = [
    [/crochet club/i, 'crafts'],
    [/jewelry (and|&) metal arts/i, 'crafts'],
    [/creative writers guild/i, 'learn'],
    [/books & banter|books and banter/i, 'learn'],
    [/university theatre|all campus musical|dance team|sneakers to stilettos/i, 'arts'],
    [/wixq|tell school of music|^music$/i, 'music'],
    [/horror movies and media|film club/i, 'arts'],
    [/paws on deck/i, 'causes'],
    [/yoga club|climbing club|outdoors club|hiking club/i, 'active'],
];

function lc(s) { return (s || '').toString().toLowerCase(); }

/**
 * Returns the interest keys for one event (never mutates it).
 */
function classifyEvent(e) {
    const tags = e.tags || [];
    const src = tags[0] || '';
    if (tags.some(t => SPORT_TAGS.has(t))) return [];

    const title = lc(e.title);
    const desc = lc(e.description).slice(0, 400);
    const text = title + ' ' + desc;
    const org = lc(e.orgName) + ' ' + lc(tags[1]);
    const out = [];
    const add = k => { if (KEYS.includes(k) && !out.includes(k) && out.length < MAX_PER_EVENT) out.push(k); };

    // ---- 3. tag / venue / org signals ------------------------------------
    if (tags.includes('Greek Life')) add('greek');
    if (tags.includes('Residence Halls')) add('reshall');
    if ((tags.includes('Music') || tags.includes('Live Music') || tags.includes('Phantom Power')) && !MUSIC_NEG.test(title)) add('music');
    if (tags.includes('Fundraising')) add('causes');
    if (tags.some(t => ARTS_TAGS.has(t))) {
        const musicByTitle = MUSIC_PERF.test(title) && !MUSIC_NEG.test(title);
        const musicByDesc = !NOT_MUSIC_TITLE.test(title) && MUSIC_PERF.test(desc) && !MUSIC_NEG.test(title);
        if (musicByTitle || musicByDesc) add('music');
        else if (CRAFTS_KW.test(title) && !CRAFTS_NEG.test(title)) add('crafts');
        else add('arts');
    }
    if (tags.some(t => FOOD_VENUE_TAGS.has(t))) {
        add('food');
        if (BAR_TRIVIA.test(title)) add('food');
    }
    if (CIVIC_SOURCES.has(src) && CIVIC_KW.test(title) && !CIVIC_NEG.test(title)) add('civic');
    for (const [re, k] of ORG_MAP) { if (re.test(org)) add(k); }

    // ---- 4. keywords -------------------------------------------------------
    const kw = [
        ['music', MUSIC_PERF, MUSIC_NEG, title],
        ['arts', ARTS_KW, ARTS_NEG, title],
        ['crafts', CRAFTS_KW, CRAFTS_NEG, title],
        ['food', FOOD_KW, FOOD_NEG, title],
        ['causes', CAUSES_KW, CAUSES_NEG, title],
        ['active', ACTIVE_KW, ACTIVE_NEG, title],
        ['learn', LEARN_KW, LEARN_NEG, title],
    ];
    for (const [k, pos, neg, hay] of kw) {
        if (out.length >= MAX_PER_EVENT) break;
        if (pos.test(hay) && !neg.test(hay)) add(k);
    }
    if (!out.includes('causes') && CAUSES_DESC.test(desc) && !CAUSES_NEG.test(desc)) add('causes');
    // "food drive" is a cause, not food
    if (out.includes('food') && /\bfood (drive|pantry|bank|collection)\b/.test(text)) {
        out.splice(out.indexOf('food'), 1); add('causes');
    }
    return out;
}

/**
 * Tags every event in place. Returns { counts, samples } for the build log / status.
 *   counts:  { music: n, … }                 (events carrying the key)
 *   samples: { music: ['title', …], … }      (up to 3 keyword-only hits per key, for review)
 */
function tagInterests(events) {
    const counts = {}; const samples = {}; let curated = 0, tagged = 0;
    KEYS.forEach(k => { counts[k] = 0; samples[k] = []; });
    for (const e of events) {
        let keys;
        if (Array.isArray(e.interests) && e.interests.length) {
            keys = e.interests.filter(k => KEYS.includes(k)).slice(0, MAX_PER_EVENT);   // 1. curated wins
            curated++;
        } else {
            keys = classifyEvent(e);
        }
        if (keys.length) { e.interests = keys; tagged++; } else { delete e.interests; }
        for (const k of keys) {
            counts[k]++;
            // keyword-only sample = no tag/venue/org signal would have produced it
            if (samples[k].length < 3 && !signalOnly(e, k)) samples[k].push(e.title);
        }
    }
    return { counts, samples, curated, tagged, keys: KEYS.slice() };
}

// true when the key is explained by a tag/venue/org signal (so it's not a keyword-only hit)
function signalOnly(e, k) {
    const tags = e.tags || [];
    const org = lc(e.orgName) + ' ' + lc(tags[1]);
    if (ORG_MAP.some(([re, key]) => key === k && re.test(org))) return true;
    switch (k) {
        case 'greek': return tags.includes('Greek Life');
        case 'reshall': return tags.includes('Residence Halls');
        case 'music': return tags.includes('Music') || tags.includes('Live Music') || tags.includes('Phantom Power') || tags.some(t => ARTS_TAGS.has(t));
        case 'arts': return tags.some(t => ARTS_TAGS.has(t));
        case 'causes': return tags.includes('Fundraising');
        case 'food': return tags.some(t => FOOD_VENUE_TAGS.has(t));
        case 'civic': return CIVIC_SOURCES.has(tags[0] || '');
        default: return false;
    }
}

module.exports = { KEYS, classifyEvent, tagInterests };
