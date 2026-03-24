const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

async function runScrape() {
    try {
        console.log("Starting Deep Scrape of Millersville Events...");
        const { data } = await axios.get('https://www.millersville.edu/calendar/events/list', {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
            }
        });
        
        const $ = cheerio.load(data);
        const events = [];

        // This version looks for broader tags used in 2026
        $('article, .calendar-list-item, .event, .listing').each((i, el) => {
            const name = $(el).find('h3, h4, .title, a').first().text().trim();
            const time = $(el).find('.time, .date, span:contains(":")').first().text().trim();
            const loc = $(el).find('.location, .room, .venue').first().text().trim();
            const category = $(el).find('.category, .type').first().text().trim() || "Event";

            if (name && name.length > 2) { // Filter out tiny/empty strings
                events.push({ name, time, loc, category });
            }
        });

        if (events.length === 0) {
            console.log("No events found. Writing dummy data for testing...");
            events.push({ name: "Scraper is active - No live events found", time: "Check back later", loc: "Online", category: "System" });
        }

        fs.writeFileSync('./events.json', JSON.stringify(events, null, 2));
        console.log(`Success! Saved ${events.length} items to events.json`);
        
    } catch (err) {
        console.error("Scrape failed:", err.message);
        process.exit(1);
    }
}
runScrape();