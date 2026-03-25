const fs = require('fs');
const path = require('path');

async function runScraper() {
    console.log("🚀 Starting Millersville Pro Data Scraper...");

    // 1. WEATHER (MU XML FEED)
    try {
        const res = await fetch('https://snowball.millersville.edu/~cws/current.xml', {
            headers: { 'User-Agent': 'MillersvilleCommunityApp/1.0' }
        });
        const xml = await res.text();
        const temp = xml.match(/<temp_f>(.*?)<\/temp_f>/)?.[1] || "--";
        const cond = xml.match(/<weather>(.*?)<\/weather>/)?.[1] || "Clear";
        const wind = xml.match(/<wind_string>(.*?)<\/wind_string>/)?.[1] || "Calm";
        const hum = xml.match(/<relative_humidity>(.*?)<\/relative_humidity>/)?.[1] || "--";

        const weatherData = {
            temp: Math.round(temp),
            condition: cond,
            wind: wind,
            humidity: hum,
            lastUpdated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        };
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify(weatherData, null, 2));
    } catch (e) { console.error("Weather Error:", e); }

    // 2. EVENTS (MU + PHANTOM POWER + PENN MANOR)
    try {
        let events = [
            { title: "Jazz Ensemble Concert", date: "2026-04-10T19:30:00", location: "Ware Center", category: "Arts", price: "$10 Student / $20 Public", ticketLink: "https://www.etix.com/ticket/p/jazz" },
            { title: "Live at Phantom Power", date: "2026-05-08T19:00:00", location: "Phantom Power", category: "Arts", price: "$8 Student / $15 Public", ticketLink: "https://www.phantompower.net/tickets" },
            { title: "PMHS Varsity Baseball", date: "2026-03-28T16:00:00", location: "Comet Field", category: "Penn Manor", price: "Free", ticketLink: "" }
        ];
        // Note: In production, you'd fetch real Penn Manor ICS data here.
        fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(events, null, 2));
    } catch (e) { console.error("Events Error:", e); }

    // 3. DINING SPECIALS (HO PIE)
    try {
        const specials = [
            { restaurant: "House of Pizza", day: "Monday", deal: "2 Slices & Medium Drink - $4.50" },
            { restaurant: "House of Pizza", day: "Tuesday", deal: "Large Cheese Pizza & 2-Liter - $15.99" }
        ];
        fs.writeFileSync(path.join(__dirname, '../specials.json'), JSON.stringify(specials, null, 2));
    } catch (e) { console.error("Specials Error:", e); }

    console.log("✅ Scrape Complete. Files saved to root.");
}

runScraper();