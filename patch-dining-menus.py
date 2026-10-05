#!/usr/bin/env python3
"""patch-dining-menus.py — Weekly dining-hall menus (dining-menus.json) on the
food card. 2026-10-05. Run from the repo root: `python patch-dining-menus.py`.
Idempotent: re-running after a successful apply reports 'already applied'.
Detects each file's EOL by byte count and writes it back unchanged.

Edits (6 anchored, all exact-match):
  app.js   A1  loadPlaces Promise.all gains fetch('dining-menus.json')
  app.js   A2  destructuring gains diningMenus
  app.js   A3  window._diningMenus = diningMenus (after _placesSpecials)
  app.js   A4  new helpers diningMenuFor() + diningMenuSectionHtml() before buildFoodCard
  app.js   A5  buildFoodCard: View Menu branch → This Week's Menu ↗ (sourceLink) when a current block exists
  app.js   A6  buildFoodCard template: ${menuHtml} after ${eventsHtml}
  main.yml M1  loop list + shape checks for dining-menus.json
"""
import sys, os

def eol_of(data: bytes):
    crlf = data.count(b"\r\n"); lf = data.count(b"\n") - crlf
    return "\r\n" if crlf > lf else "\n"

def load(path):
    data = open(path, "rb").read()
    eol = eol_of(data)
    text = data.decode("utf-8").replace("\r\n", "\n")
    return text, eol

def save(path, text, eol):
    out = text.replace("\n", eol).encode("utf-8")
    open(path, "wb").write(out)

def apply(text, edits, label):
    done = 0; skipped = 0
    for name, old, new in edits:
        if new in text:   # every NEW contains its OLD, so presence of NEW = applied
            print(f"  {name}: already applied"); skipped += 1; continue
        n = text.count(old)
        if n != 1:
            print(f"  ❌ {name}: anchor matched {n} times (expected 1) — aborting {label}"); sys.exit(1)
        text = text.replace(old, new); done += 1
        print(f"  ✓ {name}")
    return text, done, skipped

# ---------------------------------------------------------------- app.js
A1_OLD = "        fetch('campus-cupboard.json').then(r=>r.json()).catch(()=>undefined),\n        loadAssociation()"
A1_NEW = "        fetch('campus-cupboard.json').then(r=>r.json()).catch(()=>undefined),\n        fetch('dining-menus.json').then(r=>r.json()).catch(()=>null),   // weekly dining-hall menus (hand/task-maintained; null = absent)\n        loadAssociation()"

A2_OLD = "    const [restaurants, services, specials, vfw, cupboardData] = await Promise.all(["
A2_NEW = "    const [restaurants, services, specials, vfw, cupboardData, diningMenus] = await Promise.all(["

A3_OLD = "    window._placesSpecials = specials;\n"
A3_NEW = "    window._placesSpecials = specials;\n    window._diningMenus = diningMenus;   // dining-menus.json (slug → weekly menu block) — read by buildFoodCard\n"

A4_OLD = "function buildFoodCard(p, specials, dayName) {\n    // Action buttons\n"
A4_NEW = """// Weekly dining-hall menus (dining-menus.json, 2026-10-05). Hand/task-maintained
// mirror of Ville Dining's Sunday Instagram carousel — slug-keyed under .places,
// per-ET-date under .days, per-meal (brunch/breakfast/lunch/dinner) → line
// label → items, plus an optional 'also' string. validThrough is EXCLUSIVE
// (vfw.json convention): on/after that ET date the block is stale and ignored.
// Deliberately NOT a specials surface — no rail tile, no gold border, no 🔥
// lens, no specials canary; it only renders inside the food card.
function diningMenuFor(p){
    const places = (window._diningMenus || {}).places;
    const e = places && places[placeSlug(p)];
    if(!e || !e.days) return null;
    const today = hoursTodayISO();
    if(e.validThrough && today >= String(e.validThrough)) return null;
    return { entry: e, day: e.days[today] || null };
}
function diningMenuSectionHtml(p){
    const m = diningMenuFor(p);
    if(!m || !m.day) return '';
    const meals = [['brunch','Brunch'],['breakfast','Breakfast'],['lunch','Lunch'],['dinner','Dinner']];
    const mealHtml = meals.map(([key,label])=>{
        const meal = m.day[key];
        if(!meal || typeof meal !== 'object') return '';
        const lines = Object.keys(meal).filter(l=>l!=='also').map(l=>{
            const items = meal[l];
            if(!Array.isArray(items) || !items.length) return '';
            return `<p style="font-size:0.8rem;color:var(--text);margin:2px 0;"><span style="font-weight:600;">${escHtml(l)}:</span> ${items.map(escHtml).join(', ')}</p>`;
        }).join('');
        const also = meal.also ? `<p style="font-size:0.75rem;color:var(--text-muted);margin:2px 0;">${escHtml(meal.also)}</p>` : '';
        if(!lines && !also) return '';
        return `<p style="font-size:0.8rem;font-weight:700;margin:6px 0 2px;">${label}</p>${lines}${also}`;
    }).join('');
    if(!mealHtml) return '';
    return `<details class="specials-section" style="margin-top:6px;"><summary style="font-size:0.8rem;font-weight:700;cursor:pointer;">🍽 Today's Menu</summary>${mealHtml}<p style="font-size:0.7rem;color:var(--text-muted);font-style:italic;margin-top:4px;">Menus are subject to change without notice.</p></details>`;
}

function buildFoodCard(p, specials, dayName) {
    // Action buttons
"""

A5_OLD = "    else actionBtn=`<a href=\"${p.link}\" target=\"_blank\" class=\"btn btn-sm btn-outline\" style=\"display:block;text-align:center;\">📄 View Menu</a>`;\n"
A5_NEW = ("    else {\n"
          "        // Weekly menu block present (dining-menus.json) → link the week's Instagram\n"
          "        // post instead of the generic dining page; no block → unchanged View Menu.\n"
          "        const dm = diningMenuFor(p);\n"
          "        const menuHref = (dm && dm.entry.sourceLink) || p.link;\n"
          "        const menuLabel = dm ? '📄 This Week\\'s Menu ↗' : '📄 View Menu';\n"
          "        actionBtn=`<a href=\"${menuHref}\" target=\"_blank\" rel=\"noopener\" class=\"btn btn-sm btn-outline\" style=\"display:block;text-align:center;\">${menuLabel}</a>`;\n"
          "    }\n")

A6_OLD = "    const evT = placeEventsToday(p);\n    const eventsHtml = evT.length ? `<div class=\"specials-section\"><p style=\"font-size:0.8rem;font-weight:700;margin-bottom:4px;\">📅 Here today:</p>${evT.slice(0,3).map(e=>`<p style=\"font-size:0.8rem;color:var(--text);margin:2px 0;\">• ${e.title} · ${formatTime(new Date(e.t))}</p>`).join('')}</div>` : '';\n    return `<div class=\"app-card\" data-place=\"${placeSlug(p)}\" style=\"position:relative;display:flex;flex-direction:column;justify-content:flex-start;\">\n"
A6_NEW = "    const evT = placeEventsToday(p);\n    const eventsHtml = evT.length ? `<div class=\"specials-section\"><p style=\"font-size:0.8rem;font-weight:700;margin-bottom:4px;\">📅 Here today:</p>${evT.slice(0,3).map(e=>`<p style=\"font-size:0.8rem;color:var(--text);margin:2px 0;\">• ${e.title} · ${formatTime(new Date(e.t))}</p>`).join('')}</div>` : '';\n    const menuHtml = diningMenuSectionHtml(p);   // collapsed 🍽 Today's Menu — '' when no current block for this slug/day\n    return `<div class=\"app-card\" data-place=\"${placeSlug(p)}\" style=\"position:relative;display:flex;flex-direction:column;justify-content:flex-start;\">\n"

A6b_OLD = "        ${specialsHtml}${eventsHtml}\n        <div class=\"card-footer\" style=\"display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:auto;\">\n            <div style=\"flex:1;\">${actionBtn}</div>"
A6b_NEW = "        ${specialsHtml}${eventsHtml}${menuHtml}\n        <div class=\"card-footer\" style=\"display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:auto;\">\n            <div style=\"flex:1;\">${actionBtn}</div>"

# ---------------------------------------------------------------- main.yml
M1_OLD = "          for f in camps.json org-overrides.json shortnames-overlay.json imleagues.json venue-aliases.json place-specials.json; do"
M1_NEW = "          for f in camps.json org-overrides.json shortnames-overlay.json imleagues.json venue-aliases.json place-specials.json dining-menus.json; do"

M2_OLD = ("            jq -e '[.places[] | select(has(\"activeRanges\")) | .activeRanges] | all(type == \"array\" and length > 0 and all(has(\"from\") and has(\"to\") and (.from | test(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\")) and (.to | test(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\"))))' place-specials.json > /dev/null \\\n"
          "              || { echo \"❌ place-specials.json: every activeRanges must be a non-empty array of {from,to} ISO dates (YYYY-MM-DD)\"; exit 1; }\n"
          "          fi\n")
M2_NEW = M2_OLD + (
          "          if [ -f dining-menus.json ]; then\n"
          "            jq -e '.places | type == \"object\"' dining-menus.json > /dev/null \\\n"
          "              || { echo \"❌ dining-menus.json must have a .places object (slug → weekly menu block)\"; exit 1; }\n"
          "            jq -e '.places | keys | all(test(\"^[a-z0-9][a-z0-9-]*$\"))' dining-menus.json > /dev/null \\\n"
          "              || { echo \"❌ dining-menus.json keys must be directory place slugs (lowercase letters/digits/hyphens)\"; exit 1; }\n"
          "            jq -e '[.places[]] | all(has(\"validThrough\") and has(\"days\") and (.validThrough | test(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\")) and (.days | type == \"object\") and (.days | keys | all(test(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\"))))' dining-menus.json > /dev/null \\\n"
          "              || { echo \"❌ dining-menus.json: every place needs validThrough (YYYY-MM-DD) + a .days object keyed by YYYY-MM-DD\"; exit 1; }\n"
          "          fi\n")

def main():
    root = os.getcwd()
    for rel, edits in [("app.js", [("A2 destructure", A2_OLD, A2_NEW), ("A1 fetch", A1_OLD, A1_NEW), ("A3 global", A3_OLD, A3_NEW),
                                    ("A4 helpers", A4_OLD, A4_NEW), ("A5 button", A5_OLD, A5_NEW), ("A6 menuHtml const", A6_OLD, A6_NEW), ("A6b template", A6b_OLD, A6b_NEW)]),
                       (os.path.join(".github", "workflows", "main.yml"), [("M1 loop", M1_OLD, M1_NEW), ("M2 shape", M2_OLD, M2_NEW)])]:
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            print(f"❌ {rel} not found — run from the repo root"); sys.exit(1)
        text, eol = load(path)
        print(f"{rel} (EOL {'CRLF' if eol == chr(13)+chr(10) else 'LF'}):")
        text, done, skipped = apply(text, edits, rel)
        if done: save(path, text, eol)
        print(f"  → {done} applied, {skipped} already present")
    print("\nNext: node --check app.js  ·  add dining-menus.json (CRLF) at the repo root  ·  verify EOL byte counts.")

if __name__ == "__main__":
    main()
