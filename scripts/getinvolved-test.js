const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function runGetInvolvedTest() {
    console.log("🎓 Running GetInvolved API Test...\n");
    
    const today = new Date().toISOString().split('T')[0];
    const url = `https://getinvolved.millersville.edu/api/discovery/event/search?endsAfter=${today}T00:00:00-04:00&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=10`;

    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        console.log("Status:", res.status);
        
        const data = await res.json();
        const events = data.value || [];
        console.log(`✅ Successfully pulled ${events.length} test events.\n`);
        
        events.forEach((e, i) => {
            console.log(`${i+1}. ${e.name}`);
            console.log(`   Date: ${e.startsOn}`);
            console.log(`   Categories: ${(e.categoryNames || []).join(', ')}`);
            console.log(`   Theme: ${e.theme}`);
            console.log('---');
        });
        
    } catch(e) { console.log("Failed:", e.message); }
}

runGetInvolvedTest();