const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

async function runMUTest() {
    console.log("🏫 Running MU Calendar Deep-Dive Diagnostic...\n");
    
    const today = new Date();
    const startDay = today.toISOString().split('T')[0];
    const thirtyDaysOut = new Date(today);
    thirtyDaysOut.setDate(today.getDate() + 29);
    const endDay = thirtyDaysOut.toISOString().split('T')[0];

    try {
        // Step 1: Cookie Handshake
        const pageRes = await fetch('https://www.millersville.edu/calendar/', { headers: baseHeaders });
        const rawCookies = pageRes.headers.get('set-cookie');
        let cookieHeader = rawCookies ? rawCookies.split(', ').map(c => c.split(';')[0]).join('; ') : '';

        const apiHeaders = { 
            ...baseHeaders, 
            'Accept': 'application/json', 
            'X-Requested-With': 'XMLHttpRequest', 
            'Origin': 'https://www.millersville.edu', 
            'Referer': 'https://www.millersville.edu/calendar/', 
            'Content-Type': 'application/json' 
        };
        if (cookieHeader) apiHeaders['Cookie'] = cookieHeader;

        // Step 2: Fetch the data
        const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', { 
            method: 'POST', 
            headers: apiHeaders, 
            body: JSON.stringify({ getEvents: true, startDate: startDay, endDate: endDay }) 
        });

        const data = JSON.parse(await res.text());

        if (data.fields && Array.isArray(data.data)) {
            console.log("✅ Successfully fetched MU API. Analyzing fields...\n");
            
            const fields = data.fields.split(',');
            console.log("Available Columns:", fields.join(', '));
            
            // Map the exact columns we need
            const nameIdx = fields.indexOf('ActivityName');
            const idIdx = fields.indexOf('ActivityId');
            
            // Hunt for the category and group columns dynamically
            const typeIdx = fields.findIndex(f => f.toLowerCase().includes('meetingtype') || f.toLowerCase().includes('eventtype') || f.toLowerCase().includes('calendar'));
            const groupIdx = fields.findIndex(f => f.toLowerCase().includes('customer') || f.toLowerCase().includes('group'));

            console.log("\n--- FIRST 5 EVENTS ---");
            for (let i = 0; i < Math.min(5, data.data.length); i++) {
                const row = data.data[i];
                console.log(`Event: ${row[nameIdx]}`);
                console.log(`Activity ID: ${row[idIdx]}`);
                if (typeIdx !== -1) console.log(`Tag (MeetingType): ${row[typeIdx]}`);
                if (groupIdx !== -1) console.log(`Tag (Customer/Group): ${row[groupIdx]}`);
                
                // EMS systems usually route details using this ID format
                console.log(`Guessed 'More Info' Link: https://www.millersville.edu/calendar/event.php?id=${row[idIdx]}`);
                console.log('---');
            }
        } else {
            console.log("Unexpected data format returned.");
        }
    } catch(e) { console.log("Failed:", e.message); }
}

runMUTest();