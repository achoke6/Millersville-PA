const fs = require('fs');

async function pullAPI() {
    const today = new Date();
    const nextMonth = new Date(today);
    nextMonth.setDate(today.getDate() + 30);

    const startDate = today.toISOString().split('T')[0]; 
    const endDate = nextMonth.toISOString().split('T')[0];

    console.log(`Requesting events from ${startDate} to ${endDate}...`);

    try {
        const response = await fetch('https://www.millersville.edu/calendar/app/api/index.php', {
            method: 'POST',
            headers: {
                // Angular APIs usually demand this specific content type
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Millersville-App-Fetch'
            },
            // Sending the payload as a JSON string
            body: JSON.stringify({
                getEvents: true,
                startDate: startDate,
                endDate: endDate
            })
        });

        // SAFETY NET: Read the raw text first before forcing it into JSON
        const rawText = await response.text();

        if (!response.ok) {
            throw new Error(`Server Error (${response.status}): ${rawText.substring(0, 100)}`);
        }

        if (!rawText || rawText.trim() === '') {
            throw new Error("The server returned a completely blank response. It might be blocking automated requests or missing a required header.");
        }

        // Now try to parse it
        const data = JSON.parse(rawText);

        fs.writeFileSync('./events.json', JSON.stringify(data, null, 2));
        console.log(`Success! Downloaded ${data.length || 'data'} items.`);

    } catch (err) {
        console.error("API Pull failed:", err.message);
        process.exit(1);
    }
}

pullAPI();