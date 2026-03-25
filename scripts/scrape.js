const fs = require('fs');
const path = require('path');

async function runScraper() {
    console.log("🚀 Starting Millersville Pro Scraper...");

    // 1. WEATHER (MU XML FEED)
    try {
        const res = await fetch('https://snowball.millersville.edu/~cws/current.xml');
        const xml = await res.text();
        // More flexible regex to catch the temperature
        const tempMatch = xml.match(/<temp_f>(.*?)<\/temp_f>/);
        const condMatch = xml.match(/<weather>(.*?)<\/weather>/);
        
        const weatherData = {
            temp: tempMatch ? Math.round(parseFloat(tempMatch[1])) : "--",
            condition: condMatch ? condMatch[1] : "Conditions Unavailable",
            lastUpdated: new Date().toLocaleTimeString()
        };
        fs.writeFileSync(path.join(__dirname, '../weather.json'), JSON.stringify(weatherData, null, 2));
        console.log("✅ Weather Written:", weatherData.temp);
    } catch (e) { console.error("❌ Weather Fetch Failed:", e.message); }

    // 2. EVENTS (Re-integrating your original working MU API method)
    try {
        console.log("Fetching MU API Events...");
        const res = await fetch('https://map.millersville.edu/api/public/events');
        const data = await res.json();
        
        // Transform the MU API data into our App's format
        const events = data.map(item => ({
            title: item.title,
            date: item.start,
            location: item.location || "Campus",
            category: item.type || "Campus",
            price: item.cost || "Free",
            ticketLink: item.url || ""
        }));

        fs.writeFileSync(path.join(__dirname, '../events.json'), JSON.stringify(events, null, 2));
        console.log(`✅ Events Written: ${events.length} items.`);
    } catch (e) { console.error("❌ Events Fetch Failed:", e.message); }

    // 3. SPECIALS (Ensure this file exists or the app will look blank)
    const mockSpecials = [{ day: "Today", deal: "Check House of Pizza for daily specials!" }];
    fs.writeFileSync(path.join(__dirname, '../specials.json'), JSON.stringify(mockSpecials, null, 2));
}

runScraper();