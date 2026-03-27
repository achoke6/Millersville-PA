const fs = require('fs');
const path = require('path');
const dns = require('dns');
const ical = require('node-ical');

dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const SCRAPE_HORIZON_DAYS = 60;

const sportsList = ['Baseball', 'Softball', 'Track', 'Soccer', 'Lacrosse', 'Tennis', 'Volleyball', 'Wrestling', 'Basketball', 'Football', 'Field Hockey', 'Golf', 'Cross Country', 'Cheerleading', 'Swimming', 'Rugby', 'Fencing', 'Esports', 'Archery'];

const hGameClubSports = [
    'baseball', 'bowling', 'equestrian', 'fencing', 'ice hockey', 'mma',
    "men's basketball", "men's ice hockey", "men's lacrosse", "men's rugby",
    "men's soccer", "men's volleyball", 'dance team', 'running', 'softball',
    'tennis', 'ultimate frisbee', "women's basketball", "women's rugby",
    "women's soccer", "women's volleyball"
];

// ===== UTILITY FUNCTIONS =====

function extractPricing(desc, title = "", location = "", apiLink = "") {
    let price = "Free";
    let link = apiLink || "";
    if (desc) {
        const priceRegex = /\$\d+(?:\.\d{2})?(?:\s+(student|public|general|admission|door|advance|mu|adult|child)s?)?/gi;
        const prices = desc.match(priceRegex);
        if (prices) price = [...new Set(prices)].join(' / ');
        else if (/ticket|admission|cover charge|cost:/i.test(desc)) price = "Ticket Required";

        if (!link) {
            const anchorRegex = /<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
            let match, bestLink = null, highestScore = 0;
            while ((match = anchorRegex.exec(desc)) !== null) {
                const url = match[1], anchorText = match[2].toLowerCase(), lowerUrl = url.toLowerCase();
                let score = 0;
                if (/instagram\.com|facebook\.com|twitter\.com|campusgroups\.com\/organization/.test(lowerUrl)) continue;
                if (/etix\.com|universitytickets\.com|muticketsonline\.com|eventbrite\.com/.test(lowerUrl)) score = 3;
                else if (/ticket|register|buy|rsvp|purchase/.test(anchorText)) score = 2;
                else if (/ticket|register|rsvp/.test(lowerUrl)) score = 1;
                if (score > highestScore) { highestScore = score; bestLink = url; }
            }
            if (!bestLink) {
                const rawMatch = desc.match(/(https?:\/\/[^\s"'<]+)/gi);
                if (rawMatch) {
                    const ticketRaw = rawMatch.find(l => /etix\.com|universitytickets|eventbrite/.test(l.toLowerCase()));
                    if (ticketRaw) bestLink = ticketRaw;
                }
            }
            if (bestLink) link = bestLink;
        }
    }
    if (!link && price !== "Free") {
        const lt = title.toLowerCase(), ll = location.toLowerCase();
        if (/winter|lyte/.test(ll) || /concert|recital|theatre/.test(lt)) link = "https://www.etix.com/ticket/v/23659/";
        else if (/pucillo|biemesderfer/.test(ll) || /game|match|tournament/.test(lt)) link = "https://www.etix.com/ticket/v/23684/";
    }
    return { price, link };
}

function extractEventbriteEvents(ldData, eventsArray, now, futureLimit) {
    if (Array.isArray(ldData)) {
        ldData.forEach(item => extractEventbriteEvents(item, eventsArray, now, futureLimit));
    } else if (ldData && typeof ldData === 'object') {
        if (ldData['@type'] === 'Event' && ldData.name && ldData.startDate) {
            const eventDate = new Date(ldData.startDate);
            if (eventDate >= now && eventDate < futureLimit) {
                eventsArray.push({
                    title: ldData.name, date: eventDate.toISOString(), location: "Phantom Power",
                    tags: ["Other", "Live Music"], price: "Ticket Required",
                    ticketLink: ldData.url || "https://www.eventbrite.com/o/phantom-power-29187724817",
                    sourceLink: ldData.url || "https://www.phantompower.net/"
                });
            }
        } else {
            for (let key in ldData) if (typeof ldData[key] === 'object') extractEventbriteEvents(ldData[key], eventsArray, now, futureLimit);
        }
    }
}

// ===== MAIN SCRAPER =====

async function runScraper() {
    console.log(`🚀 Starting Millersville Scraper (${SCRAPE_HORIZON_DAYS}-Day Horizon)...`);

    const today = new Date();
    const startDay = today.toISOString().split('T')[0];
    const futureDate = new Date(today);
    futureDate.setDate(today.getDate() + SCRAPE_HORIZON_DAYS);
    const endDay = futureDate.toISOString().split('T')[0];

    // ===== WEATHER =====
    try {
        const res = await fetch('https://snowball.millersville.edu/~cws/current.xml', { headers: baseHeaders });
        if (!res.ok) throw new Error(`Weather returned ${res.status}`);
        const xml = await res.text();
        const g = (regex) => { const m = xml.match(regex); return m ? m[1].trim() : null; };
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify({
            temp: g(/<(?:temp_f|temperature|temp)[^>]*>\s*([-\d.]+)/i) ? Math.round(parseFloat(g(/<(?:temp_f|temperature|temp)[^>]*>\s*([-\d.]+)/i))) : "--",
            condition: g(/<(?:weather|condition|sky_condition)[^>]*>([^<]+)/i) || "Data Unavailable",
            wind: g(/<(?:wind_string|wind_mph|wind)[^>]*>([^<]+)/i) || "Calm",
            humidity: g(/<(?:relative_humidity|humidity)[^>]*>\s*([-\d.]+)/i) ? g(/<(?:relative_humidity|humidity)[^>]*>\s*([-\d.]+)/i) + "%" : "--",
            lastUpdated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        }, null, 2));
        console.log("✅ Weather saved");
    } catch (e) { console.error("❌ Weather error:", e.message); }

    let events = [];

    // ===== 1. MU ATHLETICS (SIDEARM iCAL) =====
    try {
        console.log("📡 Fetching MU Athletics (Sidearm iCal)...");
        const muAthData = await ical.async.fromURL(
            'https://millersvilleathletics.com/api/v2/Calendar/subscribe?type=ics&downloadFile=false',
            { headers: baseHeaders }
        );
        let muAthCount = 0;

        for (const ev of Object.values(muAthData)) {
            if (ev.type !== 'VEVENT') continue;
            const eventDate = new Date(ev.start);
            if (isNaN(eventDate.getTime()) || eventDate < today || eventDate >= futureDate) continue;

            const summary = ev.summary || '';
            const desc = ev.description || '';
            const loc = ev.location || '';

            // Skip past-game results (have [W], [L], [N] prefix)
            // We still include them — they have scores which could be useful
            // But for upcoming games, no prefix exists

            // Determine sport from summary: "Millersville University {Sport} vs/at {Opponent}"
            const sportMatch = summary.match(/Millersville University\s+([\w''&\s]+?)\s+(?:vs|at)\s/i);
            let sportName = sportMatch ? sportMatch[1].trim() : '';
            // Clean prefix like [W], [L], [N]
            let cleanTitle = summary.replace(/^\[.\]\s*/, '').trim();

            // Determine home/away: "vs" = home, "at" = away
            const isHome = /\bvs\b/i.test(summary) || loc.toLowerCase().includes('millersville');

            // Extract ticket link from description
            let ticketLink = '';
            const ticketMatch = desc.match(/Tickets:\s*(https?:\/\/[^\s\\]+)/i);
            if (ticketMatch) ticketLink = ticketMatch[1].replace(/&amp;/g, '&');

            // Extract streaming link
            let streamLink = '';
            const streamMatch = desc.match(/Streaming Video:\s*(https?:\/\/[^\s\\]+)/i);
            if (streamMatch) streamLink = streamMatch[1].replace(/&amp;/g, '&');

            // Build tags
            let tags = ["MU", "Athletic Competitions", "Athletics"];
            if (isHome) tags.push("Home Game Mode");

            // Detect gender
            if (/women's|women's/i.test(sportName)) tags.push("Women's");
            else if (/men's|men's/i.test(sportName)) tags.push("Men's");

            // Map sport name to our standard sport list
            sportsList.forEach(s => {
                if (sportName.toLowerCase().includes(s.toLowerCase())) tags.push(s);
            });
            // Handle "Indoor Track" / "Outdoor Track" → Track
            if (/track/i.test(sportName) && !tags.includes('Track')) tags.push('Track');
            // Handle Golf
            if (/golf/i.test(sportName) && !tags.includes('Golf')) tags.push('Golf');

            const sourceUrl = ev.url ? ev.url.replace(/&amp;/g, '&') : 'https://millersvilleathletics.com/calendar';

            events.push({
                title: cleanTitle,
                date: eventDate.toISOString(),
                location: loc || "TBD",
                tags: [...new Set(tags)],
                price: ticketLink ? "Ticket Required" : "Free",
                ticketLink: ticketLink,
                sourceLink: sourceUrl
            });
            muAthCount++;
        }
        console.log(`✅ MU Athletics: ${muAthCount} events`);
    } catch (e) { console.error("❌ MU Athletics error:", e.message); }

    // ===== 2. PENN MANOR iCAL (PAGINATED — 30 events per page) =====
    try {
        console.log("📡 Fetching Penn Manor iCal (paginated)...");
        const pmBaseUrl = 'https://www.pennmanor.net/events/list/?ical=1&tribe_event_display=list&tribe_paged=';
        let allPMEvents = {};
        let page = 1;
        const maxPages = 10; // Safety cap: 10 pages × 30 = 300 events max

        while (page <= maxPages) {
            try {
                const url = pmBaseUrl + page;
                console.log(`  Fetching page ${page}...`);
                const pageData = await ical.async.fromURL(url, { headers: baseHeaders });
                const pageEvents = Object.values(pageData).filter(e => e.type === 'VEVENT');
                console.log(`  → Page ${page}: ${pageEvents.length} VEVENTs`);

                if (pageEvents.length === 0) break; // No more pages

                // Merge into allPMEvents (keyed by UID to dedupe across pages)
                for (const [key, val] of Object.entries(pageData)) {
                    if (val.type === 'VEVENT') allPMEvents[val.uid || key] = val;
                }

                // If we got fewer than 30, this is the last page
                if (pageEvents.length < 30) break;
                page++;
            } catch (err) {
                console.log(`  → Page ${page} failed: ${err.message}`);
                break;
            }
        }

        const totalPMRaw = Object.keys(allPMEvents).length;
        console.log(`  Total unique PM VEVENTs across ${page} page(s): ${totalPMRaw}`);

        if (totalPMRaw === 0) throw new Error('Penn Manor returned no events');

        // Now pmData is our merged object
        const pmData = allPMEvents;

        let pmAthCount = 0, pmGenCount = 0;

        for (const ev of Object.values(pmData)) {
            const eventDate = new Date(ev.start);
            if (isNaN(eventDate.getTime()) || eventDate < today || eventDate >= futureDate) continue;

            const title = ev.summary || 'Penn Manor Event';
            const lowerTitle = title.toLowerCase();
            const desc = ev.description || '';
            const loc = ev.location || 'Penn Manor School District';
            const categories = ev.categories ? (Array.isArray(ev.categories) ? ev.categories.join(',') : String(ev.categories)) : '';

            // Skip noise
            if (/cycle day|^start of|^end of/i.test(lowerTitle)) continue;

            const isAthletic = categories.toLowerCase().includes('athletics') || desc.toLowerCase().includes('sport:');

            if (isAthletic) {
                // Parse structured description: Sport:, Level:, Site:
                const sportMatch = desc.match(/Sport:\s*(.+?)(?:\\n|\n|$)/i);
                const levelMatch = desc.match(/Level:\s*(.+?)(?:\\n|\n|$)/i);

                let tags = ["PM", "Athletics"];

                // Home vs Away: "vs" = home, "@" = away
                const isHome = lowerTitle.includes(' vs ');
                if (isHome) tags.push("Home Game Mode");

                // Level
                const level = levelMatch ? levelMatch[1].trim() : '';
                if (/varsity/i.test(level) && !/jv/i.test(level)) tags.push('Varsity');
                if (/jv/i.test(level)) tags.push('JV');
                if (/7th|8th|jr high|junior high/i.test(level)) tags.push('Jr High');

                // Gender
                if (/\bboys\b|boy's/i.test(level) || /\bboys\b/i.test(lowerTitle)) tags.push('Boys');
                if (/\bgirls\b|girl's/i.test(level) || /\bgirls\b/i.test(lowerTitle)) tags.push('Girls');
                if (/\bcoed\b/i.test(level) || /\bcoed\b/i.test(lowerTitle)) { tags.push('Boys'); tags.push('Girls'); }

                // Sport type
                sportsList.forEach(s => {
                    if (lowerTitle.includes(s.toLowerCase())) tags.push(s);
                });
                // Catch Track & Field variants
                if (/track\s*&?\s*field/i.test(desc) && !tags.includes('Track')) tags.push('Track');
                if (/bocce/i.test(lowerTitle)) tags.push('Athletics'); // Bocce not in list but keep tagged

                events.push({
                    title, date: eventDate.toISOString(), location: loc,
                    tags: [...new Set(tags)], price: "Free", ticketLink: "",
                    sourceLink: ev.url || "https://www.pennmanor.net/calendar/"
                });
                pmAthCount++;
            } else {
                // Non-athletic PM event
                let tags = ["PM"];
                if (/board/i.test(lowerTitle)) tags.push('Board Meetings');
                if (/pto/i.test(lowerTitle)) tags.push('PTO');
                if (/staff|in-service|act 80|faculty/i.test(lowerTitle)) tags.push('Staff');
                if (/concert|band|chorus|choir|orchestra|musical|theater|play/i.test(lowerTitle)) tags.push('Music/Arts');

                events.push({
                    title, date: eventDate.toISOString(), location: loc,
                    tags: [...new Set(tags)], price: "Free", ticketLink: "",
                    sourceLink: ev.url || "https://www.pennmanor.net/calendar/"
                });
                pmGenCount++;
            }
        }
        console.log(`✅ Penn Manor: ${pmAthCount} athletic + ${pmGenCount} general = ${pmAthCount + pmGenCount} events`);
    } catch (e) { console.error("❌ Penn Manor error:", e.message); }

    // ===== 3. MU CALENDAR (NON-SPORT EVENTS ONLY) =====
    try {
        console.log("📡 Fetching MU Calendar (non-sport events)...");
        const pageRes = await fetch('https://www.millersville.edu/calendar/', { headers: baseHeaders });
        const rawCookies = pageRes.headers.get('set-cookie');
        let cookieHeader = rawCookies ? rawCookies.split(', ').map(c => c.split(';')[0]).join('; ') : '';

        const apiHeaders = {
            ...baseHeaders, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
            'Origin': 'https://www.millersville.edu', 'Referer': 'https://www.millersville.edu/calendar/',
            'Content-Type': 'application/json'
        };
        if (cookieHeader) apiHeaders['Cookie'] = cookieHeader;

        const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', {
            method: 'POST', headers: apiHeaders,
            body: JSON.stringify({ getEvents: true, startDate: startDay, endDate: endDay })
        });
        if (!res.ok) throw new Error(`MU API returned ${res.status}`);
        const data = JSON.parse(await res.text());

        if (data.fields && Array.isArray(data.data)) {
            const fields = data.fields.split(',');
            const nameIdx = fields.indexOf('ActivityName');
            const startIdx = fields.indexOf('StartDateTime');
            const bldgIdx = fields.indexOf('BuildingCode');
            const roomIdx = fields.indexOf('RoomName');
            const descIdx = fields.indexOf('EventMeetingByActivityId.Event.Description');
            const linkIdx = fields.findIndex(f => f.toLowerCase().includes('url') || f.toLowerCase().includes('link'));
            const idIdx = fields.indexOf('ActivityId');
            const typeIdx = fields.indexOf('MeetingType:EventMeetingByActivityId.EventMeetingType.Name');
            const customerIdx = fields.indexOf('Customer:EventMeetingByActivityId.Event.Customer.Name');

            let muCount = 0;
            data.data.forEach(row => {
                const eventTitle = row[nameIdx] || "Campus Event";
                const eventType = typeIdx !== -1 ? (row[typeIdx] || '').trim() : '';

                // SKIP Athletic Competitions — we get those from Sidearm now
                if (eventType === 'Athletic Competitions') return;

                const eventLoc = `${row[bldgIdx] || ''} ${row[roomIdx] || ''}`.trim() || "Campus";
                const pricing = extractPricing(row[descIdx] || "", eventTitle, eventLoc, linkIdx !== -1 ? (row[linkIdx] || "") : "");

                let tags = ["MU"];
                if (eventType) tags.push(eventType);
                if (customerIdx !== -1 && row[customerIdx]) tags.push(row[customerIdx].trim());

                const eventId = idIdx !== -1 ? row[idIdx] : "";
                const sourceLink = eventId
                    ? `https://www.millersville.edu/calendar/events/${eventId}`
                    : "https://www.millersville.edu/calendar/";

                events.push({
                    title: eventTitle, date: row[startIdx], location: eventLoc,
                    tags: [...new Set(tags)], price: pricing.price,
                    ticketLink: pricing.link, sourceLink
                });
                muCount++;
            });
            console.log(`✅ MU Calendar (non-sport): ${muCount} events`);
        } else {
            throw new Error('MU API unexpected structure');
        }
    } catch (e) { console.error("❌ MU Calendar error:", e.message); }

    // ===== 4. CLUBS/ORGS (ANTHOLOGY / GETINVOLVED API) =====
    try {
        console.log("📡 Fetching Clubs/Orgs...");
        const giUrl = `https://getinvolved.millersville.edu/api/discovery/event/search?endsAfter=${startDay}T00:00:00-04:00&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=200`;
        const giData = await (await fetch(giUrl, { headers: baseHeaders })).json();
        let clubCount = 0;

        (giData.value || []).forEach(item => {
            const eventDate = new Date(item.startsOn);
            if (eventDate < today || eventDate >= futureDate) return;

            let tags = ["Clubs/Orgs"];
            let rawTags = [];
            if (item.organizationName) rawTags.push(item.organizationName.trim());
            if (item.theme && item.theme !== "Not Applicable") rawTags.push(item.theme.trim());
            (item.categoryNames || []).forEach(c => rawTags.push(c.trim()));

            const name = (item.name || "").toLowerCase();
            const orgName = (item.organizationName || "").toLowerCase();
            const greekRegex = /^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)\b/i;

            rawTags.forEach(t => {
                const lt = t.toLowerCase();
                if (/athletics|^competition$|^competitions$/.test(lt)) return;
                if (/fundrais/.test(lt)) { if (!tags.includes('Fundraising')) tags.push('Fundraising'); }
                else if (/fraternity|sorority|greek/.test(lt)) { if (!tags.includes('Greek Life')) tags.push('Greek Life'); }
                else tags.push(t);
            });

            if (/housing and residential|residence hall/.test(orgName)) tags.push('Residence Halls');
            if (/greek council/.test(orgName) || greekRegex.test(orgName) || greekRegex.test(name)) tags.push('Greek Life');

            let isPermittedSport = hGameClubSports.some(s => name.includes(s) || orgName.includes(s));

            if (isPermittedSport || tags.some(t => t.toLowerCase().includes('club sport'))) {
                tags.push("Club Sports");
                if (/men's|mens/.test(name)) tags.push("Men's");
                if (/women's|womens/.test(name)) tags.push("Women's");
                sportsList.forEach(s => { if (name.includes(s.toLowerCase())) tags.push(s); });

                // Home game detection for club sports
                const loc = (item.location || '').toLowerCase();
                const homeWords = ['pucillo', 'chryst', 'biemesderfer', 'cooper park', 'seaber', 'mccomsey', 'anttonen', 'millersville', 'comet'];
                if (homeWords.some(k => loc.includes(k)) || /\bvs\b/.test(name)) tags.push("Home Game Mode");
            }

            const isMainCategory = ['Residence Halls', 'Greek Life', 'Fundraising', 'Club Sports'].some(c => tags.includes(c));
            if (!isMainCategory) tags.push('Other Org');

            events.push({
                title: item.name || "Student Event", date: eventDate.toISOString(),
                location: item.location || "Campus", tags: [...new Set(tags)],
                price: "Free",
                ticketLink: `https://getinvolved.millersville.edu/event/${item.id}`,
                sourceLink: `https://getinvolved.millersville.edu/event/${item.id}`
            });
            clubCount++;
        });
        console.log(`✅ Clubs/Orgs: ${clubCount} events`);
    } catch (e) { console.error("❌ Clubs/Orgs error:", e.message); }

    // ===== 5. EVENTBRITE (PHANTOM POWER) =====
    let ebCount = 0;
    try {
        console.log("📡 Fetching Eventbrite (Phantom Power)...");
        const ebText = await (await fetch('https://www.eventbrite.com/o/phantom-power-29187724817', { headers: baseHeaders })).text();
        const ldMatches = ebText.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
        if (ldMatches) {
            const before = events.length;
            ldMatches.forEach(block => {
                try {
                    extractEventbriteEvents(JSON.parse(block.replace(/<script type="application\/ld\+json">|<\/script>/gi, '')), events, today, futureDate);
                } catch (e) { console.error("  JSON-LD parse error:", e.message); }
            });
            ebCount = events.length - before;
        }
        console.log(`✅ Eventbrite: ${ebCount} events`);
    } catch (e) { console.error("❌ Eventbrite error:", e.message); }

    // ===== DEDUPLICATION & SAVE =====
    const seen = new Set();
    const deduped = events.filter(e => {
        const key = `${e.title.trim().toLowerCase()}-${e.date}-${(e.location || '').trim().toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const dupes = events.length - deduped.length;
    if (dupes > 0) console.log(`⚠️ Removed ${dupes} duplicates`);

    deduped.sort((a, b) => new Date(a.date) - new Date(b.date));
    fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(deduped, null, 2));
    console.log(`📊 Total events saved: ${deduped.length}`);

    // ===== NEWS =====
    try {
        let news = [];
        try {
            const xml = await (await fetch('https://blogs.millersville.edu/news/feed/', { headers: baseHeaders })).text();
            const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
            for (let i = 0; i < Math.min(4, items.length); i++) {
                const t = items[i].match(/<title>([\s\S]*?)<\/title>/i);
                const l = items[i].match(/<link>([\s\S]*?)<\/link>/i);
                const d = items[i].match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
                if (t && l) news.push({
                    category: "MU", source: "Millersville News",
                    title: t[1].replace("<![CDATA[", "").replace("]]>", "").trim(),
                    link: l[1].trim(),
                    date: d ? new Date(d[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ""
                });
            }
        } catch (e) { console.error("❌ News RSS error:", e.message); }

        // TODO: Replace with real borough data source
        news.push(
            { category: "Borough", source: "Millersville Borough", title: "2026 Residential Parking Permits Now Available", link: "https://millersvilleborough.org/", date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) },
            { category: "Borough", source: "Millersville Police", title: "Road Closure Notice - Construction Updates", link: "https://millersvilleborough.org/", date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
        );
        fs.writeFileSync(path.join(__dirname, '../news.json'), JSON.stringify(news, null, 2));
        console.log(`✅ News: ${news.length} items`);

        // TODO: Replace with real dining specials source
        fs.writeFileSync(path.join(__dirname, '../specials.json'), JSON.stringify([
            { restaurant: "House of Pizza", day: "Monday", deal: "2 Slices & Medium Drink - $4.50" },
            { restaurant: "House of Pizza", day: "Tuesday", deal: "Large Cheese Pizza & 2-Liter - $15.99" },
            { restaurant: "Two Cousins", day: "Wednesday", deal: "$2 Off Any Large Stromboli" }
        ], null, 2));
    } catch (e) { console.error("❌ News/specials error:", e.message); }

    console.log("✅ All data compilations complete.");
}

runScraper();
