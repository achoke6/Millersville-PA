<?php
/**
 * report-score.php — fan score reports for finished, unscored games (2026-11-11).
 *
 * Visitors report the final score of a Penn Manor varsity or MU club-sport game that no
 * official source (District 3, MaxPreps, Hudl) has scored yet. Reports are tallied per
 * game; a score PUBLISHES to fan-scores.json once THRESHOLD different people (distinct
 * hashed IPs) report the same final, labelled "fan-reported" on the site. Adam gets ONE
 * email when a game hits the threshold (one-tap Confirm → "verified" / Reject → pulled)
 * and ONE when two different scores each have CONFLICT_MIN reporters. A score containing
 * a "hold" number (69) never auto-publishes — it waits for Confirm. Official scores always
 * replace a fan score at build (app.js overlays fan scores only where gameResult is empty).
 *
 * Storage (never in the repo, never under the site folder — the hourly deploy mirror
 * can't touch it and nothing is web-readable):
 *   <site parent>/mapp-data/score-secret.txt   HMAC key for the email links (auto-made)
 *   <site parent>/mapp-data/score-reports.json  raw reports: hashed IPs, device tokens
 * Published output (site folder, excluded from the deploy mirror — Hard Rule 9):
 *   fan-scores.json  { updatedAt, scores: {key: {score, result, status, reports}},
 *                      counts: {key: distinctReporters} }   ← what app.js reads
 *
 * Requests:
 *   POST  JSON {key, us, them, dev}     → {ok, count, needed, published}
 *   GET   ?action=confirm|reject&k=&s=&sig=   (the email links; HMAC-signed)
 * key = getEventKey(): "<title>|<date>" exactly as events.json carries it.
 */

const THRESHOLD      = 5;      // distinct reporters that publish a score
const CONFLICT_MIN   = 2;      // a second score with this many reporters = conflict email
const WINDOW_AFTER_H = 72;     // reports accepted this long after the game ends
const DAILY_IP_CAP   = 20;     // reports per hashed IP per day
const ADMIN_EMAIL    = 'admin@millersville.app';
const SITE_URL       = 'https://millersville.app';
const HOLD_NUMBERS   = [69];   // never auto-publish a score containing one of these

$CAPS = [
    'Football' => 90, 'Basketball' => 150, 'Soccer' => 15, 'Field Hockey' => 15,
    'Lacrosse' => 30, 'Baseball' => 30, 'Softball' => 30, 'Ice Hockey' => 20, 'Hockey' => 20,
    'Rugby' => 120, 'Ultimate' => 20, 'Volleyball' => 3, 'Wrestling' => 84, 'Tennis' => 9,
    'Water Polo' => 30,
];

function data_dir(): string {
    $d = dirname(__DIR__) . '/mapp-data';
    if (!is_dir($d)) { @mkdir($d, 0700, true); }
    return $d;
}

function secret(): string {
    $p = data_dir() . '/score-secret.txt';
    if (!is_file($p)) {
        $s = bin2hex(random_bytes(32));
        @file_put_contents($p, $s, LOCK_EX);
        @chmod($p, 0600);
        return $s;
    }
    return trim((string)file_get_contents($p));
}

function load_store(): array {
    $p = data_dir() . '/score-reports.json';
    if (!is_file($p)) return ['games' => [], 'ipDays' => []];
    $j = json_decode((string)file_get_contents($p), true);
    return is_array($j) ? $j + ['games' => [], 'ipDays' => []] : ['games' => [], 'ipDays' => []];
}

function save_store(array $store): void {
    $p = data_dir() . '/score-reports.json';
    // Trim the per-day IP counters to today + yesterday.
    $keep = [];
    $today = gmdate('Y-m-d'); $yday = gmdate('Y-m-d', time() - 86400);
    foreach ($store['ipDays'] as $k => $n) { if (substr($k, -10) === $today || substr($k, -10) === $yday) $keep[$k] = $n; }
    $store['ipDays'] = $keep;
    $tmp = $p . '.tmp';
    file_put_contents($tmp, json_encode($store, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
    rename($tmp, $p);
}

function load_events(): array {
    $j = json_decode((string)@file_get_contents(__DIR__ . '/events.json'), true);
    if (!is_array($j)) return [];
    return isset($j['events']) && is_array($j['events']) ? $j['events'] : $j;
}

function find_event(string $key): ?array {
    foreach (load_events() as $e) {
        if ((($e['title'] ?? '') . '|' . ($e['date'] ?? '')) === $key) return $e;
    }
    return null;
}

function event_sport(array $e): ?string {
    global $CAPS;
    foreach ($e['tags'] ?? [] as $t) { if (isset($CAPS[$t])) return $t; }
    return null;
}

/** Why a game can't take reports right now, or null when it can. Mirrors spCanReport() in app.js. */
function ineligible_reason(array $e): ?string {
    $t = $e['tags'] ?? [];
    $pmVarsity = in_array('PM', $t, true) && in_array('Athletics', $t, true) && !in_array('JV', $t, true) && !in_array('Jr High', $t, true);
    $club = in_array('Club Sports', $t, true);
    if (!$pmVarsity && !$club) return 'Only Penn Manor varsity and MU club-sport games take score reports.';
    if (!event_sport($e)) return 'This sport has no single final score to report.';
    $title = (string)($e['title'] ?? '');
    if ($club && !preg_match('/\b(vs\.?|@|at|game|match)\b/i', $title)) return 'That listing is not a game.';
    if ($club && preg_match('/\b(practice|tryout|clinic|meeting|alumni)\b/i', $title)) return 'That listing is not a game.';
    if (!empty($e['gameResult']) && !empty($e['gameScore'])) return 'An official score is already posted for this game.';
    $start = strtotime((string)($e['date'] ?? ''));
    if (!$start) return 'Bad game date.';
    $end = !empty($e['endTime']) ? strtotime((string)$e['endTime']) : $start + 3 * 3600;
    if (!$end) $end = $start + 3 * 3600;
    $now = time();
    if ($now < $end) return 'The game has not ended yet.';
    if ($now - $end > WINDOW_AFTER_H * 3600) return 'Reports closed for this game (more than 72 hours ago).';
    return null;
}

function ip_hash(string $ip): string { return substr(hash_hmac('sha256', $ip, secret()), 0, 24); }

function sig(string $action, string $key, string $score): string {
    return hash_hmac('sha256', $action . '|' . $key . '|' . $score, secret());
}

function tally(array $game): array {
    // score → set of distinct ip hashes
    $by = [];
    foreach ($game['reports'] ?? [] as $dev => $r) {
        $s = (string)($r['score'] ?? ''); $ip = (string)($r['ip'] ?? '');
        if ($s === '' || $ip === '') continue;
        $by[$s][$ip] = true;
    }
    $counts = [];
    foreach ($by as $s => $ips) $counts[$s] = count($ips);
    arsort($counts);
    $all = [];
    foreach ($by as $ips) foreach ($ips as $ip => $_) $all[$ip] = true;
    return ['counts' => $counts, 'total' => count($all)];
}

function has_hold_number(string $score): bool {
    foreach (explode('-', $score) as $n) { if (in_array((int)$n, HOLD_NUMBERS, true)) return true; }
    return false;
}

function result_for(string $score): string {
    [$a, $b] = array_map('intval', explode('-', $score));
    return $a > $b ? 'W' : ($a < $b ? 'L' : 'T');
}

function rebuild_public(array $store): void {
    $out = ['updatedAt' => gmdate('c'), 'threshold' => THRESHOLD, 'scores' => [], 'counts' => []];
    foreach ($store['games'] as $key => $g) {
        $st = $g['status'] ?? 'pending';
        $t = tally($g);
        if (($st === 'published' || $st === 'verified') && !empty($g['published'])) {
            $out['scores'][$key] = [
                'score' => $g['published'], 'result' => result_for($g['published']),
                'status' => $st === 'verified' ? 'verified' : 'fan',
                'reports' => $t['counts'][$g['published']] ?? 0,
            ];
        } elseif ($t['total'] > 0) {
            $out['counts'][$key] = $t['total'];
        }
    }
    $p = __DIR__ . '/fan-scores.json';
    $tmp = $p . '.tmp';
    file_put_contents($tmp, json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_FORCE_OBJECT), LOCK_EX);
    rename($tmp, $p);
}

function send_admin(string $subject, string $body): void {
    $headers = "From: Millersville.APP <" . ADMIN_EMAIL . ">\r\nContent-Type: text/plain; charset=UTF-8";
    @mail(ADMIN_EMAIL, $subject, $body, $headers);
}

function link_for(string $action, string $key, string $score): string {
    return SITE_URL . '/report-score.php?action=' . $action . '&k=' . rawurlencode($key) . '&s=' . rawurlencode($score) . '&sig=' . sig($action, $key, $score);
}

/** Core: record one report and re-evaluate the game. Returns the API response array. */
function record_report(string $key, int $us, int $them, string $dev, string $ip): array {
    global $CAPS;
    if (strlen($key) > 300 || strpos($key, '|') === false) return ['ok' => false, 'error' => 'Bad game key.', 'http' => 400];
    if (!preg_match('/^[a-z0-9]{8,40}$/i', $dev)) return ['ok' => false, 'error' => 'Bad device token.', 'http' => 400];
    $e = find_event($key);
    if (!$e) return ['ok' => false, 'error' => 'Game not found.', 'http' => 404];
    if ($why = ineligible_reason($e)) return ['ok' => false, 'error' => $why, 'http' => 409];
    $sport = event_sport($e); $cap = $CAPS[$sport];
    if ($us < 0 || $them < 0 || $us > $cap || $them > $cap) return ['ok' => false, 'error' => "Scores run 0–$cap for " . strtolower($sport) . '.', 'http' => 400];
    if ($sport === 'Volleyball' && (max($us, $them) < 2 || $us === $them)) return ['ok' => false, 'error' => 'Enter sets won — the winner has 2 or 3.', 'http' => 400];
    $score = $us . '-' . $them;
    $iph = ip_hash($ip);
    $dayKey = $iph . ':' . gmdate('Y-m-d');

    $store = load_store();
    $n = (int)($store['ipDays'][$dayKey] ?? 0);
    if ($n >= DAILY_IP_CAP) return ['ok' => false, 'error' => 'Too many reports from this connection today.', 'http' => 429];
    $store['ipDays'][$dayKey] = $n + 1;

    $g = $store['games'][$key] ?? ['reports' => [], 'status' => 'pending', 'published' => null, 'rejected' => [], 'emailed' => []];
    $g['reports'][$dev] = ['score' => $score, 'ip' => $iph, 'at' => time()];   // one report per device; re-report replaces
    $g['sport'] = $sport; $g['title'] = (string)($e['title'] ?? '');

    $t = tally($g);
    $lead = array_key_first($t['counts']); $leadN = $lead !== null ? $t['counts'][$lead] : 0;
    $published = false;
    $rejected = $g['rejected'] ?? [];
    $emailed = $g['emailed'] ?? [];
    if (($g['status'] ?? 'pending') !== 'verified' && $lead !== null && $leadN >= THRESHOLD
        && !in_array($lead, $rejected, true) && ($g['published'] ?? null) !== $lead) {
        if (has_hold_number($lead)) {
            $g['status'] = 'held';
            if (!in_array("held:$lead", $emailed, true)) {
                $emailed[] = "held:$lead";
                send_admin('[millersville.app] Score needs your OK: ' . $g['title'],
                    "$leadN people reported {$g['title']} as $lead, but that score needs a human look before it shows.\n\n"
                    . "Confirm (publish as verified): " . link_for('confirm', $key, $lead) . "\n"
                    . "Reject (never publish this score): " . link_for('reject', $key, $lead) . "\n");
            }
        } else {
            $g['status'] = 'published'; $g['published'] = $lead; $published = true;
            if (!in_array("threshold:$lead", $emailed, true)) {
                $emailed[] = "threshold:$lead";
                send_admin('[millersville.app] Fan score published: ' . $g['title'] . ' ' . $lead,
                    "$leadN different people reported {$g['title']} as $lead — it is now live, labelled fan-reported.\n\n"
                    . "Confirm (mark verified): " . link_for('confirm', $key, $lead) . "\n"
                    . "Reject (pull it): " . link_for('reject', $key, $lead) . "\n\n"
                    . "An official D3/MaxPreps/Hudl score replaces it automatically if one posts.\n");
            }
        }
    }
    // Conflict: two different scores each with CONFLICT_MIN reporters — one email per game.
    $strong = array_filter($t['counts'], fn($c) => $c >= CONFLICT_MIN);
    if (count($strong) >= 2 && !in_array('conflict', $emailed, true)) {
        $emailed[] = 'conflict';
        $lines = [];
        foreach ($strong as $s => $c) $lines[] = "  $s — $c reporter(s)   confirm: " . link_for('confirm', $key, $s) . "   reject: " . link_for('reject', $key, $s);
        send_admin('[millersville.app] Conflicting scores: ' . $g['title'],
            "Fans disagree on {$g['title']}:\n" . implode("\n", $lines) . "\n\nNothing publishes until one score reaches " . THRESHOLD . " reporters or you confirm one.\n");
    }
    $g['emailed'] = $emailed;
    $store['games'][$key] = $g;
    save_store($store);
    rebuild_public($store);
    return ['ok' => true, 'count' => $t['total'], 'needed' => THRESHOLD, 'published' => $published || ($g['status'] === 'published' || $g['status'] === 'verified'), 'http' => 200];
}

function admin_action(string $action, string $key, string $score, string $sigGiven): string {
    if (!in_array($action, ['confirm', 'reject'], true) || !hash_equals(sig($action, $key, $score), $sigGiven)) return 'That link is not valid.';
    $store = load_store();
    $g = $store['games'][$key] ?? null;
    if (!$g) return 'No reports on file for that game.';
    if ($action === 'confirm') { $g['status'] = 'verified'; $g['published'] = $score; $msg = "Verified: {$g['title']} $score is live as a verified score."; }
    else { $g['status'] = 'rejected'; $g['rejected'][] = $score; if (($g['published'] ?? null) === $score) $g['published'] = null; $msg = "Rejected: $score will never publish for {$g['title']}. A different score can still reach the threshold."; }
    $store['games'][$key] = $g;
    save_store($store); rebuild_public($store);
    return $msg;
}

function main(): void {
    header('Access-Control-Allow-Origin: ' . SITE_URL);
    header('Cache-Control: no-store');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'POST') {
        header('Content-Type: application/json');
        $in = json_decode((string)file_get_contents('php://input'), true);
        if (!is_array($in)) { http_response_code(400); echo json_encode(['ok' => false, 'error' => 'Bad request.']); return; }
        $res = record_report((string)($in['key'] ?? ''), (int)($in['us'] ?? -1), (int)($in['them'] ?? -1), (string)($in['dev'] ?? ''), (string)($_SERVER['REMOTE_ADDR'] ?? ''));
        http_response_code($res['http']); unset($res['http']);
        echo json_encode($res, JSON_UNESCAPED_UNICODE);
        return;
    }
    $action = (string)($_GET['action'] ?? '');
    if ($action === 'confirm' || $action === 'reject') {
        $msg = admin_action($action, (string)($_GET['k'] ?? ''), (string)($_GET['s'] ?? ''), (string)($_GET['sig'] ?? ''));
        header('Content-Type: text/html; charset=UTF-8');
        echo '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Millersville.APP</title>'
           . '<body style="font-family:system-ui,sans-serif;padding:32px;max-width:520px;margin:auto;"><h2>Millersville.APP</h2><p>'
           . htmlspecialchars($msg, ENT_QUOTES, 'UTF-8') . '</p><p><a href="' . SITE_URL . '/sports">Back to Sports →</a></p></body>';
        return;
    }
    header('Content-Type: application/json');
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'POST a report, or use a signed admin link.']);
}

if (PHP_SAPI !== 'cli') main();
