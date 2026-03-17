const axios = require('axios');
const cheerio = require('cheerio');

exports.handler = async (event, context) => {
    try {
        const { data } = await axios.get('https://www.millersville.edu/calendar/events/list');
        const $ = cheerio.load(data);
        const events = [];

        // Updated for March 2026 site structure
        $('.calendar-list-item, .event-listing').each((i, el) => {
            const name = $(el).find('h4, .event-title').text().trim();
            const time = $(el).find('.event-time, .time').text().trim();
            const loc = $(el).find('.event-location, .location').text().trim();
            const category = $(el).find('.event-category, .category').text().trim() || "General Event";

            if (name) {
                events.push({ name, time, loc, category });
            }
        });

        return {
            statusCode: 200,
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*" // Prevents CORS issues
            },
            body: JSON.stringify(events)
        };
    } catch (error) {
        console.error("Scrape Error:", error);
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: "Failed to scrape Millersville calendar" }) 
        };
    }
};