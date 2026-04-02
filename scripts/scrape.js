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
    const PAST_DAYS = 30;
    const FUTURE_DAYS = 60;
    console.log(`🚀 Starting Millersville Scraper (${PAST_DAYS}d back + ${FUTURE_DAYS}d forward)...`);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // midnight today
    const pastDate = new Date(today);
    pastDate.setDate(today.getDate() - PAST_DAYS);
    const futureDate = new Date(today);
    futureDate.setDate(today.getDate() + FUTURE_DAYS);
    const startDay = pastDate.toISOString().split('T')[0];
    const endDay = futureDate.toISOString().split('T')[0];

    // ===== WEATHER (MU Station + Open-Meteo combined) =====
    try {
        // Source 1: MU Weather Information Center — hyper-local station data
        let muTemp = null, muHumidity = null, muWindDir = null, muWindSpeed = null, muUpdate = null;
        try {
            const muRes = await fetch('https://snowball.millersville.edu/~cws/current.xml', { headers: baseHeaders });
            if (muRes.ok) {
                const muXml = await muRes.text();
                const gx = (tag) => { const m = muXml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i')); return m ? m[1].trim() : null; };
                muTemp = gx('temp');
                muHumidity = gx('humidity');
                muWindDir = gx('wind_direction');
                muWindSpeed = gx('wind_speed');
                muUpdate = gx('update');
                console.log(`  ✅ MU Station: ${muTemp}°F, Wind ${muWindSpeed} mph ${muWindDir}, Humidity ${muHumidity}%`);
            }
        } catch (e) { console.log(`  ⚠️ MU Station unavailable: ${e.message}`); }

        // Source 2: Open-Meteo — condition text, icon, feels-like (free, no API key)
        let condition = 'Unknown', icon = '🌡️', feelsLike = null;
        try {
            const omUrl = 'https://api.open-meteo.com/v1/forecast?latitude=39.9982&longitude=-76.3541&current=weather_code,apparent_temperature,temperature_2m,wind_speed_10m,relative_humidity_2m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York';
            const omRes = await fetch(omUrl);
            if (omRes.ok) {
                const omData = await omRes.json();
                const c = omData.current;
                const wmoMap = {
                    0:{cond:'Clear sky',icon:'☀️'},1:{cond:'Mainly clear',icon:'🌤️'},2:{cond:'Partly cloudy',icon:'⛅'},3:{cond:'Overcast',icon:'☁️'},
                    45:{cond:'Fog',icon:'🌫️'},48:{cond:'Rime fog',icon:'🌫️'},
                    51:{cond:'Light drizzle',icon:'🌦️'},53:{cond:'Drizzle',icon:'🌦️'},55:{cond:'Dense drizzle',icon:'🌧️'},
                    61:{cond:'Slight rain',icon:'🌦️'},63:{cond:'Rain',icon:'🌧️'},65:{cond:'Heavy rain',icon:'🌧️'},
                    66:{cond:'Freezing rain',icon:'🌧️'},67:{cond:'Heavy freezing rain',icon:'🌧️'},
                    71:{cond:'Light snow',icon:'🌨️'},73:{cond:'Snow',icon:'❄️'},75:{cond:'Heavy snow',icon:'❄️'},77:{cond:'Snow grains',icon:'❄️'},
                    80:{cond:'Light showers',icon:'🌦️'},81:{cond:'Rain showers',icon:'🌧️'},82:{cond:'Heavy showers',icon:'⛈️'},
                    85:{cond:'Snow showers',icon:'🌨️'},86:{cond:'Heavy snow showers',icon:'❄️'},
                    95:{cond:'Thunderstorm',icon:'⛈️'},96:{cond:'Thunderstorm w/ hail',icon:'⛈️'},99:{cond:'Severe thunderstorm',icon:'⛈️'}
                };
                const wmo = wmoMap[c.weather_code] || {cond:'Unknown',icon:'🌡️'};
                condition = wmo.cond;
                icon = wmo.icon;
                feelsLike = Math.round(c.apparent_temperature);
                // Use Open-Meteo as fallback if MU station is down
                if (muTemp === null) {
                    muTemp = Math.round(c.temperature_2m);
                    muHumidity = Math.round(c.relative_humidity_2m);
                    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
                    muWindDir = dirs[Math.round(c.wind_direction_10m / 22.5) % 16];
                    muWindSpeed = Math.round(c.wind_speed_10m);
                    console.log(`  ⚠️ Using Open-Meteo as fallback for readings`);
                }
                console.log(`  ✅ Open-Meteo: ${condition} ${icon}, Feels like ${feelsLike}°F`);
            }
        } catch (e) { console.log(`  ⚠️ Open-Meteo unavailable: ${e.message}`); }

        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify({
            temp: muTemp ? parseInt(muTemp) : '--',
            feelsLike: feelsLike || (muTemp ? parseInt(muTemp) : '--'),
            condition,
            icon,
            wind: muWindSpeed ? `${muWindSpeed} mph ${muWindDir || ''}`.trim() : 'Calm',
            humidity: muHumidity ? muHumidity + '%' : '--',
            stationUpdate: muUpdate || '',
            lastUpdated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }),
            source: muTemp ? 'MU Weather Station + Open-Meteo' : 'Open-Meteo'
        }, null, 2));
        console.log(`✅ Weather saved: ${muTemp || '--'}°F, ${condition}`);
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
            if (isNaN(eventDate.getTime()) || eventDate < pastDate || eventDate >= futureDate) continue;

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

            // Extract game result and score from summary prefix and description
            // Past games: "[W] Title" with "W 16-7" or "L 4-6" in description
            // Upcoming: no prefix
            let gameResult = '';  // 'W', 'L', 'N', or '' for upcoming
            let gameScore = '';
            const resultPrefix = summary.match(/^\[([WLN])\]/);
            if (resultPrefix) {
                gameResult = resultPrefix[1];
                const scoreMatch = desc.match(/^[WLN]\s+(\d+-\d+)/m);
                if (scoreMatch) gameScore = scoreMatch[1];
            }

            // Check if game is live (happening right now)
            const eventEnd = ev.end ? new Date(ev.end) : new Date(eventDate.getTime() + 3*60*60*1000);
            const isLive = now >= eventDate && now <= eventEnd && !gameResult;

            // Build source URL: prefer the event's own URL (links to specific game on schedule),
            // fall back to sport schedule page, then composite calendar
            const scheduleSlugMap = {
                'baseball': 'baseball', 'softball': 'softball', 'football': 'football',
                'wrestling': 'wrestling', 'volleyball': 'womens-volleyball',
                'field hockey': 'field-hockey', 'swimming': 'womens-swimming',
                "women's basketball": 'womens-basketball', "men's basketball": 'mens-basketball',
                "women's soccer": 'womens-soccer', "men's soccer": 'mens-soccer',
                "women's lacrosse": 'womens-lacrosse',
                "women's tennis": 'womens-tennis', "men's tennis": 'mens-tennis',
                "women's golf": 'womens-golf', "men's golf": 'mens-golf',
                "women's cross country": 'womens-cross-country', "men's cross country": 'mens-cross-country',
                "women's indoor track & field": 'womens-indoor-track-and-field',
                "women's outdoor track & field": 'womens-outdoor-track-and-field',
                "men's track and field": 'mens-track-and-field',
                "women's track and field": 'womens-track-and-field'
            };
            const sportLower = sportName.toLowerCase();
            let scheduleSlug = scheduleSlugMap[sportLower];
            if (!scheduleSlug) {
                for (const [key, slug] of Object.entries(scheduleSlugMap)) {
                    if (sportLower.includes(key) || key.includes(sportLower)) { scheduleSlug = slug; break; }
                }
            }
            const scheduleUrl = scheduleSlug
                ? `https://millersvilleathletics.com/sports/${scheduleSlug}/schedule`
                : 'https://millersvilleathletics.com/calendar';
            // ev.url from iCal points to the specific game entry on the schedule
            const sourceUrl = ev.url ? ev.url.replace(/&amp;/g, '&') : scheduleUrl;

            events.push({
                title: cleanTitle,
                date: eventDate.toISOString(),
                location: loc || "TBD",
                tags: [...new Set(tags)],
                price: ticketLink ? "Ticket Required" : "Free",
                ticketLink: ticketLink,
                sourceLink: sourceUrl,
                gameResult,
                gameScore,
                streamLink,
                isLive
            });
            muAthCount++;
        }
        console.log(`✅ MU Athletics: ${muAthCount} events`);
    } catch (e) { console.error("❌ MU Athletics error:", e.message); }

    // ===== 2. PENN MANOR iCAL (PAGINATED — fetch past + future events) =====
    try {
        console.log("📡 Fetching Penn Manor iCal (paginated until " + endDay + ")...");
        let allPMEvents = {};

        // Fetch UPCOMING events (paginated forward)
        const pmFutureUrl = 'https://www.pennmanor.net/events/list/?ical=1&tribe_event_display=list&tribe_paged=';
        let page = 1;
        const maxPages = 20;
        let latestEventDate = null;

        while (page <= maxPages) {
            try {
                const url = pmFutureUrl + page;
                console.log(`  Fetching page ${page}...`);
                const pageData = await ical.async.fromURL(url, { headers: baseHeaders });
                const pageEvents = Object.values(pageData).filter(e => e.type === 'VEVENT');
                console.log(`  → Page ${page}: ${pageEvents.length} VEVENTs`);

                if (pageEvents.length === 0) {
                    console.log(`  → Empty page, stopping.`);
                    break;
                }

                // Merge into allPMEvents, count truly new ones
                let newCount = 0;
                for (const [key, val] of Object.entries(pageData)) {
                    if (val.type === 'VEVENT') {
                        const uid = val.uid || key;
                        if (!allPMEvents[uid]) newCount++;
                        allPMEvents[uid] = val;
                    }
                }

                // Find latest event date on this page
                let pageLatest = null;
                pageEvents.forEach(ev => {
                    const d = new Date(ev.start);
                    if (!isNaN(d.getTime()) && (!pageLatest || d > pageLatest)) pageLatest = d;
                });
                if (pageLatest) {
                    latestEventDate = pageLatest;
                    console.log(`  → Latest: ${pageLatest.toISOString().split('T')[0]} | New unique: ${newCount}`);
                }

                // Stop if we've reached the end of our date range
                if (latestEventDate && latestEventDate >= futureDate) {
                    console.log(`  → Covered full range through ${endDay}, stopping.`);
                    break;
                }
                // Stop if partial page (no more data)
                if (pageEvents.length < 30) {
                    console.log(`  → Partial page (${pageEvents.length} < 30), likely last page.`);
                    break;
                }
                // Stop if no new unique events (all dupes)
                if (newCount === 0) {
                    console.log(`  → No new unique events, stopping.`);
                    break;
                }

                page++;
            } catch (err) {
                console.log(`  → Page ${page} failed: ${err.message}`);
                break;
            }
        }

        const totalFutureRaw = Object.keys(allPMEvents).length;
        const coverageEnd = latestEventDate ? latestEventDate.toISOString().split('T')[0] : 'unknown';
        console.log(`  Future: ${totalFutureRaw} unique across ${page} page(s), coverage through ${coverageEnd}`);

        // Fetch PAST events (paginated backward, up to 5 pages for ~30 days back)
        const pmPastUrl = 'https://www.pennmanor.net/events/list/?ical=1&tribe_event_display=past&tribe_paged=';
        const maxPastPages = 5;
        for (let pp = 1; pp <= maxPastPages; pp++) {
            try {
                const pastPageData = await ical.async.fromURL(pmPastUrl + pp, { headers: baseHeaders });
                const pastPageEvents = Object.values(pastPageData).filter(e => e.type === 'VEVENT');
                if (pastPageEvents.length === 0) break;
                let newPast = 0;
                for (const [key, val] of Object.entries(pastPageData)) {
                    if (val.type === 'VEVENT') {
                        const uid = val.uid || key;
                        if (!allPMEvents[uid]) newPast++;
                        allPMEvents[uid] = val;
                    }
                }
                console.log(`  Past page ${pp}: ${pastPageEvents.length} VEVENTs, ${newPast} new`);
                if (newPast === 0) break;
            } catch (err) { console.log(`  Past page ${pp} failed: ${err.message}`); break; }
        }

        const totalPMRaw = Object.keys(allPMEvents).length;
        console.log(`  Total unique (past+future): ${totalPMRaw}`);

        if (totalPMRaw === 0) throw new Error('Penn Manor returned no events');

        const pmData = allPMEvents;

        let pmAthCount = 0, pmGenCount = 0;

        for (const ev of Object.values(pmData)) {
            const eventDate = new Date(ev.start);
            if (isNaN(eventDate.getTime()) || eventDate < pastDate || eventDate >= futureDate) continue;

            const title = ev.summary || 'Penn Manor Event';
            const lowerTitle = title.toLowerCase();
            const desc = ev.description || '';
            const loc = ev.location || 'Penn Manor School District';
            const categories = ev.categories ? (Array.isArray(ev.categories) ? ev.categories.join(',') : String(ev.categories)) : '';

            // Skip noise
            if (/cycle day|^start of|^end of/i.test(lowerTitle)) continue;

            // Skip No School/Closings events entirely — not scraped
            if (/no school|snow day|spring break|weather make|school now in session|vacation|closing|closed/i.test(lowerTitle)) continue;

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

                // PM Hudl team links by sport + gender
                const pmHudlBase = 'https://fan.hudl.com/usa/pa/millersville/organization/6727/penn-manor-high-school/team/';
                const pmHudlTeams = {
                    'boys-football': '17195/boys-varsity-football',
                    'boys-football-freshman': '17199/boys-freshman-football',
                    'boys-basketball': '71274/boys-varsity-basketball',
                    'girls-basketball': '71273/girls-varsity-basketball',
                    'boys-baseball': '569426/Mens-Varsity-Baseball',
                    'girls-soccer': '346666/girls-varsity-soccer',
                    'girls-field hockey': '497810/Penn-Manor-Field-Hockey-',
                    'field hockey': '497810/Penn-Manor-Field-Hockey-',
                };
                // Build lookup key from gender + sport
                const gender = tags.includes('Boys') ? 'boys' : tags.includes('Girls') ? 'girls' : '';
                const sportTag = sportsList.find(s => tags.includes(s));
                const hudlKey1 = gender && sportTag ? `${gender}-${sportTag.toLowerCase()}` : '';
                const hudlKey2 = sportTag ? sportTag.toLowerCase() : '';
                const hudlTeam = pmHudlTeams[hudlKey1] || pmHudlTeams[hudlKey2] || null;
                const pmStreamLink = hudlTeam
                    ? pmHudlBase + hudlTeam
                    : 'https://fan.hudl.com/usa/pa/millersville/organization/6727/penn-manor-high-school/video';

                // Check if game is live
                const eventEnd = ev.end ? new Date(ev.end) : new Date(eventDate.getTime() + 2*60*60*1000);
                const pmIsLive = now >= eventDate && now <= eventEnd;

                events.push({
                    title, date: eventDate.toISOString(), location: loc,
                    tags: [...new Set(tags)], price: "Free", ticketLink: "",
                    sourceLink: ev.url || "https://www.pennmanor.net/calendar/",
                    gameResult: '', gameScore: '',
                    streamLink: pmStreamLink,
                    isLive: pmIsLive
                });
                pmAthCount++;
            } else {
                // Non-athletic PM event — categorize by title keywords
                let tags = ["PM"];
                const lt = lowerTitle;

                if (/board/i.test(lt)) tags.push('Board/PTO');
                else if (/pto/i.test(lt)) tags.push('Board/PTO');
                else if (/staff|in-service|act 80|faculty/i.test(lt)) continue; // Skip Staff events
                else if (/concert|band|chorus|choir|orchestra|musical|theater|play|string ensemble|showcase/i.test(lt)) tags.push('Music/Arts');
                else if (/pssa|grades?\s+(due|posted|are)|report card|marking period/i.test(lt)) continue; // Skip Testing/Grades events
                else if (/spirit day|dress down|reward day|talent show|pm cares/i.test(lt)) tags.push('Spirit/Fun Days');
                else if (/field trip|downtown trip|trip to/i.test(lt)) tags.push('Field Trips');
                else if (/gotr|girls on the run|heart & sole|physicals|health/i.test(lt)) tags.push('Health/Wellness');
                else if (/book fair|food fair|picture|assembly|appreciation|librarian/i.test(lt)) tags.push('School Events');
                else if (/sap meeting|team leader|lunch\s*&?\s*learn|house meeting/i.test(lt)) tags.push('Meetings');
                else tags.push('Other');

                // Skip PM-Other events (uncategorized, not useful)
                if (tags.includes('Other')) continue;

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
            if (eventDate < pastDate || eventDate >= futureDate) return;

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

    // ===== 6. MILLERSVILLE BOROUGH (Google Calendar iCal — with recurring event expansion) =====
    try {
        console.log("📡 Fetching Borough Calendar...");
        const boroughData = await ical.async.fromURL(
            'https://calendar.google.com/calendar/ical/millersville%40millersvilleborough.org/public/basic.ics',
            { headers: baseHeaders }
        );
        let boroughCount = 0;
        let boroughRecurring = 0;

        for (const ev of Object.values(boroughData)) {
            if (ev.type !== 'VEVENT') continue;

            const title = ev.summary || 'Borough Event';
            const loc = ev.location || 'Millersville Borough';

            // Handle recurring events (RRULE)
            if (ev.rrule) {
                try {
                    const occurrences = ev.rrule.between(pastDate, futureDate);
                    for (const occ of occurrences) {
                        // Check for exceptions/modifications (EXDATE)
                        const occKey = occ.toISOString().split('T')[0];
                        if (ev.exdate) {
                            const exdates = Object.values(ev.exdate).map(d => new Date(d).toISOString().split('T')[0]);
                            if (exdates.includes(occKey)) continue;
                        }

                        // Preserve original time from start
                        const origStart = new Date(ev.start);
                        const eventDate = new Date(occ);
                        eventDate.setHours(origStart.getHours(), origStart.getMinutes(), origStart.getSeconds());

                        // Check if this occurrence has been modified (RECURRENCE-ID)
                        if (ev.recurrences && ev.recurrences[occKey]) {
                            const mod = ev.recurrences[occKey];
                            events.push({
                                title: mod.summary || title,
                                date: new Date(mod.start).toISOString(),
                                location: mod.location || loc,
                                tags: ['Borough'],
                                price: 'Free', ticketLink: '',
                                sourceLink: 'https://millersvilleborough.org/resident-info/calendar/',
                                gameResult: '', gameScore: '', streamLink: '', isLive: false
                            });
                        } else {
                            events.push({
                                title,
                                date: eventDate.toISOString(),
                                location: loc,
                                tags: ['Borough'],
                                price: 'Free', ticketLink: '',
                                sourceLink: 'https://millersvilleborough.org/resident-info/calendar/',
                                gameResult: '', gameScore: '', streamLink: '', isLive: false
                            });
                        }
                        boroughCount++;
                        boroughRecurring++;
                    }
                } catch (rrErr) {
                    console.log(`  ⚠️ RRULE expansion failed for "${title}": ${rrErr.message}`);
                }
            } else {
                // Single (non-recurring) event
                const eventDate = new Date(ev.start);
                if (isNaN(eventDate.getTime()) || eventDate < pastDate || eventDate >= futureDate) continue;

                events.push({
                    title,
                    date: eventDate.toISOString(),
                    location: loc,
                    tags: ['Borough'],
                    price: 'Free', ticketLink: '',
                    sourceLink: ev.url || 'https://millersvilleborough.org/resident-info/calendar/',
                    gameResult: '', gameScore: '', streamLink: '', isLive: false
                });
                boroughCount++;
            }
        }
        console.log(`✅ Borough Calendar: ${boroughCount} events (${boroughRecurring} from recurring)`);
    } catch (e) { console.error("❌ Borough Calendar error:", e.message); }

    // ===== 7. VFW POST 7294 EVENTS (Google Cloud Vision OCR + cache) =====
    try {
        console.log("📡 Fetching VFW Post 7294 blog images for OCR...");
        const VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
        if (!VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY not set');

        // Load cache of previously OCR'd images
        const cachePath = path.join(__dirname, '../vfw-cache.json');
        let vfwCache = {};
        try {
            vfwCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            // Remove empty cache entries (from failed API calls)
            const beforeCount = Object.keys(vfwCache).length;
            for (const [key, val] of Object.entries(vfwCache)) {
                if (!val || val.trim().length === 0) delete vfwCache[key];
            }
            const cleared = beforeCount - Object.keys(vfwCache).length;
            if (cleared > 0) console.log(`  🗑️ Cleared ${cleared} empty cache entries`);
        } catch (e) { /* no cache yet */ }

        const vfwXml = await (await fetch('https://www.vfwpost7294.org/feed/', { headers: baseHeaders })).text();
        const vfwItems = vfwXml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        let vfwEventCount = 0;
        let vfwApiCalls = 0;
        let vfwWeeklySpecials = [];
        let vfwSpecialsDateRange = '';

        const months = { january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7, september:8, october:9, november:10, december:11 };
        const monthPattern = Object.keys(months).join('|');

        for (const item of vfwItems) {
          try {
            const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
            const linkMatch = item.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
            const pubMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
            const contentMatch = item.match(/<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/i);
            const descMatch = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);

            if (!titleMatch || !linkMatch) continue;

            const postTitle = titleMatch[1].replace(/&#\d+;/g, '').replace(/&amp;/g, '&').trim();
            const postLink = linkMatch[1].trim();
            const pubDate = pubMatch ? new Date(pubMatch[1]) : new Date();
            const htmlContent = (contentMatch ? contentMatch[1] : '') || (descMatch ? descMatch[1] : '');

            // Extract image URLs from the post content
            const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
            let imgMatch;
            const imageUrls = [];
            while ((imgMatch = imgRegex.exec(htmlContent)) !== null) {
                const url = imgMatch[1].replace(/&amp;/g, '&');
                const widthMatch = imgMatch[0].match(/width=["']?(\d+)/i);
                const w = widthMatch ? parseInt(widthMatch[1]) : 999;
                if (w < 100) continue;
                if (/gravatar|emoji|smilies|wp-includes|pixel|tracking/i.test(url)) continue;
                imageUrls.push(url);
            }

            if (imageUrls.length === 0) continue;
            console.log(`  📰 Post: "${postTitle}" — ${imageUrls.length} image(s)`);

            // Combine OCR text from all images
            let allOcrText = postTitle + '\n';
            // Also grab body text
            const bodyText = htmlContent.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
            allOcrText += bodyText + '\n';

            for (const imgUrl of imageUrls) {
                try {
                    // Check cache first
                    if (vfwCache[imgUrl]) {
                        console.log(`    📋 Cached OCR (${vfwCache[imgUrl].length} chars):`);
                        console.log(`    ────────────────────────────────`);
                        vfwCache[imgUrl].trim().split('\n').forEach(line => {
                            if (line.trim()) console.log(`    │ ${line.trim()}`);
                        });
                        console.log(`    ────────────────────────────────`);
                        allOcrText += '\n' + vfwCache[imgUrl];
                        continue;
                    }

                    // Download image
                    const imgRes = await fetch(imgUrl, { headers: baseHeaders, signal: AbortSignal.timeout(15000) });
                    if (!imgRes.ok) continue;
                    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

                    // Validate image
                    if (imgBuffer.length < 1000) { console.log(`    ⚠️ Skipping tiny image`); continue; }
                    const hdr = imgBuffer.slice(0, 4);
                    const isImg = (hdr[0]===0xFF&&hdr[1]===0xD8) || (hdr[0]===0x89&&hdr[1]===0x50) || (hdr[0]===0x47&&hdr[1]===0x49) || (hdr[0]===0x52&&hdr[1]===0x49);
                    if (!isImg) { console.log(`    ⚠️ Skipping non-image file`); continue; }

                    // Google Cloud Vision API call
                    const base64Img = imgBuffer.toString('base64');
                    const visionRes = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            requests: [{
                                image: { content: base64Img },
                                features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
                            }]
                        })
                    });

                    if (!visionRes.ok) {
                        const errBody = await visionRes.text();
                        console.log(`    ⚠️ Vision API error ${visionRes.status}: ${errBody.substring(0, 200)}`);
                        continue;
                    }

                    const visionData = await visionRes.json();
                    const ocrText = visionData.responses?.[0]?.fullTextAnnotation?.text || '';
                    vfwApiCalls++;

                    if (ocrText.trim().length > 10) {
                        console.log(`    🔍 Vision OCR (${ocrText.trim().length} chars):`);
                        console.log(`    ────────────────────────────────`);
                        ocrText.trim().split('\n').forEach(line => {
                            if (line.trim()) console.log(`    │ ${line.trim()}`);
                        });
                        console.log(`    ────────────────────────────────`);
                        allOcrText += '\n' + ocrText;
                        // Cache the result
                        vfwCache[imgUrl] = ocrText;
                    } else {
                        console.log(`    ⚠️ No text detected in image`);
                        vfwCache[imgUrl] = ''; // Cache empty result too
                    }
                } catch (imgErr) {
                    console.log(`    ⚠️ Image failed: ${imgErr.message}`);
                }
            }

            // ===== Extract events from combined OCR + body text =====

            // Skip "WEEKLY FOOD SPECIALS" and "WEEKLY SPECIALS" posts — these are menus, not events
            const isWeeklySpecials = /weekly\s*(food\s*)?specials/i.test(postTitle) || /weekly\s*specials/i.test(allOcrText.substring(0, 200));

            // Regular recurring food nights to SKIP (not special events)
            const recurringFoodNights = /^(wing night|taco night|burger night|shrimp night|ham steak|roast beef wrap)$/i;
            // Regular recurring events that ARE worth listing
            const recurringEvents = /bingo|trivia|cornhole|karaoke|dart|pool\s+league/i;
            // Special one-off events to ALWAYS capture
            const specialEvents = /easter|christmas|holiday|carnival|fireworks|fundraiser|dance|cook.?off|bbq|cookout|picnic|gun\s+bingo|steak\s+night|paint|volunteer|meeting|memorial|veteran/i;
            // Food items from weekly specials posts (not events)
            const foodItems = /fish\s+sandwich|beef\s+tips|meatloaf|shepherd'?s?\s+pie|fried\s+catfish|shrimp\s+alfredo|tuna\s+steak|cod|brioche|fettuccine|burger.*fries|mashed\s+potato/i;
            // OCR noise to ignore
            const ocrNoise = /years?\s+of\s+service|1899|WEW|WWEW/i;

            const foundEvents = new Set();

            // Detect if this is a CALENDAR post (has day-of-week headers + day numbers)
            const isCalendarPost = /\bcalendar\b/i.test(postTitle) ||
                (/sunday/i.test(allOcrText) && /monday|tuesday/i.test(allOcrText) && /wednesday/i.test(allOcrText) && /\b\d{1,2}\n/m.test(allOcrText));

            if (isCalendarPost) {
                console.log(`    📅 Calendar post detected — extracting events by grid position`);

                // Determine which month this calendar is for
                const calMonthMatch = allOcrText.match(new RegExp(`\\b(${monthPattern})\\b`, 'i'));
                if (!calMonthMatch) { console.log(`    ⚠️ Could not determine month`); continue; }
                const calMonth = months[calMonthMatch[1].toLowerCase()];
                let calYear = pubDate.getFullYear();
                if (calMonth < pubDate.getMonth() - 1) calYear++;

                // Build the actual calendar grid for this month
                // Figure out what day of week the 1st falls on (0=Sun, 6=Sat)
                const firstDayOfWeek = new Date(calYear, calMonth, 1).getDay();
                const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

                // Build weeks array: each week is [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
                const weeks = [];
                let week = new Array(7).fill(0);
                for (let d = 1; d <= daysInMonth; d++) {
                    const dow = new Date(calYear, calMonth, d).getDay();
                    week[dow] = d;
                    if (dow === 6 || d === daysInMonth) {
                        weeks.push([...week]);
                        week = new Array(7).fill(0);
                    }
                }

                // Column order: Sun=0, Mon=1(closed/specials), Tue=2, Wed=3, Thu=4, Fri=5, Sat=6
                // OCR reads row by row: day numbers first, then events in column order

                // Parse OCR into row blocks — each block starts with a sequence of day numbers
                const lines = allOcrText.split('\n').map(l => l.trim()).filter(l => l);
                let currentWeekIdx = -1;
                let eventLines = []; // events for current week

                // Track which week we're in by finding day number sequences
                const processWeekEvents = (weekIdx, eventItems) => {
                    if (weekIdx < 0 || weekIdx >= weeks.length) return;
                    const weekDays = weeks[weekIdx];
                    // Events appear in column order: Sun, (Mon/Weekly Specials), Tue, Wed, Thu, Fri, Sat
                    // Map each event to its column based on known patterns
                    const dayColumnMap = {
                        // Sunday events
                        'meat tray bingo': 0, 'aux easter egg hunt': 0,
                        // Tuesday events (Weekly Specials column = Mon/Tue food)
                        // Wednesday events
                        'auxiliary meeting': 3, 'wing night': 3, 'trivia': 3, 'post meeting': 3,
                        // Thursday events
                        'taco night': 4,
                        // Friday events
                        'music bingo': 5, 'fried catfish': 5, 'shrimp alfredo': 5,
                        'tuna steak': 5, 'vfw easter party': 5,
                        // Saturday events
                        'burger night': 6, 'banquet hall paint': 6,
                    };

                    for (const eventName of eventItems) {
                        const lower = eventName.toLowerCase();
                        let col = dayColumnMap[lower];

                        // If not in map, try to guess by event type
                        if (col === undefined) {
                            if (/bingo/i.test(eventName) && !/music/i.test(eventName)) col = 0; // Sunday bingo
                            else if (/meeting/i.test(eventName)) col = 3; // Wednesday meetings
                            else if (/trivia|cornhole/i.test(eventName)) col = 3; // Wednesday entertainment
                            else if (/hunt|egg/i.test(eventName)) col = 0; // Sunday
                            else continue; // Unknown — skip
                        }

                        const dayNum = weekDays[col];
                        if (!dayNum) continue; // No day in this column for this week

                        // Use noon Eastern (16:00 UTC or 17:00 UTC depending on DST) to prevent date shift
                        // Setting to 12:00 noon UTC-4 = 16:00 UTC ensures the date displays correctly in Eastern
                        const eventDate = new Date(Date.UTC(calYear, calMonth, dayNum, 16, 0, 0));
                        if (isNaN(eventDate.getTime())) continue;
                        if (eventDate < pastDate || eventDate >= futureDate) continue;
                        if (eventDate.getDay() === 1) continue; // Monday = closed

                        const dateKey = eventDate.toISOString().substring(0, 10);

                        // Skip regular recurring food nights
                        if (recurringFoodNights.test(eventName)) continue;
                        if (foodItems.test(eventName)) continue;

                        const looksLikeEvent = specialEvents.test(eventName) || recurringEvents.test(eventName) ||
                            /bingo|trivia|party|meeting|hunt|paint|dance|cornhole|concert|show|karaoke|volunteer/i.test(eventName);
                        if (!looksLikeEvent) continue;

                        if (foundEvents.has(dateKey + eventName)) continue;
                        foundEvents.add(dateKey + eventName);

                        events.push({
                            title: eventName, date: eventDate.toISOString(),
                            location: 'VFW Post 7294, 219 Walnut Hill Rd',
                            tags: ['Other', 'VFW'], price: 'Members Only', ticketLink: '', sourceLink: postLink,
                            gameResult: '', gameScore: '', streamLink: '', isLive: false, kidFriendly: false
                        });
                        vfwEventCount++;
                        console.log(`    📌 VFW Event: "${eventName}" on ${dateKey} (week ${weekIdx+1}, col ${col})`);
                    }
                };

                let pendingEvents = [];
                let seenFirstNumber = false;

                for (const line of lines) {
                    // Skip noise
                    if (ocrNoise.test(line)) continue;
                    if (/^[a-z]$/i.test(line) || /^m$/i.test(line)) continue;
                    if (/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekly specials?)$/i.test(line)) continue;
                    if (line.length < 2) continue;

                    const isNumber = /^\d{1,2}$/.test(line) && parseInt(line) >= 1 && parseInt(line) <= 31;

                    if (isNumber) {
                        const num = parseInt(line);
                        // Find which week this number belongs to
                        let numWeekIdx = -1;
                        for (let w = 0; w < weeks.length; w++) {
                            if (weeks[w].includes(num)) { numWeekIdx = w; break; }
                        }

                        // If we had events collected before seeing any number, those belong to week containing day 1
                        if (!seenFirstNumber && pendingEvents.length > 0) {
                            const week1Idx = weeks.findIndex(w => w.includes(1));
                            if (week1Idx >= 0) {
                                console.log(`    📅 Pre-number events assigned to week 1 (${pendingEvents.length} items)`);
                                processWeekEvents(week1Idx, pendingEvents);
                            }
                            pendingEvents = [];
                        }
                        seenFirstNumber = true;

                        // If switching to a different week, process pending events for the CURRENT week first
                        if (pendingEvents.length > 0 && currentWeekIdx >= 0 && numWeekIdx !== currentWeekIdx) {
                            processWeekEvents(currentWeekIdx, pendingEvents);
                            pendingEvents = [];
                        }

                        currentWeekIdx = numWeekIdx;
                    } else {
                        // This is an event name for the current week
                        if (line.length >= 3 && line.length <= 80) {
                            pendingEvents.push(line);
                        }
                    }
                }
                // Process last batch
                if (pendingEvents.length > 0 && currentWeekIdx >= 0) {
                    processWeekEvents(currentWeekIdx, pendingEvents);
                }
            } else if (!isWeeklySpecials) {
                // NON-calendar, NON-weekly-specials posts — extract events from body text
                // Look for specific event mentions with dates
                const dateRegex = new RegExp(
                    `(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)[,\\s]*)?` +
                    `(${monthPattern})[\\s.,]*(\\d{1,2})(?:st|nd|rd|th)?[,\\s]*(\\d{4})?`,
                    'gi'
                );

                let dm;
                while ((dm = dateRegex.exec(allOcrText)) !== null) {
                    const monthName = dm[1].toLowerCase();
                    const day = parseInt(dm[2]);
                    let year = dm[3] ? parseInt(dm[3]) : pubDate.getFullYear();
                    const monthNum = months[monthName];
                    if (monthNum === undefined) continue;
                    if (monthNum < pubDate.getMonth() - 1 && !dm[3]) year++;

                    const eventDate = new Date(Date.UTC(year, monthNum, day, 16, 0, 0));
                    if (isNaN(eventDate.getTime())) continue;
                    if (eventDate < pastDate || eventDate >= futureDate) continue;
                    // VFW closed on Mondays
                    if (eventDate.getDay() === 1) continue;

                    const dateKey = eventDate.toISOString().substring(0, 10);
                    if (foundEvents.has(dateKey)) continue;

                    const ctx = allOcrText.substring(Math.max(0, dm.index - 200), dm.index + dm[0].length + 400);

                    // Skip if this is just a food description context
                    if (foodItems.test(ctx) && !specialEvents.test(ctx) && !recurringEvents.test(ctx)) continue;

                    // Extract time
                    const timeMatch = ctx.match(/(?:at\s+|from\s+|begins?\s+(?:at\s+)?|starting\s+(?:at\s+)?|doors?\s+(?:open\s+)?(?:at\s+)?|@\s*)(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM))/i);
                    if (timeMatch) {
                        const tp = timeMatch[1].replace(/\./g,'').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
                        if (tp) {
                            let h = parseInt(tp[1]); const mi = tp[2]?parseInt(tp[2]):0;
                            if(tp[3].toLowerCase()==='pm'&&h<12) h+=12;
                            if(tp[3].toLowerCase()==='am'&&h===12) h=0;
                            eventDate.setHours(h,mi,0);
                        }
                    }

                    // Extract event name
                    let eventName = '';
                    const namePatterns = [
                        /(?:we have|join us for|come (?:out )?(?:to|for)|presenting|hosting|it'?s)\s+(?:our\s+)?([A-Z][^.!?\n]{3,60}?)(?:\s+(?:in|at|on|from|this|beginning|starting|!|\.))/i,
                        /([A-Z][A-Za-z\s'&]+(?:Bingo|Trivia|Cornhole|Dance|Party|Carnival|Fundraiser|Concert|Show|Tournament|Cook.?off|BBQ|Cookout|Picnic|Hunt))/,
                    ];
                    for (const pattern of namePatterns) {
                        const nm = ctx.match(pattern);
                        if (nm) {
                            eventName = nm[1].trim().replace(/^(our|the|a)\s+/i, '').trim();
                            eventName = eventName.charAt(0).toUpperCase() + eventName.slice(1);
                            if (eventName.length >= 3 && eventName.length <= 80) break;
                            eventName = '';
                        }
                    }
                    if (!eventName) eventName = postTitle.replace(/[!]+$/, '').replace(/&#\d+;/g, '').trim();

                    // Skip if event name is just a food item
                    if (foodItems.test(eventName)) continue;

                    let price = 'Free';
                    const priceMatch = ctx.match(/\$(\d+(?:\.\d{2})?)/);
                    if (priceMatch && !foodItems.test(ctx.substring(ctx.indexOf(priceMatch[0]) - 80, ctx.indexOf(priceMatch[0])))) {
                        price = `$${priceMatch[1]}`;
                    }

                    foundEvents.add(dateKey);
                    events.push({
                        title: eventName, date: eventDate.toISOString(),
                        location: 'VFW Post 7294, 219 Walnut Hill Rd',
                        tags: ['Other', 'VFW'], price: 'Members Only', ticketLink: '', sourceLink: postLink,
                        gameResult: '', gameScore: '', streamLink: '', isLive: false, kidFriendly: false
                    });
                    vfwEventCount++;
                    console.log(`    📌 VFW Event: "${eventName}" on ${dateKey}${timeMatch ? ' at ' + timeMatch[1] : ''} [${price}]`);
                }
            } else if (isWeeklySpecials) {
                // Only extract from the MOST RECENT weekly specials post (first one in RSS = newest)
                if (vfwWeeklySpecials.length > 0) {
                    console.log(`    ⏭️ Skipping older weekly specials post (already have newer)`);
                } else {
                    console.log(`    🍽️ Extracting food specials from weekly specials post`);

                    // Extract date range: "From Tuesday, March 24 through Saturday, March 28"
                    const rangeMatch = allOcrText.match(/from\s+\w+,?\s*((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2})\s*(?:through|thru|-|–)\s*\w*,?\s*((?:january|february|march|april|may|june|july|august|september|october|november|december)?\s*\d{1,2})/i);
                    let dateRange = '';
                    if (rangeMatch) {
                        dateRange = rangeMatch[0].replace(/^from\s+/i, '').trim();
                        console.log(`    📅 Date range: ${dateRange}`);
                    }

                    // Extract food items from OCR text
                    // Strategy: find lines that are ALL CAPS (food names), then find the price in nearby text
                    const lines = allOcrText.split('\n').map(l => l.trim()).filter(l => l);
                    const weeklySpecials = [];
                    const noiseWords = /^(MILLERSVILLE|MANOR|VFW|POST|WEEKLY|SPECIALS|FOOD|WEW|WWEW|YEARS|SERVICE|FROM|FRIDAY ONLY|EASTER)/i;

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        // Is this an all-caps food name? (at least 3 chars, mostly uppercase letters)
                        const isUpperName = /^[A-Z][A-Z\s&'–-]{2,50}$/.test(line) && !noiseWords.test(line);
                        if (!isUpperName) continue;

                        // Look ahead for a price in the next few lines
                        let price = '';
                        let isFridayOnly = false;
                        const lookAhead = lines.slice(i, Math.min(i + 5, lines.length)).join(' ');
                        const priceMatch = lookAhead.match(/\$(\d+\.\d{2})/);
                        if (priceMatch) price = `$${priceMatch[1]}`;

                        // Check if previous line says "FRIDAY ONLY"
                        if (i > 0 && /friday only/i.test(lines[i - 1])) isFridayOnly = true;
                        // Or if this line contains "FRIDAY ONLY"
                        if (/friday only/i.test(line)) continue; // Skip "FRIDAY ONLY" itself as a name

                        // Clean up name: title case
                        let name = line.replace(/\s+/g, ' ').split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
                        // Remove trailing dash or special chars
                        name = name.replace(/\s*[-–]\s*$/, '').trim();

                        if (name.length < 4) continue;
                        // Skip if it's a known noise pattern
                        if (/^\d|^125$|^1899/i.test(name)) continue;

                        weeklySpecials.push({ name, price, fridayOnly: isFridayOnly, dateRange });
                        console.log(`    🍽️ Special: ${name} ${price}${isFridayOnly ? ' (Friday only)' : ''}`);
                    }

                    if (weeklySpecials.length > 0) {
                        vfwWeeklySpecials = weeklySpecials;
                        vfwSpecialsDateRange = dateRange;
                    }
                }
            }
          } catch (postErr) {
            console.log(`    ⚠️ Post processing failed: ${postErr.message}`);
          }
        }

        // Save cache
        fs.writeFileSync(cachePath, JSON.stringify(vfwCache, null, 2));
        console.log(`✅ VFW Post 7294: ${vfwEventCount} events extracted (${vfwApiCalls} API calls, ${Object.keys(vfwCache).length} cached)`);

        // Write specials.json with VFW weekly specials + House of Pizza static specials
        const specials = {
            "House of Pizza": {
                note: "Dine-in & Carryout Only · Mon-Fri till 2 PM · Not for Delivery",
                daily: {
                    "Monday": ["2 Slices & MD Drink – $4.50", "Soup & Sandwich – $5.99", "Turkey Sub – $5.25"],
                    "Tuesday": ["2 Slices & MD Drink – $4.50", "Ham Sub – $5.00", "Pork BBQ Sandwich w/Fries – $5.99"],
                    "Wednesday": ["2 Slices & MD Drink – $4.50", "Soup & Sandwich – $5.99", "Italian Sub – $5.25"],
                    "Thursday": ["2 Slices & MD Drink – $4.50", "Soup & Sandwich – $5.99", "¼ Lb. Cheeseburger & Fries – $4.50", "🍺 Miller Lite Draft (Pint) – $1.50 (all day till midnight)"],
                    "Friday": ["2 Slices & MD Drink – $4.50", "Meatball Sub – $5.50", "Shrimp Basket & Fries – $5.75"]
                }
            },
            "VFW Post 7294": {
                note: "Members & Guests · Weekly specials change each week",
                weekly: vfwWeeklySpecials.map(s => {
                    let label = s.name;
                    if (s.price) label += ` – ${s.price}`;
                    if (s.fridayOnly) label += ' (Friday only)';
                    return label;
                }),
                weeklyDateRange: vfwSpecialsDateRange,
                recurring: {
                    "Tuesday": "Shrimp Night",
                    "Wednesday": "Wing Night",
                    "Thursday": "Taco Night",
                    "Friday": "Special (varies weekly)",
                    "Saturday": "Burger Night"
                }
            }
        };
        fs.writeFileSync(path.join(__dirname, '../specials.json'), JSON.stringify(specials, null, 2));
        console.log(`✅ Specials saved (VFW: ${vfwWeeklySpecials.length} weekly items)`);
    } catch (e) { console.error("❌ VFW Events error:", e.message); }

    // ===== FAMILY-FRIENDLY TAGGING =====
    const familyKeywords = /\bfamily\b|families|\bkids?\b|\bchild(ren)?\b|\byouth\b|\ball ages\b|\bopen house\b|\bparade\b|\bfestival\b|\bfun run\b|\begg hunt\b|\btrick.or.treat\b|\bstory ?time\b/i;
    const notFamilyKeywords = /\brehersal\b|\brehearsal\b|\bpractice\b|\btraining\b|\bsap meeting\b|\bstaff\b|\bfaculty\b|\bin-service\b|\bboard\b|\bpto\b/i;
    const notFamilyMUKeywords = /\bjob\b|\binternship\b|\bcareer fair\b|\bemployment\b|\brecruitment\b|\bhiring\b|\bresume\b/i;
    const familyPMKeywords = /\bconcert\b|\bensemble\b|\bshowcase\b|\bspring show\b|\bmusical\b|\bplay\b|\btalent show\b|\bassembly\b|\bbook fair\b|\bfood fair\b|\bpicture\b|\bspirit day\b|\breward day\b|\bfield day\b/i;
    let famCount = 0;
    events.forEach(e => {
        const tags = e.tags || [];
        const src = tags[0] || '';
        const title = e.title || '';
        const titleLower = title.toLowerCase();

        let isFamilyFriendly = false;

        // Skip all sporting events (they're on the Sports page, not Events)
        if (tags.includes('Athletic Competitions') || tags.includes('Athletics') || tags.includes('Club Sports')) {
            e.kidFriendly = false;
            return;
        }

        // All Clubs/Orgs events → NOT family friendly
        if (src === 'Clubs/Orgs' || tags.includes('Clubs/Orgs')) {
            e.kidFriendly = false;
            return;
        }

        // Borough events → NOT family friendly (trash collection, meetings, etc.)
        if (src === 'Borough') {
            isFamilyFriendly = false;
        }
        // PM events — selective
        else if (src === 'PM') {
            // NOT family friendly: Board/PTO, Meetings, School Events, Field Trips
            if (tags.includes('Board/PTO') || tags.includes('Meetings') || tags.includes('School Events') || tags.includes('Field Trips')) {
                isFamilyFriendly = false;
            }
            // NOT family friendly: rehearsals/practice in title
            else if (notFamilyKeywords.test(titleLower)) {
                isFamilyFriendly = false;
            }
            // YES family friendly: concerts, showcases, assemblies, book fairs, spirit days, etc.
            else if (familyPMKeywords.test(titleLower)) {
                isFamilyFriendly = true;
            }
            // PM Spirit/Fun Days → family friendly
            else if (tags.includes('Spirit/Fun Days')) {
                isFamilyFriendly = true;
            }
            // Default PM: not family friendly
            else {
                isFamilyFriendly = false;
            }
        }
        // Phantom Power / bar events → NOT family friendly
        else if (tags.includes('Other') && tags.includes('Live Music')) {
            isFamilyFriendly = false;
        }
        // MU events — keyword match, but exclude job/internship fairs
        else if (src === 'MU') {
            if (notFamilyMUKeywords.test(titleLower)) {
                isFamilyFriendly = false;
            } else if (familyKeywords.test(title)) {
                isFamilyFriendly = true;
            }
        }
        // Other sources — keyword match
        else if (familyKeywords.test(title)) {
            isFamilyFriendly = true;
        }

        e.kidFriendly = isFamilyFriendly;
        if (isFamilyFriendly) famCount++;
    });
    console.log(`👨‍👩‍👧 Family-friendly tagged: ${famCount} of ${events.length} events`);

    // ===== DEDUPLICATION & SAVE =====
    const seen = new Set();
    const dupeList = [];
    const deduped = events.filter(e => {
        const key = `${e.title.trim().toLowerCase()}-${e.date}-${(e.location || '').trim().toLowerCase()}`;
        if (seen.has(key)) {
            dupeList.push({ title: e.title, date: e.date.substring(0,10), source: (e.tags||[])[0] || 'Unknown' });
            return false;
        }
        seen.add(key);
        return true;
    });

    if (dupeList.length > 0) {
        console.log(`⚠️ Removed ${dupeList.length} duplicates:`);
        dupeList.forEach(d => console.log(`   ✕ [${d.source}] ${d.title} (${d.date})`));
    }

    deduped.sort((a, b) => new Date(a.date) - new Date(b.date));
    fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(deduped, null, 2));
    console.log(`📊 Total events saved: ${deduped.length}`);

    // ===== NEWS =====
    try {
        let news = [];

        // Helper to parse RSS items WITH optional category extraction
        function parseRSSItems(xml, sourceCategory, source, maxItems, options = {}) {
            const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
            const results = [];
            const skipCats = options.skipCategories || false;
            for (let i = 0; i < Math.min(maxItems, items.length); i++) {
                const t = items[i].match(/<title>([\s\S]*?)<\/title>/i);
                const l = items[i].match(/<link>([\s\S]*?)<\/link>/i);
                const d = items[i].match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
                // Extract RSS <category> tags for sub-categories
                let cats = [];
                if (!skipCats) {
                    const catRegex = /<category[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/gi;
                    let cm;
                    while ((cm = catRegex.exec(items[i])) !== null) {
                        const cat = cm[1].trim();
                        if (cat && !cats.includes(cat)) cats.push(cat);
                    }
                }
                if (t && l) {
                    const pubDate = d ? new Date(d[1]) : null;
                    results.push({
                        category: sourceCategory, source,
                        subCategory: cats.length > 0 ? cats[0] : '',
                        tags: cats,
                        title: t[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim(),
                        link: l[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim(),
                        date: pubDate ? pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : "",
                        sortDate: pubDate ? pubDate.toISOString() : "1970-01-01T00:00:00.000Z"
                    });
                }
            }
            return results;
        }

        // MU Official News (all posts — no sub-categories, too granular)
        try {
            const xml = await (await fetch('https://blogs.millersville.edu/news/feed/', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "MU", "Millersville News", 15, { skipCategories: true }));
            console.log(`  ✅ MU News: ${Math.min(15, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ MU News RSS error:", e.message); }

        // The Snapper — scrape each section page for proper categorization
        try {
            const snapperSections = [
                { url: 'https://thesnapper.com/news/', sub: 'News' },
                { url: 'https://thesnapper.com/opinion/', sub: 'Opinion' },
                { url: 'https://thesnapper.com/features/', sub: 'Features' },
                { url: 'https://thesnapper.com/arts-and-culture/', sub: 'Arts & Culture' },
                { url: 'https://thesnapper.com/sports/', sub: 'Sports' }
            ];
            let snapperTotal = 0;
            for (const section of snapperSections) {
                try {
                    const html = await (await fetch(section.url, { headers: baseHeaders })).text();
                    const articleRegex = /<h[23][^>]*>\s*<a\s+class="primary-link"\s+href="(https:\/\/thesnapper\.com\/[^"]+)">([^<]+)<\/a>/g;
                    const dateRegex = /<div[^>]*class="[^"]*publish-info[^"]*"[^>]*>[\s\S]*?<\/p>\s*<span[^>]*>[\s\S]*?<\/span>\s*<p>([^<]+)<\/p>/g;

                    const articles = [];
                    let match;
                    while ((match = articleRegex.exec(html)) !== null) {
                        const url = match[1], title = match[2].trim();
                        if (url.includes('/author/') || url.includes('/tag/') || title === 'View All') continue;
                        articles.push({ url, title });
                    }
                    const dates = [];
                    while ((match = dateRegex.exec(html)) !== null) dates.push(match[1].trim());

                    const max = Math.min(5, articles.length);
                    for (let i = 0; i < max; i++) {
                        const dateStr = dates[i] || '';
                        const parsed = dateStr ? new Date(dateStr) : null;
                        news.push({
                            category: "MU", source: "The Snapper",
                            subCategory: section.sub,
                            tags: [section.sub],
                            title: articles[i].title,
                            link: articles[i].url,
                            date: dateStr,
                            sortDate: parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : "1970-01-01T00:00:00.000Z"
                        });
                        snapperTotal++;
                    }
                } catch (e) { /* section failed, continue */ }
            }
            console.log(`  ✅ The Snapper: ${snapperTotal} articles across ${snapperSections.length} sections`);
        } catch (e) { console.error("❌ Snapper scrape error:", e.message); }

        // Millersville Borough News & Alerts
        try {
            const xml = await (await fetch('https://millersvilleborough.org/category/news-alerts/feed/', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "Borough", "Millersville Borough", 10));
            console.log(`  ✅ Borough News: ${Math.min(10, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ Borough News RSS error:", e.message); }

        // VFW Post 7294 Blog
        try {
            const xml = await (await fetch('https://www.vfwpost7294.org/feed/', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "Community", "VFW Post 7294", 10, { skipCategories: true }));
            console.log(`  ✅ VFW Post 7294: ${Math.min(10, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ VFW RSS error:", e.message); }

        // Penn Manor School District News
        try {
            const xml = await (await fetch('https://www.pennmanor.net/blog/feed/', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "PM", "Penn Manor News", 10));
            console.log(`  ✅ PM News: ${Math.min(10, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ PM News RSS error:", e.message); }

        // MU Athletics News (Sidearm RSS)
        try {
            const xml = await (await fetch('https://millersvilleathletics.com/rss', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "MU", "MU Athletics", 15));
            console.log(`  ✅ MU Athletics: ${Math.min(15, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ MU Athletics News RSS error:", e.message); }

        // MU The Review (magazine)
        try {
            const xml = await (await fetch('https://blogs.millersville.edu/news/category/the-review/feed/', { headers: baseHeaders })).text();
            news.push(...parseRSSItems(xml, "MU", "MU Review", 10, { skipCategories: true }));
            console.log(`  ✅ MU Review: ${Math.min(10, (xml.match(/<item>/g)||[]).length)} articles`);
        } catch (e) { console.error("❌ The Review RSS error:", e.message); }

        // Deduplicate news by link
        const seenLinks = new Set();
        news = news.filter(n => {
            if (seenLinks.has(n.link)) return false;
            seenLinks.add(n.link);
            return true;
        });

        // Sort by date, most recent first
        news.sort((a, b) => new Date(b.sortDate || 0) - new Date(a.sortDate || 0));

        fs.writeFileSync(path.join(__dirname, '../news.json'), JSON.stringify(news, null, 2));
        console.log(`✅ News: ${news.length} total items`);
    } catch (e) { console.error("❌ News/specials error:", e.message); }

    console.log("✅ All data compilations complete.");
}

runScraper();
