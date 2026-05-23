# VFW Facebook Sync — 2026-05-22 (Fri)

**Status:** COMPLETED — two time corrections applied to `vfw.json`.

## Source

Scraped https://www.facebook.com/VFWPost7294 via Claude-in-Chrome MCP through Adam's Personal Chrome profile. Read the post feed and the page's Photos tab; clicked into the May 2026 monthly calendar image and the Memorial Day Service flyer to verify times.

## Weekly Specials

**No change.** Most recent weekly-specials post on Facebook is still "Tuesday, May 19 through Saturday, May 23" — that matches what's already in `vfw.json`. No new week (5/26-5/30) posted yet. Current `validThrough` of 2026-05-24 is still in the future.

## Events — changes applied

| Event | Date | Before | After | Source |
|---|---|---|---|---|
| Memorial Day Ceremony and Brunch | 5/24 | 10:00 AM - 1:00 PM | **11:00 AM - 2:00 PM** | "Memorial Day Service Invitation" flyer (posted May 17): "Time: 11 am (Brunch to follow service)". May calendar also shows "@ 11". Description updated to reflect Service + Pavilion location. |
| Post Meeting | 5/27 | 7:00 PM - 8:00 PM | **6:00 PM - 7:00 PM** | May 2026 calendar cell for Wed 5/27: "Wing Night / Trivia @ 6 / Post Meeting @ 6". Diverges from SKILL.md default of 7 PM, but the calendar image is the source of truth. |

Trivia Night 5/27 already at 18:00 — no change.

## Events not changed

The May 2026 calendar (posted May 6) was reviewed in full. No additional event entries to add:

- Past-dated calendar items (Chicken BBQ 5/2, Cinco de Mayo 5/5, Auxiliary Meeting 5/6, Music Bingo 5/8, 12 oz Ribeye 5/1) all >= 14 days past — skipped per SKILL.md.
- Friday rotating specials (Fried Cod 5/29, Tuna Steak 5/22 today) aren't tracked as events.
- Recurring weeknights (Wing/Taco/Shrimp/Burger Night) aren't tracked.
- No June calendar posted yet — typically goes up near the 1st. Next scheduled run (Tue 5/26) should pick it up if posted by then.

## Stale events to remove

None. All current events are future-dated.

## Unclassified posts surfaced

- "Buddy Poppy" image post (Memorial Day prep — not a scheduled event)
- Auxiliary officer election congrats post (May 18 area — not an event)
- Volunteer-day call for May 11 (past, not relevant now)

## Notes for the operator

- `_comment` was already updated by Adam in chat to reference the Facebook source — not touched.
- `vfw-cache.json` not touched (legacy Vision-pipeline cache).
- JSON validates via `python3 -m json.tool`.
- GitHub Desktop should be opened so Adam can review the diff and commit.

## Chrome permission hiccup

Initial Facebook scrape attempts returned `permission_required: www.facebook.com`. After a manual prompt approval the per-tool grants started working — but inside `browser_batch` the per-action permission check still fires fresh and aborts the batch. Single tool calls work fine post-approval. For the next scheduled run, expect the same first-action approval prompt unless the per-site permission has been made persistent in the extension.
