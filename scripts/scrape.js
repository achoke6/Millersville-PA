const fs = require('fs');
const path = require('path');

// Headers to help bypass firewalls
const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

async function runScraper() {
    console.log("🚀 Starting Millersville Pro Scraper...");

    // 1. WEATHER (MU XML FEED)
    try {
        console.log("Fetching Weather XML...");
        const res = await fetch('https://snowball.millersville.edu/~cws/current.xml', { headers: fetchHeaders });
        const xml = await res.text();
        
        // Forgiving regex to capture the exact details from the XML tags
        const tempMatch = xml.match(/<temp_f>([\s\S]*?)<\/temp_f>/i);
        const condMatch = xml.match(/<weather>([\s\S]*?)<\/weather>/i);
        const windMatch = xml.match(/<wind_string>([\s\S]*?)<\/wind_string>/i);
        const humMatch = xml.match(/<relative_humidity>([\s\S]*?)<\/relative_humidity>/i);

        const weatherData = {
            temp: tempMatch ? Math.round(parseFloat(tempMatch[1].trim())) : "--",
            condition: condMatch ? condMatch[1].trim() : "Data Unavailable",
            wind: windMatch ? windMatch[1].trim() : "Calm",
            humidity: humMatch ? humMatch[1].trim() + "%" : "--",
            lastUpdated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        };
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify(weatherData, null, 2));
    } catch (e) { 
        console.error("❌ Weather Error:", e.message);
        const fallback = { temp: "--", condition: "Live Data Temporarily Unavailable", wind: "--", humidity: "--" };
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify(fallback, null, 2));
    }

    // 2. EVENTS (The Correct MU API + Phantom Power)
    try {
        console.log("Fetching Events API...");
        // Using the exact API URL you provided
        const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', { headers: fetchHeaders });
        const data = await res.json();
        
        // Handle the API structure safely
        const sourceEvents = Array.isArray(data) ? data : (data.events || []);
        
        let events = sourceEvents.map(item => ({
            title: item.title || item.name || "Campus Event",
            date: item.start || item.date || new Date().toISOString(),
            location: item.location || "Millersville University",
            category: item.category || item.type || "Campus",
            price: item.cost || item.price || "Free",
            ticketLink: item.url || item.link || ""
        }));

        // Inject Phantom Power and Penn Manor
        events.push(
            { title: "Live at Phantom Power", date: "2026-05-08T19:00:00", location: "Phantom Power", category: "Arts", price: "$10 Student / $15 Public", ticketLink: "https://www.phantompower.net/tickets" },
            { title: "PMHS Varsity Baseball", date: "2026-03-28T16:00:00", location: "Comet Field", category: "Penn Manor", price: "Free", ticketLink: "" }
        );

        fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(events, null, 2));
    } catch (e) { console.error("❌ Events Error:", e.message); }

    // 3. NEWS (Restored MU RSS Fetcher)
    try {
        console.log("Fetching News RSS...");
        const res = await fetch('https://blogs.millersville.edu/news/feed/', { headers: fetchHeaders });
        const xml = await res.text();
        
        const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        let news = [];
        
        for (let i = 0; i < Math.min(5, items.length); i++) {
            const titleMatch = items[i].match(/<title>([\s\S]*?)<\/title>/i);
            const linkMatch = items[i].match(/<link>([\s\S]*?)<\/link>/i);
            const dateMatch = items[i].match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
            
            if (titleMatch && linkMatch) {
                news.push({
                    source: "Millersville News",
                    title: titleMatch[1].replace("<![CDATA[", "").replace("]]>", "").trim(),
                    link: linkMatch[1].trim(),
                    date: dateMatch ? new Date(dateMatch[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ""
                });
            }
        }
        fs.writeFileSync(path.join(__dirname, '../news.json'), JSON.stringify(news, null, 2));
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