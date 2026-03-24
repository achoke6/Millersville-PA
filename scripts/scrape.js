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

        await page.waitForTimeout(5000); 

        const events = await page.evaluate(() => {
            const results = [];
            // Target the specific list items and articles
            const items = document.querySelectorAll('.calendar-list-item, article.event, .event-item');
            
            items.forEach(el => {
                const title = el.querySelector('h4, h3, .event-title')?.innerText.trim();
                
                // If the site uses a generic details block, we grab it all
                const details = el.innerText;
                
                // Logic to find category from the text
                const cats = ["Arts Concert / Performance", "Athletic Competitions", "Public Event", "Student Event"];
                const category = cats.find(c => details.includes(c)) || "Public Event";

                if (title) {
                    results.push({
                        name: title,
                        time: el.querySelector('.event-time, .time')?.innerText.trim() || "See Details",
                        loc: el.querySelector('.event-location, .location')?.innerText.trim() || "Millersville, PA",
                        category: category
                    });
                }
            });
            return results;
        });

        if (events.length > 0) {
            fs.writeFileSync('./events.json', JSON.stringify(events, null, 2));
            console.log(`Success: Found ${events.length} events.`);
        } else {
            // Fallback for debugging
            fs.writeFileSync('./events.json', JSON.stringify([{name: "No events found - Check selectors", category: "System"}], null, 2));
        }
    } catch (err) {
        console.error("Scrape failed:", err.message);
    } finally {
        await browser.close();
    }
}
runScrape();