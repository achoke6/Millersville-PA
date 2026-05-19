# camps.json sync report — 2026-05-18 (updated with Chrome verification)

Automated scheduled run, re-run with Chrome MCP available. **No changes have been written to `camps.json`** — the task spec requires AskUserQuestion approval; this report is for you to review and apply manually.

## Source load status

All 9 sources successfully scraped this pass.

| # | Source | URL | Status |
|---|---|---|---|
| 1 | Tech camps shop | millersvilletechcamps.com/shop/ | OK (web_fetch) — 23 products across 2 pages |
| 2 | Alumni events listing | millersville.edu/alumni/events/ | OK (web_fetch) — 9 upcoming events |
| 3 | Summer Fun Series | millersville.edu/alumni/events/summer_fun/ | OK (web_fetch) — 8 Thursday dates Jun 11 – Jul 30 |
| 4 | Baseball camp | shehanbaseballcamps.totalcamps.com | OK (Chrome) — 13 sessions, $260–$1,900 |
| 5 | Field Hockey camp | millersvillefieldhockey.totalcamps.com | OK (Chrome) — 3 clinics |
| 6 | Men's Soccer camp | millersvillemenssoccer.totalcamps.com | OK (Chrome) — 2 camps starting 7/12 |
| 7 | Football camp | millersvillefootball.totalcamps.com | OK (Chrome) — 2 sessions (5/21 and 5/29) |
| 8 | Basketball camp | millersvillebasketball.totalcamps.com | OK (Chrome) — 2 sessions (5/30 and 5/31) |
| 9 | Women's Soccer camp | millersvillewomenssoccercamps.com | OK (Chrome) — 2 clinics (6/29 and 7/20) |

## Summary

| Bucket | Count |
|---|---|
| NEW (to add) | 3 tech camps |
| MATCH with proposed changes | 1 (Women's Soccer date) |
| MATCH clean | 41 |
| REMOVED (no longer in source) | 0 |
| ATHLETIC FLAGS (additional sessions not in camps.json) | 2 (Football #2, Basketball Coach Stitzel) |
| Date discrepancy noted | 1 (Screen Printing — existing JSON correct, no action) |

## NEW — 3 tech camps to add

These three WooCommerce products are live on the shop page but not yet in `camps.json`. Dates/times pulled from product detail pages.

### 1. The Maplewood Shop — Morning (Grades 3+)

Companion to the existing "The Maplewood Shop — Afternoon" entry — same week, same instructor, different time slot.

```json
{
  "title": "The Maplewood Shop — Morning (Grades 3+)",
  "date": "2026-07-06T09:00:00-04:00",
  "endTime": "2026-07-06T12:00:00-04:00",
  "location": "Millersville University (Tech & Engineering)",
  "tags": ["MU", "Summer Camp", "Educational"],
  "price": "$240",
  "registrationUrl": "https://millersvilletechcamps.com/product/the-maplewood-shop-7-6-7-10/",
  "description": "Morning session, 9am-12pm, week of 7/6-7/10. Grades 3+. Hand tools, hand-held power tools, and small machines with shop safety — projects include marble run, tool/toy tote, bird feeder, and pucket game. Curriculum from Maplewoodshop.",
  "kidFriendly": true
}
```

### 2. Wood, Tools & Mastery: Build Something Beautiful (Grades 5+)

Instructor Alex Johnson. Hardwood box build, focus on joinery and finishing.

```json
{
  "title": "Wood, Tools & Mastery: Build Something Beautiful (Grades 5+)",
  "date": "2026-07-06T09:00:00-04:00",
  "endTime": "2026-07-06T12:00:00-04:00",
  "location": "Millersville University (Tech & Engineering)",
  "tags": ["MU", "Summer Camp", "Educational"],
  "price": "$235",
  "registrationUrl": "https://millersvilletechcamps.com/product/wood-tools-mastery/",
  "description": "Morning session, 9am-12pm, week of 7/6-7/10. Grades 5+. Real woodshop with proper tool use and shop safety — build a keepsake hardwood box with accurate measuring, clean joinery, and finishing techniques. Small group size for close supervision.",
  "kidFriendly": true
}
```

### 3. YouTube Studio Camp (Grades 3-6)

Afternoon companion to the 6/22 morning slate. Detail page currently shows "Out of stock" — confirm with tech camps whether registration will reopen before publishing.

```json
{
  "title": "YouTube Studio Camp (Grades 3-6)",
  "date": "2026-06-22T13:00:00-04:00",
  "endTime": "2026-06-22T16:00:00-04:00",
  "location": "Millersville University (Tech & Engineering)",
  "tags": ["MU", "Summer Camp", "Educational"],
  "price": "$215",
  "registrationUrl": "https://millersvilletechcamps.com/product/youtube-studio-camp/",
  "description": "Afternoon session, 1pm-4pm, week of 6/22-6/26. Grades 3-6. Become a YouTube creator — DIYs, parodies, reviews, screencasts, Let's Plays. Custom thumbnails, channel graphics, video editing, lighting, screen capture, special effects, and audio production. Note: registration page currently marked Out of Stock — confirm with organizers before publishing.",
  "kidFriendly": true
}
```

## MATCH with proposed change — 1

### MU Women's Soccer Summer Camp — date update 6/22 → 6/29

The current entry shows `2026-06-22T09:00:00`, but the Totalcamps registration page shows the **earliest 2026 clinic is Monday, June 29** (followed by Monday, July 20). The 6/22 date appears stale — the website's "About Us" page hints at 6/22 in body copy, but the actual shop/EVENT page lists 6/29 and 7/20.

Proposed change (only `date` and `endTime` fields; title, registrationUrl, kidFriendly preserved per athletic-camp rules):

```diff
   {
     "title": "MU Women's Soccer Summer Camp",
-    "date": "2026-06-22T09:00:00-04:00",
-    "endTime": "2026-06-22T11:30:00-04:00",
+    "date": "2026-06-29T09:00:00-04:00",
+    "endTime": "2026-06-29T11:30:00-04:00",
     "location": "Millersville University (Chryst Field)",
     ...
   }
```

The clinic price tier ($100 early / $110 regular / $120 late) is visible now — you could optionally tighten `"price": "See registration page"` to `"$100-$120"`, but I'm leaving the existing string since it's still accurate.

## MATCH clean — 41 entries

### Tech camps (19 matches)

All 19 existing tech camp entries match by slug. No field changes proposed for any of them.

### Summer Fun Series (8 matches)

All 8 entries (Jun 11, Jun 18, Jun 25, Jul 2, Jul 9, Jul 16 "Partners TBD", Jul 23, Jul 30 Finale) match source exactly.

### Alumni events (9 matches)

All 9 entries match the listing page: 'Ville at the Mill (5/27), Grandview Vineyards (5/29), Phila. Union (7/25), Candle Lighting (8/21), Homecoming (10/17), Veteran's Day (11/12), Glorious Sounds (12/5), Wreath Laying (12/13), Egg Hunt (4/3/27).

### Athletic camps (5 matches — confirmed via Chrome)

| Camp | Existing date in camps.json | Source-verified | Verdict |
|---|---|---|---|
| MU Baseball Summer Camp | 2026-06-23 09:00 | 6/23 College Coaches Clinic 1 (earliest non-sold-out) | Match (note: sold-out Team Camp #1 starts 6/12, but 6/23 is the better consumer-facing date — kept as-is) |
| MU Field Hockey Summer Camp | 2026-05-30 09:00-13:45, $225 | 5/30 RAD Talent ID, 9:00-1:45pm, $225 | Exact match |
| MU Men's Soccer Summer Camp | 2026-07-12 09:00 | 7/12 Boys Summer Residential Camp | Match |
| MU Football Summer Camp | 2026-05-21 16:00-20:30, $60 | 5/21 Drew Folmar Camp #1, 4:00-8:30 PM, $60 | Exact match |
| MU Basketball Summer Camp | 2026-05-30 09:00 | 5/30 Spring Team Camp | Match |

## ATHLETIC FLAGS — 2 additional sessions not in camps.json

These are extra sessions of camps that are already represented by another entry. Adam may have intentionally chosen to list only the first session — flagging for awareness, not auto-adding.

1. **Football Camp #2** — 5/29/26, 4:00-8:30 PM, $60 (second of the Drew Folmar Camps). camps.json lists Camp #1 on 5/21 only.
2. **Basketball Coach Stitzel Spring Elite Camp** — 5/31/26, $125 (high-intensity exposure camp for 9th-12th grade). camps.json lists the 5/30 Spring Team Camp only.

If you want either added, I can draft entries on the next pass — but they're optional per the existing one-entry-per-camp convention.

## REMOVED — 0

No `camps.json` entries are missing from sources.

## Date discrepancy noted — 1 (no action)

**Make Your Own Merch: Screen Printing** — shop listing title reads "7/13-7/22" but the product detail page body and `og:description` both say "July 13 to 17, 2026 – 9:00-12:00". Existing `camps.json` entry already uses 7/13-7/17, matching the detail page. The shop title is a typo. **No change needed.**

## How to apply the changes

1. **Add the 3 new tech camp entries** — insert immediately after the existing tech camp block (right before the first Summer Fun Series entry) to preserve the current ordering: athletic → tech → Summer Fun → Alumni.

2. **Update the Women's Soccer date** — change `2026-06-22` → `2026-06-29` in both `date` and `endTime` (camps.json lines 46-47).

3. **Validate** after editing with `node -e "JSON.parse(require('fs').readFileSync('camps.json','utf8'))"` or the jq checks in `.github/workflows/main.yml`.

4. (Optional) Decide whether to add the Football #2 and Basketball Coach Stitzel additional sessions.
