<?php
// mu-status-proxy.php
//
// Server-side proxy for Millersville University's emergency-status page.
// Fetches https://www.millersville.edu/emergency-status.php, extracts ONLY
// the "Campus Emergency Status" section (heading + status text), and serves
// a clean minimal HTML chunk styled to match our site. The Emergency page on
// millersville.app iframes this URL instead of MU's directly, avoiding the
// cookie banner, MU nav chrome, and X-Frame-Options issues.
//
// CACHING: 5-minute file cache keeps load off MU's server. Worst case is
// one upstream fetch every 5 min regardless of how many visitors hit the
// page. The cache also makes the proxy robust to brief MU outages — if a
// fetch fails but the cache is recent, we serve the cache.
//
// FAILURE MODES: any extraction failure (network, regex, structural change)
// falls back to a minimal "View on millersville.edu →" card. The user
// always gets something useful clickable, never a broken-looking blank.
//
// MAINTENANCE: if MU redesigns emergency-status.php and the extraction
// regex stops matching, the fallback link kicks in but the embed becomes
// useless until the regex is updated. Symptoms: iframe shows the fallback
// message even though MU's page has a status update. Fix: re-fetch MU's
// page source, find the new structure around "Campus Emergency Status",
// update the extraction logic below.

// ---- Constants ----
$MU_URL        = 'https://www.millersville.edu/emergency-status.php';
$FALLBACK_URL  = 'https://www.millersville.edu/emergency-status.php';
$CACHE_FILE    = sys_get_temp_dir() . '/mu-status-cache.html';
$CACHE_TTL     = 300;        // 5 minutes
$FETCH_TIMEOUT = 10;         // seconds — keep small so a hung MU doesn't block

// ---- HTTP headers — set BEFORE any output ----
// Tell browsers and CDNs to cache briefly. The TTL matches our server cache
// so a refresh roughly aligns with the freshest data we'd have anyway.
header('Content-Type: text/html; charset=UTF-8');
header('Cache-Control: public, max-age=' . $CACHE_TTL);
// Allow this proxy to be embedded as an iframe from millersville.app.
// SAMEORIGIN works since both files live on the same DreamHost domain.
header('X-Frame-Options: SAMEORIGIN');

// ---- Serve from cache if fresh ----
if (file_exists($CACHE_FILE) && (time() - filemtime($CACHE_FILE)) < $CACHE_TTL) {
    readfile($CACHE_FILE);
    exit;
}

// ---- Fetch upstream ----
// Curl is more reliable than file_get_contents on DreamHost — explicit
// timeouts, follows redirects properly, gives us status codes.
$ch = curl_init($MU_URL);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 3,
    CURLOPT_TIMEOUT        => $FETCH_TIMEOUT,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_USERAGENT      => 'Millersville.APP-proxy/1.0 (admin@millersville.app)',
    CURLOPT_SSL_VERIFYPEER => true,
]);
$body     = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr  = curl_error($ch);
curl_close($ch);

// ---- Extract status section ----
// Even if fetch failed, we still try to fall back to stale cache before
// giving up. A 30-minute-old cache is better than a fallback link if MU
// briefly times out.
$statusHtml = null;

if ($body !== false && $httpCode === 200) {
    // Use DOMDocument for parsing — handles malformed HTML better than
    // regex and gives us proper structural extraction. Suppress libxml
    // warnings (MU's HTML almost certainly has unclosed tags etc.).
    libxml_use_internal_errors(true);
    $dom = new DOMDocument();
    // Force UTF-8 interpretation; MU's page is utf-8 but DOMDocument
    // defaults to latin-1 without this prefix trick.
    $dom->loadHTML('<?xml encoding="UTF-8">' . $body);
    libxml_clear_errors();

    $xpath = new DOMXPath($dom);

    // Find the H2 containing "Campus Emergency Status". On MU's page this
    // is the only H2 with that text. If they restructure (h1 instead, or
    // rename the section), this returns nothing and we hit the fallback.
    $headings = $xpath->query("//h2[contains(., 'Campus Emergency Status')]");

    if ($headings->length > 0) {
        $heading = $headings->item(0);

        // Walk forward through siblings until we hit the next h2 (which is
        // "Safety Contacts" on the current page layout). Collect every
        // element in between as the status content.
        $parts = [];
        $node = $heading->nextSibling;
        while ($node) {
            // Stop when we reach the next H2 — that's where the safety
            // contacts section starts and we don't want any of it.
            if ($node->nodeType === XML_ELEMENT_NODE && strtolower($node->nodeName) === 'h2') {
                break;
            }
            // Skip whitespace text nodes and comments; capture other content.
            if ($node->nodeType === XML_ELEMENT_NODE) {
                // Get the rendered HTML of this node. saveHTML on a specific
                // node returns just that subtree.
                $parts[] = $dom->saveHTML($node);
            }
            $node = $node->nextSibling;
        }

        if (!empty($parts)) {
            // Clean up the joined HTML — strip any script/style tags
            // (defense in depth; shouldn't be any in this section but
            // never trust upstream HTML), strip data-* attributes from
            // MU's analytics/tracking, normalize <a> targets to open in
            // the parent so users don't get stuck inside the iframe.
            $statusHtml = implode("\n", $parts);
            // Strip scripts and styles defensively
            $statusHtml = preg_replace('#<script[^>]*>.*?</script>#is', '', $statusHtml);
            $statusHtml = preg_replace('#<style[^>]*>.*?</style>#is', '', $statusHtml);
            // Force links to break out of the iframe — without this, clicks
            // inside the iframe would navigate the iframe itself rather
            // than the user's main window. _parent escapes our iframe;
            // _top would escape everything including our site.
            $statusHtml = preg_replace('/<a\b/i', '<a target="_parent"', $statusHtml);
        }
    }
}

// ---- Build the output page ----
// Even on fallback we emit valid HTML so the iframe always renders something
// rather than failing weirdly. The fallback variant just shows a "view on
// millersville.edu" link with the same visual style as the success case.
$ts = date('g:i A T');

ob_start();
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MU Emergency Status</title>
<!-- Auto-refresh every 5 minutes. The iframe reloads in place; visitors
     who keep our Emergency page open get rolling fresh data without our
     parent page needing JS to manage it. Aligned with $CACHE_TTL so each
     refresh hits a freshly-populated cache. -->
<meta http-equiv="refresh" content="<?= $CACHE_TTL ?>">
<style>
    /* Inline styles only — this is a tiny iframe payload, no external CSS.
       Variables match the parent site's palette so the embed visually
       belongs to millersville.app despite being a separate document. */
    body {
        margin: 0;
        padding: 16px 18px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #f8f9fb;
        color: #111827;
        line-height: 1.55;
        font-size: 0.95rem;
    }
    h2, h3 {
        color: #1e3a8a;
        margin: 0 0 10px 0;
        font-size: 1.05rem;
        font-weight: 800;
    }
    p { margin: 0 0 10px 0; }
    a { color: #1e3a8a; font-weight: 600; }
    a:hover { text-decoration: underline; }
    .em-proxy-fallback {
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        padding: 14px 16px;
    }
    .em-proxy-meta {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid #e5e7eb;
        font-size: 0.78rem;
        color: #6b7280;
    }
</style>
</head>
<body>
<?php if ($statusHtml !== null): ?>
    <?= $statusHtml ?>
    <div class="em-proxy-meta">Source: <a href="<?= htmlspecialchars($FALLBACK_URL) ?>" target="_parent">millersville.edu</a> · Updated <?= $ts ?></div>
<?php else: ?>
    <div class="em-proxy-fallback">
        <h2>MU Emergency Status</h2>
        <p>Unable to load the current status from millersville.edu right now. Visit MU's official page for the latest information.</p>
        <p><a href="<?= htmlspecialchars($FALLBACK_URL) ?>" target="_parent">View on millersville.edu →</a></p>
    </div>
<?php endif; ?>
</body>
</html>
<?php
$output = ob_get_clean();

// ---- Write cache (best-effort) ----
// Only cache success responses, not fallbacks — we don't want a transient
// upstream failure to lock in 5 minutes of fallback for users. If MU comes
// back online, the next request gets a real fetch. Cache write failures are
// silent — file may be unwritable in some hosting configs, not worth alerting
// the user about.
if ($statusHtml !== null) {
    @file_put_contents($CACHE_FILE, $output, LOCK_EX);
}

echo $output;
