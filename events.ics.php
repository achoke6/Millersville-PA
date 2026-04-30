<?php
// Millersville.APP — iCal subscription endpoint.
//
// Calendar apps (Apple Calendar, Google Calendar, Outlook) poll this URL
// every few hours and refresh their local copy. The user's favorites are
// encoded in the URL as comma-separated feed-pref IDs:
//
//   /events.ics?p=mu-football,clubs-arts,club:RUF,family-events
//
// On each request we load the same events.json the static site uses, run
// each event through a PHP port of app.js's eventMatchesFeed(), and emit
// the matching events as RFC 5545 VEVENT entries.
//
// MAINTENANCE NOTE: the filter logic below mirrors eventMatchesFeed() in
// app.js. If you change the filter rules in app.js (new pref category,
// new tag mapping), update this file in lockstep — calendar subscribers
// will silently get the old behavior otherwise.

header('Content-Type: text/calendar; charset=utf-8');
header('Content-Disposition: inline; filename="millersville-favorites.ics"');
// 1 hour matches the scraper's cron cadence — no point serving newer.
// Calendar clients also honor REFRESH-INTERVAL/X-PUBLISHED-TTL inside
// the calendar body, but a Cache-Control header helps any CDN/proxy too.
header('Cache-Control: public, max-age=3600');

// Load events from the same JSON file the static site uses. Resolves to
// /events.json at the document root since this PHP file lives there too.
$eventsPath = __DIR__ . '/events.json';
if (!file_exists($eventsPath)) {
    http_response_code(503);
    echo "Events data unavailable. Try again in a few minutes.";
    exit;
}
$events = json_decode(file_get_contents($eventsPath), true);
if (!is_array($events)) {
    http_response_code(503);
    echo "Events data corrupted.";
    exit;
}

// Parse user's feed prefs from the ?p= query parameter. URL-decoded comma list.
$prefsRaw = isset($_GET['p']) ? (string)$_GET['p'] : '';
$prefs = array_values(array_filter(array_map('trim', explode(',', $prefsRaw)), 'strlen'));

// If no prefs supplied, return an empty-but-valid calendar with a hint
// inside it. Better than a confusing error — most calendar apps will show
// the calendar name regardless and the user can troubleshoot from there.
$emptyHint = empty($prefs);

// Filter the events.
$filtered = $emptyHint ? [] : array_values(array_filter($events, 'eventMatchesFeed'));

// Sort by start date so calendar imports preserve order on first add.
usort($filtered, function($a, $b) {
    $ta = parseInstant($a['date'] ?? '');
    $tb = parseInstant($b['date'] ?? '');
    return ($ta ? $ta->getTimestamp() : 0) <=> ($tb ? $tb->getTimestamp() : 0);
});

// Emit the calendar.
$lines = [];
$lines[] = 'BEGIN:VCALENDAR';
$lines[] = 'VERSION:2.0';
$lines[] = 'PRODID:-//Millersville.APP//Events Subscription//EN';
$lines[] = 'METHOD:PUBLISH';
$lines[] = 'CALSCALE:GREGORIAN';
$lines[] = 'X-WR-CALNAME:Millersville.APP — My Favorites';
$lines[] = 'X-WR-CALDESC:Filtered events from millersville.app, refreshed hourly.';
$lines[] = 'X-WR-TIMEZONE:America/New_York';
// Refresh hints. PT1H = 1 hour. Apple Calendar honors REFRESH-INTERVAL;
// Outlook/Microsoft prefers X-PUBLISHED-TTL. Sending both covers everyone.
$lines[] = 'REFRESH-INTERVAL;VALUE=DURATION:PT1H';
$lines[] = 'X-PUBLISHED-TTL:PT1H';

if ($emptyHint) {
    // Single placeholder VEVENT explaining the empty state. Better UX than
    // a calendar that shows nothing — at least the user knows it loaded.
    $now = gmdate('Ymd\THis\Z');
    $lines[] = 'BEGIN:VEVENT';
    $lines[] = 'UID:no-prefs-' . md5($prefsRaw) . '@millersville.app';
    $lines[] = 'DTSTAMP:' . $now;
    $lines[] = 'DTSTART:' . $now;
    $lines[] = 'DTEND:' . $now;
    $lines[] = 'SUMMARY:' . icsEscape('No favorites in subscription URL');
    $lines[] = 'DESCRIPTION:' . icsEscape("This subscription URL didn't include any favorites. Visit https://millersville.app, set your favorites in the ⭐ menu, then re-generate your subscription URL.");
    $lines[] = 'END:VEVENT';
} else {
    foreach ($filtered as $e) {
        $vevent = buildVevent($e);
        if ($vevent !== null) {
            foreach ($vevent as $line) $lines[] = $line;
        }
    }
}

$lines[] = 'END:VCALENDAR';

// Output with CRLF line endings and 75-octet folding per RFC 5545.
$folded = array_map('icsFold', $lines);
echo implode("\r\n", $folded) . "\r\n";


// =====================================================================
// HELPERS
// =====================================================================

/**
 * Parse an event date string into a DateTime. Mirrors parseEventInstant
 * in scrape.js — naive strings without TZ marker are treated as ET wall
 * clock, ISO-with-Z strings as UTC, ISO-with-offset strings as their
 * declared offset.
 */
function parseInstant($s) {
    if (!$s) return null;
    $s = trim($s);
    try {
        if (preg_match('/(?:Z|[+-]\d{2}:?\d{2})$/i', $s)) {
            return new DateTime($s);
        }
        return new DateTime($s, new DateTimeZone('America/New_York'));
    } catch (Exception $ex) {
        return null;
    }
}

/**
 * Build the VEVENT block for one event. Returns array of lines (unfolded)
 * or null if the event lacks essential data.
 */
function buildVevent($e) {
    $title = isset($e['title']) ? (string)$e['title'] : '';
    $date  = isset($e['date'])  ? (string)$e['date']  : '';
    if (!$title || !$date) return null;

    $dt = parseInstant($date);
    if (!$dt) return null;

    // Convert to UTC for emit. Most calendar clients handle UTC reliably;
    // emitting TZID-prefixed times would require a VTIMEZONE block which
    // is a lot of fiddly RFC 5545 boilerplate for marginal benefit.
    $dt->setTimezone(new DateTimeZone('UTC'));
    $dtstart = $dt->format('Ymd\THis\Z');

    // Default duration: 2 hours for athletic events (games tend to run
    // longer than 1 hour), 1 hour otherwise. events.json doesn't carry
    // explicit end times so this is a heuristic.
    $tags = isset($e['tags']) && is_array($e['tags']) ? $e['tags'] : [];
    $isAthletic = in_array('Athletics', $tags, true) || in_array('Athletic Competitions', $tags, true);
    $durationHours = $isAthletic ? 2 : 1;
    $dtEnd = clone $dt;
    $dtEnd->modify('+' . $durationHours . ' hours');
    $dtend = $dtEnd->format('Ymd\THis\Z');

    // Stable UID so calendar clients deduplicate across refreshes and update
    // existing entries when our data changes. Source link + date keeps each
    // occurrence distinct (recurring events from the same URL get unique
    // UIDs by date, otherwise calendar clients would dedupe them down to one).
    $uidSource = (isset($e['sourceLink']) && $e['sourceLink'] ? $e['sourceLink'] : $title)
                 . '|' . $date;
    $uid = md5($uidSource) . '@millersville.app';

    // DTSTAMP is the time we generated this entry — required by RFC 5545.
    $dtstamp = gmdate('Ymd\THis\Z');

    $location    = isset($e['location'])    ? (string)$e['location']    : '';
    $description = isset($e['description']) ? (string)$e['description'] : '';
    $sourceLink  = isset($e['sourceLink'])  ? (string)$e['sourceLink']  : '';

    // Build description with a footer pointing back to the source. Helpful
    // when the user wants to see ticket info, full details, etc.
    $descParts = [];
    if ($description) $descParts[] = $description;
    if ($sourceLink)  $descParts[] = 'Details: ' . $sourceLink;
    $descFinal = implode("\n\n", $descParts);

    $lines = [];
    $lines[] = 'BEGIN:VEVENT';
    $lines[] = 'UID:' . $uid;
    $lines[] = 'DTSTAMP:' . $dtstamp;
    $lines[] = 'DTSTART:' . $dtstart;
    $lines[] = 'DTEND:'   . $dtend;
    $lines[] = 'SUMMARY:' . icsEscape($title);
    if ($location)   $lines[] = 'LOCATION:'    . icsEscape($location);
    if ($descFinal)  $lines[] = 'DESCRIPTION:' . icsEscape($descFinal);
    if ($sourceLink) $lines[] = 'URL:'         . $sourceLink; // URLs aren't text-escaped per RFC
    if (!empty($tags)) {
        // CATEGORIES uses comma as the LIST separator (RFC 5545 §3.8.1.2),
        // so escape each tag individually for the rare case where a tag
        // contains a comma, then join with unescaped commas as separators.
        $escapedTags = array_map('icsEscape', $tags);
        $lines[] = 'CATEGORIES:' . implode(',', $escapedTags);
    }
    $lines[] = 'END:VEVENT';
    return $lines;
}

/**
 * Escape a value for use in an iCal text field. Per RFC 5545 §3.3.11:
 *   backslash → \\
 *   semicolon → \;
 *   comma     → \,
 *   newline   → \n
 *   carriage return is dropped (most clients can't handle it)
 */
function icsEscape($s) {
    $s = str_replace("\r\n", "\n", $s);
    return str_replace(
        ['\\',  ';',  ',',  "\n"],
        ['\\\\', '\\;', '\\,', '\\n'],
        $s
    );
}

/**
 * Fold a long content line per RFC 5545: max 75 octets, then CRLF + space
 * for continuation. Most parsers tolerate longer, but we follow spec to
 * be safe with strict importers (corporate Exchange, etc).
 */
function icsFold($line) {
    if (strlen($line) <= 75) return $line;
    $folded = '';
    $remaining = $line;
    while (strlen($remaining) > 75) {
        $folded .= substr($remaining, 0, 75) . "\r\n ";
        $remaining = substr($remaining, 75);
    }
    return $folded . $remaining;
}

/**
 * Filter predicate. Mirrors eventMatchesFeed() in app.js — keep in sync
 * if either is edited.
 */
function eventMatchesFeed($e) {
    global $prefs;
    if (empty($prefs)) return false;

    $tags  = isset($e['tags']) && is_array($e['tags']) ? $e['tags'] : [];
    $title = isset($e['title']) ? strtolower((string)$e['title']) : '';

    // Family Friendly — matches any event with the kidFriendly flag.
    if (in_array('family-events', $prefs, true) && !empty($e['kidFriendly'])) return true;

    $sportMap = [
        'baseball' => 'baseball', 'softball' => 'softball', 'lacrosse' => 'lacrosse',
        'volleyball' => 'volleyball', 'football' => 'football', 'basketball' => 'basketball',
        'soccer' => 'soccer', 'field hockey' => 'fieldhockey', 'tennis' => 'tennis',
        'track' => 'track', 'golf' => 'golf', 'swimming' => 'swimming',
        'cross country' => 'crosscountry'
    ];
    $tagsLower = array_map('strtolower', $tags);

    // PM athletics
    if (in_array('PM', $tags, true) && (in_array('Athletics', $tags, true) || in_array('Athletic Competitions', $tags, true))) {
        foreach ($sportMap as $sport => $suffix) {
            if (in_array($sport, $tagsLower, true) && in_array('pm-' . $suffix, $prefs, true)) return true;
        }
        return false;
    }
    // PM non-athletic
    if (in_array('PM', $tags, true)) {
        if (in_array('Music/Arts', $tags, true) && in_array('pm-music', $prefs, true)) return true;
        if (in_array('Board/PTO', $tags, true) && in_array('pm-board', $prefs, true)) return true;
        if ((in_array('School Events', $tags, true) || in_array('Health/Wellness', $tags, true) || in_array('Meetings', $tags, true)) && in_array('pm-board', $prefs, true)) return true;
        return false;
    }

    // MU athletics
    if (in_array('MU', $tags, true) && (in_array('Athletics', $tags, true) || in_array('Athletic Competitions', $tags, true))) {
        foreach ($sportMap as $sport => $suffix) {
            if (in_array($sport, $tagsLower, true) && in_array('mu-' . $suffix, $prefs, true)) return true;
        }
        return false;
    }

    // Clubs/Orgs (BEFORE generic MU because GetInvolved events carry both 'MU' and 'Clubs/Orgs')
    if (in_array('Clubs/Orgs', $tags, true)) {
        if (in_array('clubs-all', $prefs, true)) return true;
        if (in_array('clubs-social', $prefs, true)   && in_array('Social', $tags, true))   return true;
        if (in_array('clubs-arts', $prefs, true)     && in_array('Arts', $tags, true))     return true;
        if (in_array('clubs-sports', $prefs, true)   && in_array('Club Sports', $tags, true)) return true;
        if (in_array('clubs-greek', $prefs, true)    && in_array('Greek Life', $tags, true)) return true;
        if (in_array('clubs-service', $prefs, true)  && (in_array('Service', $tags, true) || in_array('Cultural', $tags, true))) return true;

        // Club-sports per-sport prefs (cs-*). Require Club Sports umbrella tag
        // to avoid matching varsity events that share the sport tag.
        if (in_array('Club Sports', $tags, true)) {
            if (in_array('cs-baseball', $prefs, true) && in_array('Baseball', $tags, true)) return true;
            if (in_array('cs-bowling', $prefs, true)  && preg_match('/bowling/i', $title)) return true;
            if (in_array('cs-equestrian', $prefs, true) && preg_match('/equestrian/i', $title)) return true;
            if (in_array('cs-fencing', $prefs, true)  && in_array('Fencing', $tags, true)) return true;
            if (in_array('cs-icehockey', $prefs, true) && preg_match('/ice hockey/i', $title)) return true;
            if (in_array('cs-mma', $prefs, true) && preg_match('/\bmma\b/i', $title)) return true;
            if (in_array('cs-basketball-mens', $prefs, true) && in_array('Basketball', $tags, true) && in_array("Men's", $tags, true)) return true;
            if (in_array('cs-basketball-womens', $prefs, true) && in_array('Basketball', $tags, true) && in_array("Women's", $tags, true)) return true;
            if (in_array('cs-lacrosse', $prefs, true) && in_array('Lacrosse', $tags, true)) return true;
            if (in_array('cs-rugby-mens', $prefs, true) && in_array('Rugby', $tags, true) && in_array("Men's", $tags, true)) return true;
            if (in_array('cs-rugby-womens', $prefs, true) && in_array('Rugby', $tags, true) && in_array("Women's", $tags, true)) return true;
            if (in_array('cs-soccer-mens', $prefs, true) && in_array('Soccer', $tags, true) && in_array("Men's", $tags, true)) return true;
            if (in_array('cs-soccer-womens', $prefs, true) && in_array('Soccer', $tags, true) && in_array("Women's", $tags, true)) return true;
            if (in_array('cs-volleyball-mens', $prefs, true) && in_array('Volleyball', $tags, true) && in_array("Men's", $tags, true)) return true;
            if (in_array('cs-volleyball-womens', $prefs, true) && in_array('Volleyball', $tags, true) && in_array("Women's", $tags, true)) return true;
            if (in_array('cs-dance', $prefs, true) && preg_match('/dance team/i', $title)) return true;
            if (in_array('cs-running', $prefs, true) && preg_match('/\brunning\b/i', $title)) return true;
            if (in_array('cs-softball', $prefs, true) && in_array('Softball', $tags, true)) return true;
            if (in_array('cs-tennis', $prefs, true)   && in_array('Tennis', $tags, true)) return true;
            if (in_array('cs-frisbee', $prefs, true)  && preg_match('/ultimate frisbee/i', $title)) return true;
        }

        // Individual club: prefs (e.g. "club:RUF" matches a tag named "RUF").
        foreach ($prefs as $pref) {
            if (strpos($pref, 'club:') === 0 && in_array(substr($pref, 5), $tags, true)) return true;
        }
        return false;
    }

    // MU non-sport (MU Calendar — Clubs/Orgs already handled above)
    if (in_array('MU', $tags, true)) {
        if (in_array('Arts Concert / Performance', $tags, true) && in_array('mu-arts', $prefs, true)) return true;
        if (in_array('Public Event', $tags, true) && in_array('mu-public', $prefs, true)) return true;
        return false;
    }

    if (in_array('Borough', $tags, true)       && in_array('borough-all', $prefs, true))     return true;
    if (in_array('VFW', $tags, true)           && in_array('other-vfw', $prefs, true))       return true;
    if (in_array('Live Music', $tags, true)    && in_array('other-phantom', $prefs, true))   return true;
    if (in_array('Community', $tags, true)     && in_array('other-community', $prefs, true)) return true;

    return false;
}
