const { chromium } = require('playwright');
const fs = require('fs');

async function runScrape() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    try {
        console.log("Navigating to Millersville Calendar...");
        await page.goto('https://www.millersville.edu/calendar/events/list', { 
            waitUntil: 'networkidle',
            timeout: 60000 
        });

        // Give the JavaScript extra time to populate the list
        await page.waitForTimeout(5000); 

        const events = await page.evaluate(() => {
            const results = [];
            // Looking for any container that looks like an event
            const elements = document.querySelectorAll('.calendar-list-item, article, .event-item');
            
            elements.forEach(el => {
                const title = el.querySelector('h3, h4, .event-title')?.innerText.trim();
                if (title) {
                    results.push({
                        name: title,
                        time: el.querySelector('.event-time, .time')?.innerText.trim() || "See Site",
                        loc: el.querySelector('.event-location, .location')?.innerText.trim() || "Campus",
                        category: el.querySelector('.event-category, .category')?.innerText.trim() || "General"
                    });
                }
            });
            return results;
        });

        if (events.length > 0) {
            fs.writeFileSync('./events.json', JSON.stringify(events, null, 2));
            console.log(`Successfully scraped ${events.length} events.`);
        } else {
            // Write this so we know the script reached this point
            fs.writeFileSync('./events.json', JSON.stringify([{name: "No events found in HTML", date: new Date().toISOString()}], null, 2));
            console.log("No events found. HTML might have changed.");
        }

    } catch (err) {
        console.error("SCRAPE ERROR:", err.message);
    } finally {
        await browser.close();
    }
}
runScrape();