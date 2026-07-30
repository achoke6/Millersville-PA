// ============================================================================
// eventMatchesFeed — shared between app.js (browser) and scripts/send-
// notifications.js (Node cron).
//
// Previously this function was copy-pasted in both places with comment headers
// flagging the drift risk ("KEEP IN LOCKSTEP WITH app.js"). One of those
// comments is what they all were before this extraction:
//
//     /**
//      * WARNING — eventMatchesFeed is duplicated from app.js.
//      * The function below mirrors the logic of `eventMatchesFeed` in
//      * app.js. They MUST stay aligned or notification recipients will
//      * see a different set of events than the app shows.
//      */
//
// That kind of manual lockstep is a footgun. This file is the single source
// of truth; both callers import it.
//
// PHP port (events.ics.php) is NOT covered by this — PHP can't share JS code.
// Its in-file comment now points users here as the canonical reference so the
// PHP can be updated to match whenever this changes.
//
// UMD-ish glue at the bottom exposes the function in three ways:
//   - require('./lib/eventMatch.js').eventMatchesFeed   (Node)
//   - window.eventMatchesFeed                            (browser, after script tag)
//   - global.eventMatchesFeed                            (legacy fallback)
//
// IMPORTANT: keep the function pure — no closures over outer state. The
// browser caller (app.js) wraps it in a thin shim that supplies its
// module-scope `feedPrefs`. That keeps the lib self-contained.
// ============================================================================

(function (root, factory) {
    // CommonJS (Node)
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        // Browser global
        root.eventMatchModule = factory();
        root.eventMatchesFeed = root.eventMatchModule.eventMatchesFeed;
    }
}(typeof self !== 'undefined' ? self : this, function () {

    // Sport tag → feed-pref suffix map. Used for both PM and MU per-sport
    // matching ("baseball" matches feedPref "pm-baseball" or "mu-baseball").
    // The reason we need this map at all is that some sport tags have
    // spaces ("field hockey", "cross country") but feed-pref IDs don't —
    // they collapse for URL safety. Map handles that translation.
    // Per-level sport config (lowercased sport tag -> [feed-id suffix, genders]).
    // Mirrors SPORT_GENDERS in app.js and $sportCfg in events.ics.php — KEEP IN
    // LOCKSTEP. [] genders = single (match the base pref, any gender); 2 genders =
    // split (match <level>-<sport>-<gender> using the event's gender tag).
    var SPORT_CFG = {
        pm: {
            'baseball': ['baseball', []], 'softball': ['softball', []], 'football': ['football', []],
            'field hockey': ['fieldhockey', []], 'golf': ['golf', []], 'cross country': ['crosscountry', []],
            'swimming': ['swimming', []], 'track': ['track', []], 'bowling': ['bowling', []],
            'soccer': ['soccer', ['boys', 'girls']], 'tennis': ['tennis', ['boys', 'girls']],
            'volleyball': ['volleyball', ['boys', 'girls']], 'basketball': ['basketball', ['boys', 'girls']],
            'wrestling': ['wrestling', ['boys', 'girls']], 'lacrosse': ['lacrosse', ['boys', 'girls']],
            'unified track & field': ['unified-track', []], 'unified bocce': ['unified-bocce', []]
        },
        mu: {
            'baseball': ['baseball', []], 'football': ['football', []], 'wrestling': ['wrestling', []],
            'cross country': ['crosscountry', []], 'field hockey': ['fieldhockey', []], 'lacrosse': ['lacrosse', []],
            'softball': ['softball', []], 'swimming': ['swimming', []], 'volleyball': ['volleyball', []], 'track': ['track', []],
            'basketball': ['basketball', ['mens', 'womens']], 'golf': ['golf', ['mens', 'womens']],
            'soccer': ['soccer', ['mens', 'womens']], 'tennis': ['tennis', ['mens', 'womens']]
        }
    };
    // Event gender tag (lowercased) -> feed-id gender suffix.
    var GENDER_TAG_SUFFIX = { 'boys': 'boys', 'girls': 'girls', "men's": 'mens', "women's": 'womens' };

    // Match an athletics event against the user's per-sport feed prefs for a level.
    // Single sports match the base pref (e.g. pm-track); split sports require the
    // event's gender tag and match the gendered pref (e.g. pm-soccer-girls).
    function matchSportPref(tags, feedPrefs, level) {
        var cfg = SPORT_CFG[level];
        var gsuf = null;
        for (var g = 0; g < tags.length; g++) {
            var gl = tags[g].toLowerCase();
            if (GENDER_TAG_SUFFIX[gl]) { gsuf = GENDER_TAG_SUFFIX[gl]; break; }
        }
        for (var key in cfg) {
            if (!Object.prototype.hasOwnProperty.call(cfg, key)) continue;
            var present = false;
            for (var i = 0; i < tags.length; i++) { if (tags[i].toLowerCase() === key) { present = true; break; } }
            if (!present) continue;
            var base = level + '-' + cfg[key][0];
            var genders = cfg[key][1];
            if (genders.length >= 2) {
                if (gsuf && feedPrefs.indexOf(base + '-' + gsuf) !== -1) return true;
            } else if (feedPrefs.indexOf(base) !== -1) {
                return true;
            }
        }
        return false;
    }

    function eventMatchesFeed(e, feedPrefs) {
        var tags = e.tags || [];

        // (Borough "Reserve Public Meeting Room" noise is dropped at SCRAPE time
        // as of 2026-07-28 — the render-time noise check that lived here was
        // retired; unenriched placeholders never reach events.json.)

        if (!feedPrefs || feedPrefs.length === 0) return true;

        // Family-Friendly toggle — matches any event with kidFriendly flag,
        // regardless of source. Useful for parents who don't want to enumerate
        // every per-source pref.
        if (feedPrefs.indexOf('family-events') !== -1 && e.kidFriendly) return true;

        // PM sports — only match if a specific pm-<sport> pref is set
        if (tags.indexOf('PM') !== -1 &&
            (tags.indexOf('Athletics') !== -1 || tags.indexOf('Athletic Competitions') !== -1)) {
            return matchSportPref(tags, feedPrefs, 'pm');
        }
        // PM non-sport events (concerts, board meetings, school events, etc.)
        if (tags.indexOf('PM') !== -1) {
            if (tags.indexOf('Music/Arts') !== -1 && feedPrefs.indexOf('pm-music') !== -1) return true;
            if (tags.indexOf('Board/PTO') !== -1 && feedPrefs.indexOf('pm-board') !== -1) return true;
            if ((tags.indexOf('School Events') !== -1 || tags.indexOf('Health/Wellness') !== -1 ||
                 tags.indexOf('Meetings') !== -1) && feedPrefs.indexOf('pm-board') !== -1) return true;
            return false;
        }

        // MU sports
        if (tags.indexOf('MU') !== -1 &&
            (tags.indexOf('Athletics') !== -1 || tags.indexOf('Athletic Competitions') !== -1)) {
            // mu-arts and mu-public DO NOT cover sports.
            return matchSportPref(tags, feedPrefs, 'mu');
        }

        // Clubs/Orgs (GetInvolved). MUST be checked BEFORE the generic MU
        // block below, because GetInvolved events carry both 'MU' and
        // 'Clubs/Orgs' tags — the more specific check wins.
        if (tags.indexOf('Clubs/Orgs') !== -1) {
            if (feedPrefs.indexOf('clubs-all') !== -1) return true;
            if (feedPrefs.indexOf('clubs-social') !== -1 && tags.indexOf('Social') !== -1) return true;
            if (feedPrefs.indexOf('clubs-arts') !== -1 && tags.indexOf('Arts') !== -1) return true;
            if (feedPrefs.indexOf('clubs-sports') !== -1 && tags.indexOf('Club Sports') !== -1) return true;
            if (feedPrefs.indexOf('clubs-greek') !== -1 && tags.indexOf('Greek Life') !== -1) return true;
            if (feedPrefs.indexOf('clubs-service') !== -1 &&
                (tags.indexOf('Service') !== -1 || tags.indexOf('Cultural') !== -1)) return true;

            // Per-club-sport matchers. The Club Sports umbrella tag is required
            // so these prefs don't accidentally match a Sidearm varsity event
            // that happens to share the same sport tag. cs-* IDs distinguish
            // from mu-* (varsity) and pm-* (Penn Manor).
            if (tags.indexOf('Club Sports') !== -1) {
                var t = (e.title || '');
                if (feedPrefs.indexOf('cs-baseball') !== -1 && tags.indexOf('Baseball') !== -1) return true;
                if (feedPrefs.indexOf('cs-bowling') !== -1 && /bowling/i.test(t)) return true;
                if (feedPrefs.indexOf('cs-equestrian') !== -1 && /equestrian/i.test(t)) return true;
                if (feedPrefs.indexOf('cs-fencing') !== -1 && tags.indexOf('Fencing') !== -1) return true;
                if (feedPrefs.indexOf('cs-icehockey') !== -1 && /ice hockey/i.test(t)) return true;
                if (feedPrefs.indexOf('cs-mma') !== -1 && /\bmma\b/i.test(t)) return true;
                if (feedPrefs.indexOf('cs-basketball-mens') !== -1 && tags.indexOf('Basketball') !== -1 && tags.indexOf("Men's") !== -1) return true;
                if (feedPrefs.indexOf('cs-basketball-womens') !== -1 && tags.indexOf('Basketball') !== -1 && tags.indexOf("Women's") !== -1) return true;
                if (feedPrefs.indexOf('cs-lacrosse') !== -1 && tags.indexOf('Lacrosse') !== -1) return true;
                if (feedPrefs.indexOf('cs-rugby-mens') !== -1 && tags.indexOf('Rugby') !== -1 && tags.indexOf("Men's") !== -1) return true;
                if (feedPrefs.indexOf('cs-rugby-womens') !== -1 && tags.indexOf('Rugby') !== -1 && tags.indexOf("Women's") !== -1) return true;
                if (feedPrefs.indexOf('cs-soccer-mens') !== -1 && tags.indexOf('Soccer') !== -1 && tags.indexOf("Men's") !== -1) return true;
                if (feedPrefs.indexOf('cs-soccer-womens') !== -1 && tags.indexOf('Soccer') !== -1 && tags.indexOf("Women's") !== -1) return true;
                if (feedPrefs.indexOf('cs-volleyball-mens') !== -1 && tags.indexOf('Volleyball') !== -1 && tags.indexOf("Men's") !== -1) return true;
                if (feedPrefs.indexOf('cs-volleyball-womens') !== -1 && tags.indexOf('Volleyball') !== -1 && tags.indexOf("Women's") !== -1) return true;
                if (feedPrefs.indexOf('cs-dance') !== -1 && /dance team/i.test(t)) return true;
                if (feedPrefs.indexOf('cs-running') !== -1 && /\brunning\b/i.test(t)) return true;
                if (feedPrefs.indexOf('cs-softball') !== -1 && tags.indexOf('Softball') !== -1) return true;
                if (feedPrefs.indexOf('cs-tennis') !== -1 && tags.indexOf('Tennis') !== -1) return true;
                if (feedPrefs.indexOf('cs-frisbee') !== -1 && /ultimate frisbee/i.test(t)) return true;
            }

            // Individual club follow ("club:Alpha Sigma Tau" → matches if that
            // exact org tag is on the event). Lets users follow a single
            // student org without picking a whole category.
            for (var k = 0; k < feedPrefs.length; k++) {
                var pref = feedPrefs[k];
                if (pref.indexOf('club:') === 0 && tags.indexOf(pref.substring(5)) !== -1) return true;
            }
            return false;
        }

        // MU non-sport events (MU Calendar proper — Clubs/Orgs already handled above).
        if (tags.indexOf('MU') !== -1) {
            // mu-alumni: alumni-page events. Three tag spellings cover both
            // pipelines — 'Summer Fun Series' / 'Alumni Event' (camps.json)
            // and 'Alumni Engagement' (MU Calendar customerName tag).
            if ((tags.indexOf('Alumni Event') !== -1 || tags.indexOf('Alumni Engagement') !== -1 ||
                 tags.indexOf('Summer Fun Series') !== -1) && feedPrefs.indexOf('mu-alumni') !== -1) return true;
            if (tags.indexOf('Arts Concert / Performance') !== -1 && feedPrefs.indexOf('mu-arts') !== -1) return true;
            if (tags.indexOf('Public Event') !== -1 && feedPrefs.indexOf('mu-public') !== -1) return true;
            return false;
        }

        // Other sources
        if (tags.indexOf('Borough') !== -1 && feedPrefs.indexOf('borough-all') !== -1) return true;
        if (tags.indexOf('Manor') !== -1 && feedPrefs.indexOf('manor-all') !== -1) return true;
        if (tags.indexOf('Raney Cellars') !== -1 && feedPrefs.indexOf('raney-cellars-all') !== -1) return true;
        if (tags.indexOf("Jack's Tavern") !== -1 && feedPrefs.indexOf('jacks-tavern-all') !== -1) return true;
        if (tags.indexOf('Jesus Dogs') !== -1 && feedPrefs.indexOf('jesus-dogs-all') !== -1) return true;
        if (tags.indexOf('The Backyard') !== -1 && feedPrefs.indexOf('backyard-all') !== -1) return true;
        if (tags.indexOf('HUB') !== -1 && feedPrefs.indexOf('hub-all') !== -1) return true;
        if (tags.indexOf('VFW') !== -1 && feedPrefs.indexOf('other-vfw') !== -1) return true;
        if (tags.indexOf('Live Music') !== -1 && feedPrefs.indexOf('other-phantom') !== -1) return true;
        if ((tags.indexOf('Community') !== -1 || (tags.indexOf('Other') !== -1 && tags.indexOf('Live Music') === -1)) && feedPrefs.indexOf('other-community') !== -1) return true;

        return false;
    }

    return { eventMatchesFeed: eventMatchesFeed };
}));
