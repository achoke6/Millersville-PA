const { chromium } = require('playwright');
const fs = require('fs');

async function runScrape() {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    try {
        console.log("Opening Millersville Calendar in headless Chrome...");
        await page.goto('https://www.millersville.edu/calendar/events/list', { waitUntil: 'networkidle' });

        // This line waits for the actual event items to appear on screen
        await page.waitForSelector('.calendar-list-item, article, .event', { timeout: 10000 });

        const events = await page.evaluate(() => {
            const items = [];
            // Target the 2026 container structure
            document.querySelectorAll('.calendar-list-item, article.event').forEach(el => {
                items.push({
                    name: el.querySelector('h4, h3, .event-title')?.innerText.trim(),
                    time: el.querySelector('.event-time, .time')?.innerText.trim(),
                    loc: el.querySelector('.event-location, .location')?.innerText.trim(),
                    category: el.querySelector('.event-category, .category')?.innerText.trim() || "General"
                });
            });
            return items.filter(i => i.name);
        });

        if (events.length > 0) {
            fs.writeFileSync('./events.json', JSON.stringify(events, null, 2));
            console.log(`Success! Captured ${events.length} events.`);
        } else {
            console.log("No events found in the rendered HTML.");
        }

    } catch (err) {
        console.error("Scrape failed:", err.message);
    } finally {
        await browser.close();
    }
}

runScrape();