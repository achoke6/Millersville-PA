const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function runPhantomTest() {
    console.log("👻 Running Phantom Power Eventbrite Test...\n");
    // Phantom Power's official Eventbrite Organizer profile
    const url = 'https://www.eventbrite.com/o/phantom-power-29187724817';
    
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const text = await res.text();
        console.log("Status:", res.status);
        
        // Search for Google Structured Data (JSON-LD)
        const ldMatches = text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
        if (ldMatches) {
            console.log(`Found ${ldMatches.length} JSON-LD data blocks.\n`);
            
            let foundEvents = 0;
            ldMatches.forEach(block => {
                try {
                    const jsonStr = block.replace(/<script type="application\/ld\+json">|<\/script>/gi, '');
                    const data = JSON.parse(jsonStr);
                    
                    // Recursively hunt for Event objects
                    function findEvents(obj) {
                        if (Array.isArray(obj)) obj.forEach(findEvents);
                        else if (obj && typeof obj === 'object') {
                            if (obj['@type'] === 'Event') {
                                console.log(`🎸 ${obj.name}`);
                                console.log(`   Date: ${obj.startDate}`);
                                console.log(`   Link: ${obj.url}\n`);
                                foundEvents++;
                            } else {
                                Object.values(obj).forEach(findEvents);
                            }
                        }
                    }
                    findEvents(data);
                } catch(e) {}
            });
            console.log(`✅ Total Events Found: ${foundEvents}`);
        } else {
             console.log("⚠️ No JSON-LD blocks found. Eventbrite might be blocking the GitHub IP.");
        }
    } catch(e) { console.log("Failed:", e.message); }
}

runPhantomTest();