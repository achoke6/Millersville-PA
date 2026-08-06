#!/usr/bin/env python3
# patch-advertise-v2.py — Advertise page rework (2026-08-03)
#   index.html: intro-line copy fix; starred "What You Get" box removed;
#               CTA box -> "How can we help?" / "Reach Out ->"; two FAQ
#               answers reworded (Community Partner / Get Listed orphans).
#   app.js:     applyAdvertiseGate() — Advertise page + nav hidden for
#               explicit MU students (unset + townie unchanged); switchView
#               choke-point guard; gate wired into setMuAffiliation,
#               applyAffiliation, toggle21Plus, resetEverything, initApp;
#               advertise-modal intro line copy fix.
# Idempotent: safe to run twice (2nd run: 0 applied). Do NOT commit this file.
import os, sys, tempfile

CANDIDATES = [r"C:\Millersville\Millersville-PA", os.getcwd(),
              os.path.dirname(os.path.abspath(__file__))]

def find_root():
    for c in CANDIDATES:
        if os.path.isfile(os.path.join(c, "app.js")) and os.path.isfile(os.path.join(c, "index.html")):
            return c
    sys.exit("FATAL: repo root not found (looked for app.js + index.html in: %s)" % ", ".join(CANDIDATES))

ROOT = find_root()
print("Repo root:", ROOT)

# ---------------------------------------------------------------- edits ----
# All old/new blocks written with \n; converted to the file's detected EOL.

HTML_EDITS = [
    ("H1 intro line — 'University community, local townies or both'",
     "We can push your content to the University community or townies \u2014 it's up to you.",
     "We can push your content to the University community, local townies or both \u2014 it's up to you."),

    ("H2 remove starred 'What You Get' box (.adv-grid block)",
     '''        <div class="adv-grid">
            <div class="adv-tier adv-tier-premium" style="grid-column:1 / -1;max-width:520px;">
                <div class="adv-tier-badge">What You Get</div>
                <div class="adv-tier-icon">\u2b50</div>
                <h4 class="adv-tier-name">Community Partner Listing</h4>
                <p class="adv-tier-desc">One simple listing \u2014 free \u2014 that puts your business in front of the people already using the app every day.</p>
                <div class="adv-tier-perks">
                    <span>\u2713 <strong>Choose your audience</strong> \u2014 reach the University community, local townies, or both</span>
                    <span>\u2713 <strong>Events &amp; specials integration</strong> \u2014 we pull your content from wherever you already post it, no manual work</span>
                    <span>\u2713 <strong>Directory &amp; map listing</strong> \u2014 your business, front and center with logo, tagline, and direct links, plus a pin on the town map</span>
                    <span>\u2713 <strong>Homepage Spotlight eligibility</strong> \u2014 a rotating featured spot on the app's front page</span>
                </div>
            </div>
        </div>

''',
     ""),

    ("H3 CTA box — heading / sub / button",
     '''            <h3 class="adv-cta-title">Interested?</h3>
            <p class="adv-cta-sub">Tell us about your business \u2014 we'll take it from there.</p>
            <button onclick="openAdvertiseForm()" class="btn btn-gold btn-lg" style="border:none;cursor:pointer;">Get Listed \u2192</button>''',
     '''            <h3 class="adv-cta-title">How can we help?</h3>
            <p class="adv-cta-sub">Tell us how we can help \u2014 your daily specials, an event, a spot in the directory and on the map, or something else. Every business is different.</p>
            <button onclick="openAdvertiseForm()" class="btn btn-gold btn-lg" style="border:none;cursor:pointer;">Reach Out \u2192</button>'''),

    ("H4 FAQ 'one-off event' answer — drop Community Partner pitch",
     "<p>Yes \u2014 anyone can submit an event right from the app using the event submission form. A Community Partner listing is for businesses that want their specials and events kept current automatically, plus audience targeting and a permanent spot in the Directory and on the town map.</p>",
     "<p>Yes \u2014 anyone can submit an event right from the app using the event submission form. If you're a business and want your specials and events kept current automatically, reach out and we'll wire it up for you.</p>"),

    ("H5 FAQ 'Can I be added?' answer — drop Get Listed / Community Partner",
     "<p>Absolutely. Click the Get Listed button above and we'll get you set up as a Community Partner.</p>",
     "<p>Absolutely. Click the Reach Out button above or email us and we'll get you set up.</p>"),
]

GATE_FN = '''// Advertise page is hidden from MU students \u2014 explicit 'student' only; unset
// and townie viewers both keep it (the page doubles as the pitch for visitors
// who haven't picked an identity yet). One gate covers the nav button and, if
// the viewer flips to student while ON the page (Feed settings), bounces them
// home. Wired into all three switch paths (new-surface rule: applyAffiliation /
// setMuAffiliation / toggle21Plus \u2014 no-op on the 21+ path), resetEverything
// (identity back to unset \u2192 button reappears), and initApp boot. The
// companion choke-point guard at the top of switchView() catches nav clicks,
// /advertise deep links, and popstate in one place.
function applyAdvertiseGate() {
    const btn = document.getElementById('nav-advertise');
    if (btn) btn.style.display = (muAffiliation === 'student') ? 'none' : '';
    if (muAffiliation === 'student') {
        const v = document.getElementById('view-advertise');
        if (v && v.classList.contains('active') && typeof window.switchView === 'function') window.switchView('home');
    }
}
'''

JS_EDITS = [
    ("J1 define applyAdvertiseGate() above setMuAffiliation",
     "window.setMuAffiliation = function(value) {",
     GATE_FN + "window.setMuAffiliation = function(value) {"),

    ("J2 setMuAffiliation \u2192 call gate",
     '''    if (typeof renderFoodPage === 'function') renderFoodPage(); // Food page reads muAffiliation (groups + event gate) at build time
};''',
     '''    if (typeof renderFoodPage === 'function') renderFoodPage(); // Food page reads muAffiliation (groups + event gate) at build time
    applyAdvertiseGate(); // Advertise nav/page is Marauder-hidden \u2014 new-surface rule
};'''),

    ("J3 applyAffiliation \u2192 call gate",
     "    if (typeof pruneEmptyPlaceCategories === 'function') pruneEmptyPlaceCategories(); // audience-aware menu prune \u2014 re-run on affiliation change",
     '''    if (typeof pruneEmptyPlaceCategories === 'function') pruneEmptyPlaceCategories(); // audience-aware menu prune \u2014 re-run on affiliation change
    applyAdvertiseGate(); // Advertise nav/page is Marauder-hidden \u2014 new-surface rule'''),

    ("J4 toggle21Plus \u2192 call gate (no-op, rule compliance)",
     '''    if (typeof renderFoodPage === 'function') renderFoodPage(); // food-card specials boxes gate \U0001f37a items too
};''',
     '''    if (typeof renderFoodPage === 'function') renderFoodPage(); // food-card specials boxes gate \U0001f37a items too
    applyAdvertiseGate(); // no-op for 21+ \u2014 called per the new-surface rule
};'''),

    ("J5 resetEverything \u2192 call gate (nav reappears on unset)",
     '''    muAffiliation = null;
    setFeedDotVisible(false);
    renderHomeFeed();
    renderEvents(); renderSports(); renderNewsUI();
};''',
     '''    muAffiliation = null;
    setFeedDotVisible(false);
    renderHomeFeed();
    renderEvents(); renderSports(); renderNewsUI();
    applyAdvertiseGate(); // affiliation back to unset \u2014 nav-advertise reappears
};'''),

    ("J6 switchView choke-point guard",
     '''window.switchView=function(view,skipPush){
    if(view==='places') initPlacesMap();''',
     '''window.switchView=function(view,skipPush){
    if(view==='advertise' && muAffiliation==='student') view='home';   // Advertise is Marauder-hidden \u2014 nav click, /advertise deep link, and popstate all funnel here (URL left as typed on skipPush loads, same as the /board fallthrough)
    if(view==='places') initPlacesMap();'''),

    ("J7 initApp boot \u2192 call gate before first paint",
     '''async function initApp(){
    loadFeedPrefs();''',
     '''async function initApp(){
    loadFeedPrefs();
    applyAdvertiseGate();   // nav-advertise visibility depends on affiliation \u2014 set before first paint'''),

    ("J8 advertise-modal intro line copy",
     "Tell us about your business and we'll get back to you within 24 hours.",
     "Tell us how we can help and we'll get back to you within 24 hours."),
]

# ------------------------------------------------------------- machinery ----

def load(path):
    raw = open(path, "rb").read()
    bom = raw.startswith(b"\xef\xbb\xbf")
    if bom: raw = raw[3:]
    crlf = raw.count(b"\r\n")
    lf   = raw.count(b"\n") - crlf
    eol  = "\r\n" if crlf > lf else "\n"
    return raw.decode("utf-8"), eol, bom, (crlf, lf)

def apply_edits(name, path, edits):
    text, eol, bom, counts = load(path)
    print("\n%s  (EOL=%s, CRLF=%d, bare-LF=%d%s)" % (name, repr(eol), counts[0], counts[1], ", BOM" if bom else ""))
    applied = skipped = 0
    for label, old, new in edits:
        o = old.replace("\n", eol); n = new.replace("\n", eol)
        # Idempotency: a non-empty NEW block present means the edit landed
        # (every insert-style NEW here still contains its OLD anchor, so do
        # NOT also require OLD to be absent). Deletions: OLD absent = done.
        if (n and n in text) or (not n and o not in text):
            print("  = already applied:", label); skipped += 1; continue
        c = text.count(o)
        assert c == 1, "FATAL: anchor for [%s] found %d times (expected 1) in %s" % (label, c, name)
        text = text.replace(o, n)
        print("  + applied:", label); applied += 1
    return text, eol, bom, applied, skipped

def atomic_write(path, text, bom):
    data = (b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8")
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".patchtmp-")
    try:
        with os.fdopen(fd, "wb") as f: f.write(data)
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise

# Pass 1: compute everything in memory (no writes until all edits succeed).
html_path = os.path.join(ROOT, "index.html")
js_path   = os.path.join(ROOT, "app.js")
h_text, h_eol, h_bom, h_app, h_skip = apply_edits("index.html", html_path, HTML_EDITS)
j_text, j_eol, j_bom, j_app, j_skip = apply_edits("app.js",     js_path,   JS_EDITS)

# Pass 2: atomic writes.
if h_app: atomic_write(html_path, h_text, h_bom)
if j_app: atomic_write(js_path,   j_text, j_bom)

print("\nDone. index.html: %d applied / %d already-applied. app.js: %d applied / %d already-applied."
      % (h_app, h_skip, j_app, j_skip))
print("Next: node --check app.js  \u2014 then review in GitHub Desktop (whole-file-red diff = STOP, endings flipped).")
