const { chromium } = require('playwright');
const fs = require('fs');

async function runScrape() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    try {
        await page.goto('https://www.millersville.edu/calendar/events/list', { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000); 

        const events = await page.evaluate(() => {
            const results = [];
            // Target the specific article/list structure
            document.querySelectorAll('.calendar-list-item, article.event, .event-listing').forEach(el => {
                const title = el.querySelector('h3, h4, .event-title')?.innerText.trim();
                // The calendar usually bundles time/loc in a sub-element or specific class
                const detailsText = el.querySelector('.event-details, .time-location, p')?.innerText.trim() || "";
                const category = el.querySelector('.event-category, .category')?.innerText.trim() || "Public Event";

                if (title) {
                    results.push({
                        name: title,
                        // Splitting details if they are in one string, or grabbing specific tags
                        time: el.querySelector('.event-time, .time')?.innerText.trim() || "See Details",
                        loc: el.querySelector('.event-location, .location')?.innerText.trim() || "Millersville, PA",
                        category: category
                    });
                }
            });
            return results;
        });

        fs.writeFileSync('./events.json', JSON.stringify(events, null, 2));
        console.log(`Scraped ${events.length} events.`);
    } catch (err) {
        console.error("Scrape failed:", err.message);
    } finally {
        await browser.close();
    }
}
runScrape();