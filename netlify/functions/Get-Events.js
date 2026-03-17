const axios = require('axios');
const cheerio = require('cheerio');

exports.handler = async (event, context) => {
    console.log("Function triggered: Scraping Millersville...");
    
    try {
        // Adding a User-Agent makes the Millersville server think we are a real browser
        const { data } = await axios.get('https://www.millersville.edu/calendar/events/list', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        
        const $ = cheerio.load(data);
        const events = [];

        // Selecting the event list items
        $('.calendar-list-item').each((i, el) => {
            const name = $(el).find('h4').text().trim();
            const time = $(el).find('.event-time').text().trim();
            const loc = $(el).find('.event-location').text().trim();
            const category = $(el).find('.event-category').text().trim() || "General";

            if (name) events.push({ name, time, loc, category });
        });

        console.log(`Success: Found ${events.length} events.`);

        return {
            statusCode: 200,
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*" 
            },
            body: JSON.stringify(events)
        };

    } catch (error) {
        // This log will tell you exactly why it failed in the Netlify Dashboard
        console.error("SCRAPE ERROR:", error.message);
        
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: error.message }) 
        };
    }
};