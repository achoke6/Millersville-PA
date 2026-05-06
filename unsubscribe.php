<?php
/**
 * unsubscribe.php — Remove a push notification subscription.
 *
 * Receives the endpoint URL of a subscription to remove. Counterpart to
 * subscribe.php. Cron-side cleanup (dead 410-Gone subscriptions) is handled
 * separately by send-notifications.js, which writes back the cleaned list
 * after sending.
 *
 * Request body shape (JSON):
 *   { "endpoint": "https://fcm.googleapis.com/..." }
 *
 * Returns 200 even if the endpoint wasn't in the list — idempotent. Some
 * users may unsubscribe locally (browser permission revoke) without their
 * client ever calling this; later if they re-subscribe and the endpoint
 * differs, the old one persists harmlessly until the cron's 410 cleanup.
 */

header('Content-Type: application/json');
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
if (!is_array($body) || empty($body['endpoint'])) {
    http_response_code(400);
    echo json_encode(['error' => 'endpoint required']);
    exit;
}

$path = __DIR__ . '/subscriptions.json';
if (!file_exists($path)) {
    // Nothing to remove. Idempotent success.
    echo json_encode(['ok' => true, 'removed' => false]);
    exit;
}

$fp = @fopen($path, 'c+');
if (!$fp) {
    http_response_code(500);
    error_log('unsubscribe.php: failed to open ' . $path);
    echo json_encode(['error' => 'storage unavailable']);
    exit;
}
flock($fp, LOCK_EX);
$existing = stream_get_contents($fp);
$list = json_decode($existing, true);
if (!is_array($list)) $list = [];

$endpoint = $body['endpoint'];
$before = count($list);
$list = array_values(array_filter($list, function($entry) use ($endpoint) {
    return ($entry['endpoint'] ?? '') !== $endpoint;
}));
$removed = $before > count($list);

ftruncate($fp, 0);
rewind($fp);
fwrite($fp, json_encode($list, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
fflush($fp);
flock($fp, LOCK_UN);
fclose($fp);

echo json_encode(['ok' => true, 'removed' => $removed]);
