# camps.json Weekly Sync Report — 2026-06-05

Automated run of `camps.json` sync. **No changes were written** — this run found nothing to add, and every candidate change is a "flag for your decision" item (the run was unattended, so I left the file untouched). `camps.json` is unchanged and valid.

## Source load results (all 8 attempted)

| # | Source | Result |
|---|---|---|
| 1 | Tech camps shop (WooCommerce) | ✅ Loaded — 22 camps (2 pages), Supervised Lunch skipped |
| 2 | Alumni events | ✅ Loaded — 8 upcoming events listed |
| 3 | Summer Fun Series | ✅ Loaded — full 8-week schedule table |
| 4 | Baseball (Totalcamps) | ✅ Loaded — current 2026 sessions |
| 5 | Field Hockey (Totalcamps) | ⚠️ Loaded, but only out-of-state RAD clinics (see flags) |
| 6 | Men's Soccer (Totalcamps) | ✅ Loaded — current 2026 sessions |
| 7 | Football (Totalcamps) | ⚠️ Loaded, "no items currently available for purchase" |
| 8 | Basketball (Totalcamps) | ⚠️ Loaded, "no items currently available for purchase" |
| 9 | Women's Soccer (custom site) | ✅ Loaded — 2026 clinic registration open |

## NEW (to add)

None. All 22 tech-camp shop products map 1:1 to existing `camps.json` entries by slug.

## MATCH-with-changes (proposed field updates)

None required.

- **YouTube Studio Camp** — shop listing shows "Add to cart," but the detail page still reads **"Out of stock"** and "June 22 to 26, 2026 – 1:00-4:00." The existing out-of-stock note in `camps.json` is still accurate. No change.
- **Make Your Own Merch: Screen Printing** — listing title reads "7/13-7/22," but the detail page body and meta both say **"July 13 to 17, 2026 – 9:00-12:00."** `camps.json` already has 7/13-7/17, which is correct (the title is their typo). No change.

## MATCH-clean (in both, no change needed) — counts

- Tech camps: **22**
- Summer Fun Series: **7** (8th flagged below)
- Alumni events (upcoming): **7** (Philadelphia Union, Candle Lighting, Homecoming, Veteran's Day, Glorious Sounds, Wreaths Across America, Egg Hunt)
- Athletic camps confirmed loading with current sessions: **3** (Baseball, Men's Soccer, Women's Soccer)

Athletic date confirmations (all already correct in `camps.json`):
- Baseball — earliest individual session = College Coaches Clinic 1, **6/23/26**. Matches existing date.
- Men's Soccer — Boys Summer Residential Camp starts **7/12/26**. Matches existing date.
- Women's Soccer — clinics **June 29** & July 20, **9:00–11:30 AM**. June 29 9:00–11:30 matches existing entry exactly.

## REMOVED (no longer in source — your decision)

These two alumni events have **passed** (today is June 5) and dropped off the alumni events page. The scraper auto-hides past events anyway, so removal is optional housekeeping:
- **'Ville at the Mill** (GOLD) — 5/27/26
- **College of Education & Human Services Grandview Vineyards Gathering** — 5/29/26

## FLAGS — your decision (not auto-changed)

**Summer Fun Series — July 16, 2026:** the source schedule now lists this slot as **"Looking for Partners!" / "Looking for Partners!"** (partner TBD). `camps.json` currently has a specific entry: *"Country Conjuring Magic Show & Ameri-ca-dabra!"* The source no longer confirms that partner. Options: keep as-is, blank the partner detail, or verify with Alumni Engagement.

**Athletic camps (not auto-removed per rules):**
- **Field Hockey** — page loads, but the only current sessions are out-of-state RAD talent-ID clinics (Fairfax VA, 6/29; Temecula CA, 7/12–14). No Millersville/Biemesderfer session is listed, and the existing **5/30/26** entry has passed. Keep, update, or remove?
- **Football** — page loads but shows "no items currently available for purchase." Existing **5/29/26** entry has passed.
- **Basketball** — page loads but shows "no items currently available for purchase." Existing **5/30/26** entry has passed.

## Suggested next step

When you're back, tell me which of the REMOVED/FLAG items to apply and I'll make the surgical edits to `camps.json` and open it in Notepad++ for review.
