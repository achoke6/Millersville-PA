const fs = require('fs');
const path = require('path');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

function extractPricing(desc, title = "", location = "", apiLink = "") {
    let price = "Free"; 
    let link = apiLink || "";
    
    if (desc) {
        const priceRegex = /\$\d+(?:\.\d{2})?(?:\s+(?:student|public|general|admission|door|advance|mu|adult|child)s?)?/gi;
        const prices = desc.match(priceRegex);
        if (prices) price = [...new Set(prices)].join(' / ');
        else if (desc.toLowerCase().includes('ticket') || desc.toLowerCase().includes('admission') || desc.toLowerCase().includes('cover charge') || desc.toLowerCase().includes('cost:')) price = "Ticket Required"; 

        if (!link) {
            const anchorRegex = /<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
            let match;
            let bestLink = null;
            let highestScore = 0;

            while ((match = anchorRegex.exec(desc)) !== null) {
                const url = match[1];
                const anchorText = match[2].toLowerCase();
                const lowerUrl = url.toLowerCase();
                let score = 0;

                if (lowerUrl.includes('instagram.com') || lowerUrl.includes('facebook.com') || lowerUrl.includes('twitter.com') || lowerUrl.includes('youtube.com') || lowerUrl.includes('campusgroups.com/organization')) continue;

                if (lowerUrl.includes('etix.com') || lowerUrl.includes('universitytickets.com') || lowerUrl.includes('muticketsonline.com') || lowerUrl.includes('eventbrite.com')) score = 3;
                else if (anchorText.includes('ticket') || anchorText.includes('register') || anchorText.includes('buy') || anchorText.includes('rsvp') || anchorText.includes('purchase')) score = 2;
                else if (lowerUrl.includes('ticket') || lowerUrl.includes('register') || lowerUrl.includes('rsvp')) score = 1;

                if (score > highestScore) {
                    highestScore = score;
                    bestLink = url;
                }
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
        const lowerTitle = title.toLowerCase();
        const lowerLoc = location.toLowerCase();
        if (lowerLoc.includes('winter') || lowerLoc.includes('lyte') || lowerTitle.includes('concert') || lowerTitle.includes('recital') || lowerTitle.includes('theatre')) link = "https://www.etix.com/ticket/v/23659/";
        else if (lowerLoc.includes('pucillo') || lowerLoc.includes('biemesderfer') || lowerTitle.includes('game') || lowerTitle.includes('match') || lowerTitle.includes('tournament')) link = "https://www.etix.com/ticket/v/23684/";
    }
    return { price, link };
}

// Safely traverses Eventbrite JSON-LD to find events
function extractEventbriteEvents(ldData, eventsArray, now, thirtyDaysOut) {
    if (Array.isArray(ldData)) {
        ldData.forEach(item => extractEventbriteEvents(item, eventsArray, now, thirtyDaysOut));
    } else if (ldData && typeof ldData === 'object') {
        if (ldData['@type'] === 'Event' && ldData.name && ldData.startDate) {
            const eventDate = new Date(ldData.startDate);
            if (eventDate >= now && eventDate < thirtyDaysOut) {
                
                // Slick Rick specific pricing logic based on your event data
                let eventPrice = "Ticket Required";
                if (ldData.name.toLowerCase().includes('slick rick')) {
                    eventPrice = "$35 ADV";
                }

                eventsArray.push({
                    title: ldData.name,
                    date: eventDate.toISOString(),
                    location: "Phantom Power",
                    category: "Other",
                    price: eventPrice,
                    ticketLink: ldData.url || "https://www.eventbrite.com/o/phantom-power-29187724817"
                });
            }
        } else {
            for (let key in ldData) if (typeof ldData[key] === 'object') extractEventbriteEvents(ldData[key], eventsArray, now, thirtyDaysOut);
        }
    }
}

async function runScraper() {
    console.log("🚀 Starting Millersville Pro Scraper...");

    // 1. WEATHER
    try {
        console.log("Fetching Weather XML...");
        const res = await fetch('https://snowball.millersville.edu/~cws/current.xml', { headers: baseHeaders });
        const xml = await res.text();
        const tempMatch = xml.match(/<(?:temp_f|temperature|temp)[^>]*>\s*([-\d.]+)/i);
        const condMatch = xml.match(/<(?:weather|condition|sky_condition)[^>]*>([^<]+)/i);
        const windMatch = xml.match(/<(?:wind_string|wind_mph|wind)[^>]*>([^<]+)/i);
        const humMatch = xml.match(/<(?:relative_humidity|humidity)[^>]*>\s*([-\d.]+)/i);
        const weatherData = {
            temp: tempMatch ? Math.round(parseFloat(tempMatch[1])) : "--",
            condition: condMatch ? condMatch[1].trim() : "Data Unavailable",
            wind: windMatch ? windMatch[1].trim() : "Calm",
            humidity: humMatch ? humMatch[1].trim() + "%" : "--",
            lastUpdated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        };
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify(weatherData, null, 2));
    } catch (e) { console.error("❌ Weather Error:", e.message); }

    // 2. EVENTS MASTER COMPILE
    try {
        console.log("Fetching All Events...");
        let events = [];
        const today = new Date();
        const startDay = today.toISOString().split('T')[0];
        const thirtyDaysOut = new Date(today);
        thirtyDaysOut.setDate(today.getDate() + 29);
        const endDay = thirtyDaysOut.toISOString().split('T')[0];

        // --- ATTEMPT 1: MU Primary API ---
        try {
            const pageRes = await fetch('https://www.millersville.edu/calendar/', { headers: baseHeaders });
            const rawCookies = pageRes.headers.get('set-cookie');
            let cookieHeader = '';
            if (rawCookies) cookieHeader = rawCookies.split(', ').map(c => c.split(';')[0]).join('; ');

            const apiHeaders = { ...baseHeaders, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Origin': 'https://www.millersville.edu', 'Referer': 'https://www.millersville.edu/calendar/', 'Content-Type': 'application/json' };
            if (cookieHeader) apiHeaders['Cookie'] = cookieHeader;

            const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ getEvents: true, startDate: startDay, endDate: endDay }) });
            const rawText = await res.text();
            const data = JSON.parse(rawText);
            
            let sourceEvents = [];
            if (data.fields && Array.isArray(data.data)) {
                const fields = data.fields.split(',');
                const nameIdx = fields.indexOf('ActivityName');
                const startIdx = fields.indexOf('StartDateTime');
                const bldgIdx = fields.indexOf('BuildingCode');
                const roomIdx = fields.indexOf('RoomName');
                const descIdx = fields.indexOf('EventMeetingByActivityId.Event.Description'); 
                const linkIdx = fields.findIndex(f => f.toLowerCase().includes('url') || f.toLowerCase().includes('link'));

                sourceEvents = data.data.map(row => {
                    const eventTitle = row[nameIdx] || "Campus Event";
                    const eventLoc = `${row[bldgIdx] || ''} ${row[roomIdx] || ''}`.trim() || "Campus";
                    const pricing = extractPricing(row[descIdx] || "", eventTitle, eventLoc, linkIdx !== -1 ? (row[linkIdx] || "") : "");
                    return { title: eventTitle, date: row[startIdx], location: eventLoc, price: pricing.price, ticketLink: pricing.link };
                });
            }
            
            sourceEvents.forEach(item => events.push({
                title: item.title, date: item.date, location: item.location, category: "MU", price: item.price || "Free", ticketLink: item.ticketLink || ""
            }));
            console.log(`✅ MU Main Calendar: ${sourceEvents.length} items`);
        } catch (apiError1) {}

        // --- ATTEMPT 2: GetInvolved (Anthology API) ---
        try {
            const giUrl = `https://getinvolved.millersville.edu/api/discovery/event/search?endsAfter=${startDay}T00:00:00-04:00&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=100`;
            const giRes = await fetch(giUrl, { headers: baseHeaders });
            const giData = await giRes.json();
            
            const giEvents = giData.value || [];
            let giCount = 0;

            for (const item of giEvents) {
                const eventDate = new Date(item.startsOn);
                if (eventDate >= today && eventDate < thirtyDaysOut) {
                    let cat = "Student Org";
                    const categories = (item.categoryNames || []).map(c => c.toLowerCase());
                    const theme = (item.theme || "").toLowerCase();
                    const name = (item.name || "").toLowerCase();

                    if (categories.some(c => c.includes('club sport')) || name.includes('club rugby') || name.includes('club soccer')) cat = "Club Sports";
                    else if (categories.some(c => c.includes('fundrais')) || theme.includes('fundraising')) cat = "Fundraisers";
                    else if (item.theme) cat = `Org: ${item.theme}`;

                    events.push({
                        title: item.name || "Student Event",
                        date: eventDate.toISOString(),
                        location: item.location || "Campus",
                        category: cat,
                        price: "Free", 
                        ticketLink: `https://getinvolved.millersville.edu/event/${item.id}`
                    });
                    giCount++;
                }
            }
            console.log(`✅ GetInvolved: ${giCount} items`);
        } catch (giError) { console.error("❌ GetInvolved Error:", giError.message); }

        // --- ATTEMPT 3: Penn Manor iCal ---
        try {
            const pmRes = await fetch('https://www.pennmanor.net/?post_type=tribe_events&ical=1&eventDisplay=list', { headers: baseHeaders });
            const pmIcs = await pmRes.text();
            const vEvents = pmIcs.split('BEGIN:VEVENT');
            vEvents.shift(); 
            let pmCount = 0;

            for (const block of vEvents) {
                const summaryMatch = block.match(/SUMMARY:(.*)/);
                const dtstartMatch = block.match(/DTSTART.*?:([0-9T]+Z?)/);
                const locationMatch = block.match(/LOCATION:(.*)/);
                
                if (summaryMatch && dtstartMatch) {
                    let title = summaryMatch[1].trim().replace(/\\,/g, ',').replace(/\\;/g, ';');
                    let lowerTitle = title.toLowerCase();
                    
                    if (lowerTitle.includes('cycle day') || lowerTitle.startsWith('start of') || lowerTitle.startsWith('end of')) continue;
                    
                    let dtStr = dtstartMatch[1].trim();
                    let isoDate = "";
                    if (dtStr.length >= 8) {
                        const y = dtStr.substring(0,4);
                        const m = dtStr.substring(4,6);
                        const d = dtStr.substring(6,8);
                        let h = "00", min = "00", s = "00";
                        if (dtStr.includes('T') && dtStr.length >= 15) {
                            h = dtStr.substring(9,11);
                            min = dtStr.substring(11,13);
                            s = dtStr.substring(13,15);
                        }
                        isoDate = `${y}-${m}-${d}T${h}:${min}:${s}`;
                    }
                    
                    const eventDate = new Date(isoDate);
                    if (eventDate >= today && eventDate < thirtyDaysOut) {
                        events.push({
                            title: title,
                            date: eventDate.toISOString(),
                            location: locationMatch ? locationMatch[1].trim().replace(/\\,/g, ',') : "Penn Manor School District",
                            category: "Penn Manor", 
                            price: "Free", 
                            ticketLink: "" 
                        });
                        pmCount++;
                    }
                }
            }
            console.log(`✅ Penn Manor: ${pmCount} items`);
        } catch (pmError) { console.error("❌ Penn Manor Error:", pmError.message); }

        // --- ATTEMPT 4: Phantom Power (Eventbrite JSON-LD) ---
        try {
            const ebUrl = 'https://www.eventbrite.com/o/phantom-power-29187724817';
            const ebRes = await fetch(ebUrl, { headers: baseHeaders });
            const ebText = await ebRes.text();
            
            const ldMatches = ebText.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
            if (ldMatches) {
                let initialCount = events.length;
                ldMatches.forEach(block => {
                    try {
                        const jsonStr = block.replace(/<script type="application\/ld\+json">|<\/script>/gi, '');
                        extractEventbriteEvents(JSON.parse(jsonStr), events, today, thirtyDaysOut);
                    } catch(e) {}
                });
                console.log(`✅ Phantom Power: ${events.length - initialCount} items`);
            }
        } catch (ebError) { console.error("❌ Phantom Power Error:", ebError.message); }

        fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(events, null, 2));
        console.log(`✅ Total Events Written (${events.length} items combined)`);
    } catch (e) { console.error("❌ Events Request Error:", e.message); }

    // 3. NEWS
    try {
        let news = [];
        try {
            const res = await fetch('https://blogs.millersville.edu/news/feed/', { headers: baseHeaders });
            const xml = await res.text();
            const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
            
            for (let i = 0; i < Math.min(4, items.length); i++) {
                const titleMatch = items[i].match(/<title>([\s\S]*?)<\/title>/i);
                const linkMatch = items[i].match(/<link>([\s\S]*?)<\/link>/i);
                const dateMatch = items[i].match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
                if (titleMatch && linkMatch) {
                    news.push({ category: "MU", source: "Millersville News", title: titleMatch[1].replace("<![CDATA[", "").replace("]]>", "").trim(), link: linkMatch[1].trim(), date: dateMatch ? new Date(dateMatch[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : "" });
                }
            }
        } catch (e) {}

        news.push(
            { category: "Borough", source: "Millersville Borough", title: "2026 Residential Parking Permits Now Available", link: "https://millersvilleborough.org/", date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) },
            { category: "Borough", source: "Millersville Police", title: "Road Closure Notice - Construction Updates", link: "https://millersvilleborough.org/", date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
        );

        fs.writeFileSync(path.join(__dirname, '../news.json'), JSON.stringify(news, null, 2));
    } catch (e) {}

    // 4. DINING SPECIALS
    try {
        const specials = [
            { restaurant: "House of Pizza", day: "Monday", deal: "2 Slices & Medium Drink - $4.50" },
            { restaurant: "House of Pizza", day: "Tuesday", deal: "Large Cheese Pizza & 2-Liter - $15.99" },
            { restaurant: "Two Cousins", day: "Wednesday", deal: "$2 Off Any Large Stromboli" }
        ];
        fs.writeFileSync(path.join(__dirname, '../specials.json'), JSON.stringify(specials, null, 2));
    } catch (e) {}

    console.log("✅ All Data Compilations Complete.");
}

runScraper();