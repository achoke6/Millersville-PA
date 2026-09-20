<?php
/**
 * livestats.php — Server-side proxy for Sidearm live stats (MU only).
 *
 * Why: the hourly GitHub Actions deploy is the site's data ceiling, so a live
 * MU score can never move on the rows via scrape.js. Sidearm's live-stats app
 * (millersvilleathletics.com/sidearmstats/<code>/summary) is an Angular shell
 * that loads ONE JSON snapshot and then listens on a SignalR socket. We don't
 * need the socket: polling the snapshot every 30–60s is the same scoreboard
 * with ≤1 min lag. Pattern copied from wxcam.php (cURL, temp-dir cache,
 * fail-soft, DreamHost SSL posture).
 *
 * Upstream: https://sidearmstats.com/millersville/<code>/game.json?detail=game
 *   (found in the app bundle: environment.sidearmstats_base_url + folder +
 *   sport; `detail=game` is the lighter variant the app uses for config).
 *   404 = that sport has no live-stats configuration.
 *
 * Request:  livestats.php?sport=<code>   code = ^[a-z0-9_-]{2,20}$
 *   Host and school folder are HARDCODED — the code is only a path segment,
 *   so this is not an open proxy (no URL is ever taken from the client).
 *
 * Response (always HTTP 200, JSON; the client fails soft on ok:false):
 *   { ok, sport, state: 'pre'|'mid'|'post', date: 'M/D/YYYY', type,
 *     home:{name,score,record}, away:{name,score,record}, mu:'home'|'away'|null,
 *     period:'3rd'|'OT'|'OT2'|null, clockSeconds, clockDirection:'Up'|'Down',
 *     showClock, source:'cache'|'upstream'|'stale', fetchedAt }
 *
 * The client MUST gate on `date` (the snapshot is "the sport's current game",
 * not "today's game" — Saturday's FINAL is still served on Sunday). DateUTC
 * is unreliable upstream (null on presto-sourced games, midnight placeholder
 * otherwise) — `Date` (M/D/YYYY) is the field both fixtures carry.
 *
 * Caching: 30s per sport in sys_get_temp_dir() (Hard Rule 9 untouched — no
 * repo-adjacent file); on upstream failure the stale copy is served for up to
 * 10 min flagged source:'stale', then ok:false. Never a 5xx (browsers cache
 * failed fetches poorly and the row would stick on an error state).
 */

const UPSTREAM_BASE        = 'https://sidearmstats.com/millersville/';
const CACHE_TTL_SECONDS    = 30;
const STALE_MAX_SECONDS    = 600;
const FETCH_TIMEOUT_SECONDS = 8;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=' . CACHE_TTL_SECONDS . ', stale-while-revalidate=60');

function out($arr) { echo json_encode($arr, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); exit; }

$code = isset($_GET['sport']) ? strtolower(trim((string)$_GET['sport'])) : '';
if (!preg_match('/^[a-z0-9_-]{2,20}$/', $code)) {
    out(['ok' => false, 'reason' => 'bad-sport']);
}

$cachePath = sys_get_temp_dir() . '/millersville_livestats_' . $code . '.json';

// Fresh cache → serve as-is (re-stamp source so the client can tell).
if (file_exists($cachePath) && (time() - filemtime($cachePath)) < CACHE_TTL_SECONDS) {
    $cached = @file_get_contents($cachePath);
    $obj = $cached !== false ? json_decode($cached, true) : null;
    if (is_array($obj)) { $obj['source'] = 'cache'; out($obj); }
}

// ---- Fetch upstream (cURL; wxcam.php SSL posture — DreamHost PHP has no CA bundle) ----
$url = UPSTREAM_BASE . $code . '/game.json?detail=game';
$body = false; $httpCode = 0; $curlErr = '';
if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_TIMEOUT => FETCH_TIMEOUT_SECONDS,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; MillersvilleApp/1.0; +https://millersville.app)',
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0
    ]);
    $body = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if ($body === false) $curlErr = curl_error($ch);
    curl_close($ch);
} else {
    $ctx = stream_context_create([
        'http' => ['timeout' => FETCH_TIMEOUT_SECONDS, 'follow_location' => 1, 'ignore_errors' => true,
                   'user_agent' => 'Mozilla/5.0 (compatible; MillersvilleApp/1.0; +https://millersville.app)',
                   'header' => "Accept: application/json\r\n"],
        'ssl'  => ['verify_peer' => false, 'verify_peer_name' => false]
    ]);
    $body = @file_get_contents($url, false, $ctx);
    $httpCode = $body !== false ? 200 : 0;
}

// ---- Normalize ----
function ordinal($n) {
    $n = (int)$n; $m100 = $n % 100;
    if ($m100 >= 11 && $m100 <= 13) return $n . 'th';
    switch ($n % 10) { case 1: return $n . 'st'; case 2: return $n . 'nd'; case 3: return $n . 'rd'; default: return $n . 'th'; }
}
// Case-insensitive key read: the wire is PascalCase today (Game.HomeTeam.Score);
// the app camelCases it — read either so a vendor-side casing change fails soft.
function g($arr, $key, $default = null) {
    if (!is_array($arr)) return $default;
    if (array_key_exists($key, $arr)) return $arr[$key];
    $lk = strtolower($key);
    foreach ($arr as $k => $v) { if (strtolower((string)$k) === $lk) return $v; }
    return $default;
}
function team($t) {
    $name = trim(preg_replace('/\s+/', ' ', (string)g($t, 'Name', '')));   // "Indiana  Pennsylvania" carries a double space
    return ['name' => $name, 'score' => (int)g($t, 'Score', 0), 'record' => (string)g($t, 'CurrentRecord', '')];
}

$result = null;
if ($body !== false && $httpCode >= 200 && $httpCode < 300) {
    $json = json_decode($body, true);
    $game = is_array($json) ? g($json, 'Game') : null;
    if (is_array($game) && g($game, 'HomeTeam') !== null && g($game, 'VisitingTeam') !== null) {
        $home = team(g($game, 'HomeTeam'));
        $away = team(g($game, 'VisitingTeam'));
        $hasStarted = (bool)g($game, 'HasStarted', false);
        $isComplete = (bool)g($game, 'IsComplete', false);
        $state = !$hasStarted ? 'pre' : ($isComplete ? 'post' : 'mid');
        $type = (string)g($game, 'Type', '');
        $period = (int)g($game, 'Period', 0);
        $reg = (int)g($game, 'PeriodsRegulation', 0);
        $rules = g($game, 'Rules', []);
        $periodName = (string)g($rules, 'PeriodName', 'Period');
        $otAsOt = (bool)g($rules, 'ShowExtraPeriodsAsOT', true);
        $periodLabel = null;
        if ($period > 0) {
            if ($reg > 0 && $period > $reg && $otAsOt) { $n = $period - $reg; $periodLabel = 'OT' . ($n > 1 ? $n : ''); }
            else if ($type === 'BaseballSoftballGame') { $periodLabel = 'Inn ' . $period; }
            else { $periodLabel = ordinal($period); }
        }
        $muHome = stripos($home['name'], 'millersville') === 0;
        $muAway = stripos($away['name'], 'millersville') === 0;
        $mu = ($muHome && !$muAway) ? 'home' : ((!$muHome && $muAway) ? 'away' : null);
        $result = [
            'ok' => true,
            'sport' => $code,
            'state' => $state,
            'date' => (string)g($game, 'Date', ''),          // M/D/YYYY — the client's day gate
            'type' => $type,
            'home' => $home,
            'away' => $away,
            'mu' => $mu,
            'period' => $periodLabel,
            'periodName' => $periodName,
            'clockSeconds' => (int)g($game, 'ClockSeconds', 0),
            'clockDirection' => (string)g($rules, 'ClockDirection', 'Down'),
            'showClock' => !in_array($type, ['BaseballSoftballGame', 'VolleyballGame'], true),
            'statsUrl' => 'https://millersvilleathletics.com/sidearmstats/' . $code . '/summary',
            'source' => 'upstream',
            'fetchedAt' => gmdate('c')
        ];
    }
} else if ($httpCode === 404) {
    // Sport has no live-stats configuration. Cache the negative so we don't re-hit every poll.
    $result = ['ok' => false, 'reason' => 'no-game', 'sport' => $code, 'source' => 'upstream', 'fetchedAt' => gmdate('c')];
}

if ($result !== null) {
    @file_put_contents($cachePath, json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
    out($result);
}

// ---- Upstream failed: serve stale up to STALE_MAX_SECONDS, else ok:false ----
error_log('livestats.php: upstream failed for ' . $code . ' (http ' . $httpCode . ($curlErr ? ', ' . $curlErr : '') . ')');
if (file_exists($cachePath) && (time() - filemtime($cachePath)) < STALE_MAX_SECONDS) {
    $cached = @file_get_contents($cachePath);
    $obj = $cached !== false ? json_decode($cached, true) : null;
    if (is_array($obj)) { $obj['source'] = 'stale'; out($obj); }
}
out(['ok' => false, 'reason' => 'upstream', 'sport' => $code, 'http' => $httpCode]);
