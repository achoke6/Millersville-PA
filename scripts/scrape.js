const { chromium } = require('playwright');
const fs = require('fs');

async function runScrape() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    try {
        console.log("Navigating to Millersville Calendar...");
        await page.goto('https://www.millersville.edu/calendar/events/list', { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000); 

        const events = await page.evaluate(() => {
            const results = [];
            // Target the specific list items used in the 2026 calendar
            const items = document.querySelectorAll('.calendar-list-item');
            
            items.forEach(el => {
                // 1. Get Title
                const name = el.querySelector('h4')?.innerText.trim();
                
                // 2. Get the Meta String (usually: "03/24/26, 10:00 am - 5:00 pm. Location...")
                const metaInfo = el.innerText; 
                
                // 3. Extract Category (Arts, Athletic, Public, Student)
                const categories = ["Arts Concert / Performance", "Athletic Competitions", "Public Event", "Student Event"];
                const category = categories.find(c => metaInfo.includes(c)) || "Public Event";

                // 4. Extract Time & Location using specific detail classes
                // The calendar often uses .event-details or just raw text after the date
                const time = el.querySelector('.event-time')?.innerText.trim() || "See Details";
                const loc = el.querySelector('.event-location')?.innerText.trim() || "Millersville, PA";

                if (name) {
                    results.push({ name, time, loc, category });
                }
            });
            return results;
        });

        if (events.length > 0) {
            fs.writeFileSync('./events.json', JSON.stringify(events, null, 2));
            console.log(`Successfully scraped ${events.length} events.`);
        } else {
            console.log("No events found. Check if .calendar-list-item class still exists.");
        }
    } catch (err) {
        console.error("SCRAPE ERROR:", err.message);
    } finally {
        await browser.close();
    }
}
runScrape();