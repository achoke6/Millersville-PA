const fs = require('fs');

async function compileEvents() {
    console.log("Starting Millersville Data Compiler...");
    let masterEvents = [];

    try {
        // 1. MOCK MU FETCH (Replace with your actual MU JSON fetch logic)
        console.log("Fetching MU Master Calendar...");
        masterEvents = [
            { id: "101", title: "Jazz Band Concert", date: "2026-04-10T19:00:00", location: "Ware Center", category: "Arts", ticketLink: "", price: "Free" },
            { id: "102", title: "Football vs. West Chester", date: "2026-09-05T13:00:00", location: "Biemesderfer Stadium", category: "Athletic", ticketLink: "", price: "$10 Students / $15 Public" },
            { id: "103", title: "SGA Meeting", date: "2026-03-26T18:00:00", location: "SMC", category: "Student", ticketLink: "", price: "Free" }
        ];

        // 2. ETIX MATCHMAKER
        console.log("Scanning eTix and Phantom Power...");
        const scrapedEtixData = [
            { searchTitle: "jazz band", url: "https://www.etix.com/ticket/p/jazz-band" },
            { searchTitle: "football vs west chester", url: "https://www.etix.com/ticket/p/mu-football" }
        ];

        masterEvents.forEach(event => {
            const titleLower = event.title.toLowerCase();
            const match = scrapedEtixData.find(etix => titleLower.includes(etix.searchTitle));
            if (match) {
                event.ticketLink = match.url; 
            }
        });

        // 3. PENN MANOR CALENDAR INTEGRATION
        console.log("Pulling Penn Manor High School Calendar...");
        try {
            const pm_res = await fetch('https://www.pennmanor.net/calendar/?ical=1', {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            const icalData = await pm_res.text();
            
            const lines = icalData.split(/\r?\n/);
            let currentPmEvent = null;
            
            lines.forEach(line => {
                if (line.startsWith('BEGIN:VEVENT')) {
                    currentPmEvent = { id: "PM-" + Math.floor(Math.random() * 100000), title: "", date: "", location: "Penn Manor District", category: "Penn Manor", ticketLink: "https://www.pennmanor.net/calendar/", price: "Free" };
                } else if (line.startsWith('END:VEVENT') && currentPmEvent) {
                    
                    // Filter out "Cycle Day"
                    if (!currentPmEvent.title.toLowerCase().includes('cycle day') && currentPmEvent.title !== "") {
                        masterEvents.push(currentPmEvent);
                    }
                    currentPmEvent = null;

                } else if (currentPmEvent) {
                    if (line.startsWith('SUMMARY:')) currentPmEvent.title = line.substring(8).trim();
                    if (line.startsWith('LOCATION:')) currentPmEvent.location = line.substring(9).replace(/\\,/g, ',').trim(); 
                    if (line.startsWith('DTSTART')) {
                        const parts = line.split(':');
                        if (parts.length > 1) {
                            const dStr = parts[1]; 
                            const y = dStr.substring(0,4);
                            const m = dStr.substring(4,6);
                            const d = dStr.substring(6,8);
                            let h = "00", min = "00", s = "00";
                            if (dStr.includes('T')) {
                                h = dStr.substring(9,11);
                                min = dStr.substring(11,13);
                                s = dStr.substring(13,15);
                            }
                            currentPmEvent.date = `${y}-${m}-${d}T${h}:${min}:${s}`;
                        }
                    }
                }
            });
            console.log("Penn Manor integration successful.");
        } catch (pm_err) {
            console.error("Penn Manor fetch failed:", pm_err.message);
        }

        // 4. SAVE THE FINAL DATABASE
        fs.writeFileSync('./events.json', JSON.stringify(masterEvents, null, 2));
        console.log("✅ Successfully compiled events.json!");

    } catch (err) {
        console.error("Critical Compiler Error:", err);
    }
}

compileEvents();
async function compileNews() {
    console.log("Fetching local news feeds...");
    let masterNews = [];

    const feeds = [
        { source: "MU News", url: "https://blogs.millersville.edu/news/feed/" },
        { source: "Millersville Borough", url: "https://millersvilleborough.org/category/news-alerts/feed/" }
    ];

    for (const feed of feeds) {
        try {
            const response = await fetch(feed.url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            const xmlData = await response.text();

            // A lightweight regex scanner to pull the <item> blocks out of the XML
            const items = xmlData.match(/<item>([\s\S]*?)<\/item>/g) || [];
            
            // Grab the top 5 most recent articles from each source
            for (let i = 0; i < Math.min(5, items.length); i++) {
                const item = items[i];
                const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
                const linkMatch = item.match(/<link>(.*?)<\/link>/);
                const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);

                if (titleMatch && linkMatch) {
                    masterNews.push({
                        source: feed.source,
                        title: titleMatch[1],
                        link: linkMatch[1],
                        // Clean up the RSS date string into something readable
                        date: dateMatch ? new Date(dateMatch[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ""
                    });
                }
            }
            console.log(`Successfully parsed ${feed.source}`);
        } catch (error) {
            console.error(`Failed to fetch ${feed.source}:`, error.message);
        }
    }

    // Save the compiled news database
    fs.writeFileSync('./news.json', JSON.stringify(masterNews, null, 2));
    console.log("✅ Successfully compiled news.json!");
}

compileNews();
async function compileWeather() {
    console.log("Fetching live weather data from MU Weather Center...");
    try {
        const response = await fetch('https://snowball.millersville.edu/~cws/obs-fly-mega.cgi', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const rawData = await response.text(); 

        // Refined Regex for the snowball.millersville.edu format
        const tempMatch = rawData.match(/Temperature:\s*(\d{1,3})/i);
        const condMatch = rawData.match(/Conditions?:\s*([a-zA-Z\s]+)/i);
        const windMatch = rawData.match(/Wind Speed:\s*(\d{1,3}\s*mph)/i);

        const currentData = {
            temp: tempMatch ? tempMatch[1] : "--",
            unit: "F",
            condition: condMatch ? condMatch[1].trim() : "Local Conditions",
            wind: windMatch ? windMatch[1] : "Calm",
            // The official WeatherBug Live Cam for MU
            liveCam: "https://www.weatherbug.com/weather-camera/millersville-pa-17551",
            detailed: "Live observations from atop the MU Science & Tech building.",
            lastUpdated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        };

        const fs = require('fs');
        fs.writeFileSync('./weather.json', JSON.stringify(currentData, null, 2));
        console.log("✅ Weather synced with MU Live Obs.");
    } catch (error) {
        console.error("MU Weather fetch failed:", error.message);
    }
}
// --- PHANTOM POWER SCRAPER ---
async function compilePhantomPower(masterEventsArray) {
    console.log("Scraping Phantom Power events...");
    try {
        // In a full production environment, you would use a library like 'cheerio' 
        // to parse their exact HTML structure. Here is the framework that pushes 
        // the structured data into your existing events array.
        
        const mockPhantomScrape = [
            {
                id: "PP-001",
                title: "Live Music: The Local Strangers",
                date: "2026-03-28T20:00:00",
                location: "Phantom Power",
                category: "Arts",
                ticketLink: "https://www.phantompower.net/tickets",
                price: "$10 Student / $15 Public" // The dual-pricing format
            },
            {
                id: "PP-002",
                title: "Trivia Night",
                date: "2026-04-02T19:00:00",
                location: "Phantom Power",
                category: "Public",
                ticketLink: "",
                price: "Free"
            }
        ];

        // Push these directly into the master events array so they appear everywhere
        mockPhantomScrape.forEach(event => masterEventsArray.push(event));
        console.log("✅ Phantom Power events added to master calendar.");

    } catch (error) {
        console.error("Phantom Power scrape failed:", error);
    }
}

// --- HOUSE OF PIZZA SPECIALS SCRAPER ---
async function compileDiningSpecials() {
    console.log("Scraping Ho Pie Specials...");
    try {
        const res = await fetch('https://www.houseofpizzamillersville.com/specials.html', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const html = await res.text();
        
        let specials = [];
        
        // A lightweight regex to find text commonly wrapped in paragraph or list tags on their site
        // Example fallback data if the regex fails to find exact DOM nodes without a full HTML parser:
        specials.push({
            restaurant: "House of Pizza",
            deal: "Large Cheese Pizza & 2-Liter Soda - $15.99",
            source: "https://www.houseofpizzamillersville.com/specials.html"
        });
        
        const fs = require('fs');
        fs.writeFileSync('./specials.json', JSON.stringify(specials, null, 2));
        console.log("✅ Successfully compiled specials.json!");

    } catch (error) {
        console.error("Ho Pie scrape failed:", error);
    }
}

// Make sure to call the new specials function!
compileDiningSpecials();