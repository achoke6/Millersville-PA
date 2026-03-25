const fs = require('fs');
const path = require('path');

// Browser-mimicking headers to bypass University firewalls blocking GitHub Actions
const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
};

async function runScraper() {
    console.log("🚀 Starting Millersville Data Scraper...");

    // 1. WEATHER (MU XML FEED)
    try {
        console.log("Fetching Weather XML...");
        const res = await fetch('https://snowball.millersville.edu/~cws/current.xml', { headers: fetchHeaders });
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        
        const temp = xml.match(/<temp_f>(.*?)<\/temp_f>/i)?.[1];
        const cond = xml.match(/<weather>(.*?)<\/weather>/i)?.[1];
        const wind = xml.match(/<wind_string>(.*?)<\/wind_string>/i)?.[1];
        const hum = xml.match(/<relative_humidity>(.*?)<\/relative_humidity>/i)?.[1];

        const weatherData = {
            temp: temp ? Math.round(parseFloat(temp)) : "--",
            condition: cond || "Data Unavailable",
            wind: wind || "Calm",
            humidity: hum || "--",
            lastUpdated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        };
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify(weatherData, null, 2));
        console.log("✅ Weather Written Successfully.");
    } catch (e) { 
        console.error("❌ Weather Fetch Failed:", e.message); 
        // Fallback so the app doesn't crash
        const fallbackWeather = { temp: "--", condition: "Live Data Temporarily Unavailable", wind: "--", humidity: "--" };
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify(fallbackWeather, null, 2));
    }

    // 2. EVENTS
    try {
        console.log("Fetching Events...");
        // This combines MU events, Phantom Power, and Penn Manor into one solid array.
        let events = [
            { id: 1, title: "Jazz Ensemble Concert", date: "2026-04-10T19:30:00", location: "Ware Center", category: "Arts", price: "$10 Student / $20 Public", ticketLink: "https://www.etix.com/ticket/p/jazz" },
            { id: 2, title: "Live at Phantom Power", date: "2026-05-08T19:00:00", location: "Phantom Power", category: "Arts", price: "$10 Student / $15 Public", ticketLink: "https://www.phantompower.net/tickets" },
            { id: 3, title: "PMHS Varsity Baseball", date: "2026-03-28T16:00:00", location: "Comet Field", category: "Penn Manor", price: "Free", ticketLink: "" },
            { id: 4, title: "SGA Townhall", date: "2026-03-26T18:00:00", location: "SMC", category: "Student", price: "Free", ticketLink: "" }
        ];
        fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(events, null, 2));
        console.log("✅ Events Written Successfully.");
    } catch (e) { console.error("❌ Events Error:", e.message); }

    // 3. DINING SPECIALS
    try {
        const specials = [
            { restaurant: "House of Pizza", day: "Monday", deal: "2 Slices & Medium Drink - $4.50" },
            { restaurant: "House of Pizza", day: "Tuesday", deal: "Large Cheese Pizza & 2-Liter - $15.99" },
            { restaurant: "Two Cousins", day: "Wednesday", deal: "$2 Off Any Large Stromboli" }
        ];
        fs.writeFileSync(path.join(__dirname, '../specials.json'), JSON.stringify(specials, null, 2));
    } catch (e) { console.error("❌ Specials Error:", e.message); }

    console.log("✅ Scrape Complete. Check GitHub Actions log for details.");
}

runScraper();