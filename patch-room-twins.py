#!/usr/bin/env python3
# patch-room-twins.py — MU Calendar room-booking twin collapse (2026-08-24)
#
# Run from the repo root:  python patch-room-twins.py
# Then:  node --check scripts/scrape.js
#
# Coursedog now publishes one event as MULTIPLE room-booking rows (same event
# id + instant, different rooms): 29 groups / 58 extra rows at fix time, e.g.
# "Faculty Recital of Brandon Martinez" at rooms 101 AND 116. They dodge the
# exact pass (location differs) AND the cross-source pass (same bucket).
# One edit, scripts/scrape.js (LF).
import os

REPO = os.path.dirname(os.path.abspath(__file__))

def load(rel):
    p = os.path.join(REPO, rel)
    with open(p, 'rb') as f:
        raw = f.read()
    crlf = raw.count(b'\r\n')
    bare_lf = raw.count(b'\n') - crlf
    eol = '\r\n' if crlf > bare_lf else '\n'
    return p, raw.decode('utf-8'), eol

def save(path, text):
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(text.encode('utf-8'))
    os.replace(tmp, path)

OLD = """        return true;
    });

    // Pass 2: cross-source dedupe"""

NEW = """        return true;
    });

    // ===== MU-CALENDAR ROOM-BOOKING TWIN COLLAPSE (2026-08-24) =====
    // Coursedog now publishes one event as MULTIPLE room-booking rows (same
    // event id, same instant, different rooms — "Winter Vis & Perf Arts
    // Center 101" + "116" + "100"; four Maker's Market rooms; 29 groups / 58
    // extra rows at fix time). They dodge the exact pass above (location
    // differs) AND the cross-source pass below (same bucket — its Fix #1).
    // Two rows with EQUAL non-empty millersville.edu/calendar/events/<id>
    // sourceLinks and EQUAL parsed instants are one event, conclusively: an
    // event-page URL can't belong to two events, and a recurring series
    // shares the id but never the instant. Bare no-id calendar links
    // (…/calendar/events/ with nothing after) are EXCLUDED — they can't
    // prove sameness (the Marauder Mania pair stays split, accepted).
    // Keep-preference: a specific etix /ticket/p/ link > any ticketLink >
    // first-seen — preserves the enrichment-feeding link (the recital case).
    // Runs BEFORE the cross-source pass so artsmu merges land on the single
    // survivor.
    const MU_CAL_EVENT_RE = /millersville\\.edu\\/calendar\\/events\\/[A-Za-z0-9]/i;
    const roomTwinGroups = new Map();
    pass1.forEach((e, i) => {
        const src = e.sourceLink || '';
        if (!MU_CAL_EVENT_RE.test(src)) return;
        const ms = parseEventInstant(e.date);
        if (isNaN(ms)) return;
        const key = src + '|' + ms;
        if (!roomTwinGroups.has(key)) roomTwinGroups.set(key, []);
        roomTwinGroups.get(key).push(i);
    });
    const roomTwinDrop = new Set();
    let roomTwinCollapsed = 0;
    for (const idxs of roomTwinGroups.values()) {
        if (idxs.length < 2) continue;
        const twinRank = i => {
            const link = pass1[i].ticketLink || '';
            if (/etix\\.com\\/ticket\\/p\\//i.test(link)) return 0;
            if (link) return 1;
            return 2;
        };
        idxs.sort((a, b) => twinRank(a) - twinRank(b) || a - b);
        for (let k = 1; k < idxs.length; k++) { roomTwinDrop.add(idxs[k]); roomTwinCollapsed++; }
    }
    if (roomTwinDrop.size) {
        pass1 = pass1.filter((_, i) => !roomTwinDrop.has(i));
        console.log(`🚪 Collapsed ${roomTwinCollapsed} MU Calendar room-booking twin row(s) (same event id + instant, different rooms)`);
    }

    // Pass 2: cross-source dedupe"""

def main():
    path, text, eol = load('scripts/scrape.js')
    print(f'scripts/scrape.js (EOL: {"CRLF" if eol == chr(13)+chr(10) else "LF"})')
    o = OLD.replace('\n', eol); n = NEW.replace('\n', eol)
    if n in text:
        print('  = room-twin collapse: already applied, skipping')
    else:
        count = text.count(o)
        assert count == 1, f'anchor found {count} times (expected 1) — ABORTING, file untouched'
        text = text.replace(o, n)
        save(path, text)
        print('  + room-twin collapse: applied')
    print('Now run:  node --check scripts/scrape.js')

if __name__ == '__main__':
    main()
