const fs = require('fs');
const path = require('path');
const dns = require('dns');
const ical = require('node-ical');

dns.setDefaultResultOrder('ipv4first');
// TODO: Scope this to just the weather endpoint if possible
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

function isHGameFacility(loc, title) {
    const l = (loc || "").toLowerCase();
    const t = (title || "").toLowerCase();

    const awayMatch = t.match(/ at ([a-z0-9 ]+)/i);
    if (awayMatch) {
        const dest = awayMatch[1].toLowerCase();
        if (!dest.includes('millersville') && !dest.includes('penn manor') && !dest.includes('comet') && !dest.includes('pucillo')) return false;
    }

    const homeWords = [
        'pucillo', 'chryst', 'biemesderfer', 'cooper park', 'seaber',
        'mccomsey', 'anttonen', 'millersville', 'comet', 'penn manor', 'pmhs',
        '100 e. cottage', '2950 charlestown', '1800 millersville rd'
    ];
    return homeWords.some(k => l.includes(k)) || t.includes(' vs ') || t.includes(' vs. ') || t.includes('home');
}

function extractPricing(desc, title = "", location = "", apiLink = "") {
    let price = "Free";
    let link = apiLink || "";
    if (desc) {
        const priceRegex = /\$\d+(?:\.\d{2})?(?:\s+(student|public|general|admission|door|advance|mu|adult|child)s?)?/gi;
        const prices = desc.match(priceRegex);
        if (prices) price = [...new Set(prices)].join(' / ');
        else if (desc.toLowerCase().includes('ticket') || desc.toLowerCase().includes('admission') || desc.toLowerCase().includes('cover charge') || desc.toLowerCase().includes('cost:')) price = "Ticket Required";

        if (!link) {
            const anchorRegex = /<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
            let match, bestLink = null, highestScore = 0;
            while ((match = anchorRegex.exec(desc)) !== null) {
                const url = match[1], anchorText = match[2].toLowerCase(), lowerUrl = url.toLowerCase();
                let score = 0;
                if (lowerUrl.includes('instagram.com') || lowerUrl.includes('facebook.com') || lowerUrl.includes('twitter.com') || lowerUrl.includes('campusgroups.com/organization')) continue;
                if (lowerUrl.includes('etix.com') || lowerUrl.includes('universitytickets.com') || lowerUrl.includes('muticketsonline.com') || lowerUrl.includes('eventbrite.com')) score = 3;
                else if (anchorText.includes('ticket') || anchorText.includes('register') || anchorText.includes('buy') || anchorText.includes('rsvp') || anchorText.includes('purchase')) score = 2;
                else if (lowerUrl.includes('ticket') || lowerUrl.includes('register') || lowerUrl.includes('rsvp')) score = 1;
                if (score > highestScore) { highestScore = score; bestLink = url; }
            }
            if (!bestLink) {
                const rawMatch = desc.match(/(https?:\/\/[^\s"'<]+)/gi);
                if (rawMatch) {
                    const ticketRaw = rawMatch.find(l => { const lu = l.toLowerCase(); return lu.includes('etix.com') || lu.includes('universitytickets') || lu.includes('eventbrite'); });
                    if (ticketRaw) bestLink = ticketRaw;
                }
            }
            if (bestLink) link = bestLink;
        }
    }
    if (!link && price !== "Free") {
        const lowerTitle = title.toLowerCase(), lowerLoc = location.toLowerCase();
        if (lowerLoc.includes('winter') || lowerLoc.includes('lyte') || lowerTitle.includes('concert') || lowerTitle.includes('recital') || lowerTitle.includes('theatre')) link = "https://www.etix.com/ticket/v/23659/";
        else if (lowerLoc.includes('pucillo') || lowerLoc.includes('biemesderfer') || lowerTitle.includes('game') || lowerTitle.includes('match') || lowerTitle.includes('tournament')) link = "https://www.etix.com/ticket/v/23684/";
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
                    title: ldData.name,
                    date: eventDate.toISOString(),
                    location: "Phantom Power",
                    tags: ["Other", "Live Music"],
                    price: "Ticket Required",
                    ticketLink: ldData.url || "https://www.eventbrite.com/o/phantom-power-29187724817",
                    sourceLink: ldData.url || "https://www.phantompower.net/"
                });
            }
        } else {
            for (let key in ldData) if (typeof ldData[key] === 'object') extractEventbriteEvents(ldData[key], eventsArray, now, futureLimit);
        }
    }
}

async function runScraper() {
    console.log(`🚀 Starting Millersville Scraper (${SCRAPE_HORIZON_DAYS}-Day Horizon)...`);

    // ===== WEATHER =====
    try {
        const res = await fetch('https://snowball.millersville.edu/~cws/current.xml', { headers: baseHeaders });
        if (!res.ok) throw new Error(`Weather returned ${res.status}`);
        const xml = await res.text();
        const tempMatch = xml.match(/<(?:temp_f|temperature|temp)[^>]*>\s*([-\d.]+)/i);
        const condMatch = xml.match(/<(?:weather|condition|sky_condition)[^>]*>([^<]+)/i);
        const windMatch = xml.match(/<(?:wind_string|wind_mph|wind)[^>]*>([^<]+)/i);
        const humMatch = xml.match(/<(?:relative_humidity|humidity)[^>]*>\s*([-\d.]+)/i);
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify({
            temp: tempMatch ? Math.round(parseFloat(tempMatch[1])) : "--",
            condition: condMatch ? condMatch[1].trim() : "Data Unavailable",
            wind: windMatch ? windMatch[1].trim() : "Calm",
            humidity: humMatch ? humMatch[1].trim() + "%" : "--",
            lastUpdated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        }, null, 2));
        console.log("✅ Weather saved");
    } catch (e) {
        console.error("❌ Weather error:", e.message);
    }

    // ===== EVENTS =====
    try {
        let events = [];
        const today = new Date();
        const startDay = today.toISOString().split('T')[0];
        const futureDate = new Date(today);
        futureDate.setDate(today.getDate() + SCRAPE_HORIZON_DAYS);
        const endDay = futureDate.toISOString().split('T')[0];

        // --- MU PRIMARY API ---
        try {
            console.log("📡 Fetching MU Calendar...");
            const pageRes = await fetch('https://www.millersville.edu/calendar/', { headers: baseHeaders });
            const rawCookies = pageRes.headers.get('set-cookie');
            let cookieHeader = rawCookies ? rawCookies.split(', ').map(c => c.split(';')[0]).join('; ') : '';

            const apiHeaders = {
                ...baseHeaders,
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': 'https://www.millersville.edu',
                'Referer': 'https://www.millersville.edu/calendar/',
                'Content-Type': 'application/json'
            };
            if (cookieHeader) apiHeaders['Cookie'] = cookieHeader;

            const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', {
                method: 'POST',
                headers: apiHeaders,
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

                data.data.forEach(row => {
                    const eventTitle = row[nameIdx] || "Campus Event";
                    const eventLoc = `${row[bldgIdx] || ''} ${row[roomIdx] || ''}`.trim() || "Campus";
                    const pricing = extractPricing(row[descIdx] || "", eventTitle, eventLoc, linkIdx !== -1 ? (row[linkIdx] || "") : "");

                    let tags = ["MU"];
                    const lowerTitle = eventTitle.toLowerCase();

                    if (typeIdx !== -1 && row[typeIdx]) {
                        const tName = row[typeIdx].trim();
                        tags.push(tName);

                        if (tName === "Athletic Competitions") {
                            tags.push("Athletics");
                            if (lowerTitle.includes("men's") || lowerTitle.includes("mens") || lowerTitle.includes(" men ")) tags.push("Men's");
                            if (lowerTitle.includes("women's") || lowerTitle.includes("womens") || lowerTitle.includes(" women ")) tags.push("Women's");
                            sportsList.forEach(s => { if (lowerTitle.includes(s.toLowerCase())) tags.push(s); });
                            if (isHGameFacility(eventLoc, eventTitle)) tags.push("Home Game Mode");
                        }
                    }

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
                });
                console.log(`✅ MU Calendar: ${data.data.length} events`);
            } else {
                throw new Error('MU API returned unexpected structure');
            }
        } catch (e) {
            console.error("❌ MU Calendar error:", e.message);
        }

        // --- CLUBS/ORGS (ANTHOLOGY / GETINVOLVED API) ---
        try {
            console.log("📡 Fetching Clubs/Orgs...");
            const giUrl = `https://getinvolved.millersville.edu/api/discovery/event/search?endsAfter=${startDay}T00:00:00-04:00&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=200`;
            const giData = await (await fetch(giUrl, { headers: baseHeaders })).json();
            let clubCount = 0;

            (giData.value || []).forEach(item => {
                const eventDate = new Date(item.startsOn);
                if (eventDate >= today && eventDate < futureDate) {
                    let tags = ["Clubs/Orgs"];
                    let rawTags = [];

                    if (item.organizationName) rawTags.push(item.organizationName.trim());
                    if (item.theme && item.theme !== "Not Applicable") rawTags.push(item.theme.trim());
                    (item.categoryNames || []).forEach(c => rawTags.push(c.trim()));

                    const name = (item.name || "").toLowerCase();
                    const orgName = (item.organizationName || "").toLowerCase();
                    const greekRegex = /^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)\b/i;

                    rawTags.forEach(t => {
                        const lowerT = t.toLowerCase();
                        if (lowerT.includes('athletics') || lowerT === 'competition' || lowerT === 'competitions') return;
                        if (lowerT.includes('fundrais')) {
                            if (!tags.includes('Fundraising')) tags.push('Fundraising');
                        } else if (lowerT.includes('fraternity') || lowerT.includes('sorority') || lowerT.includes('greek')) {
                            if (!tags.includes('Greek Life')) tags.push('Greek Life');
                        } else {
                            tags.push(t);
                        }
                    });

                    if (orgName.includes('housing and residential') || orgName.includes('residence hall')) tags.push('Residence Halls');
                    if (orgName.includes('greek council') || greekRegex.test(orgName) || greekRegex.test(name)) tags.push('Greek Life');

                    let isPermittedSport = false;
                    hGameClubSports.forEach(s => {
                        if (name.includes(s) || orgName.includes(s)) isPermittedSport = true;
                    });

                    if (isPermittedSport || tags.some(t => t.toLowerCase().includes('club sport'))) {
                        tags.push("Club Sports");
                        if (name.includes("men's") || name.includes("mens")) tags.push("Men's");
                        if (name.includes("women's") || name.includes("womens")) tags.push("Women's");
                        sportsList.forEach(s => { if (name.includes(s.toLowerCase())) tags.push(s); });
                        if (isHGameFacility(item.location, item.name)) tags.push("Home Game Mode");
                    }

                    const isMainCategory = tags.includes('Residence Halls') || tags.includes('Greek Life') || tags.includes('Fundraising') || tags.includes('Club Sports');
                    if (!isMainCategory) tags.push('Other Org');

                    events.push({
                        title: item.name || "Student Event",
                        date: eventDate.toISOString(),
                        location: item.location || "Campus",
                        tags: [...new Set(tags)],
                        price: "Free",
                        ticketLink: `https://getinvolved.millersville.edu/event/${item.id}`,
                        sourceLink: `https://getinvolved.millersville.edu/event/${item.id}`
                    });
                    clubCount++;
                }
            });
            console.log(`✅ Clubs/Orgs: ${clubCount} events`);
        } catch (e) {
            console.error("❌ Clubs/Orgs error:", e.message);
        }

        // --- PENN MANOR iCAL (LIST VIEW FOR FULL DATE RANGE) ---
        try {
            console.log("📡 Fetching Penn Manor events...");

            // The Events Calendar (Tribe) plugin limits iCal exports by view.
            // Month view = only current month. List view = up to posts_per_page.
            // Using list view with ical=1 gets a much larger window.
            // We try multiple URL patterns in order of likely coverage:
            const pmUrls = [
                // List view iCal — gets events from current list view (best coverage)
                `https://www.pennmanor.net/events/list/?ical=1&tribe_event_display=list`,
                // Standard tribe_events iCal with date range
                `https://www.pennmanor.net/?post_type=tribe_events&ical=1&eventDisplay=list&start_date=${startDay}&end_date=${endDay}`,
                // Fallback: basic iCal feed
                `https://www.pennmanor.net/?post_type=tribe_events&ical=1&eventDisplay=list`,
                // Fallback: plain iCal
                `https://www.pennmanor.net/?post_type=tribe_events&ical=1`
            ];

            let pmEventsData = null;
            let usedUrl = null;

            for (const url of pmUrls) {
                try {
                    console.log(`  Trying: ${url.substring(0, 80)}...`);
                    pmEventsData = await ical.async.fromURL(url, { headers: baseHeaders });
                    const eventCount = Object.values(pmEventsData).filter(e => e.type === 'VEVENT').length;
                    console.log(`  → Got ${eventCount} VEVENTs`);
                    if (eventCount > 0) {
                        usedUrl = url;
                        break;
                    }
                } catch (urlErr) {
                    console.log(`  → Failed: ${urlErr.message}`);
                }
            }

            if (!pmEventsData) throw new Error('All Penn Manor URL variants failed');

            const allPMEvents = Object.values(pmEventsData).filter(e => e.type === 'VEVENT');
            let pmCount = 0;

            // Log the date range we actually received
            const pmDates = allPMEvents
                .map(e => new Date(e.start))
                .filter(d => !isNaN(d.getTime()))
                .sort((a, b) => a - b);
            if (pmDates.length > 0) {
                console.log(`  Feed range: ${pmDates[0].toISOString().split('T')[0]} to ${pmDates[pmDates.length - 1].toISOString().split('T')[0]}`);
            }

            for (const event of allPMEvents) {
                const eventDate = new Date(event.start);
                if (isNaN(eventDate.getTime())) continue;
                if (eventDate < today || eventDate >= futureDate) continue;

                let title = event.summary || "Penn Manor Event";
                let lowerTitle = title.toLowerCase();

                // Skip non-event entries
                if (lowerTitle.includes('cycle day') || lowerTitle.startsWith('start of') || lowerTitle.startsWith('end of')) continue;

                let tags = ["PM"];

                // General category tags
                if (lowerTitle.includes('board')) tags.push('Board Meetings');
                if (lowerTitle.includes('pto')) tags.push('PTO');
                if (lowerTitle.includes('staff') || lowerTitle.includes('in-service') || lowerTitle.includes('act 80') || lowerTitle.includes('faculty')) tags.push('Staff');
                if (lowerTitle.includes('concert') || lowerTitle.includes('band') || lowerTitle.includes('chorus') || lowerTitle.includes('choir') || lowerTitle.includes('orchestra') || lowerTitle.includes('musical') || lowerTitle.includes('theater') || lowerTitle.includes('play')) tags.push('Music/Arts');

                // Level tags
                if (lowerTitle.includes('varsity') && !lowerTitle.includes('jv')) tags.push('Varsity');
                if (lowerTitle.includes('jv') || lowerTitle.includes('j.v.')) tags.push('JV');
                if (lowerTitle.includes('junior high') || lowerTitle.includes('jr high') || lowerTitle.includes('7th') || lowerTitle.includes('8th')) tags.push('Jr High');

                // Sport detection
                let isAthletic = false;
                sportsList.forEach(s => {
                    if (lowerTitle.includes(s.toLowerCase())) {
                        tags.push(s);
                        isAthletic = true;
                        tags.push('Athletics');
                    }
                });
                // Also catch "bocce" and other sports not in the main list
                if (lowerTitle.includes('bocce')) { tags.push('Athletics'); isAthletic = true; }

                const location = event.location || "Penn Manor School District";

                if (isAthletic) {
                    if (lowerTitle.includes("boys") || lowerTitle.includes("men's") || lowerTitle.includes("mens")) tags.push("Boys");
                    if (lowerTitle.includes("girls") || lowerTitle.includes("women's") || lowerTitle.includes("womens")) tags.push("Girls");
                    if (lowerTitle.includes("coed")) { tags.push("Boys"); tags.push("Girls"); }
                    if (isHGameFacility(location, title)) tags.push("Home Game Mode");
                }

                events.push({
                    title, date: eventDate.toISOString(), location,
                    tags: [...new Set(tags)], price: "Free",
                    ticketLink: "",
                    sourceLink: "https://www.pennmanor.net/calendar/"
                });
                pmCount++;
            }

            console.log(`✅ Penn Manor: ${pmCount} events (from ${allPMEvents.length} in feed, URL: ${usedUrl ? 'success' : 'fallback'})`);
        } catch (e) {
            console.error("❌ Penn Manor error:", e.message);
        }

        // --- OTHER (EVENTBRITE / PHANTOM POWER) ---
        let ebCount = 0;
        try {
            console.log("📡 Fetching Eventbrite...");
            const ebText = await (await fetch('https://www.eventbrite.com/o/phantom-power-29187724817', { headers: baseHeaders })).text();
            const ldMatches = ebText.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
            if (ldMatches) {
                const beforeCount = events.length;
                ldMatches.forEach(block => {
                    try {
                        extractEventbriteEvents(
                            JSON.parse(block.replace(/<script type="application\/ld\+json">|<\/script>/gi, '')),
                            events, today, futureDate
                        );
                    } catch (e) {
                        console.error("  JSON-LD parse error:", e.message);
                    }
                });
                ebCount = events.length - beforeCount;
            }
            console.log(`✅ Eventbrite: ${ebCount} events`);
        } catch (e) {
            console.error("❌ Eventbrite error:", e.message);
        }

        // --- DEDUPLICATION ---
        const seen = new Set();
        const deduped = events.filter(e => {
            const key = `${e.title.trim().toLowerCase()}-${e.date}-${(e.location || '').trim().toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const dupeCount = events.length - deduped.length;
        if (dupeCount > 0) console.log(`⚠️ Removed ${dupeCount} duplicates`);

        // Sort by date
        deduped.sort((a, b) => new Date(a.date) - new Date(b.date));

        fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(deduped, null, 2));
        console.log(`📊 Total events saved: ${deduped.length}`);

    } catch (e) {
        console.error("❌ CRITICAL events error:", e.message);
    }

    // ===== NEWS =====
    try {
        let news = [];
        try {
            const xml = await (await fetch('https://blogs.millersville.edu/news/feed/', { headers: baseHeaders })).text();
            const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
            for (let i = 0; i < Math.min(4, items.length); i++) {
                const titleMatch = items[i].match(/<title>([\s\S]*?)<\/title>/i);
                const linkMatch = items[i].match(/<link>([\s\S]*?)<\/link>/i);
                const dateMatch = items[i].match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
                if (titleMatch && linkMatch) {
                    news.push({
                        category: "MU",
                        source: "Millersville News",
                        title: titleMatch[1].replace("<![CDATA[", "").replace("]]>", "").trim(),
                        link: linkMatch[1].trim(),
                        date: dateMatch ? new Date(dateMatch[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ""
                    });
                }
            }
        } catch (e) {
            console.error("❌ MU News RSS error:", e.message);
        }

        // TODO: Replace these with a real Borough news source
        news.push(
            { category: "Borough", source: "Millersville Borough", title: "2026 Residential Parking Permits Now Available", link: "https://millersvilleborough.org/", date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) },
            { category: "Borough", source: "Millersville Police", title: "Road Closure Notice - Construction Updates", link: "https://millersvilleborough.org/", date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
        );

        fs.writeFileSync(path.join(__dirname, '../news.json'), JSON.stringify(news, null, 2));
        console.log(`✅ News saved: ${news.length} items`);

        // Static dining specials — TODO: pull from real source
        fs.writeFileSync(path.join(__dirname, '../specials.json'), JSON.stringify([
            { restaurant: "House of Pizza", day: "Monday", deal: "2 Slices & Medium Drink - $4.50" },
            { restaurant: "House of Pizza", day: "Tuesday", deal: "Large Cheese Pizza & 2-Liter - $15.99" },
            { restaurant: "Two Cousins", day: "Wednesday", deal: "$2 Off Any Large Stromboli" }
        ], null, 2));
    } catch (e) {
        console.error("❌ News/specials error:", e.message);
    }

    console.log("✅ All data compilations complete.");
}

runScraper();
