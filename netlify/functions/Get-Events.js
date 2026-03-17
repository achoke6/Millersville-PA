const axios = require('axios');
const cheerio = require('cheerio');

exports.handler = async (event, context) => {
    try {
        const url = 'https://www.millersville.edu/calendar/events/list';
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);
        
        const events = [];

        // Selecting each event block
        $('.calendar-list-item').each((i, el) => {
            const name = $(el).find('h4').text().trim();
            const dateStr = $(el).find('.event-date').text().trim(); // e.g., "Mar 18"
            const timeLoc = $(el).find('.event-details').text().trim(); 
            const category = $(el).find('.event-category').text().trim();

            events.push({
                name,
                date: dateStr,
                details: timeLoc,
                category: category
            });
        });

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(events.slice(0, 15)) // Sending top 15 results
        };
    } catch (error) {
        return { statusCode: 500, body: "Error scraping data" };
    }
};