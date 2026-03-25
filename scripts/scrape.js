const fs = require('fs');
const path = require('path');
const dns = require('dns');

// Force IPv4 to bypass strict university firewalls that drop IPv6 packets
dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

async function runScraper() {
    console.log("🚀 Starting Millersville Pro Scraper...");

    // 1. WEATHER (Ultra-Broad XML Parser)
    try {
        console.log("Fetching Weather XML...");
        const res = await fetch('https://snowball.millersville.edu/~cws/current.xml', { headers: fetchHeaders });
        const xml = await res.text();
        
        // Fuzzy matchers: Looks for <temp_f>, <temp>, or <temperature> anywhere in the file
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
        console.log(`✅ Weather Written (Temp: ${weatherData.temp}°F)`);
    } catch (e) { 
        console.error("❌ Weather Error:", e.message);
        const fallback = { temp: "--", condition: "Live Data Temporarily Unavailable", wind: "--", humidity: "--" };
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify(fallback, null, 2));
    }

    // 2. EVENTS (The POST Payload Fix)
    try {
        console.log("Fetching Events API via POST payload...");
        
        // Automatically calculate the first and last day of the current month
        const today = new Date();
        const startDay = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
        const endDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];

        // Send the exact payload you discovered as a URL-Encoded Form POST
        const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', { 
            method: 'POST',
            headers: {
                ...fetchHeaders,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                getEvents: 'true',
                startDate: startDay,
                endDate: endDay
            })
        });

        const rawText = await res.text();
        let events = [];
        
        try {
            const data = JSON.parse(rawText);
            const sourceEvents = Array.isArray(data) ? data : (data.events || []);
            
            // Map all university events explicitly to the "MU" category
            events = sourceEvents.map(item => ({
                title: item.title || item.name || "Campus Event",
                date: item.start || item.date || new Date().toISOString(),
                location: item.location || "Millersville University",
                category: "MU", 
                price: item.cost || item.price || "Free",
                ticketLink: item.url || item.link || ""
            }));
        } catch (parseError) {
            console.error("⚠️ MU API Payload failed parsing. Check payload format.");
        }

        // Add Phantom Power and Penn Manor under category "Other"
        events.push(
            { title: "Live at Phantom Power", date: "2026-05-08T19:00:00", location: "Phantom Power", category: "Other", price: "$10 Student / $15 Public", ticketLink: "https://www.phantompower.net/tickets" },
            { title: "PMHS Varsity Baseball", date: "2026-03-28T16:00:00", location: "Comet Field", category: "Other", price: "Free", ticketLink: "" }
        );

        fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(events, null, 2));
        console.log(`✅ Events Written (${events.length} items)`);
    } catch (e) { console.error("❌ Events Request Error:", e.message); }

    // 3. NEWS (RSS + Borough)
    try {
        console.log("Fetching News RSS...");
        let news = [];
        
        // MU RSS Feed
        try {
            const res = await fetch('https://blogs.millersville.edu/news/feed/', { headers: fetchHeaders });
            const xml = await res.text();
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
        } catch (e) { console.error("MU News Error:", e.message); }

        // Mocking Authentic Borough News so the new Category buttons have data to sort
        news.push(
            { category: "Borough", source: "Millersville Borough", title: "2026 Residential Parking Permits Now Available", link: "https://millersvilleborough.org/", date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) },
            { category: "Borough", source: "Millersville Police", title: "Road Closure Notice - Construction Updates", link: "https://millersvilleborough.org/", date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
        );

        fs.writeFileSync(path.join(__dirname, '../news.json'), JSON.stringify(news, null, 2));
        console.log("✅ News Written Successfully.");
    } catch (e) { console.error("❌ News Error:", e.message); }

    // 4. DINING SPECIALS
    try {
        const specials = [
            { restaurant: "House of Pizza", day: "Monday", deal: "2 Slices & Medium Drink - $4.50" },
            { restaurant: "House of Pizza", day: "Tuesday", deal: "Large Cheese Pizza & 2-Liter - $15.99" },
            { restaurant: "Two Cousins", day: "Wednesday", deal: "$2 Off Any Large Stromboli" }
        ];
        fs.writeFileSync(path.join(__dirname, '../specials.json'), JSON.stringify(specials, null, 2));
    } catch (e) { console.error("❌ Specials Error:", e.message); }

    console.log("✅ All Data Compilations Complete.");
}

runScraper();