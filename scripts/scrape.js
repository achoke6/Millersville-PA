const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function runDiagnostics() {
    console.log("🕵️ Running Millersville API Firewall Diagnostics...\n");

    // Using the exact dates you found in the payload
    const startDay = "2026-03-01";
    const endDay = "2026-03-31";

    // TEST 1: POST with JSON Payload
    try {
        console.log("👉 TEST 1: index.php (JSON Payload)");
        const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', {
            method: 'POST',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Content-Type': 'application/json' },
            body: JSON.stringify({ getEvents: true, startDate: startDay, endDate: endDay })
        });
        console.log("Status:", res.status);
        console.log("Raw Response:", (await res.text()).substring(0, 250), "\n");
    } catch(e) { console.log("Failed:", e.message, "\n"); }

    // TEST 2: POST with URL-Encoded Form Data
    try {
        console.log("👉 TEST 2: index.php (Form Data)");
        const params = new URLSearchParams({ getEvents: 'true', startDate: startDay, endDate: endDay });
        const res = await fetch('https://www.millersville.edu/calendar/app/api/index.php', {
            method: 'POST',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });
        console.log("Status:", res.status);
        console.log("Raw Response:", (await res.text()).substring(0, 250), "\n");
    } catch(e) { console.log("Failed:", e.message, "\n"); }

    // TEST 3: The Map API Backup
    try {
        console.log("👉 TEST 3: map.millersville.edu (GET)");
        const res = await fetch('https://map.millersville.edu/api/public/events', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        console.log("Status:", res.status);
        console.log("Raw Response:", (await res.text()).substring(0, 250), "\n");
    } catch(e) { console.log("Failed:", e.message, "\n"); }
}

runDiagnostics();