const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function runPhantomDiagnostics() {
    console.log("👻 Running Phantom Power Diagnostic...\n");
    
    const phantomLink = 'https://www.phantompower.net/tickets'; 

    try {
        const res = await fetch(phantomLink, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const text = await res.text();
        console.log("Status:", res.status);
        
        // Detect common ticketing platforms
        const platforms = [];
        if (text.includes('eventbrite.com')) platforms.push('Eventbrite');
        if (text.includes('ticketweb.com')) platforms.push('TicketWeb');
        if (text.includes('seetickets.us')) platforms.push('SeeTickets');
        if (text.includes('ticketmaster.com')) platforms.push('Ticketmaster');
        
        console.log("Ticketing Platforms Detected:", platforms.length > 0 ? platforms.join(', ') : "None (Custom HTML)");

        // Hunt for the exact block of code where prices and event titles live
        const priceMatch = text.match(/.{0,150}\$[0-9]{2}.{0,150}/i);
        const ticketMatch = text.match(/.{0,150}href=["']([^"']*(?:ticket|event)[^"']*)["'].{0,150}/i);

        console.log("\n--- HTML STRUCTURE AROUND PRICE ---");
        console.log(priceMatch ? priceMatch[0].trim() : "No standard '$XX' price text found in raw HTML.");
        
        console.log("\n--- HTML STRUCTURE AROUND TICKET LINK ---");
        console.log(ticketMatch ? ticketMatch[0].trim() : "No standard ticket links found.");
        console.log("\n");

    } catch(e) { console.log("Failed:", e.message, "\n"); }
}

runPhantomDiagnostics();