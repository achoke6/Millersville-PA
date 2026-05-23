# CLAUDE.md

Context for Claude Code sessions on this repo. Read this before making non-trivial changes.

## What this is

millersville.app — community event aggregator for Millersville, PA. Static PWA hosted on DreamHost. Hourly cron scrapes events from MU Athletics, Penn Manor, Borough, MU Calendar, clubs, Phantom Power, VFW, Hudl, etc. and writes the result to flat JSON files served alongside the site.

Solo project. Adam is admin@millersville.app, sole maintainer.

## Critical rules — read first

### Never use `sed` on HTML files

Use `str_replace` (or whatever direct edit tool is available) instead. A past sed run truncated closing tags in `index.html` and broke the site for several hours. Adam doesn't keep tagged backups; recovering from a bad HTML edit is painful. This rule is non-negotiable.

`sed` is fine for JSON, JS, CSS, YAML, MD — anything where a malformed result would be caught by a parser or linter before deploy. HTML is the dangerous case because the smoke test only checks "does it 200 and contain the string 'Millersville.APP'," not that all tags are balanced.

### Vision API pipelines are disabled by design

`scripts/scrape.js` contains two large blocks wrapped in `if (false) { ... }`:
- VFW Vision pipeline (Google Sheet → Anthropic Vision API → structured specials/events)
- John Herr's grocery Vision pipeline (print circular → Anthropic Vision API → top deals)

**Do not re-enable these.** They were intentionally disabled in favor of hand-maintained `vfw.json` and `grocery.json` to eliminate Vision API calls. If you see code that looks "broken" inside an `if (false)` block, that's the disabled state — not a bug. The code is preserved for emergency rollback, not removed.

After both pipelines disabled: `ANTHROPIC_API_KEY` is no longer used by any active scraper path. Don't add new code that depends on it without discussing.

### Hand-maintained JSON files are the source of truth

These files are curated by Adam via weekly Cowork or Claude Code sessions. Treat them like any other authored content:

| File | Purpose | Cadence |
|---|---|---|
| `camps.json` | Summer camps + tech camps | Monthly-ish |
| `vfw.json` | VFW weekly specials + events | Twice weekly (Tue/Fri, auto via `vfw-facebook-sync` scheduled task — see below) |
| `grocery.json` | John Herr's weekly deals | Weekly (Thursdays) |
| `borough-overrides.json` | Enrichments for bland Borough iCal entries | Ad hoc |
| `sponsors.json` | Premium/standard/basic sponsors | Rare |
| `org-overrides.json` | MU club name normalization | Rare |
| `shortnames-overlay.json` | MU club abbreviations | Rare |

When editing these:
- Validate shape after editing (`main.yml` has jq checks; replicate locally to verify)
- Don't regenerate from scraping — they're authored, not extracted. (Exception: `vfw.json` is now refreshed by the `vfw-facebook-sync` scheduled task, which scrapes facebook.com/VFWPost7294 and proposes a diff for operator approval before writing — incremental + reviewed, not a wholesale regen.)
- Past-dated entries are mostly auto-skipped by the scraper; light cleanup welcome but not required

`vfw-facebook-sync` runs Tuesday and Friday at ~9:09 AM local. It drives Adam's signed-in personal Chrome via the Claude-in-Chrome MCP, transcribes the weekly-specials image, decodes the monthly events-calendar image into individual events, captures one-off event posts, asks Adam to approve the diff, and opens GitHub Desktop for the commit. SKILL.md lives at `C:\Users\AdamHoke\Documents\Claude\Scheduled\vfw-facebook-sync\SKILL.md`. If Facebook ever changes its DOM or blocks the session, fall back to manual Cowork updates of `vfw.json` — the file format and downstream consumption are unchanged.

### `lib/eventMatch.js` is canonical filter logic

Determines which events match a user's feed preferences. Used in three places:
1. `app.js` — frontend filtering (via UMD-style import)
2. `scripts/send-notifications.js` — daily push notification filtering
3. `events_ics.php` — iCal feed filtering (PHP port, manually kept in sync)

If `eventMatchesFeed` logic changes in JS, the PHP port in `events_ics.php` MUST be updated to match. The PHP file has a comment block pointing at `lib/eventMatch.js` as canonical.

## File layout

```
.                                  Repo root = web root on DreamHost
├── index.html                     Static SPA shell
├── app.js                         Frontend logic (~6000 lines)
├── style.css
├── sw.js                          Service worker; cache-first shell, network-first JSON
├── manifest.json                  PWA manifest
├── status.html                    Operator dashboard (status.json data)
├── events.json                    Scraper output, ~1000 events
├── events-meta.json               Last-updated timestamps for frontend
├── status.json                    Per-cron stats consumed by status.html
├── status-history.json            7-day rolling history of source counts
├── events-snapshot.json           Cron-to-cron event diff state (gitignored from SFTP)
├── camps.json                     Hand-maintained
├── vfw.json                       Hand-maintained
├── grocery.json                   Hand-maintained
├── borough-overrides.json         Hand-maintained
├── sponsors.json                  Hand-maintained
├── org-overrides.json             Hand-maintained
├── shortnames-overlay.json        Hand-maintained
├── clubs.json, restaurants.json, housing.json, services.json, news.json,
│   weather.json, board.json, specials.json   Scraper output
├── events.ics.php                 (legacy, can probably be deleted)
├── events_ics.php                 iCal feed; PHP port of eventMatch.js
├── subscribe.php, unsubscribe.php Push notification VAPID endpoints
├── wxcam.php                      Weather cam proxy
├── lib/
│   └── eventMatch.js              Canonical event-matching logic (UMD)
└── scripts/
    ├── scrape.js                  Hourly cron entry point
    ├── send-notifications.js      Daily 7am push notification job
    └── scrape-monthly.js          Weekly Sunday auto-scraper (dormant)
```

## Deploy flow

**Deployment is cron-driven, not push-driven.** Pushing a commit does NOT trigger a deploy.

Hourly cron (`.github/workflows/main.yml`):
1. Validates hand-maintained JSON files via jq syntax + shape checks
2. Runs `scripts/scrape.js` to refresh all scraped data files
3. Commits scraped data back to repo (`System: Auto-syncing Community Data`)
4. Minifies `app.js` via terser
5. Stamps `sw.js` with `github.run_id` as the build version (for cache invalidation)
6. Deploys via `lftp mirror --reverse --delete` to DreamHost SFTP
7. Post-deploy smoke test: index.html 200s, `/events` SPA route 200s, events.json has >100 entries, status.json is <90min old

So when you push a code change, the next hourly cron picks it up. Typical wait: 0-60 min. You can manually trigger via Actions → Run workflow if needed (the gate logic correctly bypasses for manual runs).

**Files excluded from SFTP deploy** (committed to repo but not pushed to live site):
- `.git/`, `.github/`, `node_modules/`, `scripts/`, `package*.json`
- `index_old.html`, `style_old.css`, `404.html` (legacy)
- `vfw-cache.json`, `grocery-cache.json` (legacy Vision pipeline caches, no longer updated)
- `subscriptions.json` (push subscriptions — security)
- `notifications-status.json`, `auto-events.json`, `auto-events-status.json`, `events-snapshot.json` (runtime state)
- `sync-report-*.md` (Claude Code session reports)

If you add a new file that shouldn't be on the live site, add it to the lftp excludes in `.github/workflows/main.yml`.

**Note about lftp excludes:** `--exclude` treats matched files as absent from BOTH local and remote, so adding a new exclude pattern does NOT delete what's already on the server. Files uploaded before an exclude was added must be manually removed via SFTP if you want them gone from production.

**`.htaccess` (deployed via a separate `put` after the mirror).** Lives at repo root, served from web root. Contents and rationale:
- `Options -MultiViews` — stops Apache from auto-matching `/sports` etc. against same-named files and bypassing the SPA rewrite. (Related to a past incident where `index.html` got renamed `Index.html` on the server and SPA routes silently 404'd.)
- HTTP→HTTPS 301 redirect (early in the file, before SPA routing).
- SPA fallback: `RewriteRule ^ index.html [L]` after a real-file/dir check, plus an `events.ics` → `events_ics.php` rewrite.
- Cache policy: JSON + HTML `no-cache` (data freshness + instant deploy pickup); CSS/JS 5 min (filenames aren't hashed, so can't cache longer); images/fonts 1 year immutable.
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=15768000; includeSubDomains`, and a `Permissions-Policy` disabling unused features (camera/mic/geo/payment/usb/etc). Scores **A** on securityheaders.com.
- **CSP is intentionally NOT set yet** — it's the only missing header (would be A+) but is high-risk: needs every script/iframe/SW/push source scoped and report-only testing first. Deferred to its own session. Don't add a CSP casually.
- **HSTS caution:** the `Strict-Transport-Security` header is sticky — once a browser sees it, it refuses HTTP for this domain for 6 months and won't let users click through a cert error. DreamHost's Let's Encrypt auto-renews so this is normally fine, but if you ever need to roll back HTTPS, set `max-age=0` and wait for browsers to re-fetch before doing anything that breaks TLS.

## Patterns and conventions

### Adam's working style
- Ships incrementally with verification at each step
- Prefers conservative architectural choices; wants tradeoffs discussed before significant engineering
- Values clean code with thorough explanatory comments — over-comment over under-comment
- Has CLI git installed (use it directly); GitHub Desktop also available if preferred for visual review
- Local working dir: `C:\Millersville\Millersville-PA\`
- Runs verification scripts locally on **Windows PowerShell**

### Commit messages
- Auto-commits from cron: `System: Auto-syncing Community Data`
- Human commits: write descriptive messages. A one-line summary + a short body explaining the *why* if it's not obvious from the diff. Past commits in this repo are sometimes terse ("j", ".") — don't follow that pattern. If a commit touches multiple distinct things, separate them into multiple commits.

### Code style
- Long, descriptive comments explaining *why*, not *what*
- Defensive error handling on every external fetch (try/catch with descriptive log messages)
- Status/log emoji prefixes are part of the convention: ✅ success, ❌ error, ⚠️ warning, 📡 fetch, 📊 stats, 💾 write, 🏷️ tag, 📺 broadcast, 🏆 sports, 📥 received, ⏭️ skipped, 🍽️ specials, 📅 calendar, 📌 event, 📦 cached, ⏰ scheduled
- Prefer pure functions over mutating state where possible
- Hand-maintained JSON files use `_comment` and `_format` fields as inline documentation (stripped by JSON.parse, ignored by code)

### What gets cached vs fetched fresh
- Anything from external sites: fetched every cron (no caching across cron runs by default)
- Vision API results (legacy): cached in `vfw-cache.json` and `grocery-cache.json` (no longer updated)
- MU recap URLs: cached for the duration of one cron run only
- `auto-events.json`: weekly scrape output, refreshed by `scrape-monthly.js` (currently dormant — both target sources blocked by Cloudflare on GitHub Actions IPs)

## Status dashboard signals

`status.html` reads `status.json` + `status-history.json` + `notifications-status.json` + `auto-events-status.json` and renders cards. Key thresholds:

- **Per-source degradation:** if a source's count is <50% of 7-day median, warn (yellow); <10% or 0, err (red). NOISE_FLOOR=4 silences sources where median <4 (VFW, Phantom Power occasionally).
- **Stale data:** newest event date hasn't advanced in N days where N depends on source (configured in status.html).
- **Daily push notifications:** warn >36h since last run, err >72h.
- **Weekly auto-scraper:** warn >9d since last run (missed one Sunday), err >16d (missed two).
- **Recent additions (7d):** rolling window of events first seen across recent crons. Operator self-check that the pipeline is finding fresh content. 0 in this run is normal; 0 for many consecutive runs suggests something broken upstream.

## Secrets in GitHub Actions

- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — push notification keys (DO NOT regenerate; would invalidate all existing subscriptions)
- `DREAMHOST_USERNAME` / `DREAMHOST_PASSWORD` / `DREAMHOST_SERVER` / `DREAMHOST_DIR` — SFTP credentials
- `HEALTHCHECK_URL` — healthchecks.io ping URL for cron heartbeat
- `VFW_SHEET_ID` — Google Sheet ID for legacy VFW Vision pipeline (can be removed after grocery transition is stable)
- `ANTHROPIC_API_KEY` — no longer used by active code paths after Vision pipelines disabled; verify no straggler usage before removing
- `GOOGLE_VISION_API_KEY` — unused (replaced by Anthropic Vision long ago); can be removed

## Things to verify before claiming "done"

1. `node -c scripts/scrape.js` — parses without syntax error
2. For HTML changes: load the file in a browser, not just trust the smoke test
3. For status.html changes: extract the inline `<script>` and run `node -e "new Function(scriptText)"` to catch JS errors
4. For JSON changes: validate the file passes the same jq shape checks that `main.yml` enforces (or just run jq locally if available)
5. For changes to `lib/eventMatch.js`: also update `events_ics.php`

## Known gotchas

- **Time zones:** scraper runs in UTC on the GitHub runner; events are stored as ISO strings with explicit offsets; frontend renders in user's local. ET (`America/New_York`) is the canonical "site time" for things like "today" and the 7am notification window.
- **iCal vs ICS:** scraper output is `events.ics.php` (legacy) and `events_ics.php` (current). Confusing.
- **Cache invalidation:** `sw.js` precaches the app shell with a version number that changes per deploy. Users on old service workers may see stale data until they reload — usually fixes itself within a session, but if testing a fresh deploy, hard-reload + check DevTools Application → Service Workers to verify the new SW is active.
- **MU Hudl auth:** requires `x-hudl-usehotchocolate: 100` header (current as of April 2026). If MU broadcasts suddenly drop to 0, this header may have rotated.
- **GitHub Actions IPs are blocked by Cloudflare** on several target sources (MU alumni events, MU tech camps). These can't be re-enabled — use Cowork/Claude Code session for those.
- **Deleting a file doesn't always look deleted (SPA fallback masks 404s):** when you `git rm` a file and deploy, `lftp mirror --delete` *does* remove it from DreamHost. BUT requesting the deleted path can still return HTTP **200**, because the `.htaccess` SPA fallback (`RewriteRule ^ index.html [L]`) serves `index.html` for any path that isn't a real file. A 200 does NOT prove the file still exists. To actually verify a deletion: (a) check via SFTP directly, or (b) confirm the response body is the app shell (contains `Millersville.APP` / matches index.html's byte size) rather than the file's real content. A past session burned time chasing a "phantom" `mu-status-proxy.php` that was already correctly deleted — the 200 was just the SPA fallback. Don't repeat that diagnosis.
- **Cowork-maintained files auto-expire:** `vfw.json` (weekly specials) and `grocery.json` (weekly deals) gate their specials/deals on a `validThrough` date. Once past it, VFW specials are hidden and grocery falls back to the legacy `grocery-cache.json` (showing stale deals). Events inside `vfw.json` still display regardless — only the date-gated specials/deals block goes empty. If the site shows missing or stale specials, the fix is to refresh these files. `vfw.json` is refreshed automatically by the `vfw-facebook-sync` scheduled task (Tue/Fri ~9:09 AM); `grocery.json` by `weekly-grocery-circular` (Thu ~7:39 AM). Manual Cowork refresh is the fallback if a scheduled run fails or surfaces an unclassified post.

## When something breaks

- Site visibly broken: check `~/logs/millersville.app/https/error.log` on DreamHost
- Stale data: check last successful Actions run; if cron hasn't completed in >2h, that's the issue
- Wrong event titles/details: check if a hand-maintained override file (borough-overrides.json, shortnames-overlay.json, org-overrides.json) should be updated rather than fighting the upstream scrape
- Notification not delivering: check `notifications-status.json` for `lastRunAt` and counts; if `Sent: N` but no notification appears, check the `push` event handler in `sw.js`
