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

### Curated data has two delivery mechanisms — know which is which

Curated (non-scraped) content reaches the site two ways now:

**(A) Sheet-synced at build time** — the directory and curated events are maintained in Google Sheets, pulled and converted to JSON during the hourly cron. The JSON files are *generated build outputs* — DO NOT hand-edit them, the next sync overwrites them. Edit the sheet instead. Two sync scripts:

| Script | Reads (sheet) | Writes (JSON) |
|---|---|---|
| `scripts/sync-directory.js` | Directory sheet (`DIRECTORY_SHEET_CSV_URL`) | `restaurants.json`, `services.json`, `housing.json`, `campus-cupboard.json`, `association.json` |
| `scripts/sync-candidates.js` | Event Candidates sheet (`CANDIDATES_SHEET_CSV_URL`) | `borough-overrides.json` (create-mode entries only), `penn-manor-overrides.json`, `youth-sports-registration.json` |

Both fail SAFE — on fetch/HTML/parse/empty error they exit non-zero WITHOUT writing, so a bad/unreachable sheet never wipes good JSON. Both run with `continue-on-error: true` in `main.yml`. See "Sheet sync ordering" under Deploy flow — order matters.

**(B) Hand-authored JSON** — still edited directly (file is the source of truth):

| File | Purpose | Cadence |
|---|---|---|
| `camps.json` | Summer camps + tech camps | Weekly (Mon ~8 AM, auto via camps-sync task — see Scheduled Cowork tasks) |
| `vfw.json` | VFW weekly specials + events | Twice weekly (Tue/Fri, auto via `vfw-facebook-sync` scheduled task) |
| `grocery.json` | John Herr's weekly deals | Weekly (Thursdays) |
| `borough-overrides.json` *enrichment entries* | Fix bland Borough iCal titles (matchTitle entries) | Ad hoc — see split below |
| `sponsors.json` | Premium/standard/basic sponsors | Rare |
| `org-overrides.json` | MU club name normalization | Rare |
| `shortnames-overlay.json` | MU club abbreviations | Rare |

When editing the hand-authored ones: validate shape after editing (`main.yml` has jq checks; replicate locally), don't regenerate from scraping, past-dated entries are mostly auto-skipped.

`vfw-facebook-sync` runs Tuesday and Friday at ~9:09 AM local. It drives Adam's signed-in personal Chrome via the Claude-in-Chrome MCP, transcribes the weekly-specials image, decodes the monthly events-calendar image into individual events, captures one-off event posts, asks Adam to approve the diff, and opens GitHub Desktop for the commit. SKILL.md lives at `C:\Users\AdamHoke\Documents\Claude\Scheduled\vfw-facebook-sync\SKILL.md`. If Facebook ever changes its DOM or blocks the session, fall back to manual Cowork updates of `vfw.json` — the file format and downstream consumption are unchanged.

### `borough-overrides.json` has a TWO-MODE split — important

This file is half sheet-generated, half hand-authored, and the sync respects that:
- **Create-mode entries** (`"create": true`) — Borough events that live ONLY in a blog post and are NOT on the Borough iCal (e.g. National Night Out). These come from the Event Candidates sheet (Source = `Borough`). `sync-candidates.js` OWNS and overwrites these.
- **Enrichment entries** (`matchTitle` + `newTitle`) — fix a bland iCal placeholder title (e.g. "Reserve Public Meeting Room" → "Conestoga River Community Lecture"). These are HAND-AUTHORED in the JSON and `sync-candidates.js` PRESERVES them (it only replaces create-mode entries, keeps everything with `matchTitle`).

So: enrichment = edit the JSON by hand; creation = add a row to the sheet. Don't put an iCal-present event through the sheet as create-mode — you'll get a duplicate (one from the iCal enrichment, one created). The scraper's create-mode logic: an unmatched override only spawns an event when explicitly flagged `create: true`; an unmatched enrichment override is a harmless no-op.

### `lib/eventMatch.js` is canonical filter logic

Determines which events match a user's feed preferences. Used in three places:
1. `app.js` — frontend filtering (via UMD-style import)
2. `scripts/send-notifications.js` — daily push notification filtering
3. `events.ics.php` — iCal feed filtering (PHP port, manually kept in sync)

If `eventMatchesFeed` logic changes in JS, the PHP port in `events.ics.php` MUST be updated to match. The PHP file has a comment block pointing at `lib/eventMatch.js` as canonical.

## File layout

```
.                                  Repo root = web root on DreamHost
├── index.html                     Static SPA shell
├── app.js                         Frontend logic (~6300 lines)
├── style.css
├── sw.js                          Service worker; cache-first shell, network-first JSON
├── manifest.json                  PWA manifest
├── status.html                    Operator dashboard (status.json data)
├── events.json                    Scraper output, ~900 events
├── events-meta.json               Last-updated timestamps for frontend
├── status.json                    Per-cron stats consumed by status.html
├── status-history.json            7-day rolling history of source counts
├── events-snapshot.json           Cron-to-cron event diff state (gitignored from SFTP)
│
│   # SHEET-SYNCED build outputs (DO NOT hand-edit — edit the sheet):
├── restaurants.json               ← sync-directory.js (type=food rows)
├── services.json                  ← sync-directory.js (type=service rows)
├── housing.json                   ← sync-directory.js (type=housing rows)
├── campus-cupboard.json           ← sync-directory.js (single cupboard obj; hours logic stays in app.js)
├── association.json               ← sync-directory.js (verified members + spotlight, derived)
├── penn-manor-overrides.json      ← sync-candidates.js (PM community events, Approved rows)
├── youth-sports-registration.json ← sync-candidates.js (registration windows, Approved rows)
├── borough-overrides.json         ← sync-candidates.js (create-mode) + HAND (enrichment) — see split above
│
│   # HAND-AUTHORED:
├── camps.json, vfw.json, grocery.json, sponsors.json,
│   org-overrides.json, shortnames-overlay.json
│
│   # SCRAPER OUTPUT:
├── clubs.json, news.json, weather.json, board.json, specials.json
│
├── events.ics.php                 iCal feed; PHP port of eventMatch.js — THE LIVE FILE
│                                   (.htaccess rewrites /events.ics → this)
├── subscribe.php, unsubscribe.php Push notification VAPID endpoints
├── wxcam.php                      Weather cam proxy
├── lib/
│   └── eventMatch.js              Canonical event-matching logic (UMD)
└── scripts/
    ├── scrape.js                  Hourly cron entry point
    ├── sync-directory.js          Directory sheet → JSON (build-time)
    ├── sync-candidates.js         Event Candidates sheet → override JSON (build-time)
    ├── send-notifications.js      Daily push notification job
    ├── audit-duplicates.js        Manual dedup audit
    └── scrape-monthly.js          Weekly Sunday auto-scraper (dormant)
```

**NOTE on the old `events_ics.php` (underscore):** RESOLVED — the live iCal file is `events.ics.php` (DOTTED). `.htaccess` line ~33 rewrites `/events.ics` → `events.ics.php`. The underscore version `events_ics.php` was a stale duplicate and has been DELETED. If you see lingering references to `events_ics.php` anywhere, they're stale — the dotted `events.ics.php` is canonical.

## Curated events: Sheet-based review pipeline

Three local sources (Borough blog, Penn Manor community page, local youth sports orgs) are curated into events via ONE Google Sheet, "Event Candidates," with a human approval gate.

**Flow:** a weekly Cowork task (`Local Event Candidates → Review Sheet`) scans the sources and APPENDS candidate rows to the sheet (via the signed-in Chrome browser session — Adam is logged in as achoke@gmail.com; there is NO write-capable Sheets MCP, browser editing is the mechanism). Adam reviews on his phone and puts an **X in the Approved column** for keepers. `sync-candidates.js` reads the published sheet CSV at build time, takes only Approved rows, and routes each by its `Source` column into the override files. The scraper consumes those overrides on the same run (sync runs BEFORE scrape — see ordering).

**Sheet columns:** `Approved | Family | Source | Title | Date | Time | Location | Deadline | Link | Description | Notes`
- `Approved` non-blank (X) = publish; blank = candidate/skip. **The gate.**
- `Family` X = `kidFriendly:true` on the event (Cowork pre-fills as a suggestion, Adam corrects).
- `Source` = `Borough` (create-mode override) | `PM Community` | `Youth Sports`.
- `Deadline` = registration close (ISO/plain date). REQUIRED for Youth Sports; optional elsewhere (sets `registrationRequired` + auto-hide).

**Cowork task rule:** APPEND ONLY — never edit/reorder/delete existing rows (would clobber Adam's X's). Never guess a registration deadline — flag "verify" in Notes instead.

This replaced an earlier PR-based review approach (rejected as too clunky — editing JSON diffs on mobile). Don't reintroduce PRs for this.

### Registration deadlines — display behavior
Events with a `registrationDeadline` get special handling:
- A **📝 "Registration required" badge** (amber) on the event card when `registrationRequired:true`.
- **Auto-hidden** from the site once the deadline passes (scraper drops them; the create-mode youth sports events build a "Register by <date>: <org>" title and are always `kidFriendly`).
- A homepage **"📝 Upcoming Signups"** reminder section, placed directly BELOW the daily event timeline, surfacing any event with a deadline within the next **2 weeks**. Townie-gated (local-signup content). Sourced from the events array (covers youth sports + PM community uniformly), so it stays in sync with the timeline. The deadline-day timeline event ALSO still shows — the reminder is additional, not a replacement.

## Deploy flow

**Deployment is cron-driven, not push-driven.** Pushing a commit does NOT trigger a deploy.

Hourly cron (`.github/workflows/main.yml`):
1. Validates hand-maintained JSON files via jq syntax + shape checks (note: this does NOT cover the sheet-generated files — those self-validate in their sync scripts)
2. `sync-candidates.js` — Event Candidates sheet → override JSON
3. Runs `scripts/scrape.js` to refresh all scraped data files
4. `sync-directory.js` — Directory sheet → directory JSON
5. Commits scraped + synced data back to repo (`System: Auto-syncing Community Data`)
6. Minifies `app.js` via terser
7. Stamps `sw.js` with `github.run_id` as the build version (cache invalidation)
8. Deploys via `lftp mirror --reverse --delete` to DreamHost SFTP
9. Post-deploy smoke test: index.html 200s, `/events` SPA route 200s, events.json has >100 entries, status.json is <90min old

**Sheet sync ordering (important):** `sync-candidates.js` runs BEFORE `scrape.js` because the scraper READS the override files it generates (borough/PM/youth) — if it ran after, approved events wouldn't take effect until the next hourly run. `sync-directory.js` runs AFTER scrape (order-independent — the frontend reads those files directly; scrape doesn't touch them).

So when you push a code change, the next hourly cron picks it up. Typical wait: 0-60 min. Manual trigger via Actions → Run workflow works (gate logic bypasses correctly for manual runs).

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
- `Options -MultiViews` — stops Apache from auto-matching `/sports` etc. against same-named files and bypassing the SPA rewrite.
- HTTP→HTTPS 301 redirect (early in the file, before SPA routing).
- SPA fallback: `RewriteRule ^ index.html [L]` after a real-file/dir check, plus an `events.ics` → `events.ics.php` rewrite (line ~33).
- Cache policy: JSON + HTML `no-cache`; CSS/JS 5 min; images/fonts 1 year immutable.
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=15768000; includeSubDomains`, and a `Permissions-Policy` disabling unused features. Scores **A** on securityheaders.com.
- **CSP is intentionally NOT set yet** — the only missing header (would be A+) but high-risk: needs every script/iframe/SW/push source scoped and report-only testing first. Deferred. Don't add a CSP casually.
- **HSTS caution:** the `Strict-Transport-Security` header is sticky — once a browser sees it, it refuses HTTP for this domain for 6 months. DreamHost's Let's Encrypt auto-renews so this is normally fine, but if you ever need to roll back HTTPS, set `max-age=0` and wait for browsers to re-fetch first.

## Patterns and conventions

### Adam's working style
- Ships incrementally with verification at each step
- Prefers conservative architectural choices; wants tradeoffs discussed before significant engineering
- Will push back on over-engineering — favors the simplest thing that works (e.g. chose browser-driven sheet edits over a Sheets MCP; chose sheet-review over PR-review). Surface the simple option honestly even when a fancier one is technically nicer.
- Values clean code with thorough explanatory comments — over-comment over under-comment
- Has CLI git installed (use it directly); GitHub Desktop also available if preferred for visual review
- Local working dir: `C:\Millersville\Millersville-PA\`
- Runs verification scripts locally on **Windows PowerShell**

### Commit messages
- Auto-commits from cron: `System: Auto-syncing Community Data`
- Human commits: descriptive one-line summary + short body explaining the *why* if not obvious. Past commits are sometimes terse ("j", ".") — don't follow that. Separate distinct changes into multiple commits.

### Code style
- Long, descriptive comments explaining *why*, not *what*
- Defensive error handling on every external fetch (try/catch with descriptive log messages)
- Status/log emoji prefixes are part of the convention: ✅ success, ❌ error, ⚠️ warning, 📡 fetch, 📊 stats, 💾 write, 🏷️ tag, 📺 broadcast, 🏆 sports, 📥 received, ⏭️ skipped, 🍽️ specials, 📅 calendar, 📌 event, 📦 cached, ⏰ scheduled, ➕ created, 🔗 deduped
- Prefer pure functions over mutating state where possible
- Hand-maintained JSON files use `_comment` and `_format` fields as inline documentation (stripped by JSON.parse, ignored by code)

### Event dedup (in scrape.js, runs before write)
Three passes produce the final `deduped` array:
1. Exact-duplicate removal
2. Cross-source dedup (TZ-aware key, prioritizes MU Calendar over GetInvolved, etc.)
3. **Prefix-title dedup** — for same-venue + same-datetime events, if one title is a clean prefix of the other (followed by a separator or "w."/"with"/"feat"), drops the shorter, keeps the longer. Catches Eventbrite double-listings (e.g. "The Big Do 3" + "The Big Do 3 w. Skipping Stones") that have different event IDs so ID-dedup misses them. Scoped TIGHTLY to the prefix relationship — verified it does NOT merge legitimate same-slot pairs (Varsity/JV, Boys/Girls, trash/yard-waste). If you ever broaden this, re-verify against the full event set first; a naive "same venue+time = dupe" rule would wrongly merge dozens of real events.

### What gets cached vs fetched fresh
- Anything from external sites: fetched every cron (no caching across cron runs by default)
- Vision API results (legacy): cached in `vfw-cache.json` / `grocery-cache.json` (no longer updated)
- MU recap URLs: cached for one cron run only
- `auto-events.json`: weekly scrape output, refreshed by `scrape-monthly.js` (dormant — both target sources blocked by Cloudflare on GitHub Actions IPs)

## Status dashboard signals

`status.html` reads `status.json` + `status-history.json` + `notifications-status.json` + `auto-events-status.json`. Key thresholds:
- **Per-source degradation:** <50% of 7-day median → warn (yellow); <10% or 0 → err (red). NOISE_FLOOR=4 silences sources where median <4.
- **Stale data:** newest event date hasn't advanced in N days (per-source, configured in status.html).
- **Daily push notifications:** warn >36h since last run, err >72h.
- **Weekly auto-scraper:** warn >9d, err >16d.
- **Recent additions (7d):** rolling window of newly-seen events. 0 in one run is normal; 0 for many consecutive runs suggests upstream breakage.

## Secrets in GitHub Actions

- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — push notification keys (DO NOT regenerate; would invalidate all existing subscriptions)
- `DREAMHOST_USERNAME` / `DREAMHOST_PASSWORD` / `DREAMHOST_SERVER` / `DREAMHOST_DIR` — SFTP credentials
- `HEALTHCHECK_URL` — healthchecks.io ping URL for cron heartbeat
- `DIRECTORY_SHEET_CSV_URL` — published CSV of the Directory Google Sheet (read by sync-directory.js)
- `CANDIDATES_SHEET_CSV_URL` — published CSV of the Event Candidates Google Sheet (read by sync-candidates.js)
- `VFW_SHEET_ID` — Google Sheet ID for legacy VFW Vision pipeline (can be removed after grocery transition is stable)
- `ANTHROPIC_API_KEY` — no longer used by active code paths after Vision pipelines disabled; verify no straggler usage before removing
- `GOOGLE_VISION_API_KEY` — unused (replaced by Anthropic Vision long ago); can be removed

**Published-CSV URL gotcha:** the sheet syncs need the **Publish to web → CSV** URL (shape: `docs.google.com/spreadsheets/d/e/2PACX-.../pub?...output=csv`), NOT a share link (`.../edit?usp=sharing`) or a Drive file link (`drive.google.com/file/d/...`) — both of those return HTML and the sync scripts reject them with "looks like HTML, not CSV." Publish from inside the sheet (File → Share → Publish to web → pick CSV), check "Automatically republish."

## Things to verify before claiming "done"

1. `node -c scripts/scrape.js` — parses without syntax error (also `sync-directory.js`, `sync-candidates.js` if touched)
2. For HTML changes: load the file in a browser, not just trust the smoke test
3. For status.html changes: extract the inline `<script>` and run `node -e "new Function(scriptText)"` to catch JS errors
4. For JSON changes: validate the file passes the same jq shape checks that `main.yml` enforces
5. For changes to `lib/eventMatch.js`: also update `events.ics.php`
6. For sheet-sync changes: test the script locally against the real published CSV URL and `git diff` the generated JSON before trusting it (these scripts OVERWRITE the JSON files)

## Known gotchas

- **Time zones:** scraper runs in UTC on the GitHub runner; events stored as ISO strings with explicit offsets; frontend renders in user's local. ET (`America/New_York`) is the canonical "site time" for "today" and the 7am notification window. Sheet `Date`/`Deadline` cells should use ISO-with-Eastern-offset (`-04:00` EDT mid-March→early Nov, `-05:00` EST) to avoid ambiguity.
- **Cache invalidation:** `sw.js` precaches the app shell with a per-deploy version number. Users on old service workers may see stale data until reload — usually self-fixes within a session; if testing a fresh deploy, hard-reload + check DevTools → Application → Service Workers.
- **MU Hudl auth:** requires `x-hudl-usehotchocolate: 100` header (current as of April 2026). If MU broadcasts suddenly drop to 0, this header may have rotated.
- **GitHub Actions IPs are blocked by Cloudflare** on several target sources (MU alumni events, MU tech camps). Can't be re-enabled — use Cowork/Claude Code session.
- **Sheet syncs make the sheet the source of truth** — once adopted, the generated JSON files (directory files; PM/youth/borough-create overrides) are OVERWRITTEN every cron from the sheet. Anything you want kept must be IN the sheet. Don't hand-edit these files expecting it to stick (exception: borough enrichment entries, which the candidate sync preserves — see the two-mode split).
- **Tag display cleanup (app.js):** MU calendar events sometimes carry administrative department names as tags/orgs that render as ugly/wrong pills. Hidden/normalized in app.js: "Human Resources", "Office of the Provost", "Office of VP for Finance and Administration", "Advancement Department" are suppressed from chips and fall back to "MU"; specific residence halls (e.g. "Shenks Residence Hall") collapse to the generic "Residence Halls" when that category tag is present; "ACampus Campuswide ALL" location artifact normalizes to "Campus Wide". These are finite denylists — if a NEW admin department leaks into a pill, add it. Real academic departments (e.g. "Communication & Theatre") and real student orgs (SGA, IAEM) are intentionally NOT suppressed even when occasionally mis-tagged.
- **Deleting a file doesn't always look deleted (SPA fallback masks 404s):** `lftp mirror --delete` DOES remove a `git rm`'d file from DreamHost, BUT requesting the deleted path can still return HTTP **200**, because the `.htaccess` SPA fallback serves `index.html` for any non-real-file path. A 200 does NOT prove the file still exists. To verify a deletion: check via SFTP directly, or confirm the response body is the app shell (contains `Millersville.APP`) rather than the file's real content. A past session burned time chasing a "phantom" `mu-status-proxy.php` that was already correctly deleted.
- **Cowork-maintained files auto-expire:** `vfw.json` (weekly specials) and `grocery.json` (weekly deals) gate their specials/deals on a `validThrough` date. Once past it, VFW specials are hidden and grocery falls back to legacy `grocery-cache.json` (stale deals). Events inside `vfw.json` still display regardless. Refresh via `vfw-facebook-sync` (Tue/Fri ~9:09 AM) and `weekly-grocery-circular` (Thu ~7:39 AM); manual Cowork refresh is the fallback.
- **Housing is currently all-inactive in the directory sheet** (deliberate — kept as prospect rows with the Active column blank), so `housing.json` is `[]` and the Housing section is empty until Adam flips apartments active. Same pattern for several would-be directory businesses kept as inactive prospects.

## Scheduled Cowork tasks (as of this session)

Four scheduled tasks, all working dir `C:\Millersville\Millersville-PA`:

- **`vfw-facebook-sync`** — Tue/Fri ~9:09 AM — refreshes `vfw.json` from VFW Post 7294 Facebook (transcribes weekly-specials image, decodes monthly events-calendar image, captures one-off posts; Adam approves diff, commits via GitHub Desktop). SKILL.md at `C:\Users\AdamHoke\Documents\Claude\Scheduled\vfw-facebook-sync\SKILL.md`.
- **`weekly-grocery-circular`** — Thu ~7:39 AM — refreshes `grocery.json` from John Herr's circular.
- **`camps.json` sync** — Every Monday ~8:00 AM — verifies/updates `camps.json` against eight upstream sources (tech camps via WooCommerce, alumni events + Summer Fun Series on millersville.edu, and six athletic camps on Totalcamps/custom sites). Uses Claude-in-Chrome MCP (Totalcamps are JS-rendered SPAs — wait 3-5s after nav; workspace web_fetch returns empty shells). Surfaces a NEW / MATCH-with-changes / MATCH-clean / REMOVED / ATHLETIC-FLAGS diff for approval before writing. **Never auto-removes** Athletic Camp entries or non-source manual additions (flags instead); skips the `supervised-lunch` add-on; bakes a "confirm with organizers" note when a listing-card date conflicts with its detail page. Opens the result in Notepad++ (NOT VS Code — not installed under that name). Touches only `camps.json`; user commits manually.
- **`Local Event Candidates → Review Sheet`** — weekly — appends Borough / PM-community / youth-sports candidates to the Event Candidates Google Sheet for Adam's X-approval (drives signed-in Chrome to edit the sheet; append-only).

The three earlier per-source curation tasks (borough events, PM community, youth sports — all PR-based) were PAUSED and superseded by the single consolidated `Local Event Candidates → Review Sheet` task above.

## When something breaks

- Site visibly broken: check `~/logs/millersville.app/https/error.log` on DreamHost
- Stale data: check last successful Actions run; if cron hasn't completed in >2h, that's the issue
- Wrong event titles/details: check if a hand-maintained override (borough-overrides enrichment, shortnames-overlay, org-overrides) should be updated rather than fighting the upstream scrape
- Missing curated event: check the Event Candidates sheet — is the row Approved (X)? Is its `registrationDeadline` already past (auto-hidden)? Did `sync-candidates.js` run before scrape in the last cron?
- Duplicate event: if same venue+time with a prefix-title relationship, the dedup should catch it on next scrape; otherwise check if it's two genuinely-different source listings
- Notification not delivering: check `notifications-status.json` for `lastRunAt`/counts; if `Sent: N` but no notification, check the `push` handler in `sw.js`
