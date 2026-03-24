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
            document.querySelectorAll('.calendar-list-item').forEach(el => {
                const fullText = el.innerText;
                const name = el.querySelector('h4')?.innerText.trim();
                
                // Use a Regular Expression to find the time pattern (e.g., 11:30 am - 1:30 pm)
                const timeMatch = fullText.match(/\d{1,2}:\d{2}\s?(?:am|pm)\s?-\s?\d{1,2}:\d{2}\s?(?:am|pm)/i);
                const time = timeMatch ? timeMatch[0] : "See Details";

                // Grab Location (usually the text after the second comma or in a specific span)
                const loc = el.querySelector('.event-location')?.innerText.trim() || "Millersville, PA";

                // Map Categories
                const cats = ["Arts Concert / Performance", "Athletic Competitions", "Public Event", "Student Event"];
                const category = cats.find(c => fullText.includes(c)) || "Public Event";

                if (name) {
                    results.push({ name, time, loc, category });
                }
            });
            return results;
        });

        fs.writeFileSync('./events.json', JSON.stringify(events, null, 2));
        console.log(`Success! Found ${events.length} events.`);
    } catch (err) {
        console.error("Scrape failed:", err.message);
    } finally {
        await browser.close();
    }
}
runScrape();