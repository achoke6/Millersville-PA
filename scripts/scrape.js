const fs = require('fs');
const path = require('path');
const dns = require('dns');

// Force IPv4 to bypass strict university firewalls
dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Standard browser header
const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// --- NEW: Smart Pricing Extractor ---
function extractPricing(desc) {
    if (!desc) return { price: "Free", link: "" };
    
    let price = "Free";
    let link = "";
    
    // 1. Find Ticket Links in the description
    const linkMatch = desc.match(/(https?:\/\/[^\s"'<]+)/gi);
    if (linkMatch) {
        const ticketLink = linkMatch.find(l => l.toLowerCase().includes('ticket') || l.toLowerCase().includes('etix'));
        if (ticketLink) link = ticketLink;
    }
    
    // 2. Fallback default MU ticket links if mentioned in text
    if (!link && desc.toLowerCase().includes('muticketsonline.com')) link = "https://muticketsonline.com/";
    if (!link && desc.toLowerCase().includes('universitytickets.com')) link = "https://millersville.universitytickets.com/";

    // 3. Find Prices (e.g., "$5", "$10.00", "$5 Student", "$10 Public")
    const priceRegex = /\$\d+(?:\.\d{2})?(?:\s+(?:student|public|general|admission|door|advance|mu|adult|child)s?)?/gi;
    const prices = desc.match(priceRegex);
    
    if (prices) {
        // Deduplicate and combine (e.g., "$5 Student / $10 Public")
        price = [...new Set(prices)].join(' / ');
    } else if (desc.toLowerCase().includes('ticket')) {
        price = "Ticket Required"; 
    }
    
    return { price, link };
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

    // 2. EVENTS
    try {
        console.log("Fetching Events...");
        let sourceEvents = [];
        
        try {
            const pageRes = await fetch('https://www.millersville.edu/calendar/', { headers: baseHeaders });
            const rawCookies = pageRes.headers.get('set-cookie');
            let cookieHeader = '';
            if (rawCookies) cookieHeader = rawCookies.split(', ').map(c => c.split(';')[0]).join('; ');

            const today = new Date();
            const startDay = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
            const endDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];

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

            const rawText = await res.text();
            if (rawText.trim() === "") throw new Error("Blank Response");
            
            const data = JSON.parse(rawText);
            
            if (data.fields && Array.isArray(data.data)) {
                const fields = data.fields.split(',');
                const nameIdx = fields.indexOf('ActivityName');
                const startIdx = fields.indexOf('StartDateTime');
                const bldgIdx = fields.indexOf('BuildingCode');
                const roomIdx = fields.indexOf('RoomName');
                const descIdx = fields.indexOf('EventMeetingByActivityId.Event.Description'); // The magic description field

                sourceEvents = data.data.map(row => {
                    const descText = row[descIdx] || "";
                    const pricing = extractPricing(descText);
                    return { 
                        title: row[nameIdx], 
                        date: row[startIdx], 
                        location: `${row[bldgIdx] || ''} ${row[roomIdx] || ''}`.trim() || "Campus",
                        price: pricing.price,
                        ticketLink: pricing.link
                    };
                });
            } else {
                const items = Array.isArray(data) ? data : (data.events || data.data || []);
                sourceEvents = items.map(item => {
                    const pricing = extractPricing(item.description || "");
                    return {
                        title: item.title || item.name || item.ActivityName,
                        date: item.start || item.date || item.StartDateTime,
                        location: item.location || item.BuildingCode,
                        price: pricing.price !== "Free" ? pricing.price : (item.cost || item.price || "Free"),
                        ticketLink: pricing.link || item.url || item.link || ""
                    };
                });
            }
            if (sourceEvents.length === 0) throw new Error("Zero events returned");
        } catch (apiError1) {
            try {
                const res2 = await fetch('https://map.millersville.edu/api/public/events', { headers: { 'User-Agent': baseHeaders['User-Agent'] } });
                const data2 = await res2.json();
                sourceEvents = Array.isArray(data2) ? data2 : (data2.events || []);
            } catch (apiError2) {}
        }

        let events = sourceEvents.map(item => ({
            title: item.title || "Campus Event",
            date: item.date || new Date().toISOString(),
            location: item.location || "Millersville University",
            category: "MU", 
            price: item.price || "Free",
            ticketLink: item.ticketLink || ""
        }));

        // Penn Manor LIVE iCal Feed
        try {
            const pmRes = await fetch('https://www.pennmanor.net/?post_type=tribe_events&ical=1&eventDisplay=list', { headers: baseHeaders });
            const pmIcs = await pmRes.text();
            const vEvents = pmIcs.split('BEGIN:VEVENT');
            vEvents.shift(); 
            const now = new Date();

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
                    if (eventDate >= now && eventDate < new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000)) {
                        events.push({
                            title: title,
                            date: eventDate.toISOString(),
                            location: locationMatch ? locationMatch[1].trim().replace(/\\,/g, ',') : "Penn Manor School District",
                            category: "Penn Manor", 
                            price: "Check Website",
                            ticketLink: "https://www.pennmanor.net/calendar/"
                        });
                    }
                }
            }
        } catch (pmError) { console.error("❌ Penn Manor Error:", pmError.message); }

        events.push(
            { title: "Live at Phantom Power", date: "2026-05-08T19:00:00", location: "Phantom Power", category: "Other", price: "$10 Student / $15 Public", ticketLink: "https://www.phantompower.net/tickets" }
        );

        fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(events, null, 2));
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