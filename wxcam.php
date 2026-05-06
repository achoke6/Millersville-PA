<?php
/**
 * wxcam.php — Server-side proxy for the Millersville University weather cam.
 *
 * Why this exists: the upstream cam image at snowball.millersville.edu sets
 * cookies on its responses, which counts as a third-party cookie when loaded
 * directly from millersville.app. Lighthouse BP score takes a hit, and (as
 * of late 2024) browsers are progressively deprecating third-party cookies
 * — eventually those requests would either be blocked or scoped in ways
 * that broke the cam silently. Serving the image from our own origin makes
 * the cookies first-party (and they're harmless from this domain's POV
 * anyway since we don't read them).
 *
 * Caching:
 *   - 30s server-side cache to halve upstream load. The frontend refreshes
 *     every 60s anyway, so users see at most a 30s-stale frame.
 *   - Browser Cache-Control set to 30s with stale-while-revalidate.
 *
 * Failure handling: if the upstream is unreachable, return a 1×1 transparent
 * PNG with HTTP 200. The frontend's <img> still loads; the user just doesn't
 * see new frames. Errors are logged to PHP error_log for diagnostic purposes
 * but never surfaced to the client. We deliberately don't return 502 because
 * Chrome/Firefox cache failed image responses and would refuse to retry until
 * the page reloads.
 */

const UPSTREAM = 'https://snowball.millersville.edu/~cws/wxcam/latest.jpeg';
const CACHE_TTL_SECONDS = 30;
const FETCH_TIMEOUT_SECONDS = 8;
$cachePath = sys_get_temp_dir() . '/millersville_wxcam_latest.jpg';

// Serve cached copy if fresh — cuts upstream traffic in half (frontend polls
// every 60s, we cache for 30s, so every other browser request is a cache hit).
if (file_exists($cachePath) && (time() - filemtime($cachePath)) < CACHE_TTL_SECONDS) {
    header('Content-Type: image/jpeg');
    header('Cache-Control: public, max-age=' . CACHE_TTL_SECONDS . ', stale-while-revalidate=60');
    header('X-Wxcam-Source: cache');
    readfile($cachePath);
    exit;
}

// Fetch fresh from upstream via cURL. Originally used file_get_contents with
// a stream context, but DreamHost shared hosting often has allow_url_fopen=Off
// for HTTPS, which fails silently and falls through to the placeholder. cURL
// is always available regardless of php.ini and gives us better error
// signaling. Cookies from the upstream response are intentionally ignored —
// we serve the body bytes only, so they never reach the client.
//
// SSL verification is intentionally DISABLED here. DreamHost shared hosting
// doesn't ship a configured CA bundle for PHP cURL, so verification fails
// with "unable to get local issuer certificate" and the request bails before
// we ever see the response. The security tradeoff is acceptable in this
// specific case: we're proxying a public weather cam image with no auth
// tokens, no cookies forwarded back to the user, and no sensitive data
// flowing either direction. Worst-case MITM: somebody injects a fake JPEG.
// Not something to defend against here. If we ever proxy authenticated
// content through this same pattern, the right fix is to ship a cacert.pem
// alongside this file and point CURLOPT_CAINFO at it.
$body = false;
$httpCode = 0;
$curlErr = '';
if (function_exists('curl_init')) {
    $ch = curl_init(UPSTREAM);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_TIMEOUT => FETCH_TIMEOUT_SECONDS,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; MillersvilleApp/1.0; +https://millersville.app)',
        CURLOPT_HTTPHEADER => ['Accept: image/jpeg,image/*'],
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0
    ]);
    $body = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if ($body === false) $curlErr = curl_error($ch);
    curl_close($ch);
} else {
    // Last-resort fallback for environments without cURL. Will fail on hosts
    // with allow_url_fopen=Off; that's expected and we'll log it below.
    $ctx = stream_context_create([
        'http' => [
            'timeout' => FETCH_TIMEOUT_SECONDS,
            'follow_location' => 1,
            'user_agent' => 'Mozilla/5.0 (compatible; MillersvilleApp/1.0; +https://millersville.app)',
            'header' => "Accept: image/jpeg,image/*\r\n",
            'ignore_errors' => true
        ],
        'ssl' => ['verify_peer' => false, 'verify_peer_name' => false]
    ]);
    $body = @file_get_contents(UPSTREAM, false, $ctx);
    $httpCode = $body !== false ? 200 : 0;
}

// Validate. Need: non-empty, JPEG magic bytes (FF D8 FF), reasonable size.
$looksValid = ($body !== false)
    && ($httpCode >= 200 && $httpCode < 300)
    && (strlen($body) > 1000)
    && (substr($body, 0, 3) === "\xFF\xD8\xFF");

if ($looksValid) {
    @file_put_contents($cachePath, $body, LOCK_EX);
    header('Content-Type: image/jpeg');
    header('Cache-Control: public, max-age=' . CACHE_TTL_SECONDS . ', stale-while-revalidate=60');
    header('X-Wxcam-Source: upstream');
    echo $body;
    exit;
}

// Log enough diagnostic info to debug the failure mode without exposing
// sensitive details. http=403 means upstream blocked us; http=0 with a
// curl error usually means DNS or SSL issue; bad-magic-bytes means we
// got HTML (e.g. an error page) instead of an image.
$diag = sprintf(
    'wxcam.php upstream FAILED: http=%d, bytes=%d, magic=%s, curlErr=%s',
    $httpCode,
    is_string($body) ? strlen($body) : -1,
    is_string($body) && strlen($body) >= 3 ? bin2hex(substr($body, 0, 3)) : 'n/a',
    $curlErr ?: 'none'
);
error_log($diag);

// Upstream failed. If we have ANY cached copy (even stale), serve that —
// stale image is much better than a broken one for the user. Only fall back
// to the placeholder if we've never successfully fetched.
if (file_exists($cachePath)) {
    error_log('wxcam.php: upstream fetch failed, serving stale cache (age=' . (time() - filemtime($cachePath)) . 's)');
    header('Content-Type: image/jpeg');
    // Short cache on stale — try fresh again soon.
    header('Cache-Control: public, max-age=10');
    header('X-Wxcam-Source: cache-stale');
    readfile($cachePath);
    exit;
}

// No cache, no upstream. Return 1×1 transparent PNG so the <img> still loads.
// Browsers cache 200-OK images aggressively; we don't want them caching this
// failure for long, so set max-age=10 to allow recovery within ~10s.
error_log('wxcam.php: upstream fetch failed and no cache available, serving placeholder');
header('Content-Type: image/png');
header('Cache-Control: public, max-age=10');
header('X-Wxcam-Source: placeholder');
echo base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAUAAeImBZsAAAAASUVORK5CYII=');
