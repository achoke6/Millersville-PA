const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

async function scrape() {
    try {
        const { data } = await axios.get('https://www.millersville.edu/calendar/events/list', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $ = cheerio.load(data);
        const events = [];

        $('.calendar-list-item').each((i, el) => {
            events.push({
                name: $(el).find('h4').text().trim(),
                time: $(el).find('.event-time').text().trim(),
                loc: $(el).find('.event-location').text().trim(),
                category: $(el).find('.event-category').text().trim()
            });
        });

        fs.writeFileSync('./events.json', JSON.stringify(events, null, 2));
        console.log("Successfully updated events.json");
    } catch (e) {
        console.error("Scrape failed:", e.message);
    }
}
scrape();