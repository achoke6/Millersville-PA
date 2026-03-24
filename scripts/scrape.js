const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

async function runScrape() {
    try {
        console.log("Starting scrape of Millersville Events...");
        const { data } = await axios.get('https://www.millersville.edu/calendar/events/list', {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
            }
        });
        
        const $ = cheerio.load(data);
        const events = [];

        // Targets the common wrapper for events in the March 2026 layout
        $('.calendar-list-item, .event-item, article').each((i, el) => {
            const name = $(el).find('h4, h3, .event-title').first().text().trim();
            const time = $(el).find('.event-time, .time').first().text().trim();
            const loc = $(el).find('.event-location, .location').first().text().trim();
            const category = $(el).find('.event-category, .category').first().text().trim() || "General Event";

            // Only add if we actually found a name
            if (name && name.length > 0) {
                events.push({ name, time, loc, category });
            }
        });

        if (events.length === 0) {
            console.log("Warning: No events found. Selectors might need adjustment.");
        } else {
            fs.writeFileSync('./events.json', JSON.stringify(events, null, 2));
            console.log(`Success! Saved ${events.length} events to events.json`);
        }
    } catch (err) {
        console.error("Scrape failed:", err.message);
        process.exit(1);
    }
}
runScrape();