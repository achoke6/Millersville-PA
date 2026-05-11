# Millersville camps.json — Sync Report (2026-05-11)

This is an **automated, unattended run** of the `millersville-events-weekly-sync` scheduled task. Because no user is present to approve changes, **no edits were written to `camps.json`**. The diff below is for human review; apply the suggested changes manually or rerun the task interactively.

## Source load status (8 sources attempted)

| # | Source | URL | Load |
|---|---|---|---|
| 1 | Tech camps shop | millersvilletechcamps.com/shop/ | OK (20 products listed, 19 valid + 1 supervised-lunch skipped) |
| 2 | Alumni events index | millersville.edu/alumni/events/ | OK (9 event articles + 4 news blog cards) |
| 3 | Summer Fun Series | millersville.edu/alumni/events/summer_fun/ | OK (8-week schedule rendered) |
| 4 | Baseball | shehanbaseballcamps.totalcamps.com | OK — earliest upcoming 6/23/26 |
| 5 | Field Hockey | millersvillefieldhockey.totalcamps.com | OK — earliest upcoming 5/30/26 |
| 6 | Men's Soccer | millersvillemenssoccer.totalcamps.com | OK — earliest upcoming 7/12/26 |
| 7 | Football | millersvillefootball.totalcamps.com | OK — earliest upcoming 5/21/26 |
| 8 | Basketball | millersvillebasketball.totalcamps.com | OK — earliest upcoming 5/30/26 |
| 9 | Women's Soccer | millersvillewomenssoccercamps.com | OK — earliest upcoming 6/22/26 |

## NEW (would be added)

None. Every event surfaced by the eight sources already has a corresponding entry in `camps.json`.

## MATCH-with-changes (field-level proposals)

| Entry | Field | Current | Scraped | Proposal |
|---|---|---|---|---|
| MU Field Hockey Summer Camp | `price` | `"See registration page"` | `$225` (Talent ID 5/30) | Optional: update to `"$225"`. The scraped page shows the May 30 Talent ID session explicitly priced at $225/individual. Other field-hockey sessions later in the summer may carry different prices, so leaving `"See registration page"` is also defensible. |
| Make Your Own Merch: Screen Printing (Grades 6+) | (no change to camps.json) | listing title says **7/13-7/22**, detail body says **July 13 to 17, 2026 – 9:00-12:00** | **Flag/no change** — `camps.json` already has 7/13 09:00 which matches the detail page. The listing card title `7/13-7/22` looks like a typo on the source side (other 7/13 camps are 7/13-7/17). Suggest baking a "listing-card date is mistyped — confirm with organizers" note into the description, similar to the Veteran's Day and Egg Hunt entries. |

## MATCH-clean (in both, no field changes proposed)

42 entries. Breakdown:
- 19 tech camps (all dates, prices, titles match the WooCommerce shop and detail pages).
- 6 athletic camps (all six registration sites loaded and show current 2026 sessions whose earliest dates match the existing `date` field).
- 8 Summer Fun Series entries (June 11, 18, 25; July 2, 9, 16, 23, 30; partners + storytellers all match the published schedule).
- 9 alumni events (`'Ville at the Mill`, Grandview Vineyards/EDHS, Philly Union Takeover, Candle Lighting, Homecoming 2026, Veterans Day, Glorious Sounds, Wreaths Across America, Family Egg Hunt). The Veterans Day and Egg Hunt detail pages still reference the *previous* year's date (Nov 12, 2025 and March 28 respectively), which is exactly what the existing `description` notes already say.

## REMOVED (in camps.json but absent from a source)

None. No entries appear in `camps.json` that are missing from their upstream source.

## ATHLETIC FLAGS (Totalcamps pages that failed to load or showed no sessions)

None — all six athletic registration sites loaded and showed at least one upcoming 2026 session.

## Date / time discrepancies encountered

| Item | Listing says | Detail page says | Resolution |
|---|---|---|---|
| Make Your Own Merch: Screen Printing | `7/13-7/22 – Mornings – Grades 6+` (title on shop card) | `July 13 to 17, 2026 – 9:00-12:00` (description body) | Use detail-page date (7/13-7/17 9 AM-noon). `camps.json` is already correct. Optionally add a "confirm with organizers — listing card has typo" note to the description, per the standing pattern. |
| Veteran's Day Event: Salute to Service | Listing-card sidebar: November 12, 2026 | Detail page body: "Wednesday, November 12, 2025" | No change. The existing `description` already flags this with "detail page text references 2025 — confirm current-year date with organizers before publishing." |
| Millersville University Family Egg Hunt | Listing card title: Alumni Egg Hunt | Detail page body: "Saturday, March 28th, 10am-12pm" (last-year copy) | No change. The existing `description` already flags this with "detail page text references March 28th — confirm date with organizers before publishing." |
| Wreaths Across America | Listing card: Dec 13, 2026 | Detail page: "Sunday, December 13, 2026 ... Civil War Monument (10 N George St., Millersville, PA 17551)" | Minor: the detail page now spells the address as `Millersville, PA 17551`; `camps.json` `location` says `(10 N George St, Lancaster)`. Both are arguably correct (the borough line is fuzzy), but the detail page is now consistent with "Millersville". Optional: update location parenthetical to "Millersville". |

## What a reviewer would still need to confirm interactively (the AskUserQuestion step that was skipped)

a. Whether to **apply the price update** on `MU Field Hockey Summer Camp` (`"See registration page"` → `"$225"`).
b. Whether to **add the listing-typo note** to the `Make Your Own Merch: Screen Printing` description.
c. Whether to **update the location parenthetical** on the Wreaths Across America entry from "Lancaster" → "Millersville" to match what the detail page now displays.
d. Whether to leave the Veterans Day and Egg Hunt entries as-is (current existing notes still apply).
e. No kidFriendly overrides needed — all flags continue to match the prevailing rule (21+ events `false`, everything else `true`).

## Net effect on `camps.json`

If the reviewer accepts all three optional proposals (a, b, c), the change is **three field edits, zero adds, zero removes**. If they accept none, `camps.json` does not need to be modified at all for this cycle.

## Notes on autonomy

The task file says "write actions ... only take them if the task file asks for that specific action." The standing flow requires the user to approve adds/changes/removals via AskUserQuestion before any write — there is nothing to write without that approval. No edits were made to `camps.json` and Notepad++ was not opened. Re-run the task interactively to act on the proposals above.
