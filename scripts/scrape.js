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
    console.log("Fetching live weather data for Millersville...");
    try {
        // Step 1: NWS requires you to hit a "points" URL first to get the local grid coordinates
        const pointRes = await fetch('https://api.weather.gov/points/39.9973,-76.3529', {
            headers: { 'User-Agent': 'MillersvilleCommunityApp/1.0' }
        });
        const pointData = await pointRes.json();
        
        // Step 2: Grab the actual forecast URL from that data
        const forecastUrl = pointData.properties.forecast;
        
        // Step 3: Fetch the 7-day forecast
        const forecastRes = await fetch(forecastUrl, {
            headers: { 'User-Agent': 'MillersvilleCommunityApp/1.0' }
        });
        const forecastData = await forecastRes.json();

        // Extract the most important data (Today and Tonight)
        const periods = forecastData.properties.periods;
        const currentData = {
            temp: periods[0].temperature,
            unit: periods[0].temperatureUnit,
            condition: periods[0].shortForecast,
            detailed: periods[0].detailedForecast,
            isDaytime: periods[0].isDaytime,
            nextPeriodTemp: periods[1].temperature // Usually tonight's low or tomorrow's high
        };

        fs.writeFileSync('./weather.json', JSON.stringify(currentData, null, 2));
        console.log("✅ Successfully compiled weather.json!");

    } catch (error) {
        console.error("Weather fetch failed. NWS API might be temporarily down:", error.message);
        // Fallback file so the app doesn't crash if the API times out
        fs.writeFileSync('./weather.json', JSON.stringify({ error: true, message: "Weather data unavailable." }, null, 2));
    }
}

compileWeather();