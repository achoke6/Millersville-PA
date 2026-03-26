const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function runGetInvolvedDiagnostics() {
    console.log("🎓 Running GetInvolved (Student Orgs) Diagnostic...\n");
    const url = 'https://getinvolved.millersville.edu/events';

    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const text = await res.text();
        console.log("Status:", res.status);
        
        // Detect the underlying platform
        const platforms = [];
        if (text.toLowerCase().includes('campusgroups')) platforms.push('CampusGroups');
        if (text.toLowerCase().includes('anthology') || text.toLowerCase().includes('campuslabs')) platforms.push('Anthology Engage / CampusLabs');
        
        console.log("Platform Detected:", platforms.length > 0 ? platforms.join(', ') : "Unknown");

        // Look for hidden API endpoints or ICS calendar feeds in the page source
        const apiMatch = text.match(/href=["']([^"']*(?:api|events\.xml|events\.json|events\.ics)[^"']*)["']/i);
        console.log("\n--- HIDDEN DATA FEED HUNT ---");
        console.log(apiMatch ? `Found potential raw data feed: ${apiMatch[1]}` : "No obvious XML/JSON/ICS feeds found in raw HTML.");
        
        console.log("\n--- HTML PAGE TITLE & META ---");
        const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/i);
        console.log(titleMatch ? titleMatch[1].trim() : "No title found");
        console.log("\n");

    } catch(e) { console.log("Failed:", e.message, "\n"); }
}

runGetInvolvedDiagnostics();