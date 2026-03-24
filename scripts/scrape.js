const fs = require('fs');

async function pullAPI() {
    // 1. Calculate today and 30 days from now dynamically
    const today = new Date();
    const nextMonth = new Date(today);
    nextMonth.setDate(today.getDate() + 30);

    const startDate = today.toISOString().split('T')[0]; // Formats to YYYY-MM-DD
    const endDate = nextMonth.toISOString().split('T')[0];

    console.log(`Pulling Millersville events from ${startDate} to ${endDate}...`);

    try {
        // 2. Build the exact payload you found
        const params = new URLSearchParams({
            getEvents: 'true',
            startDate: startDate,
            endDate: endDate
        });

        // 3. Send a direct POST request to the PHP backend
        const response = await fetch('https://www.millersville.edu/calendar/app/api/index.php', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' // Play nice with their server
            },
            body: params.toString()
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const data = await response.json();

        // 4. Save the raw API output
        fs.writeFileSync('./events.json', JSON.stringify(data, null, 2));
        console.log(`Success! API connection established. Raw data saved.`);

    } catch (err) {
        console.error("API Pull failed:", err.message);
        process.exit(1);
    }
}

pullAPI();