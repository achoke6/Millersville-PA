# camps.json sync report — 2026-05-18

Automated scheduled run. **No changes have been written to `camps.json`.** This is a diff-only report — review and apply the desired edits manually.

## Why no auto-write

The task spec calls for an interactive AskUserQuestion confirmation step before any writes. This run was kicked off by the scheduler with no user present, so following the spec's safety rule ("when in doubt, produce a report"), I'm surfacing the diff for you to apply rather than editing the JSON unattended.

## Source load status

| # | Source | URL | Status |
|---|---|---|---|
| 1 | Tech camps shop | millersvilletechcamps.com/shop/ | OK — 23 products across 2 pages |
| 2 | Alumni events listing | millersville.edu/alumni/events/ | OK — 9 upcoming events |
| 3 | Summer Fun Series | millersville.edu/alumni/events/summer_fun/ | OK — 8 Thursday dates Jun 11 – Jul 30 |
| 4 | Baseball camp | shehanbaseballcamps.totalcamps.com | HTTP 200, empty SPA shell — Chrome MCP not connected, can't render JS |
| 5 | Field Hockey camp | millersvillefieldhockey.totalcamps.com | HTTP 200, empty SPA shell — Chrome MCP not connected, can't render JS |
| 6 | Men's Soccer camp | millersvillemenssoccer.totalcamps.com | HTTP 200, empty SPA shell — Chrome MCP not connected, can't render JS |
| 7 | Football camp | millersvillefootball.totalcamps.com | HTTP 200, empty SPA shell — Chrome MCP not connected, can't render JS |
| 8 | Basketball camp | millersvillebasketball.totalcamps.com | HTTP 200, empty SPA shell — Chrome MCP not connected, can't render JS |
| 9 | Women's Soccer camp | millersvillewomenssoccercamps.com | HTTP 200, empty SPA shell — Chrome MCP not connected, can't render JS |

The 6 athletic camp pages all return HTTP 200 (domains alive, SPAs loading), but their session contents come from JS. Without an interactive Chrome session, I can't read the calendars to verify dates/prices.

## Summary

| Bucket | Count |
|---|---|
| NEW (to add) | 3 |
| MATCH with proposed changes | 0 |
| MATCH clean | 36 |
| REMOVED (no longer in source) | 0 |
| ATHLETIC FLAGS (couldn't verify) | 6 (all preserved per task rule) |
| Date discrepancy noted | 1 (existing camps.json is correct, no action) |

## NEW — 3 tech camps to add

These three WooCommerce products are live on the shop page but not yet in `camps.json`. All times/dates were pulled from the product detail pages and confirmed against the slug.

### 1. The Maplewood Shop — Morning (Grades 3+)

Companion to the existing "The Maplewood Shop — Afternoon" entry. Same week, same instructor, different time slot.

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

New camp from instructor Alex Johnson. Hardwood box build, focus on joinery and finishing.

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

Afternoon companion to the 6/22 morning slate. Note: detail page currently shows "Out of stock" — confirm with tech camps whether registration will reopen or whether the session is canceled before publishing.

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

## MATCH clean (no changes proposed) — 36 entries

| Source slot | camps.json entry |
|---|---|
| Tech: build-your-own-robot-6-22-6-26 | Build Your Own Robot (Grades 7+) |
| Tech: intro-to-solidworks | 3D Printing with SolidWorks (Grades 5+) |
| Tech: intro-to-lego-robotics-6-22-6-26 | Intro to LEGO Robotics (Grades 3+) |
| Tech: video-game-design | Intro to Video Game Design (Grades 6+) |
| Tech: tech-adventure-camp | Tech Adventure Camp: D&D Theme (Grades 3-6) |
| Tech: get-graphic | Get Graphic: Make Your Own Comic! (Grades 3+) |
| Tech: intro-to-lego-robotics-7-6-7-10... | Intro to LEGO Robotics — Week 2 (Grades 3+) |
| Tech: makeyourownmerch | Make Your Own Merch: Printing Exploration! (Grades 3-6) |
| Tech: the-maplewood-shop-7-6-...-copy | The Maplewood Shop — Afternoon (Grades 3+) |
| Tech: residentialwiring | Residential Wiring by Doing! (Grades 6+) |
| Tech: advances-lego-robotics | Advanced LEGO Robotics (Grades 6+) |
| Tech: aquaphonics-camp | Aquaponics Camp — NEW! (Grades 3+) |
| Tech: cnc-machining-for-kids-7-13 | CNC Machining for Kids (Grades 6+) |
| Tech: intro-to-fusion360 | 3D Engineering with Fusion 360 (Grades 5+) |
| Tech: engineering-camp | Engineering Camp (Grades 5+) |
| Tech: make-your-own-merch-printing-exploration | Make Your Own Merch: Screen Printing (Grades 6+) — see discrepancy note below |
| Tech: robot-arm-construction | Robot Arm Construction (Grades 5+) |
| Tech: jewelry-by-you | Jewelry by You: Wearable Art (Grades 4+) |
| Tech: from-waste-to-wow | From Waste to Wow: Recycled Plastics (Grades 4+) |
| Summer Fun: Jun 11 | Summer Fun Series: Happily Ever Crafter & Lancaster Public Library Storytime |
| Summer Fun: Jun 18 | Summer Fun Series: Raven Ridge Wildlife Center & Author Beth Roberts |
| Summer Fun: Jun 25 | Summer Fun Series: Children's Dyslexia Center & Author Sheila Jones |
| Summer Fun: Jul 2 | Summer Fun Series: Corn Doll Husk Making with Mary Kendall & Author Lucinda Hughes '01 |
| Summer Fun: Jul 9 | Summer Fun Series: Blue Rock Regional Fire District & Alumna Amy Hoffman |
| Summer Fun: Jul 16 | Summer Fun Series: Partners TBD (source still shows "Looking for Partners!") |
| Summer Fun: Jul 23 | Summer Fun Series: MU Alumni Association & Alumna Rachel Mark '25 |
| Summer Fun: Jul 30 | Summer Fun Series Finale: Everlasting Wishes |
| Alumni: gold (May 27) | 'Ville at the Mill |
| Alumni: edhs (May 29) | College of Education & Human Services Grandview Vineyards Gathering |
| Alumni: sports (Jul 25) | Philadelphia Union Millersville Takeover |
| Alumni: candle-lighting (Aug 21) | Annual Candle Lighting Ceremony |
| Alumni: homecoming (Oct 17) | Homecoming 2026 |
| Alumni: veterans-day (Nov 12) | Veteran's Day Event: Salute to Service |
| Alumni: holidays (Dec 5) | Glorious Sounds of the Season |
| Alumni: wreath_laying (Dec 13) | Wreaths Across America Wreath Laying Ceremony |
| Alumni: egg_hunt (Apr 3, 2027) | Millersville University Family Egg Hunt |

## REMOVED — 0

No entries appear in `camps.json` but missing from sources.

## ATHLETIC FLAGS — 6 (all preserved)

Per task rules, athletic camp entries are never auto-removed even when their source can't be verified. All 6 entries remain in `camps.json` as-is.

| Entry | URL | Verification status |
|---|---|---|
| MU Baseball Summer Camp | shehanbaseballcamps.totalcamps.com | Domain alive (HTTP 200), session content not verifiable without Chrome |
| MU Field Hockey Summer Camp | millersvillefieldhockey.totalcamps.com | Domain alive (HTTP 200), session content not verifiable without Chrome |
| MU Men's Soccer Summer Camp | millersvillemenssoccer.totalcamps.com | Domain alive (HTTP 200), session content not verifiable without Chrome |
| MU Football Summer Camp | millersvillefootball.totalcamps.com | Domain alive (HTTP 200), session content not verifiable without Chrome |
| MU Basketball Summer Camp | millersvillebasketball.totalcamps.com | Domain alive (HTTP 200), session content not verifiable without Chrome |
| MU Women's Soccer Summer Camp | millersvillewomenssoccercamps.com | Domain alive (HTTP 200), session content not verifiable without Chrome |

Notable: the Football entry's existing date is `2026-05-21T16:00:00` — that's **this Thursday, 3 days from today (2026-05-18)**. If that date is correct, the camp opens this week and is worth a manual spot-check on the registration site. The other athletic camp dates in `camps.json` are also nearing — Field Hockey 5/30, Basketball 5/30 — so a one-time human review pass would be helpful before they pass.

To re-run this task with full Totalcamps verification, connect the Chrome extension before running. The task spec is correct that those SPAs need JS rendering.

## Date discrepancy noted — 1 (no action needed)

**Make Your Own Merch: Screen Printing** — the shop listing title reads `7/13-7/22` but the product detail page body and `og:description` both say `July 13 to 17, 2026 – 9:00-12:00`. The existing `camps.json` entry already uses 7/13–7/17, which matches the detail page. The shop-page title appears to be a typo. **No change needed.** If the user wants to be defensive, the description could mention "confirm with organizers" — but the detail page is unambiguous.

## How to apply the changes

If you want to add the 3 new tech camp entries, insert them into `camps.json` immediately after the existing tech camp block (between the "From Waste to Wow" entry on line 256 and the first Summer Fun Series entry on line 258) to preserve the current ordering convention: athletic camps → tech camps → Summer Fun Series → Alumni events.

After editing, validate with the same jq shape checks that `.github/workflows/main.yml` enforces (or just `node -e "JSON.parse(require('fs').readFileSync('camps.json','utf8'))"`).
