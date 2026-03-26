// First, run: npm install node-ical
const ical = require('node-ical');

async function fetchPennManorEvents() {
    // Replace this string with the URL you copied from the Penn Manor site
const icsUrl = 'https://www.pennmanor.net/events/month/?shortcode=c16e4ff0&outlook-ical=1#038;ical=1'; // <-- Paste your copied link inside the quotes

    try {
        console.log('Fetching calendar data...');
        const events = await ical.async.fromURL(icsUrl);
        
        const today = new Date();
        const twoMonthsFromNow = new Date();
        twoMonthsFromNow.setMonth(today.getMonth() + 2);

        let upcomingEvents = [];

        // Loop through the parsed calendar objects
        for (const event of Object.values(events)) {
            // Check if it's a standard calendar event
            if (event.type === 'VEVENT') {
                const eventDate = new Date(event.start);
                
                // Filter for events within our 2-month window
                if (eventDate >= today && eventDate <= twoMonthsFromNow) {
                    upcomingEvents.push({
                        title: event.summary,
                        start: event.start,
                        end: event.end,
                        location: event.location || 'No location specified'
                    });
                }
            }
        }

        // Sort the events chronologically
        upcomingEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

        console.log(`✅ Success! Found ${upcomingEvents.length} events in the next two months.`);
        console.log('Here are the first 5 events to verify the data structure:');
        console.log(upcomingEvents.slice(0, 5));

    } catch (error) {
        console.error('❌ Error fetching or parsing the calendar:', error);
    }
}

fetchPennManorEvents();