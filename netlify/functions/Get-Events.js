const axios = require('axios');
const cheerio = require('cheerio');

exports.handler = async (event, context) => {
    try {
        // 1. Fetch with a timeout and a 'Real Browser' header
        const response = await axios.get('https://www.millersville.edu/calendar/events/list', {
            timeout: 5000,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
            }
        });

        const $ = cheerio.load(response.data);
        const events = [];

        // 2. March 2026 Selectors
        $('.calendar-list-item').each((i, el) => {
            events.push({
                name: $(el).find('h4').text().trim(),
                time: $(el).find('.event-time').text().trim(),
                loc: $(el).find('.event-location').text().trim(),
                category: $(el).find('.event-category').text().trim()
            });
        });

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify(events)
        };
    } catch (error) {
        // This will now definitely show up in your Netlify Function Logs
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: error.message, note: "Check if axios/cheerio are in package.json" }) 
        };
    }
};