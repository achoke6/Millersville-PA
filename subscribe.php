<?php
/**
 * subscribe.php — Persist a push notification subscription.
 *
 * Receives a JSON POST body containing the browser's PushSubscription object
 * plus the user's current feedPrefs snapshot, and appends it to a flat JSON
 * file on disk. The cron job (scripts/send-notifications.js) reads this
 * file on its scheduled runs and sends pushes to each entry.
 *
 * Storage strategy:
 *   - subscriptions.json lives in the web root next to this file. It's NOT
 *     in git — see .gitignore. The deploy mirror (lftp) uses --exclude to
 *     skip it during deploys, so cron writes survive deploys.
 *   - Identified by `endpoint` URL. Re-subscribing or updating prefs from
 *     the same browser overwrites the existing entry rather than creating
 *     duplicates.
 *   - Last-write-wins. No locking beyond LOCK_EX during the read-write
 *     cycle — this endpoint sees ~handfuls of writes per day, contention
 *     isn't realistic.
 *
 * Request body shape (JSON):
 *   {
 *     "subscription": {           // PushSubscription.toJSON() output
 *       "endpoint": "https://fcm.googleapis.com/...",
 *       "keys": { "p256dh": "...", "auth": "..." }
 *     },
 *     "feedPrefs": ["MU", "PM", "baseball", ...]   // user's current localStorage prefs
 *   }
 *
 * Returns 200 OK on success, 400 on malformed input, 500 on disk failure.
 * Body of error responses is plain text — these are diagnostic for fetch
 * callers, not user-facing.
 */

header('Content-Type: application/json');
// CORS allow-origin: same-origin only. Push subscription endpoints should
// never be cross-origin, but be explicit.
header('Access-Control-Allow-Origin: https://millersville.app');
header('Access-Control-Allow-Methods: POST');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$raw = file_get_contents('php://input');
$body = json_decode($raw, true);
if (!is_array($body) || !isset($body['subscription']) || !isset($body['feedPrefs'])) {
    http_response_code(400);
    echo json_encode(['error' => 'subscription and feedPrefs required']);
    exit;
}

$sub = $body['subscription'];
if (!is_array($sub) || empty($sub['endpoint']) || empty($sub['keys']['p256dh']) || empty($sub['keys']['auth'])) {
    http_response_code(400);
    echo json_encode(['error' => 'malformed subscription object']);
    exit;
}

$feedPrefs = $body['feedPrefs'];
if (!is_array($feedPrefs)) $feedPrefs = [];
// Defensive cap: feedPrefs is normally <50 entries. If we ever receive
// something pathological, truncate before persisting so storage doesn't
// balloon. 200 is a comfortable headroom over realistic max.
if (count($feedPrefs) > 200) $feedPrefs = array_slice($feedPrefs, 0, 200);

$path = __DIR__ . '/subscriptions.json';

// Read-modify-write with LOCK_EX. We'd prefer atomic file_put_contents +
// rename, but with fewer than ~10 writes/day total contention isn't real.
// LOCK_EX on the read serializes concurrent invocations enough.
$fp = @fopen($path, 'c+');
if (!$fp) {
    http_response_code(500);
    error_log('subscribe.php: failed to open ' . $path);
    echo json_encode(['error' => 'storage unavailable']);
    exit;
}
flock($fp, LOCK_EX);
$existing = stream_get_contents($fp);
$list = json_decode($existing, true);
if (!is_array($list)) $list = [];

// Replace by endpoint or append. Endpoints uniquely identify a browser+device
// per the Web Push spec, so this is the right key.
$endpoint = $sub['endpoint'];
$updated = false;
foreach ($list as $i => $entry) {
    if (($entry['endpoint'] ?? '') === $endpoint) {
        $list[$i] = [
            'endpoint' => $endpoint,
            'keys' => $sub['keys'],
            'feedPrefs' => $feedPrefs,
            'subscribedAt' => $entry['subscribedAt'] ?? date('c'),
            'updatedAt' => date('c')
        ];
        $updated = true;
        break;
    }
}
if (!$updated) {
    $list[] = [
        'endpoint' => $endpoint,
        'keys' => $sub['keys'],
        'feedPrefs' => $feedPrefs,
        'subscribedAt' => date('c'),
        'updatedAt' => date('c')
    ];
}

ftruncate($fp, 0);
rewind($fp);
fwrite($fp, json_encode($list, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
fflush($fp);
flock($fp, LOCK_UN);
fclose($fp);

echo json_encode(['ok' => true, 'updated' => $updated]);
