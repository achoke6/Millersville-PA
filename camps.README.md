# camps.json — Hand-maintained camp listings

Some camp sources can't be automatically scraped (TotalCamps API blocks GitHub Actions IPs, etc.). This file lets you add camps manually. The scraper reads this file on every run and merges entries into events.json.

## File location
`camps.json` sits in the repo root (alongside `scrape.js`, `grocery-cache.json`, etc.).

## Entry format
```json
{
  "title": "MU Baseball Summer Camp",
  "date": "2026-06-22T09:00:00-04:00",
  "location": "Millersville University (Cooper Park)",
  "tags": ["MU", "Summer Camp", "Athletic Camp", "Baseball"],
  "price": "$275",
  "registrationUrl": "https://shehanbaseballcamps.totalcamps.com/",
  "description": "Summer baseball camp...",
  "kidFriendly": true
}
```

## Field reference
- **title** (required): Display title for the camp
- **date** (required): ISO 8601 with timezone, e.g. `2026-06-22T09:00:00-04:00`
- **location**: Defaults to "Millersville University"
- **tags**: Array. Default: `["MU", "Summer Camp"]`. Include sport name or special tags.
- **price**: String. Free text like "$275" or "See registration page"
- **registrationUrl**: Link users click to register (appears as Details button)
- **description**: Shows in expanded details view
- **kidFriendly**: Defaults to `true`. Set `false` to exclude from family-friendly filter.

## To update dates for a camp
1. Visit the camp's registration page
2. Note the actual start date
3. Edit the `date` field in camps.json
4. Commit & push — the scraper picks it up within the hour

## To add more camps
Copy an existing entry and modify. For recurring multi-week camps, just list the first day of each week as separate entries.

## Current placeholder dates
The 3 entries have placeholder dates in late June 2026. Update them once the registration sites publish real schedules (usually announced by May).
