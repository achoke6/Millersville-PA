const fs = require('fs');
const path = require('path');
const dns = require('dns');
const ical = require('node-ical');

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

// DIAGNOSTIC: Log everything
const diagnosticLog = {
    startTime: new Date().toISOString(),
    dateRange: {},
    sources: {},
    errors: [],
    warnings: [],
    eventCounts: { mu: 0, clubs: 0, pm: 0, other: 0 },
    totalEvents: 0,
    duplicates: 0,
    invalidEvents: 0
};

function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(logMessage);
    
    if (level === 'ERROR') diagnosticLog.errors.push(logMessage);
    if (level === 'WARN') diagnosticLog.warnings.push(logMessage);
}

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

function validateEvent(event, source) {
    if (!event.title || !event.date) {
        log(`Invalid event from ${source}: Missing title or date`, 'WARN');
        diagnosticLog.invalidEvents++;
        return false;
    }
    
    const eventDate = new Date(event.date);
    if (isNaN(eventDate.getTime())) {
        log(`Invalid event from ${source}: Invalid date format "${event.date}"`, 'WARN');
        diagnosticLog.invalidEvents++;
        return false;
    }
    
    return true;
}

async function runScraper() {
    log("🚀 Starting Millersville DIAGNOSTIC Scraper (60-Day Horizon)");

    // WEATHER
    try {
        log("Fetching weather data...");
        const res = await fetch('https://snowball.millersville.edu/~cws/current.xml', { headers: baseHeaders });
        if (!res.ok) throw new Error(`Weather API returned ${res.status}`);
        
        const xml = await res.text();
        log(`Weather XML length: ${xml.length} characters`);
        
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
        log(`✅ Weather data saved: ${weatherData.temp}°F, ${weatherData.condition}`);
        diagnosticLog.sources.weather = { status: 'success', data: weatherData };
    } catch (e) {
        log(`❌ Weather fetch failed: ${e.message}`, 'ERROR');
        diagnosticLog.sources.weather = { status: 'failed', error: e.message };
    }

    // EVENTS
    try {
        let events = [];
        const today = new Date();
        const startDay = today.toISOString().split('T')[0];
        const sixtyDaysOut = new Date(today);
        sixtyDaysOut.setDate(today.getDate() + 60);
        const endDay = sixtyDaysOut.toISOString().split('T')[0];

        diagnosticLog.dateRange = { start: startDay, end: endDay, days: 60 };
        log(`📅 Date Range: ${startDay} to ${endDay}`);

        // --- MU PRIMARY API ---
        try {
            log("Fetching MU Calendar events...");
            const pageRes = await fetch('https://www.millersville.edu/calendar/', { headers: baseHeaders });
            if (!pageRes.ok) throw new Error(`MU page returned ${pageRes.status}`);
            
            const rawCookies = pageRes.headers.get('set-cookie');
            let cookieHeader = rawCookies ? rawCookies.split(', ').map(c => c.split(';')[0]).join('; ') : '';
            log(`MU cookies obtained: ${cookieHeader ? 'Yes' : 'No'}`);

            const apiHeaders = { ...baseHeaders, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Origin': 'https://www.millersville.edu', 'Referer': 'https://www.millersville.edu/calendar/', 'Content-Type': 'application/json' };
            if (cookieHeader) apiHeaders['Cookie'] = cookieHeader;

            const apiBody = JSON.stringify({ getEvents: true, startDate: startDay, endDate: endDay });
            log(`MU API request body: ${apiBody}`);

            const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', { method: 'POST', headers: apiHeaders, body: apiBody });
            if (!res.ok) throw new Error(`MU API returned ${res.status}`);
            
            const responseText = await res.text();
            log(`MU API response length: ${responseText.length} characters`);
            
            const data = JSON.parse(responseText);
            
            if (data.fields && Array.isArray(data.data)) {
                log(`MU API returned ${data.data.length} raw events`);
                const fields = data.fields.split(',');
                const nameIdx = fields.indexOf('ActivityName'), startIdx = fields.indexOf('StartDateTime'), bldgIdx = fields.indexOf('BuildingCode'), roomIdx = fields.indexOf('RoomName'), descIdx = fields.indexOf('EventMeetingByActivityId.Event.Description'), linkIdx = fields.findIndex(f => f.toLowerCase().includes('url') || f.toLowerCase().includes('link')), idIdx = fields.indexOf('ActivityId'), typeIdx = fields.indexOf('MeetingType:EventMeetingByActivityId.EventMeetingType.Name'), customerIdx = fields.indexOf('Customer:EventMeetingByActivityId.Event.Customer.Name');

                log(`MU field indices - Name:${nameIdx}, Start:${startIdx}, Type:${typeIdx}`);

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
                            
                            if (isHGameFacility(eventLoc, eventTitle)) tags.push("Home Game Mode");
                        }
                    }

                    if (customerIdx !== -1 && row[customerIdx]) tags.push(row[customerIdx].trim());

                    const eventId = idIdx !== -1 ? row[idIdx] : "";
                    const sourceLink = eventId ? `https://www.millersville.edu/calendar/events/${eventId}` : "https://www.millersville.edu/calendar/";

                    const event = { title: eventTitle, date: row[startIdx], location: eventLoc, tags: [...new Set(tags)], price: pricing.price, ticketLink: pricing.link, sourceLink: sourceLink };
                    
                    if (validateEvent(event, 'MU')) {
                        events.push(event);
                        diagnosticLog.eventCounts.mu++;
                    }
                });
                
                log(`✅ MU Events processed: ${diagnosticLog.eventCounts.mu}`);
                diagnosticLog.sources.mu = { status: 'success', count: diagnosticLog.eventCounts.mu };
            } else {
                throw new Error('MU API returned unexpected data structure');
            }
        } catch (apiError1) {
            log(`❌ MU API Error: ${apiError1.message}`, 'ERROR');
            diagnosticLog.sources.mu = { status: 'failed', error: apiError1.message };
        }

        // --- CLUBS/ORGS (ANTHOLOGY API) ---
        try {
            log("Fetching Clubs/Orgs events...");
            const giUrl = `https://getinvolved.millersville.edu/api/discovery/event/search?endsAfter=${startDay}T00:00:00-04:00&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=200`;
            log(`Clubs API URL: ${giUrl}`);
            
            const giRes = await fetch(giUrl, { headers: baseHeaders });
            if (!giRes.ok) throw new Error(`Clubs API returned ${giRes.status}`);
            
            const giData = await giRes.json();
            log(`Clubs API returned ${giData.value ? giData.value.length : 0} events`);
            
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
                        
                        if (isHGameFacility(item.location, item.name)) tags.push("Home Game Mode");
                    }

                    const isMainCategory = tags.includes('Residence Halls') || tags.includes('Greek Life') || tags.includes('Fundraising') || tags.includes('Club Sports');
                    if (!isMainCategory) {
                        tags.push('Other Org');
                    }

                    const event = { title: item.name || "Student Event", date: eventDate.toISOString(), location: item.location || "Campus", tags: [...new Set(tags)], price: "Free", ticketLink: `https://getinvolved.millersville.edu/event/${item.id}`, sourceLink: `https://getinvolved.millersville.edu/event/${item.id}` };
                    
                    if (validateEvent(event, 'Clubs/Orgs')) {
                        events.push(event);
                        diagnosticLog.eventCounts.clubs++;
                    }
                }
            });
            
            log(`✅ Clubs/Orgs Events processed: ${diagnosticLog.eventCounts.clubs}`);
            diagnosticLog.sources.clubs = { status: 'success', count: diagnosticLog.eventCounts.clubs };
        } catch (giError) {
            log(`❌ Clubs/Orgs API Error: ${giError.message}`, 'ERROR');
            diagnosticLog.sources.clubs = { status: 'failed', error: giError.message };
        }

        // --- PENN MANOR ICAL ---
        try {
            log("Fetching Penn Manor iCal events...");
            
            // TEST MULTIPLE URL FORMATS
            const pmUrlVariants = [
                `https://www.pennmanor.net/?post_type=tribe_events&ical=1&eventDisplay=list&start_date=${startDay}&end_date=${endDay}`,
                `https://www.pennmanor.net/?post_type=tribe_events&ical=1&eventDisplay=list`,
                `https://www.pennmanor.net/?post_type=tribe_events&ical=1`
            ];
            
            log(`Testing Penn Manor URL variants...`);
            let pmEventsData = null;
            let successfulUrl = null;
            
            for (const url of pmUrlVariants) {
                try {
                    log(`Trying: ${url}`);
                    pmEventsData = await ical.async.fromURL(url, { headers: baseHeaders });
                    successfulUrl = url;
                    log(`✅ Penn Manor iCal fetched successfully with this URL`);
                    break;
                } catch (urlError) {
                    log(`Failed with this URL: ${urlError.message}`, 'WARN');
                }
            }
            
            if (!pmEventsData) throw new Error('All Penn Manor URL variants failed');
            
            const allPMEvents = Object.values(pmEventsData).filter(e => e.type === 'VEVENT');
            log(`Penn Manor iCal contains ${allPMEvents.length} total VEVENT entries`);
            
            // Log date range of events in the feed
            const pmDates = allPMEvents.map(e => new Date(e.start)).filter(d => !isNaN(d.getTime())).sort((a, b) => a - b);
            if (pmDates.length > 0) {
                log(`Penn Manor feed date range: ${pmDates[0].toISOString().split('T')[0]} to ${pmDates[pmDates.length - 1].toISOString().split('T')[0]}`);
            }

            for (const event of allPMEvents) {
                const eventDate = new Date(event.start);
                
                if (eventDate >= today && eventDate < sixtyDaysOut) {
                    let title = event.summary || "Penn Manor Event";
                    let lowerTitle = title.toLowerCase();

                    if (lowerTitle.includes('cycle day') || lowerTitle.startsWith('start of') || lowerTitle.startsWith('end of')) continue;

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

                    const location = event.location || "Penn Manor School District";

                    if (isAthletic) {
                        if (lowerTitle.includes("men's") || lowerTitle.includes("mens") || lowerTitle.includes("boys")) tags.push("Boys");
                        if (lowerTitle.includes("women's") || lowerTitle.includes("womens") || lowerTitle.includes("girls")) tags.push("Girls");
                        if (isHGameFacility(location, title)) tags.push("Home Game Mode");
                    }

                    const pmEvent = { title: title, date: eventDate.toISOString(), location: location, tags: [...new Set(tags)], price: "Free", ticketLink: "", sourceLink: "https://www.pennmanor.net/calendar/" };
                    
                    if (validateEvent(pmEvent, 'Penn Manor')) {
                        events.push(pmEvent);
                        diagnosticLog.eventCounts.pm++;
                    }
                }
            }
            
            log(`✅ Penn Manor Events processed: ${diagnosticLog.eventCounts.pm} (from ${allPMEvents.length} total in feed)`);
            diagnosticLog.sources.pennManor = { 
                status: 'success', 
                count: diagnosticLog.eventCounts.pm,
                totalInFeed: allPMEvents.length,
                feedDateRange: pmDates.length > 0 ? {
                    earliest: pmDates[0].toISOString().split('T')[0],
                    latest: pmDates[pmDates.length - 1].toISOString().split('T')[0]
                } : null,
                successfulUrl: successfulUrl
            };
        } catch (pmError) {
            log(`❌ Penn Manor iCal Error: ${pmError.message}`, 'ERROR');
            diagnosticLog.sources.pennManor = { status: 'failed', error: pmError.message };
        }

        // --- OTHER (EVENTBRITE) ---
        try {
            log("Fetching Eventbrite events...");
            const ebText = await (await fetch('https://www.eventbrite.com/o/phantom-power-29187724817', { headers: baseHeaders })).text();
            log(`Eventbrite page length: ${ebText.length} characters`);
            
            const ldMatches = ebText.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
            log(`Found ${ldMatches ? ldMatches.length : 0} JSON-LD blocks`);
            
            if (ldMatches) {
                ldMatches.forEach(block => {
                    try { 
                        extractEventbriteEvents(JSON.parse(block.replace(/<script type="application\/ld\+json">|<\/script>/gi, '')), events, today, sixtyDaysOut); 
                    } catch(e) {
                        log(`Failed to parse JSON-LD block: ${e.message}`, 'WARN');
                    }
                });
            }
            
            diagnosticLog.eventCounts.other = events.filter(e => (e.tags || []).includes('Other')).length;
            log(`✅ Other Events processed: ${diagnosticLog.eventCounts.other}`);
            diagnosticLog.sources.eventbrite = { status: 'success', count: diagnosticLog.eventCounts.other };
        } catch (ebError) {
            log(`❌ Eventbrite Error: ${ebError.message}`, 'ERROR');
            diagnosticLog.sources.eventbrite = { status: 'failed', error: ebError.message };
        }

        // CHECK FOR DUPLICATES
        const eventKeys = new Set();
        const deduped = events.filter(e => {
            const key = `${e.title}-${e.date}-${e.location}`;
            if (eventKeys.has(key)) {
                diagnosticLog.duplicates++;
                return false;
            }
            eventKeys.add(key);
            return true;
        });
        
        if (diagnosticLog.duplicates > 0) {
            log(`⚠️ Removed ${diagnosticLog.duplicates} duplicate events`, 'WARN');
        }

        diagnosticLog.totalEvents = deduped.length;
        log(`📊 TOTAL EVENTS SCRAPED: ${diagnosticLog.totalEvents}`);
        log(`   - MU: ${diagnosticLog.eventCounts.mu}`);
        log(`   - Clubs/Orgs: ${diagnosticLog.eventCounts.clubs}`);
        log(`   - Penn Manor: ${diagnosticLog.eventCounts.pm}`);
        log(`   - Other: ${diagnosticLog.eventCounts.other}`);

        fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(deduped, null, 2));
        log(`✅ Events saved to events.json`);
    } catch (e) {
        log(`❌ CRITICAL ERROR in events scraping: ${e.message}`, 'ERROR');
    }

    // NEWS
    try {
        log("Fetching news...");
        let news = [];
        try {
            const xml = await (await fetch('https://blogs.millersville.edu/news/feed/', { headers: baseHeaders })).text();
            log(`MU News RSS length: ${xml.length} characters`);
            
            const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
            log(`Found ${items.length} news items`);
            
            for (let i = 0; i < Math.min(4, items.length); i++) {
                const titleMatch = items[i].match(/<title>([\s\S]*?)<\/title>/i), linkMatch = items[i].match(/<link>([\s\S]*?)<\/link>/i), dateMatch = items[i].match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
                if (titleMatch && linkMatch) news.push({ category: "MU", source: "Millersville News", title
