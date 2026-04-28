// Auto cache-bust .json fetches (hourly, matches scraper cron)
(function(){const _f=window.fetch,_v=Math.floor(Date.now()/3600000);window.fetch=function(u,o){if(typeof u==='string'&&u.endsWith('.json'))u+=(/\?/.test(u)?'&':'?')+'_='+_v;return _f.call(this,u,o);}})();

let allEvents=[], currentNews=[], allRestaurants=[];

// Date the home timeline is currently showing. Defaults to today (midnight),
// can be moved ±1 day via shiftHomeDay() and reset via resetHomeDay(). Not
// persisted — every fresh load lands on today, matching the "Today's news"
// expectation for a home page. The Specials & Deals card stays anchored to
// today regardless of this value.
let homeViewDate = null;
const allEvSources = ['MU','PM','Borough','Other'];
let evActiveSources = new Set(allEvSources), evTags=new Set();
let evAllMode = true;
let evKidMode=false;
// Marauder-only perk filters — hidden for Townies, shown for Marauders in place of family toggle
let evFreeFoodMode=false, evFreeStuffMode=false;

// ==================== MY FEED SYSTEM ====================
const FEED_KEY = 'mapp_feed_prefs';
const AFFILIATION_KEY = 'mapp_mu_affiliation'; // 'student' | 'townie' | null (unset)
let feedPrefs = null; // null = not configured
let muAffiliation = null; // null = not yet asked; 'student' or 'townie' once set

function setFeedDotVisible(visible) {
    const d1 = document.getElementById('feed-dot');
    const d2 = document.getElementById('feed-dot-desktop');
    if (d1) d1.style.display = visible ? 'block' : 'none';
    if (d2) d2.style.display = visible ? 'block' : 'none';
}

function loadFeedPrefs() {
    try { feedPrefs = JSON.parse(localStorage.getItem(FEED_KEY)); } catch(e) { feedPrefs = null; }
    setFeedDotVisible(!!feedPrefs);
    try { muAffiliation = localStorage.getItem(AFFILIATION_KEY); } catch(e) { muAffiliation = null; }
    if (muAffiliation !== 'student' && muAffiliation !== 'townie') muAffiliation = null;
}
function saveFeedPrefs(prefs) {
    feedPrefs = prefs;
    localStorage.setItem(FEED_KEY, JSON.stringify(prefs));
    setFeedDotVisible(!!prefs);
}
window.setMuAffiliation = function(value) {
    if (value !== 'student' && value !== 'townie') return;
    muAffiliation = value;
    localStorage.setItem(AFFILIATION_KEY, value);
    // Re-render everything so the filter takes immediate effect
    if (typeof renderHomeFeed === 'function') renderHomeFeed();
    if (typeof renderEvents === 'function') renderEvents();
};
// An event is hidden from a townie's feed if it's MU-student-only.
// Default (unset affiliation) is Marauder behavior — users see everything by default
// and townies explicitly opt in via the welcome banner or Feed settings.
function isHiddenForTownie(e) {
    if (muAffiliation !== 'townie') return false; // Marauder and unset both see everything
    return e && e.audience === 'mu-only';
}

// Feed subscription tokens and their display config
// Organized into sections for the settings popup
const feedSections = {
    sports: {
        title: '🏆 Sports Favorites',
        groups: {
            pm: { label: 'Penn Manor Sports', icon: '🏫', headingStyle: true, audience: 'townie', subs: [
                {id:'pm-baseball',label:'Baseball',icon:'⚾'},{id:'pm-softball',label:'Softball',icon:'🥎'},
                {id:'pm-lacrosse',label:'Lacrosse',icon:'🥍'},{id:'pm-volleyball',label:'Volleyball',icon:'🏐'},
                {id:'pm-football',label:'Football',icon:'🏈'},{id:'pm-basketball',label:'Basketball',icon:'🏀'},
                {id:'pm-soccer',label:'Soccer',icon:'⚽'},{id:'pm-fieldhockey',label:'Field Hockey',icon:'🏑'},
                {id:'pm-tennis',label:'Tennis',icon:'🎾'},{id:'pm-track',label:'Track',icon:'🏃'}
            ]},
            musports: { label: 'MU Sports', icon: '🏴‍☠️', headingStyle: true, audience: 'student', subs: [
                {id:'mu-baseball',label:'Baseball',icon:'⚾'},{id:'mu-softball',label:'Softball',icon:'🥎'},
                {id:'mu-lacrosse',label:'Lacrosse',icon:'🥍'},{id:'mu-volleyball',label:'Volleyball',icon:'🏐'},
                {id:'mu-football',label:'Football',icon:'🏈'},{id:'mu-basketball',label:'Basketball',icon:'🏀'},
                {id:'mu-soccer',label:'Soccer',icon:'⚽'},{id:'mu-fieldhockey',label:'Field Hockey',icon:'🏑'},
                {id:'mu-tennis',label:'Tennis',icon:'🎾'},{id:'mu-track',label:'Track',icon:'🏃'},
                {id:'mu-golf',label:'Golf',icon:'⛳'},{id:'mu-swimming',label:'Swimming',icon:'🏊'},
                {id:'mu-crosscountry',label:'Cross Country',icon:'🏃'}
            ]}
        }
    },
    events: {
        title: '📅 Event Favorites',
        groups: {
            pmev: { label: 'PM Events', icon: '🏫', headingStyle: true, audience: 'townie', subs: [
                {id:'pm-music',label:'Music/Arts',icon:'🎵'},{id:'pm-board',label:'Board Meetings',icon:'📋'}
            ]},
            mu: { label: 'MU Events', icon: '🏴‍☠️', headingStyle: true, audience: 'student', subs: [
                {id:'mu-arts',label:'Arts & Performances',icon:'🎭'},{id:'mu-public',label:'Public Events',icon:'📢'}
            ]},
            clubs: {
                label: 'MU GetInvolved',      // marauder-facing default
                townieLabel: 'MU Community Events', // shown to townies (GetInvolved is MU-internal jargon)
                icon: '🎓',
                headingStyle: true,
                audience: 'student',
                subs: [
                    {id:'clubs-all',label:'All Events',townieLabel:'All Community Events',icon:'🎓'},
                    {id:'clubs-social',label:'Social Clubs',icon:'🎉'},
                    {id:'clubs-arts',label:'Arts & Performance',icon:'🎭'},
                    {id:'clubs-service',label:'Service & Community',icon:'🤝'}
                ],
                // Collapsible nested subgroups — each renders as a click-to-
                // expand row inside the GetInvolved heading group. The
                // subgroup's master ID (e.g. clubs-sports) toggles the
                // umbrella, while individual children (cs-*, chapter names)
                // can be picked granularly. Default state is collapsed since
                // each subgroup has 19-21 chips that would overwhelm the
                // accordion if always-open.
                subgroups: [
                    {
                        key: 'clubsports',
                        label: 'Club Sports',
                        icon: '⚽',
                        masterId: 'clubs-sports',
                        children: [
                            {id:'cs-baseball',label:'Baseball',icon:'⚾'},
                            {id:'cs-softball',label:'Softball',icon:'🥎'},
                            {id:'cs-basketball-mens',label:"Men's Basketball",icon:'🏀'},
                            {id:'cs-basketball-womens',label:"Women's Basketball",icon:'🏀'},
                            {id:'cs-soccer-mens',label:"Men's Soccer",icon:'⚽'},
                            {id:'cs-soccer-womens',label:"Women's Soccer",icon:'⚽'},
                            {id:'cs-lacrosse',label:'Lacrosse',icon:'🥍'},
                            {id:'cs-volleyball-mens',label:"Men's Volleyball",icon:'🏐'},
                            {id:'cs-volleyball-womens',label:"Women's Volleyball",icon:'🏐'},
                            {id:'cs-rugby-mens',label:"Men's Rugby",icon:'🏉'},
                            {id:'cs-rugby-womens',label:"Women's Rugby",icon:'🏉'},
                            {id:'cs-icehockey',label:'Ice Hockey',icon:'🏒'},
                            {id:'cs-tennis',label:'Tennis',icon:'🎾'},
                            {id:'cs-frisbee',label:'Ultimate Frisbee',icon:'🥏'},
                            {id:'cs-fencing',label:'Fencing',icon:'🤺'},
                            {id:'cs-equestrian',label:'Equestrian',icon:'🐴'},
                            {id:'cs-dance',label:'Dance Team',icon:'💃'},
                            {id:'cs-bowling',label:'Bowling',icon:'🎳'},
                            {id:'cs-running',label:'Running',icon:'🏃'},
                            {id:'cs-mma',label:'MMA',icon:'🥋'}
                        ]
                    },
                    {
                        key: 'greeklife',
                        label: 'Greek Life',
                        icon: '🏛️',
                        masterId: 'clubs-greek',
                        // Per-chapter children. The id uses the `club:<Name>`
                        // pattern matching the existing club-tag matcher, so
                        // events tagged with the chapter name (e.g. 'Delta
                        // Zeta') get matched without any new logic. Names
                        // taken verbatim from millersville.edu/campuslife/
                        // fraternity-and-sorority-life — case-sensitive
                        // because the scraper preserves casing. The 19 active
                        // chapters; suspended (Sigma Tau Gamma) and
                        // unrecognized (Alpha Gamma Theta) are excluded.
                        children: [
                            // Sororities (10)
                            {id:'club:Alpha Xi Delta',label:'Alpha Xi Delta',icon:'♀'},
                            {id:'club:Alpha Sigma Alpha',label:'Alpha Sigma Alpha',icon:'♀'},
                            {id:'club:Alpha Sigma Tau',label:'Alpha Sigma Tau',icon:'♀'},
                            {id:'club:Chi Upsilon Sigma Latin Sorority Inc.',label:'Chi Upsilon Sigma',icon:'♀'},
                            {id:'club:Delta Zeta',label:'Delta Zeta',icon:'♀'},
                            {id:'club:Delta Sigma Theta Sorority Inc.',label:'Delta Sigma Theta',icon:'♀'},
                            {id:'club:Zeta Phi Beta Sorority Inc.',label:'Zeta Phi Beta',icon:'♀'},
                            {id:'club:Mu Sigma Upsilon Sorority Inc.',label:'Mu Sigma Upsilon',icon:'♀'},
                            {id:'club:Sigma Alpha Iota International Music Fraternity Inc.',label:'Sigma Alpha Iota',icon:'♀'},
                            {id:'club:Sigma Gamma Rho Sorority Inc.',label:'Sigma Gamma Rho',icon:'♀'},
                            // Fraternities (9)
                            {id:'club:Acacia Fraternity',label:'Acacia',icon:'♂'},
                            {id:'club:Alpha Phi Alpha Fraternity Inc.',label:'Alpha Phi Alpha',icon:'♂'},
                            {id:'club:Kappa Alpha Psi Fraternity Inc.',label:'Kappa Alpha Psi',icon:'♂'},
                            {id:'club:Lambda Sigma Upsilon',label:'Lambda Sigma Upsilon',icon:'♂'},
                            {id:'club:Tau Kappa Epsilon',label:'Tau Kappa Epsilon',icon:'♂'},
                            {id:'club:Phi Beta Sigma Fraternity Inc.',label:'Phi Beta Sigma',icon:'♂'},
                            {id:'club:Phi Delta Theta',label:'Phi Delta Theta',icon:'♂'},
                            {id:'club:Phi Mu Alpha Sinfonia',label:'Phi Mu Alpha Sinfonia',icon:'♂'},
                            {id:'club:Omega Psi Phi Fraternity Inc.',label:'Omega Psi Phi',icon:'♂'}
                        ]
                    }
                ]
            },
            borough: { label: 'Borough', icon: '🌳', headingStyle: true, audience: 'townie', subs: [{id:'borough-all',label:'All Borough Events',icon:'🌳'}] },
            other: { label: 'Other', icon: '🎯', headingStyle: true, audience: 'townie', subs: [
                {id:'other-vfw',label:'VFW Events',icon:'🎖️'},{id:'other-phantom',label:'Phantom Power',icon:'🎵'},
                {id:'other-community',label:'Community Events',icon:'📝'}
            ]},
            family: { label: 'Family Friendly', icon: '👨‍👩‍👧', headingStyle: true, audience: 'townie', subs: [{id:'family-events',label:'Family Friendly Events',icon:'👨‍👩‍👧'}] }
        },
        // Townie picker shape — heading-style throughout, same uniform look.
        // Borough and Family Friendly are now heading-style groups (matching
        // Penn Manor / MU / Other) instead of standalone pills. Club Sports
        // removed from MU University composites — it lives in the Sports
        // section now. Composites remain inside MU University to collapse
        // mu-arts + clubs-arts into "Arts & Performance" (etc.) since townies
        // don't experience those as distinct.
        townieGroups: {
            pmev: {
                label: 'Penn Manor', icon: '🏫', headingStyle: true,
                subs: [
                    {id:'pm-music',label:'Music/Arts',icon:'🎵'},
                    {id:'pm-board',label:'Board Meetings',icon:'📋'}
                ]
            },
            mu: {
                label: 'Millersville University', icon: '🏴‍☠️', headingStyle: true,
                composites: [
                    { label: 'Arts & Performance', icon: '🎭', linkedIds: ['mu-arts', 'clubs-arts'] },
                    { label: 'Public Events',      icon: '📢', linkedIds: ['mu-public'] },
                    { label: 'Community Fundraisers', icon: '🤝', linkedIds: ['clubs-service'] }
                ]
            },
            borough: {
                label: 'Millersville Borough', icon: '🌳', headingStyle: true,
                subs: [{id:'borough-all',label:'All Borough Events',icon:'🌳'}]
            },
            other: {
                label: 'Other', icon: '🎯', headingStyle: true,
                subs: [
                    {id:'other-vfw',label:'VFW Events',icon:'🎖️'},
                    {id:'other-phantom',label:'Phantom Power',icon:'🎵'},
                    {id:'other-community',label:'Community Events',icon:'📝'}
                ]
            },
            family: {
                label: 'Family Friendly', icon: '👨‍👩‍👧', headingStyle: true,
                subs: [{id:'family-events',label:'Family Friendly Events',icon:'👨‍👩‍👧'}]
            }
        }
    },
    news: {
        title: '📰 News Favorites',
        groups: {
            // MU-side news — visible to both affiliations at full opacity.
            // Townies may legitimately want to follow MU news (e.g. alumni, parents),
            // and marauders obviously want it.
            news: { label: 'MU News Sources', icon: '📰', headingStyle: true, audience: 'both', subs: [
                {id:'news-mu',label:'MU News',icon:'📰'},{id:'news-snapper',label:'The Snapper',icon:'📰'},
                {id:'news-athletics',label:'MU Athletics',icon:'🏅'},{id:'news-review',label:'MU Review',icon:'📖'}
            ]},
            // Community news (Penn Manor, Borough) — tagged townie-audience so the
            // existing "dim for marauders" modal infrastructure (see groupDimmed
            // logic in openFeedSettings) kicks in. Marauders see these dimmed with
            // the "not typical for marauders — enable if interested" nag; favoriting
            // a sub here unlocks the source via SOURCE_UNLOCK_IDS below.
            newsCommunity: { label: 'Community News Sources', icon: '🌳', headingStyle: true, audience: 'townie', subs: [
                {id:'news-pm',label:'Penn Manor',icon:'📰'},{id:'news-borough',label:'Borough',icon:'🌳'}
            ]}
        }
    }
};
// Build flat feedOptions for backward compat
const feedOptions = {};
for (const sec of Object.values(feedSections)) {
    for (const [k,v] of Object.entries(sec.groups)) feedOptions[k] = v;
}
// Classify IDs by context
const sportFeedIds = new Set();
for (const g of Object.values(feedSections.sports.groups)) g.subs.forEach(s => sportFeedIds.add(s.id));
const eventFeedIds = new Set();
for (const g of Object.values(feedSections.events.groups)) g.subs.forEach(s => eventFeedIds.add(s.id));

// ========== Affiliation-based source hiding ==========
// When a user picks Marauder, PM/Borough/VFW events + PM sports are hidden by default.
// When a user picks Townie, MU GetInvolved events + MU Club Sports are hidden by default.
// Users can "unlock" hidden sources by favoriting items in them — at which point the pill
// reappears and their favorited items become visible in the filtered list.

// Map of source-pill → set of feed-pref IDs that "unlock" it. If user's feedPrefs contains
// any of these IDs, the source is considered user-opted-in and treated normally.
const SOURCE_UNLOCK_IDS = {
    // Events page source pills
    'PM':      ['pm-music', 'pm-board', 'pm-baseball', 'pm-softball', 'pm-lacrosse', 'pm-volleyball', 'pm-football', 'pm-basketball', 'pm-soccer', 'pm-fieldhockey', 'pm-tennis', 'pm-track'],
    'Borough': ['borough-all'],
    'VFW':     ['other-vfw'],
    // MU-side sources for townies
    'MU':         [], // MU itself always shown — only GetInvolved sub-content is gated
    'GetInvolved':['clubs-all', 'clubs-social', 'clubs-arts', 'clubs-sports', 'clubs-greek', 'clubs-service',
        'cs-baseball','cs-bowling','cs-equestrian','cs-fencing','cs-icehockey','cs-mma',
        'cs-basketball-mens','cs-basketball-womens','cs-lacrosse','cs-rugby-mens','cs-rugby-womens',
        'cs-soccer-mens','cs-soccer-womens','cs-volleyball-mens','cs-volleyball-womens',
        'cs-dance','cs-running','cs-softball','cs-tennis','cs-frisbee'],
    // Sports page source pills
    'SP_PM':      ['pm-baseball', 'pm-softball', 'pm-lacrosse', 'pm-volleyball', 'pm-football', 'pm-basketball', 'pm-soccer', 'pm-fieldhockey', 'pm-tennis', 'pm-track'],
    'SP_Clubs':   ['clubs-sports'],
    // News page — Penn Manor and Borough news are community-side; hidden from
    // marauders by default. Each "unlocks" only via its matching news-* fav.
    'PM_NEWS':      ['news-pm'],
    'BOROUGH_NEWS': ['news-borough']
};

// Does the user's affiliation hide this source by default?
// Default (unset) affiliation behaves as Marauder — most users of the site are MU students,
// so that's the majority-optimal default. Townies explicitly opt in.
function isSourceHiddenByAffiliation(source) {
    if (muAffiliation === 'townie') {
        // Townies hide GetInvolved + MU Club Sports
        return source === 'GetInvolved' || source === 'SP_Clubs';
    }
    // Marauder OR unset/default: hide PM, Borough, VFW events + PM sports + PM/Borough news
    return source === 'PM' || source === 'Borough' || source === 'VFW' || source === 'SP_PM'
        || source === 'PM_NEWS' || source === 'BOROUGH_NEWS';
}
// Does the user have a favorite that "unlocks" this hidden source?
function hasFavInSource(source) {
    if (!feedPrefs || feedPrefs.length === 0) return false;
    const ids = SOURCE_UNLOCK_IDS[source] || [];
    // Individual club favorites (club:*) also count as unlocking GetInvolved
    if (source === 'GetInvolved' && feedPrefs.some(p => typeof p === 'string' && p.startsWith('club:'))) return true;
    return feedPrefs.some(p => ids.includes(p));
}
// Should this source be hidden from the user? (hidden by affiliation AND no favorite unlock)
function isSourceHidden(source) {
    return isSourceHiddenByAffiliation(source) && !hasFavInSource(source);
}
// For a given event, is it from a hidden source?
function isEventFromHiddenSource(e) {
    if (!e) return false;
    const tags = e.tags || [];

    // Townie + public-audience: never source-hidden. The townie hide on
    // GetInvolved exists to filter out student-internal content (club
    // meetings, Greek Life, Residence Halls, etc.); events classified
    // audience:public during scrape are explicitly NOT student-internal —
    // they're community service, fundraisers, public-facing performances,
    // etc. Hiding them from townies defeats the audience classification.
    // Without this bypass, a townie has to set an unrelated favorite that
    // incidentally unlocks GetInvolved before they can see e.g. a Bake
    // Sale or Dance Team Showcase. The audience signal is the truth here,
    // not the source-pill default.
    //
    // Marauder side intentionally unchanged: their PM/Borough/VFW hide is
    // venue-focus-based, not audience-based ("I want MU campus content"),
    // so the existing default stands.
    if (muAffiliation === 'townie' && e.audience === 'public') return false;

    if (tags.includes('VFW') && isSourceHidden('VFW')) return true;
    if (tags.includes('PM') && isSourceHidden('PM')) return true;
    if (tags.includes('Borough') && isSourceHidden('Borough')) return true;
    if (tags.includes('Clubs/Orgs') && isSourceHidden('GetInvolved')) return true;
    return false;
}
// For sports events, check against the sports-specific hidden sources
function isSportsEventFromHiddenSource(e) {
    const tags = e.tags || [];
    const isPM = tags.includes('PM') && (tags.includes('Athletics') || tags.includes('Athletic Competitions'));
    const isMUClubSport = tags.includes('Clubs/Orgs') && tags.includes('Club Sports');
    if (isPM && isSourceHidden('SP_PM')) return true;
    if (isMUClubSport && isSourceHidden('SP_Clubs')) return true;
    return false;
}
// For news items, is it from a hidden source? Parallel to isEventFromHiddenSource.
// Marauders (default) hide Penn Manor + Borough news unless they've favorited one.
// Townies see everything (no townie-side news hiding rules exist).
function isNewsFromHiddenSource(n) {
    if (!n || !n.source) return false;
    if (n.source === 'Penn Manor News' && isSourceHidden('PM_NEWS')) return true;
    if (n.source === 'Millersville Borough' && isSourceHidden('BOROUGH_NEWS')) return true;
    return false;
}

// Returns true ONLY when the user has favorites set AND this event matches them.
// Unlike eventMatchesFeed, this returns FALSE when no favorites exist — which is what
// the card-favorite-highlight needs (no prefs = no gold border, no star). eventMatchesFeed
// returns true in the no-prefs case to mean "show everything", which is correct for its
// filter/pinning callers but wrong for the highlight check.
function isEventFavorited(e) {
    if (!feedPrefs || feedPrefs.length === 0) return false;
    return eventMatchesFeed(e);
}

// Pick the best pref ID to toggle when the user taps the ☆ button on a card.
// Logic is "most specific first" — for an MU sports game tagged Baseball we'd rather
// toggle `mu-baseball` (specific) than `musports` (everything). For a club event we
// toggle `club:<orgName>` so only that club's events get the star treatment.
// Returns null for events where there's no sensible single-tag target (e.g. non-tagged
// VFW or Phantom Power events fall back to 'other-vfw' / 'other-phantom' group IDs).
function suggestFeedIdForEvent(e, isSportsPage) {
    const tags = e.tags || [];
    // Sports page: match the sport to the affiliation's sport pref
    if (isSportsPage) {
        const sportMap = {
            'Baseball': 'baseball', 'Softball': 'softball', 'Lacrosse': 'lacrosse',
            'Volleyball': 'volleyball', 'Football': 'football', 'Basketball': 'basketball',
            'Soccer': 'soccer', 'Field Hockey': 'fieldhockey', 'Tennis': 'tennis',
            'Track': 'track', 'Golf': 'golf', 'Swimming': 'swimming', 'Cross Country': 'crosscountry'
        };
        const sportKey = tags.find(t => sportMap[t]);
        if (!sportKey) return null;
        const slug = sportMap[sportKey];
        if (tags.includes('MU')) return 'mu-' + slug;
        if (tags.includes('PM')) return 'pm-' + slug;
        if (tags.includes('Clubs/Orgs')) return 'clubs-sports';
        return null;
    }
    // Events page: individual club for GetInvolved events — org name is a non-meta tag
    if (tags.includes('Clubs/Orgs')) {
        const metaTags = new Set(['MU', 'Clubs/Orgs', 'GetInvolved', 'Student Event', 'Public Event',
            'Arts Concert / Performance', 'Art Exhibit', 'Social', 'Arts', 'Fundraising',
            'Service', 'Cultural', 'Club Sports', 'Greek Life', 'Residence Halls',
            'Home Game Mode', 'Family Friendly']);
        const orgTag = tags.find(t => !metaTags.has(t));
        if (orgTag) return 'club:' + orgTag;
        // Fallback: broad GetInvolved sub-category
        if (tags.includes('Social')) return 'clubs-social';
        if (tags.includes('Arts')) return 'clubs-arts';
        if (tags.includes('Club Sports')) return 'clubs-sports';
        if (tags.includes('Greek Life')) return 'clubs-greek';
        if (tags.includes('Service') || tags.includes('Cultural')) return 'clubs-service';
        return 'clubs-all';
    }
    // MU Calendar proper
    if (tags.includes('MU')) {
        if (tags.includes('Arts Concert / Performance') || tags.includes('Art Exhibit')) return 'mu-arts';
        if (tags.includes('Public Event')) return 'mu-public';
        return null;
    }
    // Penn Manor events
    if (tags.includes('PM')) {
        if (tags.includes('Music/Arts')) return 'pm-music';
        if (tags.includes('Board/PTO')) return 'pm-board';
        return null;
    }
    // Borough
    if (tags.includes('Borough')) return 'borough-all';
    // Other
    if (tags.includes('VFW')) return 'other-vfw';
    if (tags.includes('Phantom Power') || tags.includes('Live Music')) return 'other-phantom';
    // Community-submitted events
    if (tags.includes('Other')) return 'other-community';
    return null;
}

// Toggle a feed preference from a card-level ☆ button. Updates feedPrefs, persists,
// and re-renders the current view so gold borders/stars reflect the change.
// Resolve a prefId (e.g. "baseball-mu" or "club:Chess Club") back to the
// human-readable label users see in the favorites modal. Used by the toast
// message so the user knows exactly which category got toggled. Returns the
// prefId unchanged if no match found, which is a reasonable fallback (the
// user at least sees the raw identifier rather than a silent action).
function resolvePrefLabel(prefId) {
    if (!prefId) return '';
    if (prefId.startsWith('club:')) return prefId.slice(5);
    if (typeof feedSections === 'undefined' || !feedSections) return prefId;
    for (const section of Object.values(feedSections)) {
        if (!section || !section.groups) continue;
        for (const group of Object.values(section.groups)) {
            if (!group.subs) continue;
            const match = group.subs.find(s => s.id === prefId);
            if (match) {
                // Strip leading emoji(s) from the label for a cleaner toast.
                return (match.icon ? match.icon + ' ' : '') + match.label;
            }
        }
    }
    return prefId;
}

// Lightweight toast notifier. Reuses a single fixed element so repeated
// clicks don't stack multiple notifications. Auto-dismisses after 2s.
function showToast(message) {
    let toast = document.getElementById('mapp-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mapp-toast';
        toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--navy);color:white;padding:10px 18px;border-radius:999px;font-size:0.9rem;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,0.25);z-index:9999;opacity:0;transition:opacity 0.25s,transform 0.25s;pointer-events:none;max-width:calc(100% - 40px);text-align:center;';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    // Force reflow so the transition kicks in on first show
    // (otherwise the element goes straight to visible without animating).
    void toast.offsetWidth;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(20px)';
    }, 2000);
}

window.toggleCardFavorite = function(prefId, btnEl) {
    if (!prefId) return;
    if (!feedPrefs) feedPrefs = [];
    const idx = feedPrefs.indexOf(prefId);
    const wasActive = idx >= 0;
    const label = resolvePrefLabel(prefId);
    if (wasActive) {
        feedPrefs.splice(idx, 1);
        if (btnEl) {
            btnEl.classList.remove('active');
            btnEl.textContent = '☆';
            btnEl.setAttribute('title', 'Add to favorites');
            btnEl.setAttribute('aria-label', 'Add to favorites');
        }
        showToast(`Removed: ${label}`);
    } else {
        feedPrefs.push(prefId);
        if (btnEl) {
            btnEl.classList.add('active');
            btnEl.textContent = '★';
            btnEl.setAttribute('title', 'Remove from favorites');
            btnEl.setAttribute('aria-label', 'Remove from favorites');
            // Gold-pulse the card's secondary tag row so the user sees
            // which category bucket they just bookmarked. Animation runs
            // for ~1.2s and self-clears when it ends.
            const card = btnEl.closest('.app-card');
            if (card) {
                const tagsRow = card.querySelector('.card-tags');
                if (tagsRow) {
                    tagsRow.classList.remove('tags-flash');  // reset if mid-animation
                    void tagsRow.offsetWidth;                 // force reflow
                    tagsRow.classList.add('tags-flash');
                    setTimeout(() => tagsRow.classList.remove('tags-flash'), 1400);
                }
            }
        }
        showToast(`★ Added: ${label}`);
    }
    // Persist
    if (feedPrefs.length === 0) {
        localStorage.removeItem(FEED_KEY);
        feedPrefs = null;
    } else {
        localStorage.setItem(FEED_KEY, JSON.stringify(feedPrefs));
    }
    if (typeof setFeedDotVisible === 'function') setFeedDotVisible(!!(feedPrefs && feedPrefs.length > 0));

    // Surgical update: previously this triggered renderEvents() + renderSports()
    // + renderHomeUI() to refresh gold borders on OTHER cards matching the same
    // pref (e.g. starring "Baseball" should gold-border every Baseball card on
    // screen). Three full timeline rebuilds for a star click was costing
    // 100-200ms on slow phones. Now we walk only the visible card/tl-item
    // elements that have data-event-key, look each event up by key, and
    // toggle the visual state where it actually changed. ~5x faster, no
    // GC churn, no scroll position loss.
    if (typeof allEvents === 'undefined' || !allEvents) return;
    // Build a quick lookup map from eventKey → event so each card-update is O(1)
    // rather than scanning the whole array per card. Built once per toggle call.
    const eventByKey = new Map();
    for (const ev of allEvents) {
        const k = ev.sourceLink || (ev.title + '|' + ev.date);
        eventByKey.set(k, ev);
    }
    document.querySelectorAll('[data-event-key]').forEach(el => {
        const key = el.getAttribute('data-event-key');
        const ev = eventByKey.get(key);
        if (!ev) return;
        const isFav = isEventFavorited(ev);
        // Card surfaces (.app-card) get a .card-fav class for the gold border.
        if (el.classList.contains('app-card')) {
            el.classList.toggle('card-fav', isFav);
            // Update the inline star button if present (skip the one we already
            // updated explicitly above — it's already correct).
            const star = el.querySelector('.card-fav-inline');
            if (star && star !== btnEl) {
                star.classList.toggle('active', isFav);
                star.textContent = isFav ? '★' : '☆';
                star.setAttribute('title', isFav ? 'Remove from favorites' : 'Add to favorites');
                star.setAttribute('aria-label', isFav ? 'Remove from favorites' : 'Add to favorites');
            }
        }
        // Timeline items (tl-item on home page) show the favorited state via
        // the tl-fav class — defined for the gold left-border accent.
        if (el.classList.contains('tl-item')) {
            el.classList.toggle('tl-fav', isFav);
        }
    });
};

function eventMatchesFeed(e) {
    if (!feedPrefs || feedPrefs.length === 0) return true;
    const tags = e.tags || [];
    const title = (e.title || '').toLowerCase();

    // Family Friendly — matches any event with kidFriendly flag
    if (feedPrefs.includes('family-events') && e.kidFriendly) return true;

    const sportMap = {baseball:'baseball',softball:'softball',lacrosse:'lacrosse',volleyball:'volleyball',
        football:'football',basketball:'basketball',soccer:'soccer','field hockey':'fieldhockey',
        tennis:'tennis',track:'track',golf:'golf',swimming:'swimming','cross country':'crosscountry'};

    // PM sports
    if (tags.includes('PM') && (tags.includes('Athletics') || tags.includes('Athletic Competitions'))) {
        for (const [sport, feedSuffix] of Object.entries(sportMap)) {
            if (tags.some(t => t.toLowerCase() === sport) && feedPrefs.includes('pm-' + feedSuffix)) return true;
        }
        return false;
    }
    // PM non-sport: only match specific non-sport feeds
    if (tags.includes('PM')) {
        if (tags.includes('Music/Arts') && feedPrefs.includes('pm-music')) return true;
        if (tags.includes('Board/PTO') && feedPrefs.includes('pm-board')) return true;
        if ((tags.includes('School Events') || tags.includes('Health/Wellness') || tags.includes('Meetings')) && feedPrefs.includes('pm-board')) return true;
        return false;
    }

    // MU sports
    if (tags.includes('MU') && (tags.includes('Athletics') || tags.includes('Athletic Competitions'))) {
        for (const [sport, feedSuffix] of Object.entries(sportMap)) {
            if (tags.some(t => t.toLowerCase() === sport) && feedPrefs.includes('mu-' + feedSuffix)) return true;
        }
        // Also match if any broad MU pref exists
        if (feedPrefs.includes('mu-arts') || feedPrefs.includes('mu-public')) return false;
        return false;
    }

    // Clubs/Orgs (GetInvolved) — check BEFORE generic MU because GetInvolved events
    // now carry both 'MU' and 'Clubs/Orgs' tags. The more specific check wins.
    if (tags.includes('Clubs/Orgs')) {
        if (feedPrefs.includes('clubs-all')) return true;
        if (feedPrefs.includes('clubs-social') && tags.includes('Social')) return true;
        if (feedPrefs.includes('clubs-arts') && tags.includes('Arts')) return true;
        if (feedPrefs.includes('clubs-sports') && tags.includes('Club Sports')) return true;
        if (feedPrefs.includes('clubs-greek') && tags.includes('Greek Life')) return true;
        if (feedPrefs.includes('clubs-service') && (tags.includes('Service') || tags.includes('Cultural'))) return true;
        // Per-sport club matchers. The Club Sports umbrella tag is required so
        // these prefs don't accidentally match a Sidearm varsity event that
        // happens to share the same sport tag (e.g. "Baseball"). cs-* IDs
        // distinguish from mu-* (varsity) and pm-* (Penn Manor) prefs.
        if (tags.includes('Club Sports')) {
            if (feedPrefs.includes('cs-baseball') && tags.includes('Baseball')) return true;
            if (feedPrefs.includes('cs-bowling') && /bowling/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-equestrian') && /equestrian/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-fencing') && tags.includes('Fencing')) return true;
            if (feedPrefs.includes('cs-icehockey') && /ice hockey/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-mma') && /\bmma\b/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-basketball-mens') && tags.includes('Basketball') && tags.includes("Men's")) return true;
            if (feedPrefs.includes('cs-basketball-womens') && tags.includes('Basketball') && tags.includes("Women's")) return true;
            if (feedPrefs.includes('cs-lacrosse') && tags.includes('Lacrosse')) return true;
            if (feedPrefs.includes('cs-rugby-mens') && tags.includes('Rugby') && tags.includes("Men's")) return true;
            if (feedPrefs.includes('cs-rugby-womens') && tags.includes('Rugby') && tags.includes("Women's")) return true;
            if (feedPrefs.includes('cs-soccer-mens') && tags.includes('Soccer') && tags.includes("Men's")) return true;
            if (feedPrefs.includes('cs-soccer-womens') && tags.includes('Soccer') && tags.includes("Women's")) return true;
            if (feedPrefs.includes('cs-volleyball-mens') && tags.includes('Volleyball') && tags.includes("Men's")) return true;
            if (feedPrefs.includes('cs-volleyball-womens') && tags.includes('Volleyball') && tags.includes("Women's")) return true;
            if (feedPrefs.includes('cs-dance') && /dance team/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-running') && /\brunning\b/i.test(e.title || '')) return true;
            if (feedPrefs.includes('cs-softball') && tags.includes('Softball')) return true;
            if (feedPrefs.includes('cs-tennis') && tags.includes('Tennis')) return true;
            if (feedPrefs.includes('cs-frisbee') && /ultimate frisbee/i.test(e.title || '')) return true;
        }
        // Individual club matches
        for (const pref of feedPrefs) {
            if (pref.startsWith('club:') && tags.includes(pref.substring(5))) return true;
        }
        return false;
    }

    // MU non-sport events (MU Calendar proper — Clubs/Orgs already handled above)
    if (tags.includes('MU')) {
        if (tags.includes('Arts Concert / Performance') && feedPrefs.includes('mu-arts')) return true;
        if (tags.includes('Public Event') && feedPrefs.includes('mu-public')) return true;
        return false;
    }

    // Borough
    if (tags.includes('Borough') && feedPrefs.includes('borough-all')) return true;

    // Other
    if (tags.includes('VFW') && feedPrefs.includes('other-vfw')) return true;
    if (tags.includes('Live Music') && feedPrefs.includes('other-phantom')) return true;
    if (tags.includes('Community') && feedPrefs.includes('other-community')) return true;

    return false;
}

function newsMatchesFeed(n) {
    if (!feedPrefs || feedPrefs.length === 0) return true;
    const sourceMap = {
        'Millersville News':'news-mu','The Snapper':'news-snapper','MU Athletics':'news-athletics',
        'MU Review':'news-review','Penn Manor News':'news-pm','Millersville Borough':'news-borough'
    };
    return feedPrefs.includes(sourceMap[n.source] || '');
}

window.openFeedSettings = function() {
    loadFeedPrefs();
    const current = feedPrefs || [];
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
    overlay.onclick = function(ev){ if(ev.target===overlay) overlay.remove(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:520px;width:100%;max-height:90vh;overflow-y:auto;padding:28px;position:relative;';

    // Affiliation / dimming setup — shared state for all rendering helpers below.
    // Unset muAffiliation is treated as marauder (the app's default).
    const effectiveAffiliation = muAffiliation === 'townie' ? 'townie' : 'student';
    const isTownie = effectiveAffiliation === 'townie';
    const isMarauder = !isTownie;
    // Rank a group (or sub) by relevance to the current user — relevant first,
    // 'both' next, non-relevant last. Used to order sub-chips within a group.
    const audienceRank = aud => {
        if (!muAffiliation || aud === 'both') return 1;
        if (aud === muAffiliation) return 0;
        return 2;
    };
    // A group is "dimmed" for marauders when its audience is explicitly townie-
    // leaning (PM Events, Borough, etc.). Townies never dim. Now used to extract
    // dimmed groups into the Uncommon accordion, not to visually fade them
    // inside their natural section.
    const isGroupDimmed = (group) => {
        if (!isMarauder) return false;
        return !!(group && group.audience && group.audience !== 'both' && group.audience !== 'student');
    };
    // Use townie-specific label if user is townie and one is defined.
    const labelFor = (item) => (isTownie && item.townieLabel) ? item.townieLabel : item.label;
    // Display order: Events first (matches the nav), then Sports, then News.
    const sectionOrder = ['events', 'sports', 'news'];
    const orderedSections = sectionOrder
        .map(k => [k, feedSections[k]])
        .filter(([, v]) => v)
        .concat(Object.entries(feedSections).filter(([k]) => !sectionOrder.includes(k)));

    // Accordion + group rendering helpers — closure-scoped so they share
    // access to `current`, `effectiveAffiliation`, `isMarauder`, `labelFor`.
    const groupHasFavs = (g) => {
        if (g.linkedIds && Array.isArray(g.linkedIds)) {
            return g.linkedIds.some(id => current.includes(id));
        }
        if (g.headingStyle) {
            const allIds = [
                ...((g.subs || []).map(s => s.id)),
                ...((g.composites || []).flatMap(c => [
                    ...(c.linkedIds || []),
                    ...((c.subSports || []).map(s => s.id))
                ])),
                ...((g.subgroups || []).flatMap(sg => [
                    sg.masterId,
                    ...((sg.children || []).map(c => c.id))
                ]))
            ];
            return allIds.some(id => current.includes(id));
        }
        return (g.subs || []).some(s => current.includes(s.id));
    };
    const anyFavsIn = (groupEntries) => groupEntries.some(([, g]) => groupHasFavs(g));

    // Render one group block (label + checkboxes + sub-chips). Extracted so
    // both the per-section render AND the Uncommon bucket can reuse it.
    const renderGroupBlock = (key, group) => {
        // Composite group: a single togglable checkbox that maps to multiple
        // underlying pref IDs. Used by the townie picker to collapse e.g.
        // mu-arts + clubs-arts into one "MU Arts & Performance" item.
        // Checked state = "any linked ID is currently in feedPrefs".
        if (group.linkedIds && Array.isArray(group.linkedIds)) {
            const linkedIds = group.linkedIds;
            const isChecked = linkedIds.some(id => current.includes(id));
            return `<div style="margin-bottom:8px;">
                <label class="feed-pill${isChecked?' is-checked':''}">
                    <input type="checkbox" class="feed-sub" data-linked-ids="${linkedIds.join(',')}" ${isChecked?'checked':''} onchange="updateCompositeSub(this)">
                    <span>${group.icon} ${labelFor(group)}</span>
                </label>
            </div>`;
        }

        // Heading-style group: renders as an institutional cluster header
        // ("Penn Manor", "Millersville University", "Other") with its own
        // master checkbox attached. Children below can be either traditional
        // subs (granular pref-id chips) or composites (linkedIds aggregated
        // into chips). Master checkbox toggles every underlying pref ID
        // across both child types.
        if (group.headingStyle) {
            const subs = group.subs || [];
            const composites = group.composites || [];
            const subgroups = group.subgroups || [];
            // Collect ALL underlying IDs (subs + every composite's linkedIds
            // + subgroup masters + subgroup children) to determine master
            // state. Master is checked when every underlying ID is in current.
            const allIds = [
                ...subs.map(s => s.id),
                ...composites.flatMap(c => [
                    ...(c.linkedIds || []),
                    ...((c.subSports || []).map(s => s.id))
                ]),
                ...subgroups.flatMap(sg => [
                    sg.masterId,
                    ...((sg.children || []).map(c => c.id))
                ])
            ];
            const allChecked = allIds.length > 0 && allIds.every(id => current.includes(id));

            // Render subs as chips (same shape as marauder picker), composites
            // as full-width pill-styled checkboxes.
            const subsHtml = subs.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding-left:14px;margin-top:6px;">
                ${subs.map(s => `<label class="feed-chip${current.includes(s.id)?' is-checked':''}"><input type="checkbox" class="feed-sub" data-group="${key}" value="${s.id}" ${current.includes(s.id)?'checked':''} onchange="updateFeedGroup('${key}')"> ${s.icon} ${labelFor(s)}</label>`).join('')}
            </div>` : '';

            const compositesHtml = composites.length ? `<div style="padding-left:14px;margin-top:8px;">
                ${composites.map(c => {
                    const cChecked = (c.linkedIds || []).some(id => current.includes(id));
                    // Optional sub-sports chips inside a composite (used for
                    // Club Sports, where townies often want individual sports).
                    const subSports = c.subSports || [];
                    const subSportsHtml = subSports.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 0 4px 14px;">
                        ${subSports.map(s => `<label class="feed-chip-tiny${current.includes(s.id)?' is-checked':''}"><input type="checkbox" class="feed-sub" data-group="${key}" value="${s.id}" ${current.includes(s.id)?'checked':''} onchange="updateFeedGroup('${key}')"> ${s.icon} ${s.label}</label>`).join('')}
                    </div>` : '';
                    return `<div style="margin-bottom:6px;">
                        <label class="feed-composite-label feed-pill-sm${cChecked?' is-checked':''}">
                            <input type="checkbox" class="feed-sub" data-group="${key}" data-linked-ids="${(c.linkedIds||[]).join(',')}" ${cChecked?'checked':''} onchange="updateCompositeSub(this)">
                            <span>${c.icon} ${c.label}</span>
                        </label>
                        ${subSportsHtml}
                    </div>`;
                }).join('')}
            </div>` : '';

            // Subgroups: collapsible nested sections with their own master +
            // children. Used by MU GetInvolved for Club Sports and Greek Life
            // — each carries 19-21 chips that would overwhelm the picker if
            // always-expanded. Default collapsed; click row to expand. The
            // subgroup master toggles all children at once via toggleFeedSubgroup.
            const subgroupsHtml = subgroups.length ? `<div style="padding-left:14px;margin-top:10px;">
                ${subgroups.map(sg => {
                    const childIds = (sg.children || []).map(c => c.id);
                    const masterChecked = current.includes(sg.masterId);
                    const anyChildChecked = childIds.some(id => current.includes(id));
                    // Auto-expand if user has any sub-pref selected — they're
                    // working in this subgroup, so don't make them re-find it.
                    const startExpanded = anyChildChecked;
                    const sgKey = key + '__' + sg.key;
                    const chipsHtml = (sg.children || []).map(c =>
                        `<label style="display:flex;align-items:center;gap:4px;font-size:0.78rem;padding:4px 9px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;background:${current.includes(c.id)?'var(--gold-soft)':'var(--bg)'};"><input type="checkbox" class="feed-sub" data-group="${key}" data-subgroup="${sgKey}" value="${c.id.replace(/"/g,'&quot;')}" ${current.includes(c.id)?'checked':''} onchange="updateFeedSubgroup('${sgKey}')" style="accent-color:var(--gold);"> ${c.icon||''} ${c.label}</label>`
                    ).join('');
                    return `<div class="feed-subgroup" data-subgroup-key="${sgKey}" style="margin-bottom:8px;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;">
                        <div class="feed-subgroup-header" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:${masterChecked||anyChildChecked?'var(--gold-soft)':'var(--bg)'};cursor:pointer;" onclick="toggleSubgroupCollapse(event, '${sgKey}')">
                            <input type="checkbox" class="feed-subgroup-master feed-sub" data-group="${key}" data-subgroup="${sgKey}" value="${sg.masterId}" ${masterChecked?'checked':''} onclick="event.stopPropagation()" onchange="toggleFeedSubgroup(this)" style="accent-color:var(--gold);">
                            <span style="flex:1;font-size:0.85rem;font-weight:700;">${sg.icon} ${sg.label}</span>
                            <span class="feed-subgroup-chevron" style="font-size:0.85rem;color:var(--text-muted);transition:transform 0.15s;${startExpanded?'transform:rotate(90deg);':''}">▸</span>
                        </div>
                        <div class="feed-subgroup-children" style="display:${startExpanded?'flex':'none'};flex-wrap:wrap;gap:6px;padding:10px 12px;background:var(--surface);border-top:1px solid var(--border);">${chipsHtml}</div>
                    </div>`;
                }).join('')}
            </div>` : '';

            // Club browser button — only on the GetInvolved (clubs) group.
            // Lives below the subgroups so it sits beneath Greek Life / Club
            // Sports as a "go deeper" affordance. The heading-style render
            // path lost this button when GetInvolved became heading-style;
            // restore it here.
            const clubBrowserHtml = key === 'clubs'
                ? '<div id="clubs-individual-wrap" style="padding-left:14px;margin-top:10px;"><button onclick="toggleClubBrowser()" class="btn btn-sm btn-outline" style="font-size:0.75rem;">📋 Browse Individual Clubs ▸</button><div id="clubs-individual-list" style="display:none;max-height:200px;overflow-y:auto;margin-top:8px;flex-wrap:wrap;gap:4px;"></div></div>'
                : '';

            return `<div class="feed-heading-group" style="margin-bottom:14px;">
                <label class="feed-heading-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;padding-bottom:6px;border-bottom:1px solid var(--border);">
                    <input type="checkbox" class="feed-group" data-group="${key}" ${allChecked?'checked':''} onchange="toggleFeedGroup(this)" style="accent-color:var(--gold);width:16px;height:16px;">
                    <span class="feed-heading-text">${group.icon} ${labelFor(group)}</span>
                </label>
                ${subsHtml}
                ${compositesHtml}
                ${subgroupsHtml}
                ${clubBrowserHtml}
            </div>`;
        }

        const visibleSubs = group.subs.filter(s => {
            if (!s.audience || s.audience === 'both') return true;
            return s.audience === effectiveAffiliation;
        });
        if (visibleSubs.length === 0) return '';

        const allIds = visibleSubs.map(s => s.id);
        const allChecked = allIds.every(id => current.includes(id));
        const groupDimmed = isMarauder && group.audience && group.audience !== 'both' && group.audience !== 'student';
        const groupClass = groupDimmed ? 'feed-group-dimmed' : '';
        const subs = visibleSubs.slice().sort((a, b) => audienceRank(a.audience || group.audience || 'both') - audienceRank(b.audience || group.audience || 'both'));

        return `<div class="${groupClass}" style="margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <label style="font-size:0.88rem;font-weight:700;display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" class="feed-group" data-group="${key}" ${allChecked?'checked':''} onchange="toggleFeedGroup(this)" style="accent-color:var(--gold);width:16px;height:16px;">
                    ${group.icon} ${labelFor(group)}
                </label>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;padding-left:8px;">
                ${subs.map(s => {
                    const subAud = s.audience || group.audience || 'both';
                    const subDimmed = isMarauder && subAud !== 'both' && subAud !== 'student';
                    const subClass = subDimmed && !groupDimmed ? 'feed-group-dimmed' : '';
                    return `<label class="feed-chip${current.includes(s.id)?' is-checked':''}${subClass?' '+subClass:''}"><input type="checkbox" class="feed-sub" data-group="${key}" value="${s.id}" ${current.includes(s.id)?'checked':''} onchange="updateFeedGroup('${key}')"> ${s.icon} ${labelFor(s)}</label>`;
                }).join('')}
            </div>
            ${key === 'clubs' ? '<div id="clubs-individual-wrap" style="padding-left:8px;margin-top:8px;"><button onclick="toggleClubBrowser()" class="btn btn-sm btn-outline" style="font-size:0.75rem;">📋 Browse Individual Clubs ▸</button><div id="clubs-individual-list" style="display:none;max-height:200px;overflow-y:auto;margin-top:8px;display:none;flex-wrap:wrap;gap:4px;"></div></div>' : ''}
        </div>`;
    };

    // Render one accordion wrapper. `accent` is a left-border color preserving
    // the section color coding (navy/amber/border) from the old design.
    // `defaultOpen` controls initial expanded/collapsed state — we auto-expand
    // sections where the user already has favorites.
    const renderAccordion = (title, contentHtml, defaultOpen, subtitle, accent) => {
        const chevronStyle = defaultOpen ? 'transform:rotate(90deg);' : '';
        const contentStyle = defaultOpen ? '' : 'display:none;';
        const accentStyle = accent ? `border-left:4px solid ${accent};` : '';
        return `<div class="feed-accordion" data-open="${defaultOpen}" style="margin-bottom:10px;border:1px solid var(--border);${accentStyle}border-radius:var(--radius-sm);overflow:hidden;background:var(--surface);">
            <button type="button" onclick="toggleFeedAccordion(this)" style="width:100%;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;background:var(--bg);border:none;cursor:pointer;font-family:inherit;text-align:left;">
                <span style="flex:1;font-size:0.95rem;font-weight:800;color:var(--text);">
                    ${title}
                    ${subtitle ? `<span style="display:block;font-size:0.72rem;font-weight:400;color:var(--text-muted);margin-top:2px;">${subtitle}</span>` : ''}
                </span>
                <span class="feed-accordion-chevron" style="font-size:0.85rem;color:var(--text-muted);transition:transform 0.2s;${chevronStyle}">▶</span>
            </button>
            <div class="feed-accordion-content" style="${contentStyle}padding:14px;border-top:1px solid var(--border);">
                ${contentHtml}
            </div>
        </div>`;
    };

    // Main sections render. For marauders, dimmed (townie-audience) groups
    // are extracted out of their sections into a single "Uncommon" bucket at
    // the bottom — much cleaner than the old "dimmed at bottom of each section"
    // approach, since now sections show ONLY marauder-relevant picks.
    let sectionsHtml = '';
    const uncommonGroups = []; // [[key, group]] gathered for marauders

    for (const [secKey, section] of orderedSections) {
        // Townies use townieGroups when defined — a restructured shape with
        // composite groups and subgroup headings tailored to their UX needs.
        // Marauders always use the granular groups field.
        const sourceGroups = (isTownie && section.townieGroups) ? section.townieGroups : section.groups;
        const rawEntries = Object.entries(sourceGroups);

        let commonEntries;
        if (isMarauder) {
            commonEntries = [];
            for (const [gk, g] of rawEntries) {
                if (isGroupDimmed(g)) uncommonGroups.push([gk, g]);
                else commonEntries.push([gk, g]);
            }
        } else {
            commonEntries = rawEntries; // townies see everything in natural order
        }

        if (commonEntries.length === 0) continue;
        const groupHtml = commonEntries.map(([k, g]) => renderGroupBlock(k, g)).filter(Boolean).join('');
        if (!groupHtml.trim()) continue;

        const defaultOpen = anyFavsIn(commonEntries);
        const accent = secKey === 'sports' ? 'var(--navy)' : secKey === 'events' ? '#b45309' : 'var(--border)';
        sectionsHtml += renderAccordion(section.title, groupHtml, defaultOpen, null, accent);
    }

    // Bottom "Uncommon for Marauders" accordion — consolidates all the
    // townie-audience groups (PM Sports, PM Events, Borough, VFW, Phantom
    // Power, Community News) that used to appear individually dimmed within
    // each section. One collapsible bucket keeps the modal compact while
    // still making these options discoverable for marauders who want to
    // opt into community content. The "enable if interested" nag that used
    // to sit next to each dimmed group label now lives in the bucket's
    // subtitle, so we drop the per-group repetition.
    if (isMarauder && uncommonGroups.length > 0) {
        const uncommonHtml = uncommonGroups.map(([k, g]) => renderGroupBlock(k, g)).filter(Boolean).join('');
        const defaultOpen = anyFavsIn(uncommonGroups);
        sectionsHtml += renderAccordion(
            '🏘️ Uncommon for Marauders',
            uncommonHtml,
            defaultOpen,
            'Penn Manor, Borough, and broader community — favorite if interested',
            '#9ca3af'  // muted gray accent to de-emphasize vs. the themed sections
        );
    }

    // Build individual clubs list from events data
    const clubCategoryTags = new Set(['Clubs/Orgs','MU','GetInvolved','Social','Service','Academic','Cultural','Club Sports','Religious','Professional','Arts','Media','Governance','Recreation','Activism','Greek Life','Honor Society','Meeting','Performance','Lecture or Speaker','Movie or Film','Sporting','Fundraising','GroupBusiness','CommunityService','Tabling','Spirituality','ThoughtfulLearning','Educational Program',"Men's","Women's"]);
    const clubNames = new Map();
    allEvents.forEach(e => {
        const tags = e.tags || [];
        if (!tags.includes('Clubs/Orgs')) return;
        tags.forEach(t => {
            if (!clubCategoryTags.has(t) && t.length > 2) clubNames.set(t, (clubNames.get(t)||0) + 1);
        });
    });
    const sortedClubs = [...clubNames.entries()].filter(([,c]) => c >= 2).sort((a,b) => a[0].localeCompare(b[0]));
    window._individualClubs = sortedClubs.map(([name]) => name);

    modal.innerHTML = `
        <button onclick="this.closest('div[style*=fixed]').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-muted);z-index:2;">✕</button>
        <div style="position:sticky;top:0;background:var(--surface);z-index:1;padding-bottom:12px;border-bottom:1px solid var(--border);margin-bottom:12px;">
            <h3 style="margin-bottom:4px;">⭐ My Favorites</h3>
            <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:10px;">Pick what shows on your homepage and defaults on Events & Sports pages.</p>
            <div style="display:flex;gap:8px;align-items:stretch;">
                <button onclick="saveFeedFromModal();this.closest('div[style*=fixed]').remove();" class="btn btn-sm btn-ticket" style="flex:2;padding:10px 8px;font-size:0.88rem;white-space:nowrap;">💾 Save</button>
                <button onclick="clearFavoritesOnly();this.closest('div[style*=fixed]').remove();" class="btn btn-sm btn-outline" style="flex:1;padding:10px 8px;font-size:0.82rem;white-space:nowrap;">Clear Favs</button>
            </div>
        </div>
        <div id="feed-options">${sectionsHtml}</div>
        <!-- Small affiliation opt-out/opt-in link at the bottom. Mirrors the welcome banner's
             "Not a student? I'm a townie →" pattern. Text flips depending on current affiliation
             so users can switch back if they mis-picked. Unset users see the townie opt-out. -->
        <div style="margin-top:16px;padding-top:12px;border-top:1px dashed var(--border);font-size:0.78rem;color:var(--text-muted);text-align:center;">
            ${muAffiliation === 'townie'
                ? 'Actually a Marauder? <a href="#" onclick="event.preventDefault();this.closest(\'div[style*=fixed]\').remove();window.pickAffiliation(\'student\');openFeedSettings();" style="color:var(--navy);font-weight:600;text-decoration:underline;">I\'m a student →</a>'
                : 'Not a student? <a href="#" onclick="event.preventDefault();this.closest(\'div[style*=fixed]\').remove();window.pickAffiliation(\'townie\');openFeedSettings();" style="color:var(--navy);font-weight:600;text-decoration:underline;">I\'m a townie →</a>'
            }
        </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

window.toggleFeedGroup = function(groupCb) {
    const group = groupCb.dataset.group;
    const checked = groupCb.checked;
    document.querySelectorAll(`.feed-sub[data-group="${group}"]`).forEach(cb => {
        cb.checked = checked;
        const label = cb.closest('label');
        if (label) label.classList.toggle('is-checked', checked);
    });
};

// Expand/collapse a feed-settings accordion. data-open is the source of truth
// for the state — we mirror it into inline display + chevron rotation on each
// toggle so CSS is simple and no animation library is needed.
window.toggleFeedAccordion = function(btn) {
    const accordion = btn.closest('.feed-accordion');
    if (!accordion) return;
    const content = accordion.querySelector('.feed-accordion-content');
    const chevron = accordion.querySelector('.feed-accordion-chevron');
    const isOpen = accordion.dataset.open === 'true';
    if (isOpen) {
        content.style.display = 'none';
        if (chevron) chevron.style.transform = '';
        accordion.dataset.open = 'false';
    } else {
        content.style.display = '';
        if (chevron) chevron.style.transform = 'rotate(90deg)';
        accordion.dataset.open = 'true';
    }
};

window.toggleClubBrowser = function() {
    const list = document.getElementById('clubs-individual-list');
    if (!list) return;
    const isHidden = list.style.display === 'none';
    if (!isHidden) { list.style.display = 'none'; return; }

    // Prefer the full directory from clubs.json; fall back to events-derived list if unavailable
    const directory = (allClubsDirectory && allClubsDirectory.length > 0)
        ? allClubsDirectory
        : (window._individualClubs || []).map(n => ({ name: n, category: '', categories: [] }));

    // Render search input + major dropdown + scrollable list. The major
    // dropdown is populated once the mapping JSON loads (lazy fetch); the
    // search input is always available even if the mapping fails.
    list.style.display = 'block';
    list.style.flexWrap = 'initial';
    list.style.maxHeight = '380px';
    list.innerHTML = `
        <div id="major-filter-row" style="margin-bottom:8px;display:none;">
            <select id="major-filter-select" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.85rem;background:var(--surface);box-sizing:border-box;cursor:pointer;">
                <option value="">— Show all majors —</option>
            </select>
        </div>
        <input id="club-search-input" type="text" placeholder="Search ${directory.length} MU organizations..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.85rem;margin-bottom:8px;box-sizing:border-box;">
        <div id="club-search-results" style="display:flex;flex-wrap:wrap;gap:4px;max-height:260px;overflow-y:auto;"></div>`;

    const input = document.getElementById('club-search-input');
    const results = document.getElementById('club-search-results');
    const majorRow = document.getElementById('major-filter-row');
    const majorSelect = document.getElementById('major-filter-select');

    // Currently selected major spec (object from mapping JSON), or null for "all".
    let selectedMajor = null;

    function renderList(query) {
        const q = (query || '').trim().toLowerCase();
        const current = feedPrefs || [];
        // Filter pipeline: major filter narrows first (if active), then text
        // search refines. This is the most user-intuitive ordering — picking
        // a major sets a context, typing within it narrows further.
        let orgs = directory;
        if (selectedMajor) {
            orgs = orgs.filter(o => clubMatchesMajor(o, selectedMajor));
        }
        if (q) {
            orgs = orgs.filter(o => o.name.toLowerCase().includes(q) || (o.category || '').toLowerCase().includes(q));
        }
        if (!q && !selectedMajor) {
            // Default sort: favorited first, then alphabetical. Top 60 only.
            orgs = orgs.slice().sort((a, b) => {
                const af = current.includes('club:' + a.name) ? 0 : 1;
                const bf = current.includes('club:' + b.name) ? 0 : 1;
                if (af !== bf) return af - bf;
                return a.name.localeCompare(b.name);
            });
            if (orgs.length > 60) orgs = orgs.slice(0, 60);
        } else if (selectedMajor) {
            // When filtering by major, sort favorited first then alphabetical.
            // No 60-cap since major filtering naturally narrows the list.
            orgs = orgs.slice().sort((a, b) => {
                const af = current.includes('club:' + a.name) ? 0 : 1;
                const bf = current.includes('club:' + b.name) ? 0 : 1;
                if (af !== bf) return af - bf;
                return a.name.localeCompare(b.name);
            });
        }
        const totalInDir = directory.length;
        // Status row at top of results — communicates filter state to user.
        let showingInfo = '';
        if (selectedMajor && q) {
            showingInfo = `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">${orgs.length} clubs for ${selectedMajor.displayName || selectedMajor.name} matching "${q}"</div>`;
        } else if (selectedMajor) {
            showingInfo = `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">${orgs.length} clubs related to ${selectedMajor.displayName || selectedMajor.name}</div>`;
        } else if (q) {
            showingInfo = `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">${orgs.length} of ${totalInDir} match "${q}"</div>`;
        } else if (totalInDir > 60) {
            showingInfo = `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">Showing 60 of ${totalInDir} — type to search or pick your major above</div>`;
        }
        if (orgs.length === 0) {
            // Different empty-state message depending on what filters are active.
            const reason = selectedMajor
                ? `No clubs in our directory matched "${selectedMajor.displayName || selectedMajor.name}". <a href="#" onclick="event.preventDefault();document.getElementById('major-filter-select').value='';document.getElementById('major-filter-select').dispatchEvent(new Event('change'));" style="color:var(--navy);">Show all clubs</a>`
                : 'No organizations match.';
            results.innerHTML = showingInfo + `<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:0.85rem;">${reason}</div>`;
            return;
        }
        results.innerHTML = showingInfo + orgs.map(o => {
            const val = 'club:' + o.name;
            const checked = current.includes(val);
            const escapedName = o.name.replace(/"/g, '&quot;');
            return `<label class="feed-chip-tiny feed-chip-club${checked?' is-checked':''}"><input type="checkbox" class="feed-club" value="${val}" ${checked?'checked':''} onchange="this.closest('label').classList.toggle('is-checked', this.checked)"> ${escapedName}</label>`;
        }).join('');
    }

    input.addEventListener('input', () => renderList(input.value));
    majorSelect.addEventListener('change', () => {
        const idx = majorSelect.value;
        selectedMajor = (idx === '' || !majorClubsMapping) ? null : majorClubsMapping.majors[parseInt(idx)];
        renderList(input.value);
    });

    // Populate the major dropdown asynchronously. If load fails or returns
    // empty, the row stays hidden and the rest of the UI works unaffected.
    loadMajorClubsMapping().then(mapping => {
        if (!mapping || !mapping.majors || mapping.majors.length === 0) return;
        // Append major options. Use index as value so we can reference the
        // full spec object (with keywords + categories) on selection.
        const opts = mapping.majors.map((m, i) =>
            `<option value="${i}">${m.displayName || m.name}</option>`
        ).join('');
        majorSelect.insertAdjacentHTML('beforeend', opts);
        majorRow.style.display = 'block';

        // Diagnostic: log any mapping that produces 0 matches against the
        // current directory. Helps us spot dead/misaligned mappings without
        // needing a separate eval pass. Logs once per session.
        if (!window._majorMappingDiagnosticLogged) {
            window._majorMappingDiagnosticLogged = true;
            const empties = mapping.majors
                .filter(m => directory.filter(c => clubMatchesMajor(c, m)).length === 0)
                .map(m => m.displayName || m.name);
            if (empties.length > 0) {
                console.log(`[major-mapping] ${empties.length} of ${mapping.majors.length} majors produced 0 matches against ${directory.length}-club directory:`, empties);
            } else {
                console.log(`[major-mapping] all ${mapping.majors.length} majors produced ≥1 match against ${directory.length}-club directory.`);
            }
        }
    });

    renderList('');
};

window.updateFeedGroup = function(group) {
    const subs = document.querySelectorAll(`.feed-sub[data-group="${group}"]`);
    const groupCb = document.querySelector(`.feed-group[data-group="${group}"]`);
    if (groupCb) groupCb.checked = [...subs].every(s => s.checked);
    subs.forEach(cb => {
        const label = cb.closest('label');
        if (label) label.classList.toggle('is-checked', cb.checked);
    });
};

// Subgroup toggle handlers. Subgroups are collapsible nested sections inside
// heading-style groups (Club Sports, Greek Life under MU GetInvolved). Each
// has: a master checkbox (toggles all children), a row that expands/collapses
// to reveal child chips, and a parent-state ripple back up to the group's
// master.

// Click on the subgroup row (anywhere except the master checkbox) toggles
// the chips panel. Stop propagation on the master so checking it doesn't also
// collapse/expand the panel.
window.toggleSubgroupCollapse = function(evt, sgKey) {
    // If the click originated on the master checkbox, ignore (its onclick
    // already stopped propagation). Belt and suspenders.
    if (evt && evt.target && evt.target.classList && evt.target.classList.contains('feed-subgroup-master')) return;
    const sg = document.querySelector(`.feed-subgroup[data-subgroup-key="${sgKey}"]`);
    if (!sg) return;
    const panel = sg.querySelector('.feed-subgroup-children');
    const chevron = sg.querySelector('.feed-subgroup-chevron');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'flex';
    if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
};

// Master checkbox toggled — set ALL children to match. Also flip the row
// background (gold-soft when any state is "on", default otherwise) and
// re-sync the parent group's master state via updateFeedGroup.
window.toggleFeedSubgroup = function(masterCb) {
    const sgKey = masterCb.dataset.subgroup;
    const groupKey = masterCb.dataset.group;
    const checked = masterCb.checked;
    const sg = document.querySelector(`.feed-subgroup[data-subgroup-key="${sgKey}"]`);
    if (!sg) return;
    sg.querySelectorAll(`.feed-sub[data-subgroup="${sgKey}"]:not(.feed-subgroup-master)`).forEach(cb => {
        cb.checked = checked;
        const label = cb.closest('label');
        if (label) label.classList.toggle('is-checked', checked);
    });
    const header = sg.querySelector('.feed-subgroup-header');
    if (header) header.classList.toggle('is-active', checked);
    if (groupKey && typeof updateFeedGroup === 'function') updateFeedGroup(groupKey);
};

// Individual child toggled — re-sync the subgroup master (checked when every
// child is checked, unchecked otherwise) and the parent group's master.
window.updateFeedSubgroup = function(sgKey) {
    const sg = document.querySelector(`.feed-subgroup[data-subgroup-key="${sgKey}"]`);
    if (!sg) return;
    const children = [...sg.querySelectorAll(`.feed-sub[data-subgroup="${sgKey}"]:not(.feed-subgroup-master)`)];
    const master = sg.querySelector('.feed-subgroup-master');
    const allChecked = children.length > 0 && children.every(c => c.checked);
    const anyChecked = children.some(c => c.checked);
    if (master) master.checked = allChecked;
    // Update each child's own check state class — updateFeedGroup won't reach them
    children.forEach(c => {
        const label = c.closest('label');
        if (label) label.classList.toggle('is-checked', c.checked);
    });
    const header = sg.querySelector('.feed-subgroup-header');
    if (header) header.classList.toggle('is-active', allChecked || anyChecked);
    // Cascade up to parent group master via the data-group attribute
    const groupKey = master && master.dataset.group;
    if (groupKey && typeof updateFeedGroup === 'function') updateFeedGroup(groupKey);
};

window.saveFeedFromModal = function() {
    // Composite subs (data-linked-ids) expand to multiple pref IDs; standard
    // subs use their single .value. De-duplicate via a Set since composites
    // could overlap with each other's linked IDs in theory.
    const seen = new Set();
    const selected = [];
    [...document.querySelectorAll('.feed-sub:checked')].forEach(cb => {
        if (cb.dataset.linkedIds) {
            cb.dataset.linkedIds.split(',').forEach(id => {
                const trimmed = id.trim();
                if (trimmed && !seen.has(trimmed)) {
                    seen.add(trimmed);
                    selected.push(trimmed);
                }
            });
        } else if (cb.value) {
            if (!seen.has(cb.value)) {
                seen.add(cb.value);
                selected.push(cb.value);
            }
        }
    });
    // Also capture individual club selections
    const clubSelections = [...document.querySelectorAll('.feed-club:checked')].map(cb => cb.value);
    const allPrefs = [...selected, ...clubSelections];
    if (allPrefs.length === 0) { clearFeedPrefs(); return; }
    saveFeedPrefs(allPrefs);
    renderHomeFeed();
    renderEvents(); renderSports(); renderNewsUI();
    decorateFeedStars();
};

// Visual feedback when a composite sub (linkedIds checkbox) is toggled.
// Reflects the same gold-border/soft-background pattern used by other
// favorited UI elements so the state is unmistakable.
window.updateCompositeSub = function(cb) {
    const label = cb.closest('label');
    if (!label) return;
    label.classList.toggle('is-checked', cb.checked);
    // If this composite belongs to a heading-style group (data-group present),
    // re-sync the master checkbox state — checked when every sibling sub
    // (chips + composites) is checked.
    if (cb.dataset.group) {
        const groupKey = cb.dataset.group;
        const siblingSubs = document.querySelectorAll(`.feed-sub[data-group="${groupKey}"]`);
        const masterCb = document.querySelector(`.feed-group[data-group="${groupKey}"]`);
        if (masterCb && siblingSubs.length > 0) {
            masterCb.checked = [...siblingSubs].every(s => s.checked);
        }
    }
};

window.clearFeedPrefs = function() {
    localStorage.removeItem(FEED_KEY);
    feedPrefs = null;
    setFeedDotVisible(false);
    renderHomeFeed();
    renderEvents(); renderSports(); renderNewsUI();
    decorateFeedStars();
};

// Clear just the favorites list but keep the Marauder/Townie affiliation
window.clearFavoritesOnly = function() {
    localStorage.removeItem(FEED_KEY);
    feedPrefs = null;
    setFeedDotVisible(false);
    renderHomeFeed();
    renderEvents(); renderSports(); renderNewsUI();
    decorateFeedStars();
};

// Reset everything: favorites AND affiliation. Next page load will re-prompt.
window.resetEverything = function() {
    localStorage.removeItem(FEED_KEY);
    localStorage.removeItem(AFFILIATION_KEY);
    localStorage.removeItem('welcomeDismissed'); // let the welcome banner show again
    feedPrefs = null;
    muAffiliation = null;
    setFeedDotVisible(false);
    renderHomeFeed();
    renderEvents(); renderSports(); renderNewsUI();
    decorateFeedStars();
};

// ==================== FEED STAR DECORATION ====================
function decorateFeedStars() {
    document.querySelectorAll('[data-feed]').forEach(btn => {
        const existingStar = btn.querySelector('.feed-star');
        if (existingStar) existingStar.remove();

        if (!feedPrefs || feedPrefs.length === 0) return;

        const feedKey = btn.dataset.feed;
        // Determine context — which page is this button on?
        const onEventsPage = !!btn.closest('#view-events');
        const onSportsPage = !!btn.closest('#view-sports');
        // Filter prefs by context
        const contextPrefs = onEventsPage ? feedPrefs.filter(p => eventFeedIds.has(p) || p.startsWith('club:'))
                           : onSportsPage ? feedPrefs.filter(p => sportFeedIds.has(p))
                           : feedPrefs;

        let isInFeed = false;
        if (feedKey.startsWith('sport-')) {
            const suffix = feedKey.replace('sport-', '');
            isInFeed = contextPrefs.some(p => p === 'pm-' + suffix || p === 'mu-' + suffix);
        } else if (feedKey.endsWith('-')) {
            isInFeed = contextPrefs.some(p => p.startsWith(feedKey));
        } else {
            isInFeed = contextPrefs.includes(feedKey);
        }

        if (isInFeed) {
            const star = document.createElement('span');
            star.className = 'feed-star';
            star.textContent = '★';
            star.style.cssText = 'color:var(--navy);font-size:0.7rem;position:absolute;top:-5px;right:-5px;pointer-events:none;text-shadow:0 0 2px rgba(255,255,255,0.8);line-height:1;';
            btn.style.position = 'relative';
            btn.appendChild(star);
        }
    });
    showFavTipToast();
}

// Double-tap/click to toggle favorites (works on both desktop and mobile)
(function() {
    let lastTapTime = 0;
    let lastTapBtn = null;
    let singleTapTimer = null;

    // Intercept clicks on data-feed buttons in capture phase (before inline onclick)
    document.addEventListener('click', function(e) {
        const btn = e.target.closest('[data-feed]');
        if (!btn || (!btn.classList.contains('src-btn') && !btn.classList.contains('sport-pill') && !btn.classList.contains('btn') && !btn.classList.contains('family-toggle'))) return;

        const now = Date.now();
        const isDoubleTap = (lastTapBtn === btn && now - lastTapTime < 400);

        if (isDoubleTap) {
            // Double-tap: toggle favorite, cancel the pending single tap
            e.stopImmediatePropagation();
            e.preventDefault();
            clearTimeout(singleTapTimer);
            lastTapBtn = null;
            lastTapTime = 0;
            if (window.getSelection) window.getSelection().removeAllRanges();
            toggleFeedFromButton(btn);
        } else {
            // First tap: delay the normal click action
            e.stopImmediatePropagation();
            e.preventDefault();
            lastTapBtn = btn;
            lastTapTime = now;
            clearTimeout(singleTapTimer);
            // Store the onclick to fire after delay
            const onclickAttr = btn.getAttribute('onclick');
            singleTapTimer = setTimeout(function() {
                lastTapBtn = null;
                lastTapTime = 0;
                // Execute the original onclick
                if (onclickAttr) {
                    try { new Function(onclickAttr).call(btn); } catch(ex) {}
                }
            }, 350);
        }
    }, true); // capture phase
})();

function toggleFeedFromButton(btn) {
    const feedKey = btn.dataset.feed;
    if (!feedKey) return;

    let prefs = feedPrefs ? [...feedPrefs] : [];
    const isPrefix = feedKey.endsWith('-');
    const isSportPill = feedKey.startsWith('sport-');

    if (isSportPill) {
        // Sport pill: toggle both pm-{sport} and mu-{sport}
        const suffix = feedKey.replace('sport-', '');
        const ids = ['pm-' + suffix, 'mu-' + suffix];
        const allIn = ids.every(id => prefs.includes(id));
        if (allIn) {
            prefs = prefs.filter(p => !ids.includes(p));
        } else {
            ids.forEach(id => { if (!prefs.includes(id)) prefs.push(id); });
        }
    } else if (isPrefix) {
        // Get all feed IDs that match this prefix, filtered by page context
        const onEventsPage = !!btn.closest('#view-events');
        const onSportsPage = !!btn.closest('#view-sports');
        const allIds = [];
        for (const group of Object.values(feedOptions)) {
            group.subs.forEach(s => {
                if (!s.id.startsWith(feedKey)) return;
                if (onEventsPage && !eventFeedIds.has(s.id)) return;
                if (onSportsPage && !sportFeedIds.has(s.id)) return;
                allIds.push(s.id);
            });
        }
        const allIn = allIds.every(id => prefs.includes(id));
        if (allIn) {
            // Remove all matching
            prefs = prefs.filter(p => !p.startsWith(feedKey));
        } else {
            // Add all matching
            allIds.forEach(id => { if (!prefs.includes(id)) prefs.push(id); });
        }
    } else {
        // Toggle single feed ID
        if (prefs.includes(feedKey)) {
            prefs = prefs.filter(p => p !== feedKey);
        } else {
            prefs.push(feedKey);
        }
    }

    if (prefs.length === 0) {
        clearFeedPrefs();
    } else {
        saveFeedPrefs(prefs);
        renderHomeFeed();
        renderEvents(); renderSports(); renderNewsUI();
        decorateFeedStars();
    }

    // Brief visual feedback
    btn.style.transition = 'transform 0.15s';
    btn.style.transform = 'scale(1.15)';
    setTimeout(() => { btn.style.transform = ''; }, 200);
}

function renderHomeFeed() {
    const hasFeed = feedPrefs && feedPrefs.length > 0;
    const feedCta = document.getElementById('home-feed-cta');
    if (feedCta) feedCta.style.display = hasFeed ? 'none' : 'block';
    // Welcome banner shows once on first visit. Dismisses permanently when:
    //   - User clicks "Set Up Favorites" (opens the feed modal; they've engaged)
    //   - User clicks "Skip for now" (explicit dismiss; stays Marauder-default)
    //   - User clicks "I'm a townie" (sets affiliation + offers favorites setup)
    //   - User has already set up favorites (hasFeed)
    const wb = document.getElementById('welcome-banner');
    if (wb) {
        const dismissed = localStorage.getItem('welcomeDismissed');
        wb.style.display = (!hasFeed && !dismissed) ? 'block' : 'none';
    }
    renderHomeUI();
}
// Day navigator on the home page. Selected day persists only for the current
// view session — refresh always lands on today.
window.shiftHomeDay = function(direction) {
    if (!homeViewDate) homeViewDate = todayMidnight();
    const d = new Date(homeViewDate);
    d.setDate(d.getDate() + direction);
    // Bound the navigator: 30 days back (older events have rolled off the
    // scrape window), 60 days forward (matches scrape horizon). Beyond those,
    // every day would be empty and that's just confusing UX.
    const today = todayMidnight();
    const minDate = new Date(today); minDate.setDate(minDate.getDate() - 30);
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + 60);
    if (d < minDate || d > maxDate) return;
    homeViewDate = d;
    renderHomeUI();
    // Scroll the timeline section into view if user is below it (in case
    // nav was clicked from far down the page). Subtle UX nicety.
    const sec = document.getElementById('home-timeline');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
window.resetHomeDay = function() {
    homeViewDate = todayMidnight();
    renderHomeUI();
};
window.dismissWelcome = function() {
    localStorage.setItem('welcomeDismissed', '1');
    const wb = document.getElementById('welcome-banner');
    if (wb) wb.style.display = 'none';
};
// Primary CTA: user wants to set up favorites. Dismiss the banner and open the feed modal.
// Affiliation stays unset → treated as Marauder (the app default).
window.welcomeSetupFavorites = function() {
    localStorage.setItem('welcomeDismissed', '1');
    const wb = document.getElementById('welcome-banner');
    if (wb) wb.style.display = 'none';
    openFeedSettings();
};
// Secondary opt-out: user says they're a townie. Set affiliation, dismiss the banner,
// then open the feed modal (already in townie mode) so they can set up their favorites.
window.welcomeIdentifyAsTownie = function() {
    pickAffiliation('townie');
    localStorage.setItem('welcomeDismissed', '1');
    const wb = document.getElementById('welcome-banner');
    if (wb) wb.style.display = 'none';
    openFeedSettings();
};
window.pickAffiliation = function(value) {
    if (value !== 'student' && value !== 'townie') return;
    const prev = muAffiliation;
    const changingExisting = prev && prev !== value && feedPrefs && feedPrefs.length > 0;
    if (changingExisting) {
        const label = value === 'student' ? 'Marauder' : 'Townie';
        if (!confirm(`Reset your favorites to ${label} defaults? Your current favorites will be cleared.`)) {
            // User declined — just update affiliation, keep favorites (but still prune stale state below)
            muAffiliation = value;
            localStorage.setItem(AFFILIATION_KEY, value);
            pruneStaleStateForAffiliation();
            renderHomeFeed();
            if (typeof renderEvents === 'function') renderEvents();
            if (typeof renderSports === 'function') renderSports();
            if (typeof renderNewsUI === 'function') renderNewsUI();
            return;
        }
        // User confirmed — clear favorites and reopen modal
        localStorage.removeItem(FEED_KEY);
        feedPrefs = null;
        setFeedDotVisible(false);
    }
    muAffiliation = value;
    localStorage.setItem(AFFILIATION_KEY, value);
    pruneStaleStateForAffiliation();
    renderHomeFeed();
    if (typeof renderEvents === 'function') renderEvents();
    if (typeof renderSports === 'function') renderSports();
    if (typeof renderNewsUI === 'function') renderNewsUI();
    if (typeof decorateFeedStars === 'function') decorateFeedStars();
};

// Called after affiliation changes. Cleans up state that may be invalid under the new
// affiliation. Specifically:
//   - evTags: drop any sub-filter tag not present in the new affiliation's evSubMap
//     (e.g. a Marauder with "Greek Life" selected becomes a Townie → "Greek Life" no
//     longer appears as a sub-chip, but the tag would silently keep filtering the list).
//   - feedPrefs: drop any pref tied to a sub-chip that the new affiliation can't see
//     in the modal (e.g. clubs-greek when switching to Townie). Protects against the
//     user not being able to uncheck favorites they no longer see.
//   - evKidMode / perk toggles: cleared here too, since the buttons themselves are
//     shown/hidden per affiliation and an invisible active filter is confusing.
function pruneStaleStateForAffiliation() {
    // Rebuild valid sub-tag set from the current affiliation's evSubMap
    if (typeof getEvSubMap === 'function' && typeof evTags !== 'undefined') {
        const validSubTags = new Set();
        const subMap = getEvSubMap();
        for (const subs of Object.values(subMap || {})) {
            for (const sub of subs) {
                const tag = typeof sub === 'string' ? sub : sub.tag;
                validSubTags.add(tag);
            }
        }
        // Prune any active tag that doesn't exist under the new affiliation
        for (const tag of Array.from(evTags)) {
            if (!validSubTags.has(tag)) evTags.delete(tag);
        }
    }
    // Prune feedPrefs: drop IDs tied to subs the user can't see anymore
    if (feedPrefs && feedPrefs.length > 0 && typeof feedSections !== 'undefined') {
        const effectiveAff = muAffiliation === 'townie' ? 'townie' : 'student';
        const visibleIds = new Set();
        for (const section of Object.values(feedSections)) {
            for (const group of Object.values(section.groups)) {
                for (const sub of group.subs) {
                    // A sub is visible if it has no audience OR its audience matches effective
                    if (!sub.audience || sub.audience === 'both' || sub.audience === effectiveAff) {
                        visibleIds.add(sub.id);
                    }
                }
            }
        }
        // Keep `club:*` favorites (individual clubs are always visible in the browser)
        const pruned = feedPrefs.filter(p => {
            if (typeof p !== 'string') return false;
            if (p.startsWith('club:')) return true;
            return visibleIds.has(p);
        });
        if (pruned.length !== feedPrefs.length) {
            feedPrefs = pruned;
            if (feedPrefs.length === 0) {
                localStorage.removeItem(FEED_KEY);
                feedPrefs = null;
            } else {
                localStorage.setItem(FEED_KEY, JSON.stringify(feedPrefs));
            }
        }
    }
    // Clear toolbar mode state that no longer applies. updateEventsUI/updateSportsUI
    // will be called by the renderEvents/renderSports that follow pickAffiliation.
    evKidMode = false;
    evFreeFoodMode = false;
    evFreeStuffMode = false;
}
// ==================== END MY FEED ====================

// View mode state for Events page
// Infinite-scroll state: how many days of future events are currently rendered.
// Each "Load more" click adds LOAD_MORE_INCREMENT days for future, or
// LOAD_MORE_INCREMENT_PAST days for past. Past uses a smaller step because users
// typically want "last week's games" not "last 2 months" — 60-day jumps there are
// an awkward amount.
const INITIAL_DAYS = 60;
const INITIAL_DAYS_PAST = 14;
const LOAD_MORE_INCREMENT = 60;
const LOAD_MORE_INCREMENT_PAST = 14;
let evDaysVisible = INITIAL_DAYS;
// Favorites-only filter mode — when on, only favorited events show (still day-grouped).
// Replaces the old "pin at top" behavior since pinning all future favorites under the
// Today header was confusing when the first pinned card was weeks away.
let evFavOnlyMode = false;
let spFavOnlyMode = false;
// Events page retains mode/anchor only for back-compat with older functions that
// reference them; actively ignored by the new render pipeline.
let evMode='upcoming', evAnchorDate=new Date();

// Sports page state
let spActiveSources=new Set(['PM','MU','Clubs']), spSportTag=null, spHomeOnly=false;
// Sports view state: 'upcoming' (infinite-scroll forward) or 'past' (infinite-scroll backward)
let spTimeView = 'upcoming';
let spDaysVisible = INITIAL_DAYS;
let spPastDaysVisible = INITIAL_DAYS_PAST;
let spMode='week', spAnchorDate=new Date();

const sportsList=['Baseball','Softball','Track','Soccer','Lacrosse','Tennis','Volleyball','Wrestling','Basketball','Football','Field Hockey','Golf','Cross Country','Cheerleading','Swimming','Rugby','Fencing','Esports','Archery'];
const topSources=['MU','PM','Borough','Other'];
const sportMetaTags=['Athletic Competitions','Athletics','Club Sports','Home Game Mode','H Games'];

// Sub-filter chips vary by affiliation:
//   - Marauders see MU-internal vocabulary (GetInvolved, Residence Halls, Greek Life)
//   - Townies see community-friendly vocabulary (Community). Residence Halls and Greek Life
//     are omitted because they're MU-internal living arrangements townies don't filter by.
// Each sub-chip entry is either a string (label = tagName = filter-tag) or
// { label, tag } when the display label differs from the underlying tag to match on.
function getEvSubMap() {
    // Default (unset) → show Marauder sub-filters. Townies explicitly opt in via the
    // affiliation picker, at which point they see the community-friendly vocabulary.
    const isTownie = muAffiliation === 'townie';
    return {
        'MU': isTownie
            ? [
                'Public Event',
                'Arts Concert / Performance',
                { label: 'Community', tag: 'Clubs/Orgs' },  // townie-friendly label for student-org public events
                'Fundraising'
            ]
            : ['Public Event', 'Arts Concert / Performance', 'GetInvolved', 'Residence Halls', 'Greek Life', 'Fundraising'],
        'PM': ['Music/Arts', 'School Events', 'Board/PTO', 'Health/Wellness', 'Field Trips', 'Meetings']
    };
}
// Keep evSubMap as a getter for any legacy readers that expect an object shape
const evSubMap = new Proxy({}, { get: (_, key) => getEvSubMap()[key] });

// Date helpers
function toDateStr(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;}
function localDateStr(iso){return toDateStr(new Date(iso));}
function todayMidnight(){const d=new Date();return new Date(d.getFullYear(),d.getMonth(),d.getDate());}
function getMonday(d){const day=d.getDay(),diff=d.getDate()-day+(day===0?-6:1);return new Date(d.getFullYear(),d.getMonth(),diff);}
function addDays(d,n){const r=new Date(d);r.setDate(r.getDate()+n);return r;}
function fmtDateLabel(d){const t=todayMidnight();if(toDateStr(d)===toDateStr(t))return 'Today, '+d.toLocaleDateString('en-US',{month:'short',day:'numeric'});return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});}
function fmtWeekLabel(start){const end=addDays(start,6);return start.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' – '+end.toLocaleDateString('en-US',{month:'short',day:'numeric'});}

function getDateRange(mode,anchor){
    const today=todayMidnight();
    if(mode==='upcoming') return {start:toDateStr(today),end:'9999-12-31'};
    if(mode==='past') return {start:'0000-01-01',end:toDateStr(addDays(today,-1))};
    if(mode==='day') return {start:toDateStr(anchor),end:toDateStr(anchor)};
    if(mode==='week'){return {start:toDateStr(anchor),end:toDateStr(addDays(anchor,6))};}
    return {start:'0000-01-01',end:'9999-12-31'};
}

function getVisibleDateRange(events){
    if(events.length===0) return null;
    const first=localDateStr(events[0].date);
    const last=localDateStr(events[events.length-1].date);
    const fd=new Date(first+'T12:00:00'), ld=new Date(last+'T12:00:00');
    return fd.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' – '+ld.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}

function updateModeUI(prefix,mode,anchor,filteredEvents){
    ['past','day','week'].forEach(m=>{
        const btn=document.getElementById(prefix+'-mode-'+m);
        if(btn) btn.classList.toggle('active',m===mode);
    });
    const prevBtn=document.getElementById(prefix+'-prev');
    const nextBtn=document.getElementById(prefix+'-next');
    const label=document.getElementById(prefix+'-date-label');
    const showArrows=(mode==='day'||mode==='week');
    if(prevBtn) prevBtn.style.display=showArrows?'flex':'none';
    if(nextBtn) nextBtn.style.display=showArrows?'flex':'none';
    if(label){
        if(mode==='day') label.textContent=fmtDateLabel(anchor);
        else if(mode==='week') label.textContent=fmtWeekLabel(anchor);
        else if((mode==='upcoming'||mode==='past')&&filteredEvents&&filteredEvents.length>0) label.textContent=getVisibleDateRange(filteredEvents);
        else label.textContent='';
    }
}

function isSportEvent(e){
    const t=e.tags||[];
    // Athletic Camps are kids events (not competitive games) — keep on Events page
    if(t.includes('Athletic Camp')) return false;
    return t.includes('Athletic Competitions')||t.includes('Athletics')||t.includes('Club Sports')||sportsList.some(s=>t.includes(s))||(t.includes('PM')&&t.includes('Athletics'));
}
function isPMSportByTitle(e){
    const t=e.tags||[];
    if(!t.includes('PM')) return false;
    const title=(e.title||'').toLowerCase();
    return title.includes('sport:')||sportsList.some(s=>title.includes(s.toLowerCase()))||(/\b(varsity|jv|j\.v\.)\b/i.test(title));
}
function matchesSource(tags,src){
    if(src==='All') return true;
    // MU now includes GetInvolved (MU Clubs) since those events are tagged MU + GetInvolved + Clubs/Orgs
    if(src==='MU') return tags.includes('MU');
    if(src==='PM') return tags.includes('PM');
    if(src==='Borough') return tags.includes('Borough');
    if(src==='Other') return tags.includes('Other') || tags.includes('Community');
    // Sports page still uses 'Clubs' as a separate filter (Club Sports games)
    if(src==='Clubs') return tags.includes('Clubs/Orgs')&&(tags.includes('Club Sports')||sportsList.some(s=>tags.includes(s)));
    return false;
}
function formatDate(d){return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});}
function formatTime(d){return d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});}

function matchesSportSource(tags, src) {
    if(src==='MU') return tags.includes('MU')&&(tags.includes('Athletic Competitions')||tags.includes('Athletics'));
    if(src==='Clubs') return tags.includes('Clubs/Orgs')&&(tags.includes('Club Sports')||sportsList.some(s=>tags.includes(s)));
    if(src==='PM') return tags.includes('PM')&&tags.includes('Athletics');
    return false;
}

const viewPaths={home:'/',news:'/news',events:'/events',sports:'/sports',places:'/places',board:'/board',weather:'/weather',store:'/store',advertise:'/advertise',analytics:'/analytics'};
const pathToView=Object.fromEntries(Object.entries(viewPaths).map(([k,v])=>[v,k]));
// Legacy URL redirects
pathToView['/food'] = 'places';
pathToView['/services'] = 'places';
pathToView['/directory'] = 'places';

// Runtime header-height measurement. The secondary sticky nav bar (events/
// sports pages) uses --header-h to position flush below the main header. A
// hardcoded CSS value drifts any time the header's content changes size —
// new nav item, bigger gear icon, Ecwid cart widget loading async, font
// metrics shifting across platforms. Measuring once on load and again
// whenever the header's bounding box changes keeps everything aligned
// without guess-work. Falls back to the CSS fallback values (60px desktop /
// 50px mobile) if the header element isn't found.
function updateHeaderHeightVar() {
    const header = document.querySelector('header');
    if (!header) return;
    const h = Math.round(header.getBoundingClientRect().height);
    if (h > 0) {
        document.documentElement.style.setProperty('--header-h', h + 'px');
    }
}
// rAF coalesce so rapid fire resize events don't thrash layout.
let _headerMeasurePending = false;
function scheduleHeaderMeasure() {
    if (_headerMeasurePending) return;
    _headerMeasurePending = true;
    requestAnimationFrame(() => {
        _headerMeasurePending = false;
        updateHeaderHeightVar();
    });
}

document.addEventListener("DOMContentLoaded",()=>{
    updateHeaderHeightVar();

    // Admin/demo convenience: ?resetWelcome=1 in the URL clears ONLY the
    // welcome-dismissed flag (not favorites or affiliation), letting the
    // banner resurface without losing real user state. Appended silently
    // via history.replaceState so the URL bar stays clean.
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.has('resetWelcome')) {
            localStorage.removeItem('welcomeDismissed');
            params.delete('resetWelcome');
            const cleanSearch = params.toString();
            const newUrl = window.location.pathname + (cleanSearch ? '?' + cleanSearch : '') + window.location.hash;
            history.replaceState(null, '', newUrl);
        }
    } catch (_) { /* no URL params support → skip */ }

    // Show welcome banner IMMEDIATELY if this is a first-time visitor.
    // We previously only set banner visibility in renderHomeFeed(), which
    // runs after ~9 concurrent data fetches settle — producing a 2-5 second
    // window where the page is visible but the banner isn't, making new
    // visitors think it doesn't exist. Since the show/hide condition only
    // reads localStorage, there's no reason to wait for remote data.
    try {
        const hasFeed = !!localStorage.getItem(FEED_KEY);
        const dismissed = !!localStorage.getItem('welcomeDismissed');
        if (!hasFeed && !dismissed) {
            const wb = document.getElementById('welcome-banner');
            if (wb) wb.style.display = 'block';
        }
    } catch (_) { /* localStorage blocked → banner stays hidden, no-op */ }

    initApp();

    // Re-measure on viewport resize (covers mobile→desktop breakpoint flips
    // where the header's content swaps between hamburger and nav buttons).
    window.addEventListener('resize', scheduleHeaderMeasure);

    // Re-measure when web fonts finish loading — text-driven heights can
    // shift a pixel or two after font swap.
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(updateHeaderHeightVar);
    }

    // Re-measure whenever the header's own size changes. Catches async
    // widget loads (e.g., the Ecwid cart widget initializing after script
    // download) that would otherwise silently break the sticky offset.
    if (typeof ResizeObserver !== 'undefined') {
        const header = document.querySelector('header');
        if (header) new ResizeObserver(scheduleHeaderMeasure).observe(header);
    }
});

// Keyboard shortcuts: Left/Right arrows navigate weeks when on Events or Sports pages
document.addEventListener('keydown', (e) => {
    // Ignore if user is typing in an input/textarea/contenteditable
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    // Ignore if any modifier keys are held (don't hijack browser shortcuts)
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    // Ignore if a modal/overlay is open
    if (document.getElementById('search-overlay') || document.getElementById('feed-settings-overlay')) return;

    const eventsView = document.getElementById('view-events');
    const sportsView = document.getElementById('view-sports');
    const onEvents = eventsView && eventsView.classList.contains('active');
    const onSports = sportsView && sportsView.classList.contains('active');
    if (!onEvents && !onSports) return;

    // Arrow-key navigation used to step through weeks. With day-grouped infinite scroll
    // that concept is gone, so arrows are no longer bound. Left as a hook for future use.
});

async function initApp(){
    loadFeedPrefs();
    await Promise.allSettled([loadWeather(),loadSpecials(),loadEvents(),loadPlaces(),loadHousing(),loadNews(),loadBoard(),loadSponsors(),loadClubsDirectory()]);
    renderHomeFeed();
    syncFilterArrows();
    loadEcwidStore(); // Load Ecwid early so cart widget renders in header
    setInterval(refreshCam,60000); refreshCam();
    // Route to correct view based on URL
    let p=window.location.pathname.replace(/\/$/,'');
    // Handle 404.html redirect: ?p=/sports → /sports
    const params=new URLSearchParams(window.location.search);
    if(params.has('p')){
        p=params.get('p').replace(/\/$/,'');
        history.replaceState(null,'',p);
    }
    let view=pathToView[p]||'home';
    // Redirect old /housing URL to services with Housing filter
    if(p==='/housing'){ view='places'; history.replaceState(null,'','/places'); }
    switchView(view,true);
    if(p==='/housing'){ setTimeout(()=>{ const btn=document.querySelector('#svc-filter-group .src-btn:nth-child(2)'); if(btn) btn.click(); },500); }
}

// Handle browser back/forward
window.addEventListener('popstate',function(){
    const p=window.location.pathname.replace(/\/$/,'');
    const view=pathToView[p]||'home';
    switchView(view,true);
});

window.toggleMobileMenu=function(){
    if(window.innerWidth>768) return;
    const nav=document.getElementById('top-nav'), overlay=document.getElementById('menu-overlay');
    if(nav.classList.contains('open')){nav.classList.remove('open');overlay.classList.remove('open');setTimeout(()=>{if(!nav.classList.contains('open'))nav.style.display='';},300);}
    else{nav.style.display='flex';void nav.offsetWidth;nav.classList.add('open');overlay.classList.add('open');}
};
const viewLabels={home:'',news:'/ News',events:'/ Events',sports:'/ Sports',places:'/ Places',board:'/ Board',weather:'/ Weather',store:'/ Store',advertise:'/ Advertise'};

let ecwidLoaded = false;
function loadEcwidStore(){
    if(ecwidLoaded) return;
    ecwidLoaded = true;
    const s = document.createElement('script');
    s.setAttribute('data-cfasync','false');
    s.src = 'https://app.shopsettings.com/script.js?128927005&data_platform=code&data_date=2026-04-08';
    s.charset = 'utf-8';
    s.onload = function(){
        if(typeof xProductBrowser === 'function'){
            xProductBrowser("categoriesPerRow=3","views=grid(20,3) list(60) table(60)","categoryView=grid","searchView=list","id=my-store-128927005");
        }
        if(typeof Ecwid !== 'undefined'){
            Ecwid.init();
            Ecwid.OnPageLoaded.add(function(){
                injectEcwidCSS();
                // Kill Mailchimp/newsletter popups (they use Shadow DOM so we must remove the wrapper)
                function killPopups(){
                    document.querySelectorAll('.mcforms-wrapper, [id^="mcforms-"], [id*="PopupSignup"], [class*="mailchimp"], [class*="mc-banner"], [class*="mc-modal"]').forEach(el => el.remove());
                }
                killPopups();
                setTimeout(killPopups, 500);
                setTimeout(killPopups, 1500);
                setTimeout(killPopups, 3000);
                setTimeout(killPopups, 6000);
                setTimeout(killPopups, 10000);
                // Persistent watcher in case they inject late
                new MutationObserver(function(mutations){
                    for(const m of mutations){
                        for(const n of m.addedNodes){
                            if(n.nodeType===1 && (n.classList?.contains('mcforms-wrapper') || n.id?.startsWith('mcforms-'))){
                                n.remove();
                            }
                        }
                    }
                }).observe(document.body, { childList: true, subtree: true });
            });
            // Make cart widgets navigate to store page when clicked outside store
            document.querySelectorAll('.ec-cart-widget').forEach(function(w){
                w.addEventListener('click', function(){
                    const currentView = document.querySelector('.app-view.active');
                    if(currentView && currentView.id !== 'view-store'){
                        switchView('store');
                    }
                });
            });
        }
    };
    document.body.appendChild(s);
}

function injectEcwidCSS(){
    function resizeCategoryCards(){
        document.querySelectorAll('.grid-category').forEach(el => {
            el.style.maxWidth = '90px';
            el.style.flexBasis = '90px';
        });
        // Let images fill naturally inside the constrained card (matches source site)
        document.querySelectorAll('.grid-category__image-spacer').forEach(el => {
            el.style.paddingBottom = '0';
            el.style.height = '60px';
        });
        document.querySelectorAll('.grid-category__image-spacer-inner').forEach(el => {
            el.style.paddingBottom = '0';
        });
        document.querySelectorAll('.grid-category__shadow-inner').forEach(el => {
            el.style.fontSize = '0.7rem';
        });
    }
    resizeCategoryCards();
    setTimeout(resizeCategoryCards, 1000);
    setTimeout(resizeCategoryCards, 3000);
    setTimeout(resizeCategoryCards, 5000);

    const storeEl = document.getElementById('my-store-128927005');
    if(storeEl){
        const observer = new MutationObserver(function(){ resizeCategoryCards(); });
        observer.observe(storeEl, { childList: true, subtree: true });
    }
}

window.switchView=function(view,skipPush){
    document.querySelectorAll('.app-view').forEach(v=>v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    document.querySelectorAll('.nav-link').forEach(b=>b.classList.remove('active'));
    const btn=document.getElementById(`nav-${view}`); if(btn) btn.classList.add('active');
    const titleEl=document.getElementById('header-page-title');
    if(titleEl) titleEl.textContent=viewLabels[view]||'';
    window.scrollTo(0,0);
    const path=viewPaths[view]||'/';
    if(!skipPush && window.location.pathname.replace(/\/$/,'')!==path){
        history.pushState({view},'',path);
    }
    // Track SPA page view in Google Analytics
    if(typeof gtag === 'function'){
        gtag('event', 'page_view', { page_path: path, page_title: 'Millersville.APP ' + (viewLabels[view]||'') });
    }
    // Lazy-load Ecwid when store is first visited
    if(view==='store') loadEcwidStore();
};

async function loadEvents(){
    try{const res=await fetch('events.json'); if(!res.ok) return;
    allEvents=await res.json();
    // Pre-parse date strings to millisecond timestamps once, attached as
    // _dateMs. Filter and sort hot paths reference _dateMs instead of
    // calling `new Date(e.date)` (which allocates a Date and reparses the
    // string each time). With ~1200 events, a single render's filter+sort
    // would otherwise allocate 2000+ Date objects; this caches them once at
    // load. NaN/invalid dates fall to 0 — safer than throwing in a sort
    // comparator. Display code still uses `new Date(e.date)` since locale
    // formatting needs the Date object, not just a timestamp.
    for (const ev of allEvents) {
        const t = new Date(ev.date).getTime();
        ev._dateMs = isNaN(t) ? 0 : t;
    }
    allEvents.sort((a, b) => a._dateMs - b._dateMs);
    renderEvents(); renderSports();
    if (currentNews.length > 0) renderNewsUI();
    decorateFeedStars();
    // Inject schema.org Event structured data for the next ~20 upcoming public
    // events. Helps Google, Bing, and social-media crawlers understand what's
    // scheduled. Runs once per load — enough for SEO discovery.
    if (typeof emitEventsStructuredData === 'function') emitEventsStructuredData();
    // Load sibling meta for the "last updated" indicator. Failing quietly is fine —
    // the file may not exist on first deploy before the scraper has run.
    try {
        const metaRes = await fetch('events-meta.json', { cache: 'no-store' });
        if (metaRes.ok) {
            const meta = await metaRes.json();
            renderLastUpdated(meta.generatedAt);
        }
    } catch (_) { /* silent */ }
    }catch(e){console.error('Events load error:',e);}
}

// Emit schema.org Event JSON-LD for upcoming public events. We skip student-
// only (mu-only) content since that's irrelevant to general web search, and
// we cap at 20 to keep the payload reasonable. Google's Event rich results
// require: @type, name, startDate, location (with @type Place + name). We
// also include endDate (estimated) and eventStatus, which are recommended.
function emitEventsStructuredData() {
    try {
        // Remove any prior injection — avoids duplicates if called twice.
        const prior = document.getElementById('mapp-events-ld');
        if (prior) prior.remove();

        const now = new Date();
        const nowMs = now.getTime();
        const upcoming = (allEvents || [])
            .filter(e => {
                if (!e.date || (e._dateMs || 0) < nowMs) return false;
                // Public-facing only: skip mu-student-only content and
                // GetInvolved-internal events (not useful for townie web
                // searchers, and mostly require MU credentials anyway).
                if (e.audience === 'mu-only') return false;
                if ((e.tags || []).includes('Clubs/Orgs') && e.audience !== 'public') return false;
                return true;
            })
            .slice(0, 20);
        if (upcoming.length === 0) return;

        const cleanLoc = (loc) => {
            if (!loc) return 'Millersville, PA';
            return loc.replace(/^\s+|\s+$/g, '').substring(0, 200);
        };

        const ldArray = upcoming.map(e => {
            const d = new Date(e.date);
            // End time: most of our events don't have an explicit end; assume
            // 2 hours for events, 3 for sport games. Schema.org accepts this
            // and it's closer to reality than omitting endDate entirely.
            const tags = e.tags || [];
            const isSport = tags.includes('Athletics') || tags.includes('Athletic Competitions');
            const endD = new Date(d.getTime() + (isSport ? 3 : 2) * 60 * 60 * 1000);
            const item = {
                "@context": "https://schema.org",
                "@type": "Event",
                "name": e.title || 'Millersville event',
                "startDate": d.toISOString(),
                "endDate": endD.toISOString(),
                "eventStatus": "https://schema.org/EventScheduled",
                "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
                "location": {
                    "@type": "Place",
                    "name": cleanLoc(e.location),
                    "address": {
                        "@type": "PostalAddress",
                        "addressLocality": "Millersville",
                        "addressRegion": "PA",
                        "addressCountry": "US"
                    }
                }
            };
            if (e.description) {
                // Google allows up to ~500 chars for description in rich
                // results. Strip any HTML that may have leaked in.
                item.description = e.description.replace(/<[^>]+>/g, '').substring(0, 500);
            }
            if (e.image) item.image = [e.image];
            if (e.ticketLink) {
                item.offers = {
                    "@type": "Offer",
                    "url": e.ticketLink,
                    "availability": "https://schema.org/InStock"
                };
                if (e.price && e.price.toLowerCase() !== 'free') {
                    // Only set price if we have numeric extraction from "$X";
                    // pure strings like "Free entry" or "Members only" get
                    // skipped to avoid schema validation warnings.
                    const priceNum = (e.price.match(/\$?([\d.]+)/) || [])[1];
                    if (priceNum) {
                        item.offers.price = priceNum;
                        item.offers.priceCurrency = "USD";
                    }
                } else {
                    item.offers.price = "0";
                    item.offers.priceCurrency = "USD";
                }
            }
            if (e.sourceLink) item.url = e.sourceLink;
            return item;
        });

        const script = document.createElement('script');
        script.id = 'mapp-events-ld';
        script.type = 'application/ld+json';
        script.textContent = JSON.stringify(ldArray);
        document.head.appendChild(script);
    } catch (err) {
        // SEO injection is informational — never break the app if it fails.
        console.warn('Structured data injection failed:', err);
    }
}

// Render the homepage's "updated X ago" line. Reads from the scraper-written
// events-meta.json. The threshold for calling it "stale" is 3 hours — our cron runs
// hourly, so anything past 3 hours means 2+ consecutive runs failed.
function renderLastUpdated(iso) {
    if (!iso) return;
    const then = new Date(iso);
    if (isNaN(then)) return;
    const now = new Date();
    const diffMin = Math.max(0, Math.round((now - then) / 60000));
    let label;
    if (diffMin < 2) label = 'Just updated';
    else if (diffMin < 60) label = `Updated ${diffMin} min ago`;
    else if (diffMin < 120) label = 'Updated 1 hour ago';
    else if (diffMin < 24 * 60) label = `Updated ${Math.floor(diffMin / 60)} hours ago`;
    else label = `Updated ${Math.floor(diffMin / (24 * 60))} days ago`;
    const stale = diffMin > 180;
    const suffix = stale ? ' ⚠️' : '';
    // Home page pill — only on home view, top-of-feed position
    const homeEl = document.getElementById('home-last-updated');
    if (homeEl) {
        homeEl.textContent = label + suffix;
        homeEl.classList.toggle('stale', stale);
        homeEl.style.display = 'block';
    }
    // Footer — visible across all views, dimmer styling
    const footerEl = document.getElementById('footer-last-updated');
    if (footerEl) {
        footerEl.textContent = label + suffix;
        footerEl.classList.toggle('stale', stale);
    }
}

/* ==================== EVENTS PAGE ==================== */
window.setEventSourceAll=function(){
    evAllMode = true;
    evActiveSources = new Set(allEvSources);
    evTags.clear();
    updateEventsUI();
    renderEvents();
};
window.toggleEventSource=function(src){
    evAllMode = false;
    if (evActiveSources.size === allEvSources.length && allEvSources.every(s => evActiveSources.has(s))) {
        evActiveSources = new Set([src]);
    } else {
        if(evActiveSources.has(src)) evActiveSources.delete(src);
        else evActiveSources.add(src);
    }
    // All mode activates when all VISIBLE sources are selected (affiliation can hide PM/Borough)
    const visibleEvSources = allEvSources.filter(s =>
        !(s === 'PM' && isSourceHidden('PM')) &&
        !(s === 'Borough' && isSourceHidden('Borough'))
    );
    if (visibleEvSources.length > 0 && visibleEvSources.every(s => evActiveSources.has(s))) {
        evAllMode = true;
        // Ensure hidden sources are also in the set so filter logic stays consistent
        evActiveSources = new Set(allEvSources);
    }
    evTags.clear();
    updateEventsUI();
    renderEvents();
};
function updateEventsUI(){
    const allBtn = document.getElementById('ev-src-all');
    if (allBtn) allBtn.classList.toggle('active', evAllMode);
    const srcMap = {'MU':'mu','PM':'pm','Borough':'borough','Other':'other'};
    allEvSources.forEach(src => {
        const btn = document.getElementById('ev-src-' + srcMap[src]);
        if (!btn) return;
        btn.classList.toggle('active', !evAllMode && evActiveSources.has(src));
        // Hide pills for sources the user's affiliation doesn't care about (unless they've favorited them)
        //   PM pill hidden for Marauders unless they favorited a PM item
        //   Borough pill hidden for Marauders unless they favorited Borough content
        //   Other pill is NOT hidden — it contains VFW + Phantom Power + Community; keeping it
        //   visible preserves Phantom Power visibility for Marauders (Phantom Power is a campus
        //   event venue). We filter VFW out at the event level via isEventFromHiddenSource.
        let hidePill = false;
        if (src === 'PM') hidePill = isSourceHidden('PM');
        else if (src === 'Borough') hidePill = isSourceHidden('Borough');
        btn.style.display = hidePill ? 'none' : '';
    });

    // Toolbar toggle swap based on affiliation:
    //   Townies (default) → show 👨‍👩‍👧 family toggle; hide 🍕/🎁 perks
    //   Marauder (default) → hide family toggle; show 🍕 Free Food + 🎁 Free Stuff
    //   Townie → show 👨‍👩‍👧 family toggle; hide perk toggles
    const kidBtn = document.getElementById('ev-kid-toggle');
    const foodBtn = document.getElementById('ev-freefood-toggle');
    const stuffBtn = document.getElementById('ev-freestuff-toggle');
    const isTownie = muAffiliation === 'townie';  // unset treated as Marauder for toolbar
    if (kidBtn) kidBtn.style.display = isTownie ? '' : 'none';
    if (foodBtn) foodBtn.style.display = isTownie ? 'none' : '';
    if (stuffBtn) stuffBtn.style.display = isTownie ? 'none' : '';
    // If affiliation changed to Townie, clear any stale perk-toggle state
    if (isTownie && (evFreeFoodMode || evFreeStuffMode)) {
        evFreeFoodMode = false; evFreeStuffMode = false;
        if (foodBtn) foodBtn.classList.remove('active');
        if (stuffBtn) stuffBtn.classList.remove('active');
    }
    // And similarly: non-townie shouldn't have an active kid-mode filter
    if (!isTownie && evKidMode) {
        evKidMode = false;
        if (kidBtn) kidBtn.classList.remove('active');
    }

    // "Clean state" for the clear-filters button: all sources on, no tag/kid/perk filters,
    // default scroll window (60 days). Week/anchor concept is retired.
    const isClean = evAllMode && evTags.size === 0 && !evKidMode && !evFreeFoodMode && !evFreeStuffMode && !evFavOnlyMode && evDaysVisible === INITIAL_DAYS;
    document.getElementById('ev-clear-btn').style.visibility = isClean ? 'hidden' : 'visible';

    // Refresh sub-category chip row so it matches the currently-active source
    renderEvSubFilters();
}
// Render sub-category filter chips under the source row. Shows subs for whichever
// top-level source is currently active (MU, PM, etc.). Clicking a sub chip toggles it
// in `evTags`, which the event filter uses to narrow down by sub-type (e.g. "Greek Life",
// "Music/Arts"). No-ops when multiple sources are active or when the active source has
// no sub-map entry (Borough and Other don't have sub-filters).
function renderEvSubFilters(){
    const c = document.getElementById('ev-sub-container');
    if (!c) return;
    c.innerHTML = '';
    c.classList.remove('active');

    // Only show sub-filters when exactly one source is active and it has a sub-map entry.
    if (evAllMode || evActiveSources.size !== 1) return;
    const src = Array.from(evActiveSources)[0];
    const subs = getEvSubMap()[src];
    if (!subs || subs.length === 0) return;

    c.classList.add('active');
    c.innerHTML = subs.map(sub => {
        // Entries can be strings (label === tag) or { label, tag } objects for the townie-
        // friendly "Community" relabel where display differs from the underlying filter tag.
        const label = typeof sub === 'string' ? sub : sub.label;
        const tag = typeof sub === 'string' ? sub : sub.tag;
        const active = evTags.has(tag);
        return `<button class="sub-tag-btn${active ? ' active' : ''}" onclick="toggleEventSub('${tag.replace(/'/g, "\\'")}')">${label}</button>`;
    }).join('');
}
// Toggle a sub-category tag on/off
window.toggleEventSub = function(tag){
    if (evTags.has(tag)) evTags.delete(tag);
    else evTags.add(tag);
    renderEvSubFilters();
    renderEvents();
};
window.setEvMode = function(){};
// Legacy no-op stubs — the Events/Sports toolbars no longer have prev/next nav
// since the day-grouped infinite-scroll replaces week-paging. Kept so any stale
// onclick handlers or external callers don't throw.
window.evNavPrev = function(){};
window.evNavNext = function(){};
window.toggleKidFriendly=function(){
    evKidMode=!evKidMode;
    document.getElementById('ev-kid-toggle').classList.toggle('active',evKidMode);
    updateEventsUI();
    renderEvents();
};
window.toggleFreeFood=function(){
    evFreeFoodMode=!evFreeFoodMode;
    document.getElementById('ev-freefood-toggle').classList.toggle('active',evFreeFoodMode);
    updateEventsUI();
    renderEvents();
};
window.toggleFreeStuff=function(){
    evFreeStuffMode=!evFreeStuffMode;
    document.getElementById('ev-freestuff-toggle').classList.toggle('active',evFreeStuffMode);
    updateEventsUI();
    renderEvents();
};
window.clearEventFilters=function(){
    evTags.clear(); evAllMode=true; evActiveSources=new Set(allEvSources);
    evKidMode=false; evFreeFoodMode=false; evFreeStuffMode=false;
    evFavOnlyMode=false;
    evDaysVisible = INITIAL_DAYS;
    document.getElementById('ev-kid-toggle').classList.remove('active');
    const ff=document.getElementById('ev-freefood-toggle');
    const fs=document.getElementById('ev-freestuff-toggle');
    if(ff) ff.classList.remove('active');
    if(fs) fs.classList.remove('active');
    updateEventsUI();
    renderEvents();
    // Scroll to top so the user sees the reset fresh state
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Collapsible filter toggles
window.toggleEvFilters=function(){
    const wrap = document.getElementById('ev-filters-wrap');
    const arrow = document.getElementById('ev-filter-arrow');
    const isVisible = getComputedStyle(wrap).display !== 'none';
    wrap.style.display = isVisible ? 'none' : 'block';
    arrow.textContent = isVisible ? '▸' : '▾';
};
window.toggleSpFilters=function(){
    const wrap = document.getElementById('sp-filters-wrap');
    const arrow = document.getElementById('sp-filter-arrow');
    const isVisible = getComputedStyle(wrap).display !== 'none';
    wrap.style.display = isVisible ? 'none' : 'block';
    arrow.textContent = isVisible ? '▸' : '▾';
};
// Sync filter arrows on load (mobile defaults to collapsed via CSS)
function syncFilterArrows(){
    ['ev','sp'].forEach(p => {
        const wrap = document.getElementById(p+'-filters-wrap');
        const arrow = document.getElementById(p+'-filter-arrow');
        if(wrap && arrow) arrow.textContent = getComputedStyle(wrap).display === 'none' ? '▸' : '▾';
    });
}

// Favorites tip — one-time toast notification
function showFavTipToast(){
    if (localStorage.getItem('favTipShown')) return;
    if (feedPrefs && feedPrefs.length > 0) return;
    const toast = document.createElement('div');
    toast.className = 'fav-toast';
    toast.innerHTML = '★ <strong>Tip:</strong> Double-tap any source button to add it to your favorites';
    toast.onclick = function(){ toast.remove(); };
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('fav-toast-visible'), 100);
    setTimeout(() => { toast.classList.remove('fav-toast-visible'); setTimeout(() => toast.remove(), 400); }, 5000);
    localStorage.setItem('favTipShown', '1');
}

// ===== Day grouping helpers =====
// Format a Date as a friendly header label: "Today" / "Tomorrow" / "Thu, Apr 23"
function formatDayHeader(d) {
    const today = todayMidnight();
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((target - today) / (1000 * 60 * 60 * 24));
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Group a flat sorted list of events into [{dateKey, dateObj, events: [...]}, ...]
// Preserves the caller's sort order within each day.
function groupEventsByDay(events) {
    const groups = new Map();
    for (const e of events) {
        const d = new Date(e.date);
        const key = toDateStr(d); // YYYY-MM-DD
        if (!groups.has(key)) {
            groups.set(key, { dateKey: key, dateObj: new Date(d.getFullYear(), d.getMonth(), d.getDate()), events: [] });
        }
        groups.get(key).events.push(e);
    }
    return [...groups.values()];
}

// Build HTML for a single day group: a sticky header + its card list
function buildDayGroupHTML(group, buildCard) {
    const todayStr = toDateStr(todayMidnight());
    const isToday = group.dateKey === todayStr;
    const label = formatDayHeader(group.dateObj);
    const count = group.events.length;
    const plural = count === 1 ? 'event' : 'events';
    return `<div class="day-group-header${isToday ? ' today' : ''}">${label}<span class="day-count">${count} ${plural}</span></div>`
        + group.events.map(e => buildCard(e)).join('');
}

// Render N skeleton cards as a loading placeholder. Layout mimics the real
// .app-card so the visual shift on data arrival is minimal. Each card has
// a title bar, two metadata rows, and a tag row — the shimmer animation
// is pure CSS (.skel-bar class), no JS animation loops.
function renderSkeletonCards(n) {
    const card = `<div class="app-card card-skeleton" aria-hidden="true">
        <div class="card-body">
            <div class="card-heading"><span class="skel-bar" style="width:30px;height:30px;border-radius:50%;flex-shrink:0;"></span><span class="skel-bar" style="height:18px;flex:1;"></span></div>
            <span class="skel-bar" style="display:block;width:60%;height:14px;margin:6px 0;"></span>
            <span class="skel-bar" style="display:block;width:75%;height:14px;margin:6px 0 10px;"></span>
            <div style="display:flex;gap:6px;"><span class="skel-bar" style="width:50px;height:18px;border-radius:10px;"></span><span class="skel-bar" style="width:80px;height:18px;border-radius:10px;"></span></div>
        </div>
    </div>`;
    return card.repeat(n);
}

function renderEvents(){
    updateEventsUI();
    const container = document.getElementById('ev-events-container');
    // Loading state: events.json hasn't returned yet. Render 4 skeleton cards
    // so the page doesn't flash empty before content arrives. Once allEvents
    // populates, loadEvents triggers another renderEvents() which replaces
    // these. Empty allEvents after load is a different state (no events at
    // all) — we can't distinguish here, but realistically allEvents.length
    // is always >0 in production, so skeletons only show during fetch.
    if (!allEvents || allEvents.length === 0) {
        container.innerHTML = renderSkeletonCards(4);
        return;
    }
    if (evActiveSources.size === 0) {
        container.innerHTML = '<p class="empty-state">Select a source to view events.</p>';
        return;
    }

    // Infinite-scroll window: today through today+evDaysVisible
    const today = todayMidnight();
    const rangeStart = toDateStr(today);
    const rangeEnd = toDateStr(addDays(today, evDaysVisible));

    // Build the filter predicate once so we can reuse it when counting "beyond" events
    const filterEvent = (e) => {
        if (isSportEvent(e)) return false;
        if (isPMSportByTitle(e)) return false;
        if (isHiddenForTownie(e)) return false;
        if (isEventFromHiddenSource(e)) return false;
        const tags = e.tags || [];
        if (!Array.from(evActiveSources).some(src => matchesSource(tags, src))) return false;
        // Sub-tag filter uses OR semantics: an event matches if it has ANY of the
        // selected sub-tags. Previously this was AND (every tag must match) which felt
        // like the filter was "narrowing" beyond what users expected — they think of
        // sub-chips as additive ("show me Greek Life AND Fundraising events") and expect
        // the list to grow, not shrink.
        if (evTags.size > 0 && !Array.from(evTags).some(t => tags.includes(t))) return false;
        if (evKidMode && !e.kidFriendly) return false;
        if (evFreeFoodMode || evFreeStuffMode) {
            const benefits = e.benefits || [];
            const hasFood = benefits.includes('Free Food');
            const hasStuff = benefits.includes('Free Stuff');
            if (evFreeFoodMode && evFreeStuffMode) { if (!hasFood && !hasStuff) return false; }
            else if (evFreeFoodMode && !hasFood) return false;
            else if (evFreeStuffMode && !hasStuff) return false;
        }
        return true;
    };

    const allMatching = allEvents.filter(filterEvent);
    // Visible window (today + next N days)
    const filtered = allMatching.filter(e => {
        const d = localDateStr(e.date);
        return d >= rangeStart && d <= rangeEnd;
    });
    // Count of events beyond the window (to decide whether to show "Load more")
    const beyondCount = allMatching.filter(e => localDateStr(e.date) > rangeEnd).length;

    if (filtered.length === 0) {
        // Build a contextual empty-state message based on what's actively filtering.
        // We lead with the MOST restrictive-seeming filter so users understand why nothing shows.
        const activeTags = Array.from(evTags);
        const activeSources = Array.from(evActiveSources);
        const sourceLabel = activeSources.length <= 2 ? activeSources.join(', ') : activeSources.length + ' sources';
        const windowText = 'next ' + evDaysVisible + ' days';
        let msg, hint = '';
        if (evKidMode) {
            msg = '👨‍👩‍👧 No family-friendly events coming up in the ' + windowText + '.';
            hint = 'Try turning off the family filter, or loading more days.';
        } else if (evFreeFoodMode && evFreeStuffMode) {
            msg = '🍕🎁 No free food or free stuff events coming up.';
            hint = 'Try turning off one or both perk filters.';
        } else if (evFreeFoodMode) {
            msg = '🍕 No free food events coming up in the ' + windowText + '.';
            hint = 'Try turning off the free food filter.';
        } else if (evFreeStuffMode) {
            msg = '🎁 No free stuff events coming up in the ' + windowText + '.';
            hint = 'Try turning off the free stuff filter.';
        } else if (activeTags.length > 0 && !evAllMode) {
            msg = 'No events matching "' + activeTags.join(', ') + '" from ' + sourceLabel + ' in the ' + windowText + '.';
            hint = 'Try clearing your filters or adding more sources.';
        } else if (activeTags.length > 0) {
            msg = 'No events matching "' + activeTags.join(', ') + '" in the ' + windowText + '.';
            hint = 'Try clearing the filter tags.';
        } else if (!evAllMode) {
            msg = 'No events from ' + sourceLabel + ' in the ' + windowText + '.';
            hint = 'Try adding more sources or loading more days.';
        } else {
            msg = 'Nothing scheduled in the ' + windowText + '.';
            hint = beyondCount > 0 ? 'There are more events further out.' : 'Check back later — new events come in hourly.';
        }
        let html = '<div class="empty-state"><p>' + msg + '</p><p style="font-size:0.82rem;color:var(--text-muted);margin-top:4px;">' + hint + '</p>';
        // Offer a one-click clear button when any filter is active (other than just the default window)
        const anyFilterActive = evKidMode || evFreeFoodMode || evFreeStuffMode || activeTags.length > 0 || !evAllMode || evFavOnlyMode;
        if (anyFilterActive) {
            html += '<button class="btn btn-sm btn-outline" onclick="clearEventFilters()" style="margin-top:10px;">Clear all filters</button>';
        }
        html += '</div>';
        if (beyondCount > 0) html += '<button class="load-more-btn" onclick="evLoadMore()">Load more events (' + beyondCount + ' more available)</button>';
        container.innerHTML = html;
        return;
    }

    // Favorites UX: toolbar ⭐ Favs button is shown when user has event favorites.
    // Favorited cards get a gold border (.card-fav via buildEventCard) so they stand out
    // in their natural day group. When fav-only mode is active, the list narrows to favorites.
    const hasAnyPrefs = feedPrefs && feedPrefs.length > 0;
    const hasEventPrefs = hasAnyPrefs && feedPrefs.some(p => eventFeedIds.has(p) || p.startsWith('club:'));
    const favCount = hasEventPrefs ? allMatching.filter(e => eventMatchesFeed(e)).length : 0;

    // Show/hide toolbar fav button based on whether user has any event favorites
    const favBtn = document.getElementById('ev-fav-toggle');
    if (favBtn) {
        favBtn.style.display = (hasEventPrefs && favCount > 0) ? '' : 'none';
        favBtn.classList.toggle('active', evFavOnlyMode);
        favBtn.title = evFavOnlyMode ? 'Showing favorites only — tap to show all' : 'Jump to your favorites (' + favCount + ')';
    }

    let html = '';
    let dayItems = filtered;

    // Setup hint (shown only when user has no prefs at all — not a filter chip, just guidance)
    if (!hasAnyPrefs) {
        html += '<div class="feed-setup-hint">⚙️ <a href="#" onclick="event.preventDefault();openFeedSettings();">Set up your favorites</a> to highlight your preferred events</div>';
    } else if (hasAnyPrefs && !hasEventPrefs) {
        html += '<div class="feed-setup-hint">No event favorites set — <a href="#" onclick="event.preventDefault();openFeedSettings();">add some</a> to highlight them here</div>';
    }

    // If favorites-only mode is on, narrow the list to favorites
    if (evFavOnlyMode && hasEventPrefs) {
        dayItems = filtered.filter(e => eventMatchesFeed(e));
        if (dayItems.length === 0) {
            html += '<p class="empty-state">No upcoming favorites in the next ' + evDaysVisible + ' days. <a href="#" onclick="event.preventDefault();evToggleFavOnly();">Show all events</a></p>';
            if (beyondCount > 0) html += '<button class="load-more-btn" onclick="evLoadMore()">Load more (' + beyondCount + ' more events)</button>';
            container.innerHTML = html;
            if (typeof refreshDayLabels === 'function') refreshDayLabels();
            return;
        }
    }

    // Day-grouped render
    const groups = groupEventsByDay(dayItems);
    html += groups.map(g => buildDayGroupHTML(g, e => buildEventCard(e, false))).join('');

    // Load more / footer note
    if (beyondCount > 0) {
        html += '<button class="load-more-btn" onclick="evLoadMore()">Load more events (' + beyondCount + ' more available)</button>';
    } else {
        html += '<div class="load-more-note">That\'s all scheduled events 👋</div>';
    }

    container.innerHTML = html;
    injectInlineAds('ev-events-container','events');
    if (typeof refreshDayLabels === 'function') refreshDayLabels();
}

// Load the next batch of future days on the Events page
window.evLoadMore = function() {
    evDaysVisible += LOAD_MORE_INCREMENT;
    renderEvents();
};

// Toggle favorites-only filter on Events
window.evToggleFavOnly = function() {
    evFavOnlyMode = !evFavOnlyMode;
    renderEvents();
    // Scroll to top so the user sees the filtered view from the beginning
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Scroll-to-today helper (clicking the toolbar date label jumps back to Today)
window.evScrollToToday = function() {
    const container = document.getElementById('ev-events-container');
    if (!container) return;
    const todayHeader = container.querySelector('.day-group-header.today') || container.querySelector('.day-group-header');
    if (todayHeader) {
        const stickyOffset = 140; // site header + sticky toolbar combined
        const top = todayHeader.getBoundingClientRect().top + window.scrollY - stickyOffset;
        window.scrollTo({ top, behavior: 'smooth' });
    } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
};
window.spScrollToToday = function() {
    const container = document.getElementById('sp-events-container');
    if (!container) return;
    const todayHeader = container.querySelector('.day-group-header.today') || container.querySelector('.day-group-header');
    if (todayHeader) {
        const stickyOffset = 140;
        const top = todayHeader.getBoundingClientRect().top + window.scrollY - stickyOffset;
        window.scrollTo({ top, behavior: 'smooth' });
    } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
};

// ===== Toolbar date label — updates as the user scrolls through day groups =====
// Tracks which day-group-header is nearest the top of the viewport and mirrors its
// label into the toolbar's #ev-current-day-label / #sp-current-day-label span.
// Uses a simple scroll listener rather than IntersectionObserver because the
// day groups are added/removed as "Load more" extends the list.
function updateCurrentDayLabel(pageKey) {
    const prefix = pageKey; // 'ev' or 'sp'
    const labelEl = document.getElementById(prefix + '-current-day-label');
    const container = document.getElementById(prefix + '-events-container');
    if (!labelEl || !container) return;
    const headers = container.querySelectorAll('.day-group-header');
    if (headers.length === 0) {
        labelEl.textContent = 'Today';
        return;
    }
    // Defensive bail-out: when called immediately after innerHTML assignment,
    // the browser hasn't laid out the new DOM yet and getBoundingClientRect()
    // returns top: 0 for every header. The loop below would then mark every
    // header as "above threshold" and `active` would advance to the LAST one,
    // showing e.g. "Wed, Jun 24" on the toolbar at first paint instead of
    // "Today". If we detect this state, default to the today-marked header
    // (or the first if no today-marked exists) and skip the scroll math.
    const firstRect = headers[0].getBoundingClientRect();
    const lastRect = headers[headers.length - 1].getBoundingClientRect();
    if (firstRect.top === 0 && lastRect.top === 0) {
        const todayHeader = container.querySelector('.day-group-header.today');
        const fallback = todayHeader || headers[0];
        labelEl.textContent = (fallback.childNodes[0] ? fallback.childNodes[0].textContent.trim() : fallback.textContent.trim()) || 'Today';
        return;
    }
    // "Active" header = the last one whose top has scrolled above the toolbar offset
    const offsetTop = 120; // ~ site header (50) + toolbar height (70)
    let active = headers[0];
    for (const h of headers) {
        const rect = h.getBoundingClientRect();
        if (rect.top <= offsetTop + 8) active = h;
        else break;
    }
    // Extract just the label (ignore the count span)
    const labelText = active.childNodes[0] ? active.childNodes[0].textContent.trim() : active.textContent.trim();
    if (labelEl.textContent !== labelText) labelEl.textContent = labelText;
}
// Throttle to once-per-animation-frame to avoid jank on scroll
let _dayLabelScrollPending = false;
window.addEventListener('scroll', () => {
    if (_dayLabelScrollPending) return;
    _dayLabelScrollPending = true;
    requestAnimationFrame(() => {
        _dayLabelScrollPending = false;
        // Only update for whichever view is active
        const eventsView = document.getElementById('view-events');
        const sportsView = document.getElementById('view-sports');
        if (eventsView && eventsView.classList.contains('active')) updateCurrentDayLabel('ev');
        else if (sportsView && sportsView.classList.contains('active')) updateCurrentDayLabel('sp');
    });
}, { passive: true });
// Also update after renders in case a filter changes what's at the top.
// Defer to next animation frame so the browser has a chance to lay out the
// freshly-rendered DOM — calling immediately after innerHTML returns
// getBoundingClientRect tops of 0 for everything (no layout yet), which
// makes the active-header loop pick the last header instead of the first.
function refreshDayLabels() {
    requestAnimationFrame(() => {
        updateCurrentDayLabel('ev');
        updateCurrentDayLabel('sp');
    });
}

/* ==================== SPORTS PAGE ==================== */

let spAllMode = true; // tracks if "All" is the active selection

window.setSportsSourceAll=function(btn){
    spAllMode = true;
    spActiveSources = new Set(['PM','MU','Clubs']);
    spSportTag = null;
    updateSportsUI();
    renderSports();
};

window.toggleSportsSource=function(src){
    spAllMode = false;
    // When switching from All, start fresh with just this source
    if (spActiveSources.size === 3 && spActiveSources.has('PM') && spActiveSources.has('MU') && spActiveSources.has('Clubs')) {
        spActiveSources = new Set([src]);
    } else {
        if(spActiveSources.has(src)) spActiveSources.delete(src);
        else spActiveSources.add(src);
    }
    // If all VISIBLE sources are active, switch to All mode.
    // We used to require all 3 hard-coded sources, but affiliation can hide PM (Marauders)
    // or Clubs (Townies) — so for those users, "all sources selected" means all visible ones.
    const visibleSources = ['PM','MU','Clubs'].filter(s =>
        !(s === 'PM' && isSourceHidden('SP_PM')) &&
        !(s === 'Clubs' && isSourceHidden('SP_Clubs'))
    );
    if (visibleSources.length > 0 && visibleSources.every(s => spActiveSources.has(s))) {
        spAllMode = true;
        // Ensure hidden sources are also in the set so event filter stays consistent
        spActiveSources = new Set(['PM','MU','Clubs']);
    }
    spSportTag=null;
    updateSportsUI();
    renderSports();
};

function updateSportsUI(){
    const allBtn = document.getElementById('sp-src-all');
    if (allBtn) allBtn.classList.toggle('active', spAllMode);
    ['PM','MU','Clubs'].forEach(src=>{
        const btn=document.getElementById('sp-src-'+src.toLowerCase());
        if(!btn) return;
        btn.classList.toggle('active', !spAllMode && spActiveSources.has(src));
        // Hide PM pill for Marauders (unless they favorited PM sports);
        // Hide Clubs pill for Townies (unless they favorited Club Sports)
        let hidePill = false;
        if (src === 'PM') hidePill = isSourceHidden('SP_PM');
        else if (src === 'Clubs') hidePill = isSourceHidden('SP_Clubs');
        btn.style.display = hidePill ? 'none' : '';
    });
    document.getElementById('hgame-toggle').classList.toggle('active', spHomeOnly);
    // Past button active state — highlighted when viewing past games
    const pastBtn = document.getElementById('sp-past-toggle');
    if (pastBtn) pastBtn.classList.toggle('active', spTimeView === 'past');
    document.getElementById('sp-no-source').style.display = spActiveSources.size===0 ? 'block' : 'none';
    // "Clean state" for the clear-filters button: all sources on, no tag filter, no home-only,
    // viewing the default Upcoming tab. (Day/week paging no longer exists.)
    const isClean = spAllMode && !spHomeOnly && !spSportTag && spTimeView === 'upcoming' && !spFavOnlyMode;
    document.getElementById('sp-clear-btn').style.visibility = isClean ? 'hidden' : 'visible';
}

// Legacy no-op stubs — Sports page uses Upcoming/Past tabs now, not week nav
window.setSpMode = function(){};
window.spNavPrev = function(){};
window.spNavNext = function(){};

window.toggleHomeGameMode=function(){
    spHomeOnly=!spHomeOnly;
    updateSportsUI();
    renderSports();
};
window.clearSportsFilters=function(){
    spSportTag=null; spHomeOnly=false; spAllMode=true;
    spActiveSources=new Set(['PM','MU','Clubs']);
    spTimeView='upcoming';
    spFavOnlyMode=false;
    spDaysVisible = INITIAL_DAYS;
    spPastDaysVisible = INITIAL_DAYS_PAST;
    // Past-toggle button's active class is refreshed by updateSportsUI below
    updateSportsUI();
    renderSports();
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

function renderSports(){
    // Loading state: events.json hasn't returned yet. Show skeletons in the
    // sports container so the page doesn't flash empty.
    if (!allEvents || allEvents.length === 0) {
        document.getElementById('sp-events-container').innerHTML = renderSkeletonCards(4);
        document.getElementById('sp-sport-tags').innerHTML = '';
        updateSportsUI();
        return;
    }
    if(spActiveSources.size===0){
        document.getElementById('sp-events-container').innerHTML='';
        document.getElementById('sp-sport-tags').innerHTML='';
        updateSportsUI();
        return;
    }

    updateSportsUI();

    const today = todayMidnight();
    const todayStr = toDateStr(today);
    const isPast = spTimeView === 'past';
    // Date window:
    //   upcoming: today through today+spDaysVisible
    //   past:     today-spPastDaysVisible through yesterday
    const daysN = isPast ? spPastDaysVisible : spDaysVisible;
    const rangeStart = isPast ? toDateStr(addDays(today, -daysN)) : todayStr;
    const rangeEnd   = isPast ? toDateStr(addDays(today, -1))     : toDateStr(addDays(today, daysN));

    // Base filter (source + hidden-affiliation + home-game toggle) — applied to BOTH counts & visible
    const filterSport = (e) => {
        if (!isSportEvent(e)) return false;
        if (isSportsEventFromHiddenSource(e)) return false;
        const tags = e.tags || [];
        if (!Array.from(spActiveSources).some(src => matchesSportSource(tags, src))) return false;
        if (spHomeOnly && !tags.includes('Home Game Mode') && !tags.includes('H Games')) return false;
        return true;
    };
    const allMatching = allEvents.filter(filterSport);

    // Sport-type tag row uses only the visible window's events (matches what the user sees)
    const windowMatching = allMatching.filter(e => {
        const d = localDateStr(e.date);
        return d >= rangeStart && d <= rangeEnd;
    });
    renderSportTypeTags(windowMatching);

    // Apply sport-type filter after the tag bar is rendered
    let filtered = spSportTag ? windowMatching.filter(e => (e.tags || []).includes(spSportTag)) : windowMatching;

    // Sort: past view newest-first (so "most recent" is at top); upcoming oldest-first
    filtered.sort((a, b) => isPast ? (b._dateMs - a._dateMs) : (a._dateMs - b._dateMs));

    // Count of events beyond the current window (for "Load more" label)
    let beyondCount = 0;
    if (isPast) {
        beyondCount = allMatching.filter(e => localDateStr(e.date) < rangeStart
            && (!spSportTag || (e.tags || []).includes(spSportTag))).length;
    } else {
        beyondCount = allMatching.filter(e => localDateStr(e.date) > rangeEnd
            && (!spSportTag || (e.tags || []).includes(spSportTag))).length;
    }

    const container = document.getElementById('sp-events-container');
    if (filtered.length === 0) {
        const sourceList = Array.from(spActiveSources);
        const sourceLabel = sourceList.length <= 2 ? sourceList.join(', ') : sourceList.length + ' sources';
        const windowText = isPast ? 'past ' + daysN + ' days' : 'next ' + daysN + ' days';
        let msg, hint = '';
        if (spHomeOnly && spSportTag) {
            msg = '🏠 No home ' + spSportTag.toLowerCase() + ' games ' + (isPast ? 'recently' : 'coming up') + '.';
            hint = 'Try turning off the home-only filter or picking a different sport.';
        } else if (spHomeOnly) {
            msg = '🏠 No home games in the ' + windowText + '.';
            hint = 'Try turning off the home-only filter.';
        } else if (spSportTag) {
            msg = 'No ' + spSportTag.toLowerCase() + ' games ' + (isPast ? 'recently' : 'coming up') + '.';
            hint = 'Try selecting a different sport, or clear the sport filter.';
        } else if (!spAllMode) {
            msg = 'No games from ' + sourceLabel + (isPast ? ' recently' : ' coming up') + '.';
            hint = 'Try adding more sources.';
        } else {
            msg = isPast ? 'No past games in the ' + windowText + '.' : 'Nothing scheduled in the ' + windowText + '.';
            hint = beyondCount > 0 ? 'There are more games further out.' : (isPast ? 'Past games stream in after they finish.' : 'Check back later — new games come in hourly.');
        }
        let html = '<div class="empty-state"><p>' + msg + '</p><p style="font-size:0.82rem;color:var(--text-muted);margin-top:4px;">' + hint + '</p>';
        const anyFilterActive = spHomeOnly || spSportTag || !spAllMode || spFavOnlyMode || spTimeView === 'past';
        if (anyFilterActive) {
            html += '<button class="btn btn-sm btn-outline" onclick="clearSportsFilters()" style="margin-top:10px;">Clear all filters</button>';
        }
        html += '</div>';
        if (beyondCount > 0) html += '<button class="load-more-btn" onclick="spLoadMore()">Load more games (' + beyondCount + ' more available)</button>';
        container.innerHTML = html;
        return;
    }

    // Favorites UX: toolbar ⭐ Favs button shown whenever user has sport favorites.
    // Works in both Upcoming and Past views — users can jump to past games of their
    // favorite teams to see scores, or upcoming games to see what's next.
    const hasAnyPrefs = feedPrefs && feedPrefs.length > 0;
    const hasSportPrefs = hasAnyPrefs && feedPrefs.some(p => sportFeedIds.has(p));
    const sportFavCount = hasSportPrefs ? allMatching.filter(e => eventMatchesFeed(e)).length : 0;

    const spFavBtn = document.getElementById('sp-fav-toggle');
    if (spFavBtn) {
        spFavBtn.style.display = (hasSportPrefs && sportFavCount > 0) ? '' : 'none';
        spFavBtn.classList.toggle('active', spFavOnlyMode);
        spFavBtn.title = spFavOnlyMode ? 'Showing favorites only — tap to show all' : 'Jump to your favorites (' + sportFavCount + ')';
    }

    let html = '';
    let dayItems = filtered;

    // Setup hints — shown in upcoming view only, since past view is more of a "check results"
    // mode where a fresh user wouldn't be configuring favorites.
    if (!isPast) {
        if (!hasAnyPrefs) {
            html += '<div class="feed-setup-hint">⚙️ <a href="#" onclick="event.preventDefault();openFeedSettings();">Set up your favorites</a> to highlight your preferred games</div>';
        } else if (hasAnyPrefs && !hasSportPrefs) {
            html += '<div class="feed-setup-hint">No sport favorites set — <a href="#" onclick="event.preventDefault();openFeedSettings();">add some</a> to highlight them here</div>';
        }
    }

    // Apply favorites-only filter in BOTH upcoming and past views
    if (spFavOnlyMode && hasSportPrefs) {
        dayItems = filtered.filter(e => eventMatchesFeed(e));
        if (dayItems.length === 0) {
            const timeLabel = isPast ? 'past ' + daysN + ' days' : 'next ' + daysN + ' days';
            const kindLabel = isPast ? 'past favorite games' : 'upcoming favorite games';
            html += '<p class="empty-state">No ' + kindLabel + ' in the ' + timeLabel + '. <a href="#" onclick="event.preventDefault();spToggleFavOnly();">Show all games</a></p>';
            if (beyondCount > 0) html += '<button class="load-more-btn" onclick="spLoadMore()">Load more (' + beyondCount + ' more games)</button>';
            container.innerHTML = html;
            if (typeof refreshDayLabels === 'function') refreshDayLabels();
            return;
        }
    }

    // Day-grouped render
    const groups = groupEventsByDay(dayItems);
    html += groups.map(g => buildDayGroupHTML(g, e => buildEventCard(e, true))).join('');

    if (beyondCount > 0) {
        html += '<button class="load-more-btn" onclick="spLoadMore()">Load more games (' + beyondCount + ' more available)</button>';
    } else {
        html += '<div class="load-more-note">That\'s all ' + (isPast ? 'past' : 'scheduled') + ' games 👋</div>';
    }
    container.innerHTML = html;
    injectInlineAds('sp-events-container','sports');
    if (typeof refreshDayLabels === 'function') refreshDayLabels();
}

// Load the next batch in the active view (upcoming extends forward, past extends backward)
window.spLoadMore = function() {
    if (spTimeView === 'past') spPastDaysVisible += LOAD_MORE_INCREMENT_PAST;
    else spDaysVisible += LOAD_MORE_INCREMENT;
    renderSports();
};

// Toggle favorites-only filter on Sports (Upcoming view only)
window.spToggleFavOnly = function() {
    spFavOnlyMode = !spFavOnlyMode;
    renderSports();
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Toggle Past mode on the Sports page. Replaces the old two-tab Upcoming/Past switcher.
// When Past is on, the list shows completed games newest-first. When off, it shows
// scheduled games chronologically. The Clear ✕ button lights up when Past is on so
// users have an obvious way out (alongside tapping the Past button itself again).
// Favorites-only filter stays available in both modes so users can jump to past games
// of their favorite teams.
window.toggleSportsPast = function() {
    const newView = spTimeView === 'past' ? 'upcoming' : 'past';
    spTimeView = newView;
    spMode = newView; // keep legacy variable in sync
    // Reset the other view's day window so switching feels fresh
    if (newView === 'upcoming') spPastDaysVisible = INITIAL_DAYS_PAST;
    else spDaysVisible = INITIAL_DAYS;
    renderSports();
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Back-compat: callers that still expect setSportsTimeView (e.g. memoryEdits or tests)
window.setSportsTimeView = function(view) {
    if (view !== 'upcoming' && view !== 'past') return;
    if (spTimeView !== view) toggleSportsPast();
};

function renderSportTypeTags(baseEvents){
    const row=document.getElementById('sp-sport-tags');
    const activeSports=new Set();
    baseEvents.forEach(e=>{(e.tags||[]).forEach(t=>{if(sportsList.includes(t))activeSports.add(t);});});
    if(activeSports.size===0){row.innerHTML='';return;}
    const sportFeedMap={Baseball:'baseball',Softball:'softball',Lacrosse:'lacrosse',Volleyball:'volleyball',
        Football:'football',Basketball:'basketball',Soccer:'soccer','Field Hockey':'fieldhockey',
        Tennis:'tennis',Track:'track',Golf:'golf',Swimming:'swimming','Cross Country':'crosscountry'};
    let html=`<button class="sport-pill ${!spSportTag?'active':''}" onclick="setSportType(null)">All Sports</button>`;
    Array.from(activeSports).sort().forEach(s=>{
        const feedSuffix = sportFeedMap[s] || s.toLowerCase().replace(/\s+/g,'');
        html+=`<button class="sport-pill ${spSportTag===s?'active':''}" data-feed="sport-${feedSuffix}" onclick="setSportType('${s}')">${s}</button>`;
    });
    row.innerHTML=html;
    decorateFeedStars();
}
window.setSportType=function(sport){
    spSportTag=(spSportTag===sport)?null:sport;
    renderSports();
};

/* ==================== CARD BUILDER ==================== */
// Generate a minimal .ics (iCalendar) file and trigger a browser download.
// The file is the universal "add to calendar" format accepted by Apple Calendar,
// Google Calendar (as import), Outlook, Thunderbird, and mobile OS calendars.
// We keep the ICS body minimal — Anthropic spec compliance:
//   - DTSTART/DTEND use floating time (no TZID) since event.date strings vary in
//     how they encode timezone; most are America/New_York local time from scrapers.
//     Floating time means "the calendar treats this as local time wherever imported"
//     which is the sensible default for a local-community aggregator.
//   - DTEND defaults to DTSTART + 1 hour since most event sources don't include
//     end times. Users can adjust after import.
//   - UID uses the sourceLink (or title+date as fallback) so re-importing the same
//     event updates rather than duplicates in calendars that respect UID.
function buildICS(e) {
    const start = new Date(e.date);
    if (isNaN(start)) return null;
    const end = new Date(start.getTime() + 60 * 60 * 1000); // +1 hour default
    // ICS wants YYYYMMDDTHHMMSS (no punctuation) in floating local time
    const pad = n => String(n).padStart(2, '0');
    const fmt = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
        + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + '00';
    const now = new Date();
    const dtStamp = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
        + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z';
    // ICS requires \-escape of commas, semicolons, backslashes; newlines become \n literal
    const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    // Long lines should be folded at 75 octets per RFC 5545, but most clients accept
    // unfolded lines. Skipping fold logic for minimalism.
    const uid = (e.sourceLink || (e.title + '-' + e.date)).replace(/[^\w@.-]/g, '').substring(0, 200) + '@millersville.app';
    const summary = esc((e.title || 'Event').substring(0, 250));
    const location = esc((e.location || '').substring(0, 250));
    const description = esc(((e.description || '') + (e.sourceLink ? '\n\n' + e.sourceLink : '')).substring(0, 1500));
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Millersville.APP//Event//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        'UID:' + uid,
        'DTSTAMP:' + dtStamp,
        'DTSTART:' + fmt(start),
        'DTEND:' + fmt(end),
        'SUMMARY:' + summary
    ];
    if (location) lines.push('LOCATION:' + location);
    if (description) lines.push('DESCRIPTION:' + description);
    if (e.sourceLink) lines.push('URL:' + e.sourceLink);
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n');
}

// Click handler for card 📅 buttons. Builds the ICS, triggers a download.
// Filename uses a slugged version of the event title for easy recognition in
// the user's Downloads folder.
// Build a Google Calendar web URL for a given event. Opens the GCal "create event"
// form pre-filled with details. Universal fallback for platforms where .ics downloads
// don't trigger an "Add to Calendar" prompt — notably iOS Safari, which drops the file
// into the Files app instead of offering the calendar sheet.
function buildGoogleCalendarURL(e) {
    const start = new Date(e.date);
    if (isNaN(start)) return null;
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
        + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + '00Z';
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: (e.title || 'Event').substring(0, 200),
        dates: fmt(start) + '/' + fmt(end),
        details: ((e.description || '') + (e.sourceLink ? '\n\n' + e.sourceLink : '')).substring(0, 1500),
        location: (e.location || '').substring(0, 250)
    });
    return 'https://calendar.google.com/calendar/render?' + params.toString();
}

// Mobile detection: .ics file downloads are a poor UX on both iOS (Safari drops
// the file in the Files app) and Android (Chrome drops it in Downloads and the
// user has to tap through the notification to reach Calendar). On mobile we
// offer a chooser modal with Google Calendar as primary (works one-tap on
// every platform via a pre-filled web URL) and .ics as secondary fallback.
// Desktop keeps the simple .ics download — OS-level .ics handlers (macOS
// Calendar, Outlook, Thunderbird) are reliable there.
function isIOS() {
    const ua = navigator.userAgent || '';
    // iPad on iOS 13+ reports as "MacIntel" so also check for touch
    return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
}
function isAndroid() {
    return /Android/i.test(navigator.userAgent || '');
}
function isMobile() {
    return isIOS() || isAndroid();
}

window.addToCalendar = function(btn) {
    const key = btn.dataset.cardkey;
    if (!key) return;
    const e = (allEvents || []).find(ev => (ev.sourceLink || (ev.title + '|' + ev.date)) === key);
    if (!e) return;
    if (isMobile()) {
        showCalendarChooser(e);
    } else {
        downloadICS(e);
    }
};

// Share action — Web Share API on mobile (native share sheet: iMessage,
// AirDrop, WhatsApp, etc.), clipboard copy fallback on desktop. Share text
// includes title, formatted date/time, location, and a link back to the
// event's source or millersville.app if no source URL exists.
window.shareEvent = function(btn) {
    const key = btn.dataset.cardkey;
    if (!key) return;
    const e = (allEvents || []).find(ev => (ev.sourceLink || (ev.title + '|' + ev.date)) === key);
    if (!e) return;

    const d = new Date(e.date);
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const isAllDay = e.allDay === true;
    const timeStr = isAllDay ? '' : ` @ ${formatTime(d)}`;
    // Prefer the event's own source URL (recap page, MU Calendar entry, etc.)
    // as the share link since it's the most specific landing page. Fall back
    // to the site root for events without a source — the user landing there
    // can at least find the same item via Today's list.
    const link = e.sourceLink || 'https://millersville.app';
    const location = (e.location || '').trim();

    const title = e.title || 'Millersville event';
    // Body includes all essentials so a shared SMS/iMessage is self-contained
    // without relying on link previews (which don't always render).
    const body = `${title}\n📅 ${dateStr}${timeStr}${location ? '\n📍 ' + location : ''}\n\n${link}`;

    // Visual success feedback — flips the icon to a green check for 1.5s
    // so the user knows the action fired. Used on both the native-share
    // success path AND the clipboard fallback.
    const flashSuccess = () => {
        const originalText = btn.innerHTML;
        const originalColor = btn.style.color;
        btn.innerHTML = '✓';
        btn.style.color = '#16a34a';
        btn.style.borderColor = '#16a34a';
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.style.color = originalColor;
            btn.style.borderColor = '';
        }, 1500);
    };

    if (navigator.share) {
        navigator.share({ title, text: body, url: link })
            .then(flashSuccess)
            .catch(err => {
                // AbortError = user dismissed the share sheet; don't treat as failure.
                if (err && err.name === 'AbortError') return;
                // Other errors (permission denied, etc.) — fall back to clipboard.
                copyToClipboardFallback();
            });
    } else {
        copyToClipboardFallback();
    }

    function copyToClipboardFallback() {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(body)
                .then(flashSuccess)
                .catch(() => {
                    // Clipboard API unavailable or blocked. Last resort:
                    // prompt() the text so user can manually copy. Rare path
                    // on modern browsers with HTTPS.
                    window.prompt('Copy this text to share:', body);
                });
        } else {
            window.prompt('Copy this text to share:', body);
        }
    }
};

// Trigger .ics download (desktop / Android primary path)
function downloadICS(e) {
    const ics = buildICS(e);
    if (!ics) return;
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const slug = (e.title || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60) || 'event';
    const a = document.createElement('a');
    a.href = url;
    a.download = slug + '.ics';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

// Mobile chooser modal. Google Calendar is the primary action — a pre-filled web
// URL works one-tap on both iOS (opens in browser / Google Calendar app) and
// Android (hands off to the GCal app if installed, otherwise web). The .ics
// download remains as a secondary option for users on Apple Calendar, Outlook,
// Samsung Calendar, etc. — the label is device-neutral since .ics isn't
// Apple-specific.
function showCalendarChooser(e) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.onclick = ev => { if (ev.target === overlay) overlay.remove(); };
    const gcalUrl = buildGoogleCalendarURL(e);
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:360px;width:100%;padding:20px;text-align:center;';
    modal.innerHTML = `
        <h3 style="margin:0 0 8px;font-size:1rem;">Add to Calendar</h3>
        <p style="font-size:0.82rem;color:var(--text-muted);margin:0 0 16px;">Which calendar do you use?</p>
        <div style="display:flex;flex-direction:column;gap:8px;">
            ${gcalUrl ? `<a href="${gcalUrl}" target="_blank" onclick="this.closest('div[style*=fixed]').remove();" class="btn btn-sm btn-ticket" style="padding:10px;text-decoration:none;">📆 Google Calendar</a>` : ''}
            <button onclick="this.closest('div[style*=fixed]').remove();downloadICS(window.__calEvent);" class="btn btn-sm btn-outline" style="padding:10px;">📥 Apple Calendar / Other (.ics)</button>
            <button onclick="this.closest('div[style*=fixed]').remove();" style="background:none;border:none;color:var(--text-muted);font-size:0.82rem;cursor:pointer;padding:6px;margin-top:4px;">Cancel</button>
        </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    // Stash the event on window so the inline handler can reach it after the closure
    window.__calEvent = e;
}
window.downloadICS = downloadICS;

function cleanLocation(loc) {
    if (!loc) return '';
    let cleaned = loc.replace(/^AcCALEN$/i, 'Millersville University');

    // Strip duplicated building-code prefixes from MU calendar data. The
    // raw API returns strings like "SMC SMC Commons" or "WARE Ware Center"
    // where the building code is prepended even though the venue name
    // already contains it. Two cases:
    //   1) Identical repeat: "SMC SMC Commons" → "SMC Commons"
    //   2) Code is a prefix of the next word: "WARE Ware Center" → "Ware Center"
    const dupRepeat = /^([A-Z]{2,6})\s+\1\b/;
    if (dupRepeat.test(cleaned)) {
        cleaned = cleaned.replace(dupRepeat, '$1');
    } else {
        const codePrefix = /^([A-Z]{2,6})\s+([A-Z][a-z]+)/;
        const m = cleaned.match(codePrefix);
        if (m && m[2].toLowerCase().startsWith(m[1].toLowerCase())) {
            cleaned = cleaned.slice(m[1].length + 1);
        }
    }

    // Specific cleanups kept as a safety net.
    cleaned = cleaned.replace(/^Ware Center\s+(?!,)/, 'Ware Center, ');
    return cleaned;
}
function buildEventCard(e,isSportsPage){
    const d=new Date(e.date), tags=e.tags||[];
    const priceText=e.price?e.price.toString():"Free";
    const isFree=priceText.toLowerCase()==='free'||priceText.toLowerCase()==='free entry';
    const hasLink=e.ticketLink&&e.ticketLink.trim()!=="";
    const isHome=tags.includes('Home Game Mode')||tags.includes('H Games');

    // Determine main source label
    let sourceLabel='';
    if(tags.includes('VFW')) sourceLabel='VFW';
    else if(tags.includes('Other')&&tags.includes('Live Music')) sourceLabel='Phantom Power';
    else if(tags.includes('Borough')) sourceLabel='Borough';
    else if(tags.includes('PM')) sourceLabel='PM';
    else if(tags.includes('MU')) sourceLabel='MU';

    const hiddenTags=[...topSources,...sportMetaTags,'MU Calendar','Penn Manor','Clubs/Orgs','Phantom Power','VFW','Live Music','Other'];
    // Townie-friendly label swap: "GetInvolved" is MU-internal jargon. Only actual townies
    // see it as "Community" — unset/Marauder users see the original label since the default
    // is now Marauder mode.
    const relabelForTownie = (tag) => (muAffiliation === 'townie' && tag === 'GetInvolved') ? 'Community' : tag;
    const displayTags=tags.filter(t=>!hiddenTags.includes(t)).map(relabelForTownie);
    let tagHtml=sourceLabel?`<span class="card-tag">${sourceLabel}</span>`:'';
    tagHtml+=displayTags.map(t=>`<span class="card-tag">${t}</span>`).join('');

    // Score badge for completed games — large, top-right corner
    let scoreBadge='';
    let cardResultClass='';
    if(isSportsPage && e.gameResult && e.gameScore){
        const isWin = e.gameResult==='W';
        const isLoss = e.gameResult==='L';
        cardResultClass = isWin ? 'card-win' : isLoss ? 'card-loss' : 'card-tie';
        scoreBadge=`<div class="score-corner ${isWin?'score-win':isLoss?'score-loss':'score-tie'}"><span class="score-result">${e.gameResult}</span><span class="score-value">${e.gameScore}</span></div>`;
    }

    // Dynamic live check (doesn't rely on scraper's hourly isLive flag)
    const now = new Date();
    const eventEnd = new Date(d.getTime() + 3*60*60*1000); // assume ~3hr game
    const isCurrentlyLive = isSportsPage && e.streamLink && d <= now && now <= eventEnd && !e.gameResult;
    const isPast = isSportsPage && d < now && !isCurrentlyLive;

    // Live badge
    let liveBadge='';
    if(isCurrentlyLive){
        liveBadge=`<a href="${e.streamLink}" target="_blank" class="badge badge-live">🔴 LIVE</a>`;
    }

    // Action buttons
    let actionHtml='';
    const isFuture = isSportsPage && d > now;
    if(isCurrentlyLive && e.streamLink){
        actionHtml=`<a href="${e.streamLink}" target="_blank" class="btn btn-sm btn-live">📺 Watch</a>`;
    } else if(isFuture && e.streamLink){
        actionHtml=`<a href="${e.streamLink}" target="_blank" class="btn btn-sm btn-outline" style="border-color:var(--gold);color:var(--gold);">📺 Will Stream</a>`;
    } else if(isPast && e.streamLink){
        actionHtml=`<a href="${e.streamLink}" target="_blank" class="btn btn-sm btn-outline">📺 Replay</a>`;
    } else if(!isSportsPage && e.streamLink){
        actionHtml=`<a href="${e.streamLink}" target="_blank" class="btn btn-sm btn-outline">📺 Stream</a>`;
    } else if(hasLink){
        actionHtml=`<a href="${e.ticketLink}" target="_blank" class="btn btn-sm btn-ticket">🎟 Tickets</a>`;
    } else if(!isFree){
        actionHtml=`<span class="badge badge-door">${priceText}</span>`;
    }

    // Game location badge (lower-left corner for sports) / Family badge for events
    let locBadge = '';
    if (isSportsPage) {
        if (isHome) locBadge = '<span class="game-loc-badge game-loc-home">🏠 Home</span>';
        else locBadge = '<span class="game-loc-badge game-loc-away">📍 Away</span>';
    } else if (e.kidFriendly) {
        locBadge = '<span class="game-loc-badge tag-family">👨‍👩‍👧 Family</span>';
    }

    // Hide time if event is explicitly all-day. Trusts the scraper's allDay
    // flag rather than guessing from "exactly 12:00". The old noon heuristic
    // misidentified real noon meetings (e.g. lunchtime club meetings) as
    // all-day.
    const isAllDay = e.allDay === true;
    const timeStr = isAllDay ? '' : ` @ ${formatTime(d)}`;

    // Student perks
    const benefits = e.benefits || [];
    let perkBadges = '';
    if (benefits.includes('Free Food')) perkBadges += '<span class="perk-badge perk-food">🍕 Free Food</span>';
    if (benefits.includes('Free Stuff')) perkBadges += '<span class="perk-badge perk-stuff">🎁 Free Stuff</span>';
    if (benefits.includes('Credit')) perkBadges += '<span class="perk-badge perk-credit">📚 Credit</span>';

    // Clean title
    const displayTitle = (e.title || '').replace(/^Millersville University\s*/i, '').replace(/ - (Girls|Boys)\s+(vs |@ )/i, ' $2');

    // Visual highlight for favorited cards. Replaces the old "pinned at top" behavior —
    // favorites now sit in their chronological day group with a gold accent so users can
    // spot them at a glance while scrolling. Uses isEventFavorited (not eventMatchesFeed)
    // because the latter returns true for all events when user has no prefs set.
    const isFav = (typeof isEventFavorited === 'function') && isEventFavorited(e);
    const favClass = isFav ? ' card-fav' : '';
    // One-tap favorite button — inline with title. Toggles the best-matching pref ID for
    // this event so the user doesn't have to open the settings modal for a simple pick.
    // For club events the ID is `club:<orgName>`; for MU sports it's the sport-specific ID;
    // everything else falls back to the broad source ID (e.g. `borough-all`). See
    // suggestFeedIdForEvent() for the mapping logic.
    const favId = (typeof suggestFeedIdForEvent === 'function') ? suggestFeedIdForEvent(e, isSportsPage) : null;

    // Description block — shown on event cards (not sports cards, where descriptions are
    // usually empty or boilerplate). Short descriptions render plain; longer ones get a
    // "more" link that toggles a `.expanded` class on the parent <div> via inline handler.
    // Kept inline rather than routed to the modal so users can scan multiple descriptions
    // at once without opening modals. Descriptions over 400 chars are truncated in the
    // scraper already (600 cap), so our 180-char preview is always smaller than the full.
    let descBlock = '';
    const desc = (e.description || '').trim();
    const PREVIEW_LEN = 180;
    if (desc && !isSportsPage) {
        // Escape quotes for safe HTML attribute use; the full text is embedded in the DOM
        // so the expand handler doesn't need to re-fetch. Preserve basic whitespace.
        const escaped = desc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        if (desc.length <= PREVIEW_LEN) {
            descBlock = `<div class="card-desc"><p class="card-desc-text">${escaped}</p></div>`;
        } else {
            // Cut at a word boundary near PREVIEW_LEN so we don't truncate mid-word.
            let cut = desc.lastIndexOf(' ', PREVIEW_LEN);
            if (cut < PREVIEW_LEN - 30) cut = PREVIEW_LEN; // no word break nearby, use hard cut
            const preview = desc.substring(0, cut).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            descBlock = `<div class="card-desc">
                <p class="card-desc-text card-desc-preview">${preview}… <a href="#" class="card-desc-more" onclick="event.preventDefault();event.stopPropagation();this.closest('.card-desc').classList.add('expanded');">more</a></p>
                <p class="card-desc-text card-desc-full">${escaped} <a href="#" class="card-desc-less" onclick="event.preventDefault();event.stopPropagation();this.closest('.card-desc').classList.remove('expanded');">less</a></p>
            </div>`;
        }
    }

    // Card-level identifier that addToCalendar uses to find the event in allEvents.
    // Uses sourceLink when available; otherwise title+date as a fallback (matches the
    // composite key strategy used by openEventDetails and search hit-handling).
    const cardKey = (e.sourceLink || (e.title + '|' + e.date)).replace(/"/g, '&quot;');
    const calBtn = `<button class="btn-cal" data-cardkey="${cardKey}" onclick="event.stopPropagation();addToCalendar(this)" title="Add to calendar" aria-label="Add to calendar">📥</button>`;
    // Share button — uses Web Share API on mobile (native share sheet with
    // iMessage/AirDrop/Slack/etc.) and falls back to clipboard copy on
    // desktop browsers where navigator.share is undefined. Visual feedback
    // (✓) on the button itself confirms the copy worked on the fallback path.
    const shareBtn = `<button class="btn-share" data-cardkey="${cardKey}" onclick="event.stopPropagation();shareEvent(this)" title="Share" aria-label="Share">🔗</button>`;

    // Whole-card click opens the detail modal — the same one used by homepage
    // timeline and search results. All interactive children (star, calendar,
    // tickets, stream, description more/less) call stopPropagation so their
    // action wins over the card-level click.
    const modalKey = cardKey; // same composite key as cardKey
    const cardOnclick = `onclick="window.openEventDetails(&quot;${modalKey}&quot;)" style="cursor:pointer;"`;

    // Star renders inline before the title so it's visually anchored to the
    // event name rather than floating in the corner. Older layout used
    // position:absolute which forced ad-hoc left/right padding on the tags
    // row and title to avoid overlap — now the star is part of the title
    // flow line and those padding hacks are unnecessary.
    const inlineFavBtn = favId
        ? `<button class="card-fav-inline${isFav ? ' active' : ''}" onclick="event.stopPropagation();toggleCardFavorite('${favId.replace(/'/g, "\\'")}', this)" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}">${isFav ? '★' : '☆'}</button>`
        : '';

    return `<div class="app-card${isCurrentlyLive?' card-live':''} ${cardResultClass}${favClass}" data-event-key="${cardKey}" style="position:relative;" ${cardOnclick}>${scoreBadge}<div class="card-body">
        <div class="card-heading">${inlineFavBtn}<h3 class="card-title">${displayTitle}</h3></div>
        <p class="card-meta">📅 ${formatDate(d)}${timeStr}</p>
        <p class="card-meta">📍 ${cleanLocation(e.location)}</p>
        ${tagHtml || liveBadge ? `<div class="card-tags card-tags-secondary">${tagHtml}${liveBadge}</div>` : ''}
        ${descBlock}
        ${perkBadges?`<div class="perk-row">${perkBadges}</div>`:''}
    </div><div class="card-footer"><div class="card-actions">${locBadge}${calBtn}${shareBtn}${actionHtml}</div></div></div>`;
}

/* ==================== HOME ==================== */
function renderHomeUI(){
    const now = new Date();
    if (!homeViewDate) homeViewDate = todayMidnight();
    const todayD = todayMidnight();
    const isToday = toDateStr(homeViewDate) === toDateStr(todayD);
    const viewDateStr = toDateStr(homeViewDate);
    const hasFeed = feedPrefs && feedPrefs.length > 0;

    // Update the day-navigator label and Today-snap-back visibility. The
    // label uses fmtDateLabel for consistent formatting ("Today, Apr 28" vs
    // "Tue, Apr 29"). Today button hidden when already on today since it
    // would be a no-op.
    const dayLabelEl = document.getElementById('home-day-label');
    if (dayLabelEl) {
        const labelText = isToday ? 'Today' : fmtDateLabel(homeViewDate);
        dayLabelEl.textContent = '📅 ' + labelText;
    }
    const todayBtn = document.getElementById('home-day-today');
    if (todayBtn) todayBtn.style.display = isToday ? 'none' : '';

    // ===== COMBINED TIMELINE: games + events sorted by time =====
    // Filter against the currently-selected home view date. Same audience and
    // source filtering as before — date is the only thing that changes.
    const dayEvents = allEvents.filter(e => {
        if(localDateStr(e.date) !== viewDateStr) return false;
        if(isHiddenForTownie(e)) return false;
        if(isEventFromHiddenSource(e)) return false;
        if(isSportsEventFromHiddenSource(e)) return false;
        if((e.tags||[]).includes('Clubs/Orgs') && e.audience !== 'public' && muAffiliation === 'townie') return false;
        return true;
    }).sort((a,b) => a._dateMs - b._dateMs);

    const timeline = document.getElementById('home-timeline');
    if(dayEvents.length === 0){
        // Show next upcoming items relative to viewed day. Slightly different
        // copy depending on whether user is on today or another day.
        const upcoming = allEvents.filter(e => {
            const d = localDateStr(e.date);
            if (d <= viewDateStr) return false;
            if (isHiddenForTownie(e)) return false;
            if (isEventFromHiddenSource(e)) return false;
            if (isSportsEventFromHiddenSource(e)) return false;
            if ((e.tags||[]).includes('Clubs/Orgs') && e.audience !== 'public' && muAffiliation === 'townie') return false;
            return true;
        }).sort((a,b) => a._dateMs - b._dateMs).slice(0, 5);
        const noneCopy = isToday
            ? 'Nothing scheduled today.'
            : 'Nothing scheduled on ' + fmtDateLabel(homeViewDate) + '.';
        if (upcoming.length > 0) {
            timeline.innerHTML = '<p class="home-empty">' + noneCopy + ' Coming up next:</p>' + upcoming.map(e => buildTimelineItem(e, now)).join('');
        } else {
            timeline.innerHTML = '<p class="home-empty">' + noneCopy + '</p>';
        }
    } else if (hasFeed) {
        const favs = dayEvents.filter(e => eventMatchesFeed(e));
        const others = dayEvents.filter(e => !eventMatchesFeed(e));
        const allLabel = isToday ? 'All Today' : 'All ' + fmtDateLabel(homeViewDate);
        let html = '';
        if (favs.length > 0) {
            html += '<div class="feed-pinned-header"><span>⚡ My Favorites</span></div>';
            html += favs.map(e => buildTimelineItem(e, now)).join('');
            if (others.length > 0) html += '<div class="feed-divider"><span>' + allLabel + '</span></div>';
        } else {
            const noFavCopy = isToday ? 'No favorites scheduled today' : 'No favorites scheduled';
            html += '<p class="home-empty">' + noFavCopy + '</p>';
            html += '<div class="feed-divider"><span>' + allLabel + '</span></div>';
        }
        html += others.map(e => buildTimelineItem(e, now)).join('');
        timeline.innerHTML = html;
    } else {
        timeline.innerHTML = dayEvents.map(e => buildTimelineItem(e, now)).join('');
    }

    // ===== LATEST NEWS (compact text links) =====
    const newsContainer = document.getElementById('home-news-list');
    // Filter PM/Borough news out for marauders (unless favorited) so the home
    // feed matches the main News page's marauder-default behavior.
    let latestNews = (currentNews || []).filter(n => !isNewsFromHiddenSource(n)).slice(0, 12);
    if (hasFeed) {
        const favNews = latestNews.filter(n => newsMatchesFeed(n));
        const otherNews = latestNews.filter(n => !newsMatchesFeed(n));
        latestNews = [...favNews, ...otherNews];
    }
    latestNews = latestNews.slice(0, 5);
    if(latestNews.length === 0){
        newsContainer.innerHTML = '<p class="home-empty">No news available</p>';
    } else {
        const sourceDisplay = {'Millersville News':'MU','The Snapper':'Snapper','MU Athletics':'MU Athletics','MU Review':'MU Review','Penn Manor News':'PM','Millersville Borough':'Borough'};
        newsContainer.innerHTML = latestNews.map(n => {
            const src = sourceDisplay[n.source] || n.source;
            return `<a href="${n.link}" target="_blank" class="home-news-item"><span class="home-news-src">${src}</span><span class="home-news-title">${n.title}</span></a>`;
        }).join('');
    }

    // ===== COMMUNITY BOARD PREVIEW =====
    const boardSection = document.getElementById('home-board-section');
    const boardPreview = document.getElementById('home-board-preview');
    if (allBoardPosts && allBoardPosts.length > 0) {
        boardSection.style.display = '';
        const latest = allBoardPosts.slice(0, 2);
        boardPreview.innerHTML = latest.map(p => {
            const catColors = {'Lost Pet':'#dc2626','Found Pet':'#16a34a','Yard Sale':'#d97706','Help Wanted':'#2563eb','For Sale':'#7c3aed','Free Stuff':'#059669','Community Notice':'#6b7280'};
            const color = catColors[p.category] || 'var(--text-muted)';
            return `<div class="home-board-item" onclick="switchView('board')"><span class="home-board-cat" style="color:${color};">${p.category}</span> <span class="home-board-title">${p.title}</span></div>`;
        }).join('');
    } else {
        boardSection.style.display = 'none';
    }

    // ===== FEED CTA =====
    const feedCta = document.getElementById('home-feed-cta');
    if (feedCta) feedCta.style.display = hasFeed ? 'none' : 'block';
}

function buildTimelineItem(e, now) {
    const d = new Date(e.date);
    const tags = e.tags || [];
    const isSport = isSportEvent(e) || isPMSportByTitle(e);
    const isHome = tags.includes('Home Game Mode') || tags.includes('H Games');

    // Source label / org pill. For marauders only (muAffiliation === 'student')
    // and when the event has an orgShortName, use that as the pill instead of
    // the generic "MU" — most marauder home items are MU events, so the "MU"
    // label conveys nothing. The org short name (e.g. "IAEM", "SGA", "Acacia")
    // tells them which group is hosting at a glance. Falls back to standard
    // logic when no orgShortName, or when townie (townies see PM/MU/Borough
    // distinction as meaningful, so keep generic).
    let src = '';
    if (muAffiliation === 'student' && e.orgShortName && !isSport) {
        src = e.orgShortName;
    } else if(tags.includes('VFW')) src = 'VFW';
    else if(tags.includes('Borough')) src = 'Borough';
    else if(tags.includes('PM') && isSport) src = 'PM';
    else if(tags.includes('PM')) src = 'PM';
    else if(tags.includes('MU') && isSport) src = 'MU';
    else if(tags.includes('MU')) src = 'MU';
    else if(tags.includes('Community')) src = 'Community';
    else src = 'Event';

    // Clean title — strip "Millersville University" prefix and redundant gender
    let title = e.title || '';
    title = title.replace(/^Millersville University\s*/i, '').replace(/ - (Girls|Boys)\s+(vs |@ )/i, ' $2');

    // For marauders: when the org pill already shows the org name, strip the
    // org name out of the title to avoid redundant display. The scraper's
    // decorateGenericTitle prepends org names to bare titles like "Practice"
    // or "Meeting" so they read sensibly when no pill is present — but on
    // the marauder home view the pill IS the org, so showing the name twice
    // is noise. Townies don't have org pills so they keep the full title.
    if (muAffiliation === 'student' && e.orgName && e.orgShortName) {
        const orgPattern = e.orgName
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // escape regex chars
            .replace(/[''']/g, "[''']?")              // tolerate curly/straight quote variants
            .replace(/\s+/g, '\\s+');                  // tolerate whitespace variants
        const re = new RegExp(`(^|\\s)${orgPattern}(\\s|$)`, 'i');
        const stripped = title.replace(re, ' ').replace(/\s{2,}/g, ' ').trim();
        // Sanity guard — only use the stripped version if it's still
        // meaningful (≥ 4 chars). Otherwise the title was probably JUST
        // the org name and stripping would leave nothing useful.
        if (stripped.length >= 4 && stripped !== title) {
            title = stripped;
        }
    }

    // Append location to title in timeline view. Helps users at-a-glance
    // know where to go without opening the modal. Skipped for: empty/generic
    // locations, locations already mentioned in the title, very long
    // locations (full street addresses), and cases where the location
    // matches the org name (the pill already conveys it — avoids "Free
    // Lunch — The HUB" with [The HUB] pill, which is double display).
    const rawLoc = cleanLocation(e.location || '').trim();
    const genericLoc = /^(millersville university|campus|tba|tbd|online|virtual|zoom|n\/a)$/i;
    const orgEqualsLoc = e.orgShortName && rawLoc.toLowerCase() === e.orgShortName.toLowerCase();
    if (rawLoc && rawLoc.length <= 35 && !genericLoc.test(rawLoc) && !orgEqualsLoc && !title.toLowerCase().includes(rawLoc.toLowerCase())) {
        title = `${title} — ${rawLoc}`;
    }

    // Time — uses the scraper's allDay flag. Real noon meetings now show
    // their actual time instead of being heuristic-guessed as "All Day".
    const isAllDay = e.allDay === true;
    const timeStr = isAllDay ? 'All Day' : formatTime(d);

    // Badges
    let badges = '';
    if (isSport && isHome) badges += '<span class="tl-badge tl-home">🏠</span>';
    if (e.kidFriendly) badges += '<span class="tl-badge tl-family">👨‍👩‍👧</span>';
    const benefits = e.benefits || [];
    if (benefits.includes('Free Food')) badges += '<span class="tl-badge tl-perk">🍕</span>';
    if (benefits.includes('Free Stuff')) badges += '<span class="tl-badge tl-perk">🎁</span>';

    // Live / Score
    const _end = new Date(d.getTime() + 3*60*60*1000);
    const _live = isSport && e.streamLink && d <= now && now <= _end && !e.gameResult;
    if (_live) badges += '<span class="badge badge-live" style="font-size:0.6rem;padding:1px 6px;">LIVE</span>';
    if (e.gameResult && e.gameScore) {
        const cls = e.gameResult==='W' ? 'tl-win' : e.gameResult==='L' ? 'tl-loss' : 'tl-tie';
        badges += `<span class="tl-badge ${cls}">${e.gameResult} ${e.gameScore}</span>`;
    }

    // Stream icon for games with Hudl broadcast data. Three states:
    //   - Future game + not yet started → "Stream scheduled" (Hudl has
    //     planned broadcast but it's not live yet — tooltip makes this
    //     clear rather than misleading users into thinking it's active).
    //   - Currently in game window → no separate icon; the LIVE badge
    //     above already announces the active stream with higher prominence.
    //   - Past game → "Replay available" (Hudl archives post-game).
    let streamBtn = '';
    if (isSport && e.streamLink && !_live) {
        if (d > now) {
            streamBtn = `<span class="tl-stream" title="Stream scheduled">📺</span>`;
        } else if (e.gameResult) {
            streamBtn = `<span class="tl-stream" title="Replay available">📺</span>`;
        }
    }

    // Ticket icon for events with a purchase link. Suppressed for marauders on
    // MU athletic events because MU students get in free with their student ID
    // (the icon would just cause confusion / unnecessary clicks). Townies always
    // see the icon when a ticket link exists — they pay for everything. Unset
    // affiliation defaults to marauder behavior (the app's default audience).
    // Click opens the ticket link directly and stops propagation so the card's
    // modal doesn't also fire; title attribute hints at the action on hover.
    let ticketBtn = '';
    const isMUAthletic = isSport && tags.includes('MU');
    const hideTicketForMarauder = (muAffiliation !== 'townie') && isMUAthletic;
    if (e.ticketLink && e.ticketLink.trim() && !hideTicketForMarauder) {
        const safeUrl = e.ticketLink.replace(/"/g, '&quot;');
        ticketBtn = `<a href="${safeUrl}" target="_blank" rel="noopener" class="tl-ticket" title="Buy tickets" onclick="event.stopPropagation();">🎟️</a>`;
    }

    // Use event's sourceLink as unique identifier for the detail modal lookup.
    // Falls back to title+date composite for events without sourceLink.
    const eventKey = e.sourceLink || (e.title + '|' + e.date);
    const typeClass = isSport ? ' tl-sport' : ' tl-event';
    // Add fav class so favorited events get the gold accent on the timeline
    // immediately at render time. Surgical updates in toggleCardFavorite
    // toggle this class without rebuilding the timeline.
    const tlFavClass = (typeof isEventFavorited === 'function' && isEventFavorited(e)) ? ' tl-fav' : '';

    // Wrap badges + stream icon in a single flex cluster so they stay
    // right-anchored and never wrap to a new line below the title.
    // Empty cluster is hidden via `.tl-badges:empty { display: none; }` in CSS.
    return `<div class="tl-item${typeClass}${tlFavClass}" data-event-key="${eventKey.replace(/"/g, '&quot;')}" onclick="window.openEventDetails(${JSON.stringify(eventKey).replace(/"/g, '&quot;')})">
        <span class="tl-time">${timeStr}</span>
        <div class="tl-content">
            <span class="tl-src${isSport?'':' tl-src-event'}">${src}</span>
            <span class="tl-title">${title}</span>
            <span class="tl-badges">${badges}${streamBtn}${ticketBtn}</span>
        </div>
    </div>`;
}

// Event detail modal — shown when a user clicks a timeline card (home) or search result.
// Looks up event by key (sourceLink or title|date composite), renders title/time/location/
// description/tags/benefits, and provides buttons to open source link or tickets.
window.openEventDetails = function(key) {
    if (!key) return;
    const e = allEvents.find(ev => (ev.sourceLink || (ev.title + '|' + ev.date)) === key);
    if (!e) return;

    const d = new Date(e.date);
    const tags = e.tags || [];
    const isSport = isSportEvent(e) || isPMSportByTitle(e);
    const isHome = tags.includes('Home Game Mode') || tags.includes('H Games');
    const isAllDay = e.allDay === true;
    const timeStr = isAllDay ? 'All Day' : formatTime(d);
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    // Source label (reuse logic from buildTimelineItem)
    let src = '';
    if(tags.includes('VFW')) src = 'VFW';
    else if(tags.includes('Borough')) src = 'Borough';
    else if(tags.includes('PM')) src = 'PM';
    else if(tags.includes('MU')) src = 'MU';
    else if(tags.includes('Community')) src = 'Community';
    else src = 'Event';

    // Badges row — home/family only. Score is shown in the dedicated scoreSummary
    // block below (more readable: "Millersville 4, Holy Family 2 – Final (W)"
    // beats a plain "W 4-2" pill). Perks get their own high-visibility strip.
    let badges = '';
    if (isSport && isHome) badges += '<span class="tl-badge tl-home">🏠 Home</span>';
    if (e.kidFriendly) badges += '<span class="tl-badge tl-family">👨‍👩‍👧 Family</span>';

    // Perk badges — prominent colored pills, own row, bigger sizing via
    // .event-details-overlay .perk-badge rules in CSS.
    const benefits = e.benefits || [];
    let perks = '';
    if (benefits.includes('Free Food'))  perks += '<span class="perk-badge perk-food">🍕 Free Food</span>';
    if (benefits.includes('Free Stuff')) perks += '<span class="perk-badge perk-stuff">🎁 Free Stuff</span>';
    if (benefits.includes('Credit'))     perks += '<span class="perk-badge perk-credit">📚 Credit</span>';

    // Tag chips (exclude noisy internal markers). Only townies get the Community relabel
    // (unset/Marauder users see "GetInvolved" since default is now Marauder mode).
    const hiddenTags = new Set(['MU','PM','Borough','Other','VFW','Clubs/Orgs','Live Music','H Games','Home Game Mode','Athletic Competitions','Athletics','Phantom Power']);
    const relabelForTownie = (tag) => (muAffiliation === 'townie' && tag === 'GetInvolved') ? 'Community' : tag;
    const displayTags = tags.filter(t => !hiddenTags.has(t)).map(relabelForTownie).slice(0, 6);

    const description = (e.description || '').trim();
    const descBlock = description
        ? `<div style="margin-top:12px;font-size:0.9rem;line-height:1.5;color:var(--text);">${description}</div>`
        : '';

    const location = (e.location || '').trim();
    const locBlock = location
        ? `<div style="margin-top:10px;font-size:0.88rem;color:var(--text-muted);">📍 ${location}</div>`
        : '';

    // Game score summary for past sports events. We store the score as "4-2"
    // (our-team first when home, their-team first when away — inherited from
    // the scraper's parse). Pair that with the opponent extracted from the
    // title to build a human-readable summary line. Inning-by-inning box
    // scores aren't in our data pipeline; the recap URL points at MaxPreps
    // (PM) or MU Athletics (MU) where the full box score is published.
    let scoreSummary = '';
    if (isSport && e.gameResult && e.gameScore) {
        const ourTeam = tags.includes('MU') ? 'Millersville' : tags.includes('PM') ? 'Penn Manor' : 'Home';
        // Extract opponent from title: "Softball vs Holy Family" → "Holy Family"
        const oppMatch = (e.title || '').match(/\s(?:vs\.?|@|at)\s+(.+?)(?:\s+(?:-|·|–).*)?$/i);
        const opponent = oppMatch ? oppMatch[1].trim() : '';
        const [n1, n2] = e.gameScore.split('-').map(s => s.trim());
        // When we won, our score is the higher number; when we lost, ours is lower.
        // Tie: either order works — use home-first convention.
        let ourScore, theirScore;
        if (e.gameResult === 'W') {
            ourScore = Math.max(+n1, +n2); theirScore = Math.min(+n1, +n2);
        } else if (e.gameResult === 'L') {
            ourScore = Math.min(+n1, +n2); theirScore = Math.max(+n1, +n2);
        } else {
            ourScore = n1; theirScore = n2;
        }
        const resultLabel = e.gameResult === 'W' ? 'Final (W)' : e.gameResult === 'L' ? 'Final (L)' : 'Final';
        const resultColor = e.gameResult === 'W' ? '#15803d' : e.gameResult === 'L' ? '#b91c1c' : '#6b7280';
        scoreSummary = `<div style="margin-top:12px;padding:10px 12px;background:var(--bg);border-left:4px solid ${resultColor};border-radius:var(--radius-sm);">
            <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;color:${resultColor};font-weight:700;">${resultLabel}</div>
            <div style="font-size:1rem;font-weight:700;color:var(--text);margin-top:2px;">${ourTeam} ${ourScore}${opponent ? `, ${opponent} ${theirScore}` : ` – ${theirScore}`}</div>
        </div>`;
    }

    // Inline linescore (box score). Rendered only when the scraper populated
    // event.periodScores. Structure: { labels: [...], home: {team, values},
    // away: {team, values}, ourTeamSide: 'home'|'away' }. ourTeamSide tells us
    // which row to visually emphasize (the "home team" in box-score parlance
    // is the school hosting, not necessarily the MU/PM team we're tracking).
    let linescoreBlock = '';
    if (isSport && e.periodScores && Array.isArray(e.periodScores.labels) && e.periodScores.home && e.periodScores.away) {
        const ps = e.periodScores;
        const rowHtml = (side, data) => {
            const isOur = side === ps.ourTeamSide;
            const rowStyle = isOur
                ? 'background:var(--gold-soft);font-weight:700;'
                : '';
            const teamName = (data.team || '').replace(/</g, '&lt;');
            const cells = (data.values || []).map((v, i) => {
                // Last three columns (R/H/E for baseball, or total for other
                // sports) get bold emphasis as summary values.
                const isTotal = i >= ps.labels.length - 3;
                const cellStyle = isTotal ? 'font-weight:700;border-left:1px solid var(--border);' : '';
                return `<td style="padding:4px 8px;text-align:center;${cellStyle}">${v}</td>`;
            }).join('');
            return `<tr style="${rowStyle}"><td style="padding:4px 8px;font-weight:600;">${teamName}</td>${cells}</tr>`;
        };
        const headerCells = ps.labels.map((lbl, i) => {
            const isTotal = i >= ps.labels.length - 3;
            const cellStyle = isTotal ? 'font-weight:800;border-left:1px solid var(--border);' : '';
            return `<th style="padding:4px 8px;text-align:center;font-size:0.72rem;color:var(--text-muted);${cellStyle}">${lbl}</th>`;
        }).join('');
        linescoreBlock = `<div style="margin-top:12px;overflow-x:auto;">
            <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);font-weight:700;margin-bottom:4px;">Box Score</div>
            <table style="border-collapse:collapse;font-size:0.85rem;min-width:100%;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;">
                <thead style="background:var(--bg);">
                    <tr><th style="padding:4px 8px;text-align:left;"></th>${headerCells}</tr>
                </thead>
                <tbody>
                    ${rowHtml('away', ps.away)}
                    ${rowHtml('home', ps.home)}
                </tbody>
            </table>
        </div>`;
    }

    // Action buttons
    let actions = '';
    if (e.ticketLink) actions += `<a href="${e.ticketLink}" target="_blank" class="btn btn-sm btn-ticket" style="text-decoration:none;">🎟️ Buy Tickets</a>`;
    if (e.streamLink) {
        // State-aware label — same three cases as the card buttons. Clarifies
        // that a future streamLink is a scheduled broadcast, not something
        // you can tune into right now.
        const streamD = new Date(e.date);
        const streamEnd = new Date(streamD.getTime() + 3*60*60*1000);
        const streamNow = new Date();
        const isLiveNow = isSport && streamD <= streamNow && streamNow <= streamEnd && !e.gameResult;
        let streamLabel;
        if (isLiveNow) streamLabel = '🔴 Watch Live';
        else if (e.gameResult) streamLabel = '📺 Replay';
        else streamLabel = '📺 Will Stream';
        actions += `<a href="${e.streamLink}" target="_blank" class="btn btn-sm btn-outline" style="text-decoration:none;">${streamLabel}</a>`;
    }
    // Calendar action — uses the same key scheme as card buttons so addToCalendar can find it
    const modalCardKey = (e.sourceLink || (e.title + '|' + e.date)).replace(/"/g, '&quot;');
    actions += `<button class="btn btn-sm btn-outline" data-cardkey="${modalCardKey}" onclick="addToCalendar(this)" style="cursor:pointer;">📅 Add to Calendar</button>`;
    actions += `<button class="btn btn-sm btn-outline" data-cardkey="${modalCardKey}" onclick="shareEvent(this)" style="cursor:pointer;">🔗 Share</button>`;
    // Source link labeling: for past sports games, promote it to "Game Recap
    // & Box Score" since the target URL is the MaxPreps/MU Athletics recap
    // page where inning/quarter box scores and recap articles live. Other
    // contexts keep the generic "View Source" label.
    if (e.sourceLink) {
        const isPastGame = isSport && e.gameResult && e.gameScore;
        const isMUSport = isSport && tags.includes('MU');
        let srcLabel;
        if (isPastGame) srcLabel = '📊 Game Recap & Box Score';
        else if (isMUSport && !e.ticketLink) srcLabel = '🎟️ View on MU Athletics';
        else srcLabel = '🔗 View Source';
        actions += `<a href="${e.sourceLink}" target="_blank" class="btn btn-sm btn-outline" style="text-decoration:none;">${srcLabel}</a>`;
    }

    // Build modal
    const overlay = document.createElement('div');
    overlay.className = 'event-details-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9998;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px 16px;overflow-y:auto;';
    overlay.onclick = ev => { if (ev.target === overlay) overlay.remove(); };

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:540px;width:100%;padding:24px;position:relative;box-shadow:0 10px 40px rgba(0,0,0,0.2);';
    modal.innerHTML = `
        <button onclick="this.closest('.event-details-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-muted);padding:4px 8px;">✕</button>
        <h2 style="margin:0 0 8px;font-size:1.25rem;color:var(--navy);line-height:1.3;padding-right:24px;">${e.title || 'Event'}</h2>
        <div style="font-size:0.92rem;color:var(--text);font-weight:600;">📅 ${dateStr}${!isAllDay ? ' · ' + timeStr : ''}</div>
        ${locBlock}
        ${scoreSummary}
        ${linescoreBlock}
        ${perks ? `<div class="modal-perks">${perks}</div>` : ''}
        ${badges ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:4px;">${badges}</div>` : ''}
        ${displayTags.length ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;">${displayTags.map(t => `<span class="card-tag">${t}</span>`).join('')}</div>` : ''}
        ${descBlock}
        ${actions ? `<div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:8px;">${actions}</div>` : ''}
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

/* ==================== HOME SPECIALS ==================== */
async function loadHomeSpecials(){
    try {
        const specials = await fetch('specials.json').then(r=>r.json());
        const dayName = new Date().toLocaleDateString('en-US',{weekday:'long'});
        const container = document.getElementById('home-specials');
        let cards = [];

        // Campus Cupboard — marauder-only resource (free grocery store inside
        // the HUB for MU students). Year-round, with auto-switching hours
        // between academic-year (M-F 8am-8pm) and summer (M-F 9am-1pm).
        // Summer pause is approximate — May 11 to Aug 24 — same window as
        // HUB meal events. Card always shown to marauders, never to townies.
        if (muAffiliation === 'student') {
            const cupboardItems = buildCampusCupboardItems(dayName);
            if (cupboardItems) {
                cards.push(`<div class="home-special-card"><h4 class="home-special-name">🛒 Campus Cupboard</h4><p class="home-special-note">Free grocery store for MU students — inside The HUB</p>${cupboardItems.map(i=>`<p class="home-special-item">• ${i}</p>`).join('')}</div>`);
            }
        }

        for (const [restaurant, sp] of Object.entries(specials)) {
            // VFW is members-only — hide from marauders by default. Townies
            // (and marauders who explicitly favorite VFW) can still see it.
            // The favorited-opt-in path is implicit: this loop only shows
            // cards on the home special-deals strip; the picker provides
            // the override route.
            if (restaurant === 'VFW Post 7294' && muAffiliation === 'student') continue;

            const isWeekend = (dayName === 'Saturday' || dayName === 'Sunday');
            if (isWeekend && restaurant === 'VFW Post 7294') continue;

            let items = [];
            if(sp.daily && sp.daily[dayName]) items = sp.daily[dayName];

            // VFW: show recurring for today + weekly specials
            if (restaurant === 'VFW Post 7294') {
                if(sp.recurring && sp.recurring[dayName]) items.push(`🔁 ${sp.recurring[dayName]}`);
                if(sp.weekly && sp.weekly.length > 0) items = [...items, ...sp.weekly];
            } else {
                if(sp.weekly && sp.weekly.length > 0) items = [...items, ...sp.weekly];
                if(sp.recurring && sp.recurring[dayName]) items.push(`🔁 ${sp.recurring[dayName]}`);
            }

            if(items.length > 0){
                const note = sp.note || '';
                cards.push(`<div class="home-special-card"><h4 class="home-special-name">${restaurant}</h4><p class="home-special-note">${note}</p>${items.map(i=>`<p class="home-special-item">• ${i}</p>`).join('')}</div>`);
            }
        }
        container.innerHTML = cards.length > 0 ? cards.join('') : '<p class="home-empty">No specials today</p>';
    } catch(e) { document.getElementById('home-specials').innerHTML = '<p class="home-empty">No specials today</p>'; }
}

// Build a list of items shown on the Campus Cupboard card based on current
// day + season. Returns null if not open today (only Sat/Sun would match).
// Hours: academic year M-F 8am-8pm, summer M-F 9am-1pm.
function buildCampusCupboardItems(dayName) {
    const isWeekday = ['Monday','Tuesday','Wednesday','Thursday','Friday'].includes(dayName);
    const now = new Date();
    const m = now.getMonth() + 1, d = now.getDate();
    // Same summer window as HUB scrape (May 11 – Aug 24)
    const isSummer = (m === 5 && d >= 11) || m === 6 || m === 7 || (m === 8 && d < 25);
    if (isWeekday) {
        const hours = isSummer ? '9am – 1pm' : '8am – 8pm';
        return [`Open today: ${hours}`, 'Fresh produce, dairy, eggs, frozen, canned & dry goods, hygiene products', 'Bring student ID'];
    }
    return ['Closed today (open weekdays only)', 'Fresh produce, dairy, eggs, frozen, canned & dry goods, hygiene products', 'Bring student ID'];
}

/* ==================== WEATHER ==================== */
async function loadWeather(){
    try{const data=await(await fetch('weather.json')).json();
    const icon=data.icon||'🌡️';
    const todayDate = new Date().toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
    // Home page compact weather bar
    document.getElementById('home-weather-bar').innerHTML=`<div class="weather-bar">
        <div class="weather-bar-left">
            <span class="weather-bar-icon">${icon}</span>
            <span class="weather-bar-temp">${data.temp}°F</span>
            <span class="weather-bar-cond">${data.condition}</span>
        </div>
        <span class="weather-bar-date">${todayDate}</span>
    </div>`;
    // Weather page
    document.getElementById('w-icon').textContent=icon;
    document.getElementById('w-temp').textContent=`${data.temp}°F`;
    document.getElementById('w-feels').textContent=`Feels like ${data.feelsLike||data.temp}°F`;
    document.getElementById('w-cond').textContent=data.condition;
    document.getElementById('w-details').textContent=`Wind: ${data.wind} | Humidity: ${data.humidity}`;
    const stationEl=document.getElementById('w-station-update');
    if(stationEl) stationEl.textContent=data.stationUpdate||`Updated: ${data.lastUpdated||''}`;
    const sourceEl=document.getElementById('w-source');
    if(sourceEl) sourceEl.textContent=data.source?`Source: ${data.source}`:'';
    }catch(e){console.error('Weather load error:',e);}
}
async function loadSpecials(){ await loadHomeSpecials(); }
async function loadNews(){try{currentNews=await(await fetch('news.json')).json();renderNewsSubFilters();renderNewsUI();}catch(e){}}

let newsSource='All', newsSubFilter=null;

window.setNewsSource=function(src,btn){
    newsSource=src; newsSubFilter=null;
    btn.closest('.filter-group').querySelectorAll('.src-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    renderNewsSubFilters();
    renderNewsUI();
};

function renderNewsSubFilters(){
    const c=document.getElementById('news-sub-container'); c.innerHTML='';
    if(newsSource==='All'){c.classList.remove('active');return;}
    let filtered=currentNews.filter(n=>n.source===newsSource);
    const subs=new Set();
    filtered.forEach(n=>{
        if(n.subCategory) subs.add(n.subCategory);
        if(n.tags) n.tags.forEach(t=>subs.add(t));
    });
    const uniqueSubs=[...subs].sort();
    if(uniqueSubs.length<=1){c.classList.remove('active');return;}
    c.classList.add('active');
    uniqueSubs.forEach(sub=>{
        const b=document.createElement('button'); b.className='sub-btn'+(newsSubFilter===sub?' active':''); b.textContent=sub;
        b.onclick=()=>{
            newsSubFilter=(newsSubFilter===sub)?null:sub;
            c.querySelectorAll('.sub-btn').forEach(x=>x.classList.toggle('active',x.textContent===newsSubFilter));
            renderNewsUI();
        };
        c.appendChild(b);
    });
}

function buildNewsCard(n) {
    const sourceDisplay={'Millersville News':'MU','The Snapper':'MU Snapper'};
    let tags=[];
    if(n.source) tags.push(sourceDisplay[n.source]||n.source);
    if(n.subCategory && !tags.includes(n.subCategory)) tags.push(n.subCategory);
    if(n.tags) n.tags.forEach(t=>{if(!tags.includes(t)) tags.push(t);});
    const tagHtml=tags.length?`<div class="card-tags">${tags.map(t=>`<span class="card-tag">${t}</span>`).join('')}</div>`:'';
    return `<div class="app-card">${tagHtml}<p class="card-meta">${n.date}</p><h3 class="card-title">${n.title}</h3><a href="${n.link}" target="_blank" class="btn btn-sm btn-outline" style="margin-top:12px;">Read ➔</a></div>`;
}

// Hide PM/Borough news source pills for marauders who haven't favorited them.
// Mirrors updateEventsUI / updateSportsUI pill-visibility pattern. Also resets
// newsSource back to 'All' if the currently-selected source just got hidden
// (e.g. user switched affiliation while on the Penn Manor pill).
function updateNewsSourcePills() {
    const pmBtn = document.querySelector('#news-source-group .src-btn[data-feed="news-pm"]');
    const boBtn = document.querySelector('#news-source-group .src-btn[data-feed="news-borough"]');
    const pmHidden = isSourceHidden('PM_NEWS');
    const boHidden = isSourceHidden('BOROUGH_NEWS');
    if (pmBtn) pmBtn.style.display = pmHidden ? 'none' : '';
    if (boBtn) boBtn.style.display = boHidden ? 'none' : '';
    // If the active pill just got hidden, fall back to "All".
    if ((pmHidden && newsSource === 'Penn Manor News') ||
        (boHidden && newsSource === 'Millersville Borough')) {
        newsSource = 'All';
        document.querySelectorAll('#news-source-group .src-btn').forEach(b => b.classList.remove('active'));
        const allBtn = document.querySelector('#news-source-group .src-btn');
        if (allBtn) allBtn.classList.add('active');
    }
}

function renderNewsUI(){
    // Refresh source pill visibility first — hidden PM/Borough pills may have
    // become visible (user favorited one) or vice-versa.
    updateNewsSourcePills();
    const c=document.getElementById('news-container');
    let f=currentNews.filter(n=>{
        // Affiliation-based source filter: marauders without a PM/Borough news favorite
        // won't see those items. If user has favorited one, it shows through normally.
        if (isNewsFromHiddenSource(n)) return false;
        if(newsSource!=='All'){
            if(n.source!==newsSource) return false;
        }
        if(newsSubFilter){
            const hasSub=(n.subCategory===newsSubFilter)||(n.tags&&n.tags.includes(newsSubFilter));
            if(!hasSub) return false;
        }
        return true;
    });
    if(f.length===0){ c.innerHTML='<p class="empty-state">No news articles found.</p>'; return; }

    const hasAnyPrefs = feedPrefs && feedPrefs.length > 0;
    const hasNewsPrefs = hasAnyPrefs && feedPrefs.some(p => p.startsWith('news-'));
    if (newsSource === 'All') {
        const feedItems = hasNewsPrefs ? f.filter(n => newsMatchesFeed(n)) : [];
        const otherItems = hasNewsPrefs ? f.filter(n => !newsMatchesFeed(n)) : f;
        let html = '';
        if (hasNewsPrefs && feedItems.length > 0) {
            html += '<div class="feed-pinned-header"><span>⚡ My Favorites</span></div>';
            html += feedItems.map(n => buildNewsCard(n)).join('');
            if (otherItems.length > 0) html += '<div class="feed-divider"><span>All News</span></div>';
        } else if (!hasAnyPrefs) {
            html += '<div class="feed-setup-hint">⚙️ <a href="#" onclick="event.preventDefault();openFeedSettings();">Set up your favorites</a> to see your preferred news sources first</div>';
        } else if (hasAnyPrefs && !hasNewsPrefs) {
            html += '<div class="feed-setup-hint">No news favorites set — <a href="#" onclick="event.preventDefault();openFeedSettings();">add some</a> to pin them here</div>';
        }
        html += otherItems.map(n => buildNewsCard(n)).join('');
        c.innerHTML = html;
    } else {
        c.innerHTML = f.map(n => buildNewsCard(n)).join('');
    }
    injectInlineAds('news-container','news');
}
let allPlaces=[], placesFilter='All';

function renderStars(rating) {
    if (!rating) return '';
    rating = parseFloat(rating);
    const full = Math.floor(rating);
    const half = rating % 1 >= 0.25 && rating % 1 < 0.75 ? 1 : 0;
    const empty = 5 - full - half;
    const extra = rating % 1 >= 0.75 ? 1 : 0;
    return '<span style="color:var(--gold);font-size:0.85rem;letter-spacing:1px;">' +
        '★'.repeat(full + extra) + (half ? '½' : '') + '☆'.repeat(empty - extra) +
        '</span> <span style="font-size:0.8rem;color:var(--text-muted);">' + rating.toFixed(1) + '</span>';
}

async function loadHousing(){try{const data=await(await fetch('housing.json')).json();const c=document.getElementById('housing-container');data.sort((a,b)=>(b.featured===true)-(a.featured===true));c.innerHTML=data.map(p=>{const badge=p.featured?'<span class="badge badge-premium">Featured</span>':'';return `<div class="app-card ${p.featured?'card-featured':''}">${badge}<h3 class="card-title">${p.name}</h3><p class="card-meta" style="font-weight:bold;text-transform:uppercase;margin-bottom:8px;">${p.landlord}</p><p style="font-size:0.9rem;margin-bottom:16px;">${p.description}</p><div class="card-footer"><a href="${p.link}" target="_blank" class="btn btn-sm ${p.featured?'btn-dark':'btn-outline'}" style="display:block;text-align:center;">View Property</a></div></div>`;}).join('');}catch(e){}}

async function loadPlaces(){try{
    const [restaurants, services, specials] = await Promise.all([
        fetch('restaurants.json').then(r=>r.json()).catch(()=>[]),
        fetch('services.json').then(r=>r.json()).catch(()=>[]),
        fetch('specials.json').then(r=>r.json()).catch(()=>({}))
    ]);
    // Store grocery deals for popup
    const jh = specials["John Herr's Village Market"];
    if(jh && jh.rawDeals) { allGroceryDeals = jh.rawDeals; }
    allRestaurants = restaurants;
    // Merge: add category to restaurants, combine
    const foodPlaces = restaurants.map(r => ({...r, placeType:'food', category:'Food & Drink'}));
    const svcPlaces = services.map(s => ({...s, placeType:'service'}));
    allPlaces = [...foodPlaces, ...svcPlaces];
    // Store specials globally for rendering
    window._placesSpecials = specials;
    renderPlaces();
}catch(e){console.error('Places error:',e);}}

window.setPlacesFilter=function(cat,btn){
    placesFilter=cat;
    btn.closest('.filter-group').querySelectorAll('.src-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    renderPlaces();
};

function renderPlaces(){
    const hc=document.getElementById('housing-container');
    const pc=document.getElementById('places-container');
    const specials = window._placesSpecials || {};
    const dayName = new Date().toLocaleDateString('en-US',{weekday:'long'});

    // Housing visibility
    if(placesFilter==='All' || placesFilter==='Housing'){
        hc.style.display='';
    } else {
        hc.style.display='none';
    }

    if(placesFilter==='Housing'){
        pc.style.display='none';
        return;
    }
    pc.style.display='';

    // Filter places
    const filtered = placesFilter==='All' ? allPlaces : allPlaces.filter(p=>p.category===placesFilter);

    // Sort: featured first, then food, then services
    filtered.sort((a,b) => (b.featured===true)-(a.featured===true) || (a.placeType==='food'?0:1)-(b.placeType==='food'?0:1));

    // Campus Cupboard pinned card — marauders only, shown in All and Food & Drink
    // views (it's a free grocery store inside the HUB). Skipped for townies
    // and for filter views that exclude food (e.g. Services).
    let cupboardCard = '';
    if (muAffiliation === 'student' && (placesFilter === 'All' || placesFilter === 'Food & Drink')) {
        cupboardCard = buildCampusCupboardCard(dayName);
    }

    const cards = filtered.map(p => {
        if (p.placeType === 'food') return buildFoodCard(p, specials, dayName);
        return buildServiceCard(p);
    });
    pc.innerHTML = (cupboardCard + cards.join('')) || '<p class="empty-state">No places found in this category. Know a local business? <a href="#" onclick="event.preventDefault();openSubmitBusiness();">Add it here →</a></p>';
}

// Build the Campus Cupboard card for the Places page. Mirrors the food-card
// shape (header + meta + action button) but pulls hours from
// buildCampusCupboardItems for season-aware display.
function buildCampusCupboardCard(dayName) {
    const items = buildCampusCupboardItems(dayName);
    const isWeekday = ['Monday','Tuesday','Wednesday','Thursday','Friday'].includes(dayName);
    const statusClass = isWeekday ? 'open' : 'closed';
    const statusText = isWeekday ? items[0] : 'Closed today';
    return `<div class="app-card" style="border-left:4px solid var(--gold);">
        <div class="card-body">
            <div class="card-heading"><span style="font-size:1.5rem;">🛒</span><h3 class="card-title">Campus Cupboard</h3></div>
            <p class="card-meta">📍 Inside The HUB · MU students only</p>
            <p class="card-meta status-${statusClass}">⏰ ${statusText}</p>
            <p style="font-size:0.85rem;margin:8px 0;color:var(--text-muted);">Free grocery store with fresh produce, dairy, eggs, frozen, canned & dry goods, and hygiene products. Bring student ID.</p>
        </div>
    </div>`;
}

function buildFoodCard(p, specials, dayName) {
    // Action buttons
    let actionBtn='';
    if(p.status==='App Required') actionBtn=`<div style="display:flex;gap:8px;"><a href="${p.iosLink||'#'}" target="_blank" class="btn btn-sm ${p.featured?'btn-dark':'btn-outline'}" style="flex:1;text-align:center;">🍎 iOS</a><a href="${p.link||'#'}" target="_blank" class="btn btn-sm ${p.featured?'btn-dark':'btn-outline'}" style="flex:1;text-align:center;">🤖 Android</a></div>`;
    else if(p.status==='Order Online') actionBtn=`<a href="${p.link}" target="_blank" class="btn btn-sm btn-ticket" style="display:block;text-align:center;">🛒 Order Online</a>`;
    else actionBtn=`<a href="${p.link}" target="_blank" class="btn btn-sm btn-outline" style="display:block;text-align:center;">📄 View Menu</a>`;

    const membersBadge = p.status==='Members Only' ? '<span class="badge-members-only">Members Only</span>' : '';
    const featuredBadge = p.featured ? '<span class="badge badge-premium">Featured</span>' : '';
    const addr = p.address ? `<p class="card-meta" style="margin-bottom:4px;">📍 ${p.address}</p>` : '';
    const stars = p.rating ? renderStars(p.rating) : '';
    const reviews = p.reviewCount ? `<span style="font-size:0.75rem;color:var(--text-muted);margin-left:4px;">(${p.reviewCount} review${p.reviewCount>1?'s':''})</span>` : '';
    const ratingRow = stars ? `<div style="margin:4px 0 6px;">${stars}${reviews}</div>` : '';

    // Build specials section
    let specialsHtml='';
    const sp = specials[p.name];
    const isWeekend = (dayName === 'Saturday' || dayName === 'Sunday');
    if(sp && !(isWeekend && p.name === 'VFW Post 7294')){
        let items=[];
        if(sp.daily && sp.daily[dayName]) items = sp.daily[dayName];
        if (p.name === 'VFW Post 7294') {
            if(sp.recurring && sp.recurring[dayName]) items.push(`🔁 ${sp.recurring[dayName]}`);
            if(sp.weekly && sp.weekly.length > 0) items = [...items, ...sp.weekly];
        } else {
            if(sp.weekly && sp.weekly.length > 0) items = [...items, ...sp.weekly];
            if(sp.recurring && sp.recurring[dayName]) items.push(`🔁 ${sp.recurring[dayName]}`);
        }
        if(items.length > 0){
            const isGrocery = p.name === "John Herr's Village Market";
            const note = sp.note ? `<p style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px;font-style:italic;">${sp.note}</p>` : '';
            const dateRange = (!isGrocery && sp.weeklyDateRange) ? `<p style="font-size:0.7rem;color:var(--gold);font-weight:600;margin-bottom:4px;">${sp.weeklyDateRange}</p>` : '';
            const isVFW = p.name === 'VFW Post 7294';
            const heading = isGrocery ? '🏷️ Top Weekly Deals:' : isVFW ? `Specials (${dayName}):` : `Today's Specials (${dayName}):`;
            const topItems = isGrocery ? items.slice(0, 5) : items;
            const moreItems = isGrocery ? items.slice(5) : [];
            let moreHtml = '';
            if(moreItems.length > 0){
                moreHtml = `<button onclick="showGroceryDeals(event)" class="btn btn-sm btn-outline" style="margin-top:6px;font-size:0.75rem;width:100%;text-align:center;">View All ${items.length} Deals</button>`;
            }
            specialsHtml=`<div class="specials-section">${note}${dateRange}<p style="font-size:0.8rem;font-weight:700;margin-bottom:4px;">${heading}</p>${topItems.map(i=>`<p style="font-size:0.8rem;color:var(--text);margin:2px 0;">• ${i}</p>`).join('')}${moreHtml}</div>`;
        }
    }

    return `<div class="app-card ${p.featured?'card-featured':''}" style="position:relative;">${membersBadge}${featuredBadge}
        <div style="display:flex;justify-content:space-between;align-items:flex-start;"><span class="card-tag">🍴 ${p.cuisine || 'Food & Drink'}</span></div>
        <h3 class="card-title" style="margin-top:6px;">${p.name}</h3>
        ${ratingRow}${addr}
        <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:8px;">${p.description||''}</p>
        ${specialsHtml}
        <div class="card-footer" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <button onclick="openReviewModal('${p.name.replace(/'/g,"\\'")}')" class="btn btn-sm btn-outline" style="font-size:0.75rem;">⭐ Review</button>
            <div style="flex:1;">${actionBtn}</div>
        </div>
    </div>`;
}

function buildServiceCard(p) {
    const catIcons={'Government':'🏛','Health':'🏥','Beauty/Grooming':'💈','Shopping':'🛒','Recreation':'🏞','Transport':'🚌','Finance':'🏦','Shipping':'📦','Entertainment':'🎵','Education':'📚','Mechanic':'🔧','Gas Station':'⛽','EV Charging':'🔌','Housing':'🏠'};
    const icon = catIcons[p.category] || '🏢';
    const stars = p.rating ? renderStars(p.rating) : '';
    const reviews = p.reviewCount ? `<span style="font-size:0.75rem;color:var(--text-muted);margin-left:4px;">(${p.reviewCount} review${p.reviewCount>1?'s':''})</span>` : '';
    const ratingRow = stars ? `<div style="margin:4px 0 6px;">${stars}${reviews}</div>` : '';
    const hours = p.hours ? `<p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">🕐 ${p.hours}</p>` : '';
    const phone = p.phone ? `<a href="tel:${p.phone.replace(/[^+\d]/g,'')}" style="font-weight:600;font-size:0.85rem;color:var(--text);text-decoration:none;">📞 ${p.phone}</a>` : '';
    const site = p.gasLink ? `<a href="${p.gasLink}" target="_blank" class="btn btn-sm btn-outline" style="font-size:0.75rem;">⛽ Prices</a>` :
                 p.link ? `<a href="${p.link}" target="_blank" class="btn btn-sm btn-outline" style="font-size:0.75rem;">🌐 Visit</a>` : '';
    return `<div class="app-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <span class="card-tag">${icon} ${p.category}</span>
        </div>
        <h3 class="card-title" style="margin-top:6px;">${p.name}</h3>
        ${ratingRow}
        <p class="card-meta" style="margin-bottom:4px;">📍 ${p.address}</p>
        ${hours}
        <p style="font-size:0.85rem;color:var(--text-muted);margin:8px 0;">${p.description}</p>
        <div class="card-footer" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            ${phone}
            <div style="display:flex;gap:6px;align-items:center;">
                <button onclick="openReviewModal('${p.name.replace(/'/g,"\\'")}')" class="btn btn-sm btn-outline" style="font-size:0.75rem;">⭐ Review</button>
                ${site}
            </div>
        </div>
    </div>`;
}
// ==================== COMMUNITY BOARD ====================
let allBoardPosts=[], boardFilter='All';
async function loadBoard(){try{allBoardPosts=await(await fetch('board.json')).json();renderBoard();}catch(e){
    document.getElementById('board-container').innerHTML='<p class="empty-state">No community posts yet. Be the first to post!</p>';
}}
window.setBoardFilter=function(cat,btn){
    boardFilter=cat;
    document.querySelectorAll('#board-filter-group .src-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    renderBoard();
};
function renderBoard(){
    const c=document.getElementById('board-container');
    const filtered=boardFilter==='All'?allBoardPosts:allBoardPosts.filter(p=>p.category===boardFilter);
    if(filtered.length===0){c.innerHTML='<p class="empty-state">No posts in this category.</p>';return;}
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    c.innerHTML=filtered.map(p=>{
        const catIcons={'Yard Sale':'🏷️','Lost Pet':'🐾','Found Pet':'🐾','Help Wanted':'💼','For Sale':'🛒','Free Stuff':'🎁','Community Notice':'📢'};
        const icon=catIcons[p.category]||'📋';
        const img=p.image?`<div class="card-img-wrap"><img src="${p.image}" alt="" loading="lazy" class="card-img"></div>`:'';
        const contact=p.contact?`<p style="font-size:0.85rem;margin-top:8px;">📧 ${p.contact}</p>`:'';
        const loc=p.location?`<p class="card-meta">📍 ${p.location}</p>`:'';
        const urgentClass=(p.category==='Lost Pet')?'style="border-left:4px solid #dc2626;"':'';

        // Age + expiry badges. Scraper now writes postedAt/expiresAt as ISO
        // strings (per BOARD_TTL_DAYS: 7d for Free Stuff, 14d for Lost/Found
        // Pet, 21d for Yard Sale, 30d for Help Wanted/For Sale/Community
        // Notice). Older posts predating the TTL fields keep their legacy
        // p.date display. Future posts (dated beyond today) label as "posted
        // today" since they're freshly approved from the sheet.
        let ageBadge = '';
        let expiryBadge = '';
        if (p.postedAt) {
            const postedMs = new Date(p.postedAt).getTime();
            if (!isNaN(postedMs)) {
                const ageDays = Math.floor((now - postedMs) / dayMs);
                let ageText;
                if (ageDays <= 0) ageText = 'Posted today';
                else if (ageDays === 1) ageText = 'Posted yesterday';
                else if (ageDays < 7) ageText = `Posted ${ageDays} days ago`;
                else if (ageDays < 14) ageText = 'Posted over a week ago';
                else ageText = `Posted ${Math.floor(ageDays / 7)} weeks ago`;
                ageBadge = `<span class="board-badge board-badge-age">${ageText}</span>`;
            }
        }
        if (p.expiresAt) {
            const expMs = new Date(p.expiresAt).getTime();
            if (!isNaN(expMs)) {
                const daysLeft = Math.ceil((expMs - now) / dayMs);
                // Only show if within 3 days of expiry (the "urgent" window).
                // Posts with more time get no expiry badge — reduces clutter.
                if (daysLeft <= 0) {
                    expiryBadge = `<span class="board-badge board-badge-expiring-now">Expiring today</span>`;
                } else if (daysLeft === 1) {
                    expiryBadge = `<span class="board-badge board-badge-expiring-soon">Expires tomorrow</span>`;
                } else if (daysLeft <= 3) {
                    expiryBadge = `<span class="board-badge board-badge-expiring-soon">Expires in ${daysLeft} days</span>`;
                }
            }
        }

        // Footer meta row: fall back to the original p.date string only when
        // we have nothing dynamic to say (very old posts or posts with no
        // postedAt). Keeps legacy display without forcing every post to
        // wait for a scraper-regen to show anything at all.
        const footerMeta = (ageBadge || expiryBadge)
            ? `<div class="board-meta-row">${ageBadge}${expiryBadge}</div>`
            : (p.date ? `<p style="font-size:0.7rem;color:var(--text-muted);margin-top:6px;">${p.date}</p>` : '');

        return `<div class="app-card" ${urgentClass}>${img}<span class="card-tag">${icon} ${p.category}</span><h3 class="card-title">${p.title}</h3>${loc}<p style="font-size:0.85rem;color:var(--text-muted);margin:6px 0;">${p.description||''}</p>${contact}${footerMeta}</div>`;
    }).join('');
}

window.openSubmitBusiness=function(){
    openAdvertiseForm();
};

window.openBoardPost=function(){
    const overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
    overlay.onclick=function(ev){if(ev.target===overlay)overlay.remove();};
    const modal=document.createElement('div');
    modal.style.cssText='background:var(--surface);border-radius:var(--radius);max-width:520px;width:100%;max-height:90vh;overflow-y:auto;padding:28px;position:relative;';
    const cats=['Yard Sale','Lost Pet','Found Pet','Help Wanted','For Sale','Free Stuff','Community Notice'];
    modal.innerHTML=`
        <button onclick="this.closest('div[style*=fixed]').remove()" class="modal-close-btn">✕</button>
        <h3 style="margin-bottom:4px;">📋 Post to Community Board</h3>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:16px;">Share with your Millersville neighbors. Posts are reviewed before publishing.</p>
        <div id="board-form-fields">
            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Category *</label>
            <select id="bp-cat" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">
                ${cats.map(c=>`<option value="${c}">${c}</option>`).join('')}
            </select>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Title *</label>
            <input id="bp-title" type="text" placeholder="e.g. Multi-family Yard Sale Saturday" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Description *</label>
            <textarea id="bp-desc" rows="3" placeholder="Details about your post..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;resize:vertical;background:var(--bg);color:var(--text);"></textarea>

            <div style="display:flex;gap:12px;margin-bottom:12px;">
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Contact Info *</label>
                    <input id="bp-contact" type="text" placeholder="Phone or email" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Location</label>
                    <input id="bp-loc" type="text" placeholder="Neighborhood or address" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
            </div>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Image URL (optional)</label>
            <input id="bp-img" type="url" placeholder="https://..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:16px;background:var(--bg);color:var(--text);">

            <button id="bp-submit-btn" onclick="submitBoardPost()" class="btn btn-sm btn-ticket" style="display:block;width:100%;text-align:center;padding:12px;font-size:0.95rem;">Submit Post</button>
        </div>
        <div id="bp-success" style="display:none;text-align:center;padding:24px 0;">
            <p style="font-size:1.5rem;margin-bottom:8px;">✅</p>
            <h3 style="margin-bottom:8px;">Post Submitted!</h3>
            <p style="font-size:0.85rem;color:var(--text-muted);">Thanks for sharing! Your post will appear after review.</p>
        </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

window.submitBoardPost=function(){
    const cat=document.getElementById('bp-cat').value;
    const title=document.getElementById('bp-title').value.trim();
    const desc=document.getElementById('bp-desc').value.trim();
    const contact=document.getElementById('bp-contact').value.trim();
    const loc=document.getElementById('bp-loc').value.trim();
    const img=document.getElementById('bp-img').value.trim();

    if(!title||!desc||!contact){alert('Please fill in Title, Description, and Contact Info.');return;}

    const btn=document.getElementById('bp-submit-btn');
    btn.textContent='Submitting...';btn.disabled=true;

    const formData=new URLSearchParams();
    formData.append('entry.1277308076',cat);
    formData.append('entry.1203434084',title);
    formData.append('entry.255927381',desc);
    formData.append('entry.214344890',contact);
    formData.append('entry.768523464',loc);
    formData.append('entry.1488331868',img);

    fetch('https://docs.google.com/forms/d/e/1FAIpQLSeCLBn-aWzznszV25pbH9iZhNzkpZyl-48jCiCArjHQA0iphQ/formResponse',{
        method:'POST',mode:'no-cors',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:formData.toString()
    }).then(()=>{
        document.getElementById('board-form-fields').style.display='none';
        document.getElementById('bp-success').style.display='block';
    }).catch(()=>{
        document.getElementById('board-form-fields').style.display='none';
        document.getElementById('bp-success').style.display='block';
    });
};

// ==================== BUSINESS REVIEWS ====================
// TODO: Replace these with actual Google Form ID and entry IDs after creating the form
const REVIEW_FORM_ID = '1FAIpQLSfhrXMwntQtaSgEru41iDOlsMgD8GrtqkIsbGaL8dwPqODUaA';
const REVIEW_FIELDS = { business: 'entry.1618716598', rating: 'entry.417623384', review: 'entry.1736323342', name: 'entry.2003641787' };

window.openReviewModal = function(businessName) {
    // Build dropdown from loaded services data
    const bizOptions = (allPlaces || []).map(s => `<option value="${s.name}" ${s.name===businessName?'selected':''}>${s.name}</option>`).join('');

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
    overlay.onclick = function(ev) { if (ev.target === overlay) overlay.remove(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:420px;width:100%;max-height:90vh;overflow-y:auto;padding:28px;position:relative;';
    modal.innerHTML = `
        <button onclick="this.closest('div[style*=fixed]').remove()" class="modal-close-btn">✕</button>
        <h3 style="margin-bottom:12px;">⭐ Leave a Review</h3>
        <div id="rv-form-fields">
            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Business *</label>
            <select id="rv-business" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">
                ${bizOptions}
            </select>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:8px;">Your Rating *</label>
            <div id="rv-stars" style="display:flex;gap:8px;margin-bottom:16px;">
                ${[1,2,3,4,5].map(n => `<button onclick="setReviewRating(${n})" class="rv-star" data-val="${n}" style="background:none;border:none;font-size:2rem;cursor:pointer;color:var(--border);transition:color 0.15s;">★</button>`).join('')}
            </div>
            <input type="hidden" id="rv-rating" value="">

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Review (optional)</label>
            <textarea id="rv-text" rows="3" placeholder="What was your experience?" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;resize:vertical;background:var(--bg);color:var(--text);"></textarea>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Your Name (optional)</label>
            <input id="rv-name" type="text" placeholder="Anonymous" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:16px;background:var(--bg);color:var(--text);">

            <button id="rv-submit-btn" onclick="submitReview()" class="btn btn-sm btn-ticket" style="display:block;width:100%;text-align:center;padding:12px;font-size:0.95rem;">Submit Review</button>
        </div>
        <div id="rv-success" style="display:none;text-align:center;padding:24px 0;">
            <p style="font-size:1.5rem;margin-bottom:8px;">⭐</p>
            <h3 style="margin-bottom:8px;">Review Submitted!</h3>
            <p style="font-size:0.85rem;color:var(--text-muted);">Thanks for your feedback! Your review will be reflected after processing.</p>
        </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

window.setReviewRating = function(n) {
    document.getElementById('rv-rating').value = n;
    document.querySelectorAll('.rv-star').forEach(btn => {
        const val = parseInt(btn.dataset.val);
        btn.style.color = val <= n ? 'var(--gold)' : 'var(--border)';
    });
};

window.submitReview = function() {
    const businessName = document.getElementById('rv-business').value;
    const rating = document.getElementById('rv-rating').value;
    if (!rating) { alert('Please select a star rating.'); return; }
    const review = document.getElementById('rv-text').value.trim();
    const name = document.getElementById('rv-name').value.trim() || 'Anonymous';

    const btn = document.getElementById('rv-submit-btn');
    btn.textContent = 'Submitting...'; btn.disabled = true;

    const formData = new URLSearchParams();
    formData.append(REVIEW_FIELDS.business, businessName);
    formData.append(REVIEW_FIELDS.rating, rating);
    formData.append(REVIEW_FIELDS.review, review);
    formData.append(REVIEW_FIELDS.name, name);

    fetch(`https://docs.google.com/forms/d/e/${REVIEW_FORM_ID}/formResponse`, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
    }).then(() => {
        document.getElementById('rv-form-fields').style.display = 'none';
        document.getElementById('rv-success').style.display = 'block';
    }).catch(() => {
        document.getElementById('rv-form-fields').style.display = 'none';
        document.getElementById('rv-success').style.display = 'block';
    });
};

// ==================== SPONSOR SYSTEM ====================
let sponsorData = { sponsors: [], config: { rotateIntervalMs: 15000, inlineAdEveryN: 9, placements: {} } };
let sponsorImpressions = {}; // { sponsorId: { impressions: N, clicks: N } }

// Full MU organization directory (loaded from clubs.json — includes orgs without current events)
let allClubsDirectory = [];

// Major → relevant clubs mapping (loaded from major-clubs-mapping.json on first
// club-browser open). Lazy-loaded since most users won't open the picker. Once
// fetched it stays in memory for the session.
let majorClubsMapping = null;
let majorClubsMappingLoadPromise = null;
function loadMajorClubsMapping() {
    if (majorClubsMapping) return Promise.resolve(majorClubsMapping);
    if (majorClubsMappingLoadPromise) return majorClubsMappingLoadPromise;
    majorClubsMappingLoadPromise = fetch('major-clubs-mapping.json')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            majorClubsMapping = data;
            return data;
        })
        .catch(err => {
            // File missing or malformed isn't a fatal error — picker just
            // hides the major dropdown. Search still works.
            console.warn('Major mapping unavailable:', err);
            majorClubsMapping = null;
            return null;
        });
    return majorClubsMappingLoadPromise;
}

// Match a club against a major spec from the mapping. Returns true if any
// keyword (substring of name or category) matches, OR any of the major's
// listed categories matches one of the club's categories. Case-insensitive.
function clubMatchesMajor(club, majorSpec) {
    if (!club || !majorSpec) return false;
    const nameLower = (club.name || '').toLowerCase();
    const catLower = (club.category || '').toLowerCase();
    const cats = (club.categories || []).map(c => (c || '').toLowerCase());
    // Pool the singular .category string with the .categories array for
    // robust matching — some clubs (especially event-derived ones) only
    // have the singular field populated.
    const allCats = catLower ? [...cats, catLower] : cats;
    const keywords = majorSpec.keywords || [];
    for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        if (nameLower.includes(kwLower)) return true;
        if (catLower.includes(kwLower)) return true;
    }
    const majorCats = (majorSpec.categories || []).map(c => c.toLowerCase());
    for (const mc of majorCats) {
        if (allCats.some(c => c.includes(mc))) return true;
    }
    return false;
}
async function loadClubsDirectory() {
    try {
        const res = await fetch('clubs.json');
        if (!res.ok) return;
        allClubsDirectory = await res.json();
    } catch (e) {
        // Non-fatal — the club browser falls back to events-derived list
        console.log('Clubs directory not available');
    }
}

async function loadSponsors() {
    try {
        sponsorData = await (await fetch('sponsors.json')).json();
        const now = new Date();
        // Filter active sponsors within date range
        sponsorData.sponsors = sponsorData.sponsors.filter(s => {
            if (!s.active) return false;
            if (s.startDate && new Date(s.startDate) > now) return false;
            if (s.endDate && new Date(s.endDate) < now) return false;
            return true;
        });
        renderHomeSponsors();
        startSponsorRotation();
        renderAnalytics();
    } catch (e) { console.log('Sponsors load error:', e.message); renderHomeSponsors(); }
}

function trackImpression(sponsorId, placement) {
    if (!sponsorImpressions[sponsorId]) sponsorImpressions[sponsorId] = { impressions: 0, clicks: 0 };
    sponsorImpressions[sponsorId].impressions++;
    if (typeof gtag === 'function') {
        gtag('event', 'ad_impression', { sponsor_id: sponsorId, placement: placement, sponsor_name: sponsorData.sponsors.find(s => s.id === sponsorId)?.name || sponsorId });
    }
}

function trackClick(sponsorId, placement) {
    if (!sponsorImpressions[sponsorId]) sponsorImpressions[sponsorId] = { impressions: 0, clicks: 0 };
    sponsorImpressions[sponsorId].clicks++;
    if (typeof gtag === 'function') {
        gtag('event', 'ad_click', { sponsor_id: sponsorId, placement: placement, sponsor_name: sponsorData.sponsors.find(s => s.id === sponsorId)?.name || sponsorId });
    }
}

function buildSponsorCard(s, placement) {
    const clickHandler = s.internal
        ? `event.preventDefault();trackClick('${s.id}','${placement}');switchView('${s.link.replace('/','')}')`
        : `trackClick('${s.id}','${placement}')`;
    const href = s.internal ? '#' : s.link;
    const target = s.internal ? '' : 'target="_blank"';
    return `<a href="${href}" ${target} class="sponsor-card ${s.tierClass||'sponsor-featured'}" onclick="${clickHandler}" data-sponsor="${s.id}" data-placement="${placement}">
        <span class="sponsor-tier">${s.tier}</span>
        <h4 class="sponsor-name">${s.name}</h4>
        <span class="sponsor-cta">${s.cta}</span>
    </a>`;
}

function renderHomeSponsors() {
    const container = document.getElementById('home-sponsors');
    if (!container) return;
    const homeSponsors = sponsorData.sponsors.filter(s => s.placements.includes('homepage'));
    if (homeSponsors.length === 0) {
        container.innerHTML = '<p class="empty-state">Interested in sponsoring? <a href="#" onclick="event.preventDefault();switchView(\'advertise\')">Learn more →</a></p>';
        return;
    }
    container.innerHTML = homeSponsors.map(s => buildSponsorCard(s, 'homepage')).join('');
    // Track impressions for visible sponsors
    homeSponsors.forEach(s => trackImpression(s.id, 'homepage'));
}

function buildInlineAd(placement) {
    const pool = sponsorData.sponsors.filter(s => s.placements.includes(placement));
    if (pool.length === 0) return '';
    const s = pool[Math.floor(Math.random() * pool.length)];
    trackImpression(s.id, placement + '-inline');
    const clickHandler = s.internal
        ? `event.preventDefault();trackClick('${s.id}','${placement}-inline');switchView('${s.link.replace('/','')}')`
        : `trackClick('${s.id}','${placement}-inline')`;
    const href = s.internal ? '#' : s.link;
    const target = s.internal ? '' : 'target="_blank"';
    return `<a href="${href}" ${target} class="app-card sponsor-inline" onclick="${clickHandler}" data-sponsor="${s.id}" style="background:linear-gradient(135deg,var(--gold-soft),var(--surface));border:1px solid var(--gold);text-decoration:none;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;cursor:pointer;">
        <span style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--gold);letter-spacing:1px;margin-bottom:4px;">Sponsored</span>
        <h4 style="font-size:1rem;font-weight:700;color:var(--text);margin-bottom:4px;">${s.name}</h4>
        <span style="font-size:0.85rem;color:var(--text-muted);">${s.cta}</span>
    </a>`;
}

// Inject inline ads into card grids after rendering
function injectInlineAds(containerId, placement) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const n = sponsorData.config.inlineAdEveryN || 9;
    const cards = container.querySelectorAll('.app-card:not(.sponsor-inline)');
    // Remove existing inline ads
    container.querySelectorAll('.sponsor-inline').forEach(el => el.remove());
    if (cards.length < n) return; // Not enough cards to warrant an ad
    const pool = sponsorData.sponsors.filter(s => s.placements.includes(placement));
    if (pool.length === 0) return;
    // Insert after every Nth card
    let inserted = 0;
    cards.forEach((card, i) => {
        if ((i + 1) % n === 0) {
            const ad = document.createElement('div');
            ad.innerHTML = buildInlineAd(placement);
            const adEl = ad.firstElementChild;
            if (adEl) { card.after(adEl); inserted++; }
        }
    });
}

let rotationInterval = null;
function startSponsorRotation() {
    if (rotationInterval) clearInterval(rotationInterval);
    const interval = sponsorData.config.rotateIntervalMs || 15000;
    rotationInterval = setInterval(() => {
        // Rotate homepage sponsors order
        const container = document.getElementById('home-sponsors');
        if (!container || container.children.length <= 1) return;
        const first = container.firstElementChild;
        if (first) {
            first.style.transition = 'opacity 0.3s';
            first.style.opacity = '0';
            setTimeout(() => {
                container.appendChild(first);
                first.style.opacity = '1';
                // Track impression for the newly visible first sponsor
                const newFirst = container.firstElementChild;
                if (newFirst?.dataset?.sponsor) {
                    trackImpression(newFirst.dataset.sponsor, 'homepage-rotate');
                }
            }, 300);
        }
    }, interval);
}

function renderAnalytics() {
    const dash = document.getElementById('analytics-dashboard');
    if (!dash) return;
    const now = new Date();
    let html = '';
    sponsorData.sponsors.forEach(s => {
        const stats = sponsorImpressions[s.id] || { impressions: 0, clicks: 0 };
        const ctr = stats.impressions > 0 ? ((stats.clicks / stats.impressions) * 100).toFixed(1) : '0.0';
        const endDate = s.endDate ? new Date(s.endDate) : null;
        const daysLeft = endDate ? Math.ceil((endDate - now) / (1000*60*60*24)) : '∞';
        html += `<div class="app-card" style="margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                <div>
                    <span class="card-tag">${s.tier}</span>
                    <h3 class="card-title" style="margin-top:6px;">${s.name}</h3>
                </div>
                <span class="badge" style="background:var(--green);color:white;font-size:0.7rem;">Active</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px;">
                <div style="text-align:center;"><p style="font-size:1.2rem;font-weight:700;">${stats.impressions}</p><p style="font-size:0.7rem;color:var(--text-muted);">Impressions</p></div>
                <div style="text-align:center;"><p style="font-size:1.2rem;font-weight:700;">${stats.clicks}</p><p style="font-size:0.7rem;color:var(--text-muted);">Clicks</p></div>
                <div style="text-align:center;"><p style="font-size:1.2rem;font-weight:700;">${ctr}%</p><p style="font-size:0.7rem;color:var(--text-muted);">CTR</p></div>
                <div style="text-align:center;"><p style="font-size:1.2rem;font-weight:700;">${daysLeft}</p><p style="font-size:0.7rem;color:var(--text-muted);">Days Left</p></div>
            </div>
            <div style="margin-top:12px;font-size:0.8rem;color:var(--text-muted);">
                Placements: ${s.placements.join(', ')}
            </div>
        </div>`;
    });
    if (!html) html = '<p class="empty-state">No active sponsors.</p>';
    dash.innerHTML = html;
}
// ==================== END SPONSOR SYSTEM ====================

// Grocery deals popup
let allGroceryDeals = [];
window.showGroceryDeals = function(e) {
    if(e) e.stopPropagation();
    if(allGroceryDeals.length === 0) return;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.onclick = function(ev){ if(ev.target===overlay) overlay.remove(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:480px;width:100%;max-height:80vh;overflow-y:auto;padding:24px;position:relative;';
    const dateRange = allGroceryDeals[0]?.dateRange || '';
    modal.innerHTML = `<button onclick="this.closest('div[style*=fixed]').remove()" class="modal-close-btn">✕</button>
        <h3 style="margin-bottom:4px;">🏷️ John Herr's Weekly Deals</h3>
        ${dateRange ? `<p style="font-size:0.8rem;color:var(--gold);font-weight:600;margin-bottom:12px;">${dateRange}</p>` : ''}
        ${allGroceryDeals.map((d,i) => `<div style="padding:8px 0;${i>0?'border-top:1px solid var(--border);':''}">
            <span style="font-weight:600;">${d.item}</span>
            <span style="color:var(--gold);font-weight:700;float:right;">${d.salePrice}</span>
            ${d.regularPrice ? `<br><span style="font-size:0.75rem;color:var(--text-muted);text-decoration:line-through;">${d.regularPrice}</span>` : ''}
            ${d.savings ? `<span style="font-size:0.75rem;color:#16a34a;margin-left:6px;">${d.savings}</span>` : ''}
        </div>`).join('')}
        <a href="https://www.johnherrsvillagemarket.com/weekly-ad" target="_blank" class="btn btn-sm btn-ticket" style="display:block;text-align:center;margin-top:16px;">View Full Circular</a>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

// Global Search
window.openSearch = function() {
    const overlay = document.createElement('div');
    overlay.id = 'search-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:var(--bg);z-index:9999;display:flex;flex-direction:column;';
    overlay.innerHTML = `
        <div style="padding:16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border);background:var(--surface);">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="search-input" type="text" placeholder="Search events, news, food, services..." autofocus style="flex:1;padding:10px;border:none;font-family:inherit;font-size:1rem;background:transparent;color:var(--text);outline:none;">
            <button onclick="document.getElementById('search-overlay').remove()" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-muted);padding:4px 8px;">✕</button>
        </div>
        <div id="search-results" style="flex:1;overflow-y:auto;padding:16px;"></div>`;
    document.body.appendChild(overlay);
    const input = document.getElementById('search-input');
    // Debounce search input — runSearch does a full filter + DOM rebuild on
    // ~1200 events, which feels laggy on phones for longer queries. 120ms
    // wait gives the user time to finish typing a word before we re-render.
    // Empty input still clears immediately (no debounce on the cleared state)
    // since users tend to expect Backspace-to-clear to feel instant.
    let searchDebounceTimer = null;
    input.addEventListener('input', function(){
        const val = this.value;
        clearTimeout(searchDebounceTimer);
        if (!val) {
            // Cleared input: respond immediately, no delay
            runSearch('');
            return;
        }
        searchDebounceTimer = setTimeout(() => runSearch(val), 120);
    });
    input.addEventListener('keydown', function(ev){ if(ev.key==='Escape') overlay.remove(); });
    document.getElementById('search-results').innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px;">Start typing to search across all content</p>';
    // Focus the input — autofocus attribute isn't reliable for dynamically-injected elements
    // Small delay ensures the browser has painted the overlay before focusing (prevents iOS keyboard jank)
    setTimeout(() => input.focus(), 50);
};

function runSearch(q) {
    const results = document.getElementById('search-results');
    if (!q || q.length < 2) {
        results.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px;">Start typing to search across all content</p>';
        return;
    }
    const ql = q.toLowerCase();
    let html = '';

    // Search Events (non-sport, upcoming)
    const now = new Date();
    const nowMs = now.getTime();
    const eventHits = allEvents.filter(e => {
        if ((e._dateMs || 0) < nowMs) return false;
        const text = (e.title + ' ' + e.location + ' ' + (e.tags||[]).join(' ')).toLowerCase();
        return text.includes(ql);
    }).slice(0, 6);
    if (eventHits.length) {
        html += `<div style="margin-bottom:20px;"><h4 class="modal-section-label">📅 Events</h4>`;
        eventHits.forEach(e => {
            const d = new Date(e.date);
            const src = (e.tags||[])[0] || '';
            const eventKey = (e.sourceLink || (e.title + '|' + e.date)).replace(/"/g, '&quot;').replace(/'/g, "\\'");
            const clickAction = `document.getElementById('search-overlay').remove();window.openEventDetails('${eventKey}');`;
            // Student-only badge + "not in your feed" note for townies
            const hiddenForMe = isHiddenForTownie(e);
            const muOnlyBadge = hiddenForMe
                ? '<span style="display:inline-block;background:var(--gold-soft);color:var(--navy);border:1px solid var(--gold);font-size:0.68rem;font-weight:600;padding:1px 6px;border-radius:10px;margin-left:6px;vertical-align:1px;">🎓 MU students only</span>'
                : '';
            const hiddenNote = hiddenForMe
                ? '<div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;font-style:italic;">Not shown in your feed — you marked yourself as a townie</div>'
                : '';
            html += `<div class="search-result" onclick="${clickAction}">
                <span style="font-size:0.7rem;color:var(--text-muted);">${src}</span>${muOnlyBadge}
                <p style="font-weight:600;margin:2px 0;">${e.title}</p>
                <span style="font-size:0.8rem;color:var(--text-muted);">${formatDate(d)} · ${cleanLocation(e.location)}</span>
                ${hiddenNote}
            </div>`;
        });
        html += '</div>';
    }

    // Search Sports (upcoming games)
    const sportHits = allEvents.filter(e => {
        const tags = e.tags || [];
        if (!tags.includes('Athletic Competitions') && !tags.includes('Athletics')) return false;
        if ((e._dateMs || 0) < nowMs) return false;
        const text = (e.title + ' ' + e.location + ' ' + tags.join(' ')).toLowerCase();
        return text.includes(ql);
    }).slice(0, 6);
    if (sportHits.length) {
        html += `<div style="margin-bottom:20px;"><h4 class="modal-section-label">🏆 Sports</h4>`;
        sportHits.forEach(e => {
            const d = new Date(e.date);
            const src = (e.tags||[])[0] || '';
            const eventKey = (e.sourceLink || (e.title + '|' + e.date)).replace(/"/g, '&quot;').replace(/'/g, "\\'");
            const clickAction = `document.getElementById('search-overlay').remove();window.openEventDetails('${eventKey}');`;
            html += `<div class="search-result" onclick="${clickAction}">
                <span style="font-size:0.7rem;color:var(--text-muted);">${src}</span>
                <p style="font-weight:600;margin:2px 0;">${e.title}</p>
                <span style="font-size:0.8rem;color:var(--text-muted);">${formatDate(d)} · ${cleanLocation(e.location)}</span>
            </div>`;
        });
        html += '</div>';
    }

    // Search News
    const newsHits = (currentNews||[]).filter(n => {
        // Respect affiliation-based source hiding (marauders don't see PM/Borough
        // news in search unless they've favorited one).
        if (isNewsFromHiddenSource(n)) return false;
        return (n.title + ' ' + n.source).toLowerCase().includes(ql);
    }).slice(0, 5);
    if (newsHits.length) {
        html += `<div style="margin-bottom:20px;"><h4 class="modal-section-label">📰 News</h4>`;
        newsHits.forEach(n => {
            html += `<div class="search-result" onclick="window.open('${n.link}','_blank')">
                <span style="font-size:0.7rem;color:var(--text-muted);">${n.source}</span>
                <p style="font-weight:600;margin:2px 0;">${n.title}</p>
                <span style="font-size:0.8rem;color:var(--text-muted);">${n.date || ''}</span>
            </div>`;
        });
        html += '</div>';
    }

    // Search Places (food + services)
    const svcHits = (allPlaces||[]).filter(s => {
        return (s.name + ' ' + (s.category||'') + ' ' + (s.cuisine||'') + ' ' + (s.description||'')).toLowerCase().includes(ql);
    }).slice(0, 5);
    if (svcHits.length) {
        html += `<div style="margin-bottom:20px;"><h4 class="modal-section-label">📍 Places</h4>`;
        svcHits.forEach(s => {
            html += `<div class="search-result" onclick="document.getElementById('search-overlay').remove();switchView('places');">
                <p style="font-weight:600;margin:2px 0;">${s.name}</p>
                <span style="font-size:0.8rem;color:var(--text-muted);">${s.category||s.cuisine||''} · ${s.description?.substring(0,60)||''}</span>
            </div>`;
        });
        html += '</div>';
    }

    // Search Community Board
    const boardHits = (allBoardPosts||[]).filter(p => {
        return (p.title + ' ' + p.category + ' ' + (p.description||'') + ' ' + (p.location||'')).toLowerCase().includes(ql);
    }).slice(0, 5);
    if (boardHits.length) {
        html += `<div style="margin-bottom:20px;"><h4 class="modal-section-label">📋 Community Board</h4>`;
        boardHits.forEach(p => {
            html += `<div class="search-result" onclick="document.getElementById('search-overlay').remove();switchView('board');">
                <span style="font-size:0.7rem;color:var(--text-muted);">${p.category}</span>
                <p style="font-weight:600;margin:2px 0;">${p.title}</p>
                <span style="font-size:0.8rem;color:var(--text-muted);">${p.location||''} · ${p.date||''}</span>
            </div>`;
        });
        html += '</div>';
    }

    if (!html) {
        html = `<p style="color:var(--text-muted);text-align:center;margin-top:40px;">No results for "${q}"</p>`;
    }
    results.innerHTML = html;
}

window.refreshCam=function(){const cam=document.getElementById('cam-img');if(cam)cam.src=`https://snowball.millersville.edu/~cws/wxcam/latest.jpeg?t=${Date.now()}`;const t=document.getElementById('cam-time');if(t)t.textContent=`Updated: ${new Date().toLocaleTimeString()}`;};

// Advertise Form
window.openAdvertiseForm = function() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
    overlay.onclick = function(ev){ if(ev.target===overlay) overlay.remove(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:520px;width:100%;max-height:90vh;overflow-y:auto;padding:28px;position:relative;';
    const tiers = ['Premium','Standard','Basic','Not Sure'];
    modal.innerHTML = `
        <button onclick="this.closest('div[style*=fixed]').remove()" class="modal-close-btn">✕</button>
        <h3 style="margin-bottom:4px;">📢 Advertise With Us</h3>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:16px;">Tell us about your business and we'll get back to you within 24 hours.</p>
        <div id="adv-form-fields">
            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Business Name *</label>
            <input id="adv-biz" type="text" placeholder="e.g. Joe's Pizza" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Contact Name *</label>
            <input id="adv-name" type="text" placeholder="Your name" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <div style="display:flex;gap:12px;margin-bottom:12px;">
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Email *</label>
                    <input id="adv-email" type="email" placeholder="you@business.com" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Phone</label>
                    <input id="adv-phone" type="tel" placeholder="(717) 555-1234" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
            </div>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:6px;">Type of Interest *</label>
            <div id="adv-tiers" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
                ${tiers.map(t => `<label style="display:flex;align-items:center;gap:5px;font-size:0.85rem;padding:6px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;background:var(--bg);"><input type="checkbox" value="${t}" name="adv-tier" style="accent-color:var(--gold);"> ${t}</label>`).join('')}
            </div>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Tell us more</label>
            <textarea id="adv-msg" rows="3" placeholder="What are you looking for? Any questions?" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:16px;resize:vertical;background:var(--bg);color:var(--text);"></textarea>

            <button id="adv-submit-btn" onclick="submitAdvertise()" class="btn btn-sm btn-ticket" style="display:block;width:100%;text-align:center;padding:12px;font-size:0.95rem;">Submit →</button>
        </div>
        <div id="adv-success" style="display:none;text-align:center;padding:24px 0;">
            <p style="font-size:1.5rem;margin-bottom:8px;">✅</p>
            <h3 style="margin-bottom:8px;">We'll Be in Touch!</h3>
            <p style="font-size:0.85rem;color:var(--text-muted);">Thanks for your interest. We'll reach out within 24 hours to discuss the best placement for your business.</p>
        </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

window.submitAdvertise = function() {
    const biz = document.getElementById('adv-biz').value.trim();
    const name = document.getElementById('adv-name').value.trim();
    const email = document.getElementById('adv-email').value.trim();
    const phone = document.getElementById('adv-phone').value.trim();
    const msg = document.getElementById('adv-msg').value.trim();
    const tiers = [...document.querySelectorAll('input[name="adv-tier"]:checked')].map(c => c.value);

    if(!biz || !name || !email || tiers.length === 0) {
        alert('Please fill in Business Name, Contact Name, Email, and select at least one type of interest.');
        return;
    }

    const btn = document.getElementById('adv-submit-btn');
    btn.textContent = 'Submitting...';
    btn.disabled = true;

    const formData = new URLSearchParams();
    formData.append('entry.1812391001', biz);
    formData.append('entry.2112425545', name);
    formData.append('entry.336196442', email);
    formData.append('entry.1305587255', phone);
    formData.append('entry.1887090090', msg);
    tiers.forEach(t => formData.append('entry.1921946502', t));

    fetch('https://docs.google.com/forms/d/e/1FAIpQLSfSGk9g9R4YHuEbiIdY537G3UztmlXjzDgYFDgr1X5wsN7rqA/formResponse', {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
    }).then(() => {
        document.getElementById('adv-form-fields').style.display = 'none';
        document.getElementById('adv-success').style.display = 'block';
    }).catch(() => {
        document.getElementById('adv-form-fields').style.display = 'none';
        document.getElementById('adv-success').style.display = 'block';
    });
};

// Submit Event Form
window.openSubmitEvent = function() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
    overlay.onclick = function(ev){ if(ev.target===overlay) overlay.remove(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--surface);border-radius:var(--radius);max-width:520px;width:100%;max-height:90vh;overflow-y:auto;padding:28px;position:relative;';
    modal.innerHTML = `
        <button onclick="this.closest('div[style*=fixed]').remove()" class="modal-close-btn">✕</button>
        <h3 style="margin-bottom:4px;">📝 Submit an Event</h3>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:16px;">Share a community event with Millersville. Submissions are reviewed before publishing.</p>
        <div id="submit-event-form">
            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Event Name *</label>
            <input id="se-name" type="text" placeholder="e.g. Spring Community Festival" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <div style="display:flex;gap:12px;margin-bottom:12px;">
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Date *</label>
                    <input id="se-date" type="date" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
                <div style="flex:1;">
                    <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Time</label>
                    <input id="se-time" type="time" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;background:var(--bg);color:var(--text);">
                </div>
            </div>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Location *</label>
            <input id="se-location" type="text" placeholder="e.g. Millersville Borough Park" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Description</label>
            <textarea id="se-desc" rows="3" placeholder="Tell us about the event..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;resize:vertical;background:var(--bg);color:var(--text);"></textarea>

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Contact Email *</label>
            <input id="se-email" type="email" placeholder="your@email.com" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:12px;background:var(--bg);color:var(--text);">

            <label style="font-size:0.82rem;font-weight:700;display:block;margin-bottom:4px;">Website / Link</label>
            <input id="se-link" type="url" placeholder="https://..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;margin-bottom:16px;background:var(--bg);color:var(--text);">

            <button id="se-submit-btn" onclick="submitEvent()" class="btn btn-sm btn-ticket" style="display:block;width:100%;text-align:center;padding:12px;font-size:0.95rem;">Submit Event</button>
        </div>
        <div id="se-success" style="display:none;text-align:center;padding:24px 0;">
            <p style="font-size:1.5rem;margin-bottom:8px;">✅</p>
            <h3 style="margin-bottom:8px;">Event Submitted!</h3>
            <p style="font-size:0.85rem;color:var(--text-muted);">Thanks for sharing! Your event will appear on the site after review.</p>
        </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
};

window.submitEvent = function() {
    const name = document.getElementById('se-name').value.trim();
    const date = document.getElementById('se-date').value;
    const time = document.getElementById('se-time').value;
    const location = document.getElementById('se-location').value.trim();
    const desc = document.getElementById('se-desc').value.trim();
    const email = document.getElementById('se-email').value.trim();
    const link = document.getElementById('se-link').value.trim();

    if(!name || !date || !location || !email) {
        alert('Please fill in the required fields: Event Name, Date, Location, and Contact Email.');
        return;
    }

    const btn = document.getElementById('se-submit-btn');
    btn.textContent = 'Submitting...';
    btn.disabled = true;

    // Parse date and time for Google Form
    const [year, month, day] = date.split('-');
    let hour = '', minute = '';
    if(time) {
        const [h, m] = time.split(':');
        const h24 = parseInt(h);
        hour = String(h24 > 12 ? h24 - 12 : (h24 === 0 ? 12 : h24));
        minute = m;
    }

    const formData = new URLSearchParams();
    formData.append('entry.490875700', name);
    formData.append('entry.885260694_year', year);
    formData.append('entry.885260694_month', month);
    formData.append('entry.885260694_day', day);
    if(hour) {
        formData.append('entry.499967239_hour', hour);
        formData.append('entry.499967239_minute', minute);
    }
    formData.append('entry.461670075', location);
    formData.append('entry.1500961889', desc);
    formData.append('entry.6546809', email);
    formData.append('entry.946075783', link);

    fetch('https://docs.google.com/forms/d/e/1FAIpQLSeBPjHbqbhZ9YTYK4s5xZzi3nxfPcID_zDKq5HkUlhuh7LWfw/formResponse', {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
    }).then(() => {
        document.getElementById('submit-event-form').style.display = 'none';
        document.getElementById('se-success').style.display = 'block';
    }).catch(() => {
        document.getElementById('submit-event-form').style.display = 'none';
        document.getElementById('se-success').style.display = 'block';
    });
};
