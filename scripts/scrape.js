const fs = require('fs');
const path = require('path');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

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
        'mccomsey', 'anttonen', 'millersville', 'comet', 'penn manor', 'pmhs'
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
                let eventPrice = "Ticket Required";
                if (ldData.name.toLowerCase().includes('slick rick')) eventPrice = "$35 ADV";

                eventsArray.push({
                    title: ldData.name, date: eventDate.toISOString(), location: "Phantom Power", tags: ["Other", "Live Music"], price: eventPrice, ticketLink: ldData.url || "https://www.eventbrite.com/o/phantom-power-29187724817", sourceLink: ldData.url || "https://www.phantompower.net/"
                });
            }
        } else {
            for (let key in ldData) if (typeof ldData[key] === 'object') extractEventbriteEvents(ldData[key], eventsArray, now, futureLimit);
        }
    }
}

async function runScraper() {
    console.log("🚀 Starting Millersville Pro Scraper (60-Day Horizon)...");

    try {
        const res = await fetch('https://snowball.millersville.edu/~cws/current.xml', { headers: baseHeaders });
        const xml = await res.text();
        const tempMatch = xml.match(/<(?:temp_f|temperature|temp)[^>]*>\s*([-\d.]+)/i);
        const condMatch = xml.match(/<(?:weather|condition|sky_condition)[^>]*>([^<]+)/i);
        const windMatch = xml.match(/<(?:wind_string|wind_mph|wind)[^>]*>([^<]+)/i);
        const humMatch = xml.match(/<(?:relative_humidity|humidity)[^>]*>\s*([-\d.]+)/i);
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify({
            temp: tempMatch ? Math.round(parseFloat(tempMatch[1])) : "--", condition: condMatch ? condMatch[1].trim() : "Data Unavailable", wind: windMatch ? windMatch[1].trim() : "Calm", humidity: humMatch ? humMatch[1].trim() + "%" : "--", lastUpdated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        }, null, 2));
    } catch (e) {}

    try {
        let events = [];
        const today = new Date();
        const startDay = today.toISOString().split('T')[0];
        const sixtyDaysOut = new Date(today);
        sixtyDaysOut.setDate(today.getDate() + 60);
        const endDay = sixtyDaysOut.toISOString().split('T')[0];

        // --- MU Primary API ---
        try {
            const pageRes = await fetch('https://www.millersville.edu/calendar/', { headers: baseHeaders });
            const rawCookies = pageRes.headers.get('set-cookie');
            let cookieHeader = rawCookies ? rawCookies.split(', ').map(c => c.split(';')[0]).join('; ') : '';

            const apiHeaders = { ...baseHeaders, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Origin': 'https://www.millersville.edu', 'Referer': 'https://www.millersville.edu/calendar/', 'Content-Type': 'application/json' };
            if (cookieHeader) apiHeaders['Cookie'] = cookieHeader;

            const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ getEvents: true, startDate: startDay, endDate: endDay }) });
            const data = JSON.parse(await res.text());
            
            if (data.fields && Array.isArray(data.data)) {
                const fields = data.fields.split(',');
                const nameIdx = fields.indexOf('ActivityName'), startIdx = fields.indexOf('StartDateTime'), bldgIdx = fields.indexOf('BuildingCode'), roomIdx = fields.indexOf('RoomName'), descIdx = fields.indexOf('EventMeetingByActivityId.Event.Description'), linkIdx = fields.findIndex(f => f.toLowerCase().includes('url') || f.toLowerCase().includes('link')), idIdx = fields.indexOf('ActivityId'), typeIdx = fields.indexOf('MeetingType:EventMeetingByActivityId.EventMeetingType.Name'), customerIdx = fields.indexOf('Customer:EventMeetingByActivityId.Event.Customer.Name');

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
                            if (lowerTitle.includes("men's") || lowerTitle.includes("mens") || lowerTitle.includes(" men ")) tags.push("Men's");
                            if (lowerTitle.includes("women's") || lowerTitle.includes("womens") || lowerTitle.includes(" women ")) tags.push("Women's");
                            sportsList.forEach(s => { if (lowerTitle.includes(s.toLowerCase())) tags.push(s); });
                            
                            if (isHGameFacility(eventLoc, eventTitle)) tags.push("H Games");
                        }
                    }

                    if (customerIdx !== -1 && row[customerIdx]) tags.push(row[customerIdx].trim());

                    const eventId = idIdx !== -1 ? row[idIdx] : "";
                    const sourceLink = eventId ? `https://www.millersville.edu/calendar/events/${eventId}` : "https://www.millersville.edu/calendar/";

                    events.push({ title: eventTitle, date: row[startIdx], location: eventLoc, tags: [...new Set(tags)], price: pricing.price, ticketLink: pricing.link, sourceLink: sourceLink });
                });
            }
        } catch (apiError1) {}

        // --- Clubs/Orgs (Anthology API) ---
        try {
            const giUrl = `https://getinvolved.millersville.edu/api/discovery/event/search?endsAfter=${startDay}T00:00:00-04:00&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=200`;
            const giData = await (await fetch(giUrl, { headers: baseHeaders })).json();
            
            (giData.value || []).forEach(item => {
                const eventDate = new Date(item.startsOn);
                if (eventDate >= today && eventDate < sixtyDaysOut) {
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
                        
                        if (isHGameFacility(item.location, item.name)) tags.push("H Games");
                    }

                    events.push({ title: item.name || "Student Event", date: eventDate.toISOString(), location: item.location || "Campus", tags: [...new Set(tags)], price: "Free", ticketLink: `https://getinvolved.millersville.edu/event/${item.id}`, sourceLink: `https://getinvolved.millersville.edu/event/${item.id}` });
                }
            });
        } catch (giError) {}

        // --- Penn Manor iCal ---
        try {
            const pmIcs = await (await fetch('https://www.pennmanor.net/?post_type=tribe_events&ical=1&eventDisplay=list', { headers: baseHeaders })).text();
            const vEvents = pmIcs.split('BEGIN:VEVENT');
            vEvents.shift(); 

            for (const block of vEvents) {
                const summaryMatch = block.match(/SUMMARY:(.*)/);
                const dtstartMatch = block.match(/DTSTART.*?:([0-9T]+Z?)/);
                const locationMatch = block.match(/LOCATION:(.*)/);
                
                if (summaryMatch && dtstartMatch) {
                    let title = summaryMatch[1].trim().replace(/\\,/g, ',').replace(/\\;/g, ';');
                    let lowerTitle = title.toLowerCase();
                    if (lowerTitle.includes('cycle day') || lowerTitle.startsWith('start of') || lowerTitle.startsWith('end of')) continue;
                    
                    let dtStr = dtstartMatch[1].trim(), isoDate = "";
                    if (dtStr.length >= 8) {
                        const y = dtStr.substring(0,4), m = dtStr.substring(4,6), d = dtStr.substring(6,8);
                        let h = "00", min = "00", s = "00";
                        if (dtStr.includes('T') && dtStr.length >= 15) { h = dtStr.substring(9,11); min = dtStr.substring(11,13); s = dtStr.substring(13,15); }
                        isoDate = `${y}-${m}-${d}T${h}:${min}:${s}`;
                    }
                    
                    const eventDate = new Date(isoDate);
                    if (eventDate >= today && eventDate < sixtyDaysOut) {
                        let tags = ["PM"]; 
                        
                        if (lowerTitle.includes('board')) tags.push('Board Meetings');
                        if (lowerTitle.includes('pto')) tags.push('PTO');
                        if (lowerTitle.includes('staff') || lowerTitle.includes('in-service') || lowerTitle.includes('act 80') || lowerTitle.includes('faculty')) tags.push('Staff');
                        if (lowerTitle.includes('concert') || lowerTitle.includes('band') || lowerTitle.includes('chorus') || lowerTitle.includes('choir') || lowerTitle.includes('orchestra') || lowerTitle.includes('musical') || lowerTitle.includes('theater') || lowerTitle.includes('play')) tags.push('Music/Arts');

                        if (lowerTitle.includes('varsity')) tags.push('Varsity');
                        if (lowerTitle.includes('jv') || lowerTitle.includes('j.v.')) tags.push('JV');
                        if (lowerTitle.includes('junior high') || lowerTitle.includes('jr high')) tags.push('Jr High');
                        
                        let isAthletic = false;
                        sportsList.forEach(s => { 
                            if (lowerTitle.includes(s.toLowerCase())) { 
                                tags.push(s); 
                                isAthletic = true; 
                                tags.push('Athletics'); 
                            } 
                        });

                        if (isAthletic) {
                            if (lowerTitle.includes("men's") || lowerTitle.includes("mens") || lowerTitle.includes("boys")) tags.push("Boys");
                            if (lowerTitle.includes("women's") || lowerTitle.includes("womens") || lowerTitle.includes("girls")) tags.push("Girls");
                            if (isHGameFacility(locationMatch ? locationMatch[1] : "", title)) tags.push("H Games");
                        }

                        events.push({ title: title, date: eventDate.toISOString(), location: locationMatch ? locationMatch[1].trim().replace(/\\,/g, ',') : "Penn Manor School District", tags: [...new Set(tags)], price: "Free", ticketLink: "", sourceLink: "https://www.pennmanor.net/calendar/" });
                    }
                }
            }
        } catch (pmError) {}

        // --- Other (Eventbrite) ---
        try {
            const ebText = await (await fetch('https://www.eventbrite.com/o/phantom-power-29187724817', { headers: baseHeaders })).text();
            const ldMatches = ebText.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
            if (ldMatches) {
                ldMatches.forEach(block => {
                    try { extractEventbriteEvents(JSON.parse(block.replace(/<script type="application\/ld\+json">|<\/script>/gi, '')), events, today, sixtyDaysOut); } catch(e) {}
                });
            }
        } catch (ebError) {}

        fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(events, null, 2));
    } catch (e) {}

    // 3. NEWS & 4. DINING (Unchanged)
    try {
        let news = [];
        try {
            const xml = await (await fetch('https://blogs.millersville.edu/news/feed/', { headers: baseHeaders })).text();
            const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
            for (let i = 0; i < Math.min(4, items.length); i++) {
                const titleMatch = items[i].match(/<title>([\s\S]*?)<\/title>/i), linkMatch = items[i].match(/<link>([\s\S]*?)<\/link>/i), dateMatch = items[i].match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
                if (titleMatch && linkMatch) news.push({ category: "MU", source: "Millersville News", title: titleMatch[1].replace("<![CDATA[", "").replace("]]>", "").trim(), link: linkMatch[1].trim(), date: dateMatch ? new Date(dateMatch[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : "" });
            }
        } catch (e) {}
        news.push({ category: "Borough", source: "Millersville Borough", title: "2026 Residential Parking Permits Now Available", link: "https://millersvilleborough.org/", date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }, { category: "Borough", source: "Millersville Police", title: "Road Closure Notice - Construction Updates", link: "https://millersvilleborough.org/", date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) });
        fs.writeFileSync(path.join(__dirname, '../news.json'), JSON.stringify(news, null, 2));
        
        fs.writeFileSync(path.join(__dirname, '../specials.json'), JSON.stringify([
            { restaurant: "House of Pizza", day: "Monday", deal: "2 Slices & Medium Drink - $4.50" },
            { restaurant: "House of Pizza", day: "Tuesday", deal: "Large Cheese Pizza & 2-Liter - $15.99" },
            { restaurant: "Two Cousins", day: "Wednesday", deal: "$2 Off Any Large Stromboli" }
        ], null, 2));
    } catch (e) {}
    console.log("✅ All Data Compilations Complete.");
}

runScraper();