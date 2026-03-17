const fetch = require('node-fetch');
const cheerio = require('cheerio');

exports.handler = async (event, context) => {
  try {
    // 1. Fetch the Millersville Calendar HTML
    const response = await fetch('https://www.millersville.edu/calendar/events/list');
    const html = await response.text();
    
    // 2. Load the HTML into Cheerio
    const $ = cheerio.load(html);
    const events = [];

    // 3. Find each event listing (based on the MU site structure)
    $('.calendar-list-item').each((i, el) => {
      const name = $(el).find('.event-title').text().trim();
      const time = $(el).find('.event-time').text().trim();
      const loc = $(el).find('.event-location').text().trim();
      const category = $(el).find('.event-category').text().trim();

      events.push({ name, time, loc, category });
    });

    // 4. Return the data to your web app
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events)
    };
  } catch (error) {
    return { statusCode: 500, body: error.toString() };
  }
};