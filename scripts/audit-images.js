const fs = require('fs');
// Run this script against your local events.json. Reports image coverage by source.
const eventsPath = process.argv[2] || './events.json';
if (!fs.existsSync(eventsPath)) {
    console.error(`✗ events.json not found at ${eventsPath}`);
    process.exit(1);
}
const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
console.log(`📥 Loaded ${events.length} events\n`);

function bucket(e) {
    const tags = e.tags || [];
    const link = (e.sourceLink || '').toLowerCase();
    if (link.includes('artsmu.com')) return 'artsmu';
    if (link.includes('getinvolved.millersville.edu') || tags.includes('Clubs/Orgs')) return 'GetInvolved';
    if (link.includes('millersvilleathletics.com')) return 'MU Athletics';
    if (link.includes('millersville.edu/calendar') || (tags.includes('MU') && !tags.includes('Athletics') && !tags.includes('Clubs/Orgs'))) return 'MU Calendar';
    if (link.includes('millersvilletechcamps')) return 'Tech Camps (manual)';
    if (link.includes('totalcamps') || link.includes('shehanbaseball') || link.includes('millersvillewomenssoccercamps')) return 'Sport Camps (manual)';
    if (link.includes('millersville.edu/alumni')) return 'Alumni (manual)';
    if (link.includes('phantompower') || link.includes('eventbrite')) return 'Phantom Power';
    if (tags.includes('PM')) return 'Penn Manor';
    if (tags.includes('Borough')) return 'Borough';
    if (tags.includes('VFW')) return 'VFW';
    if (tags.includes('Community')) return 'Community submissions';
    return 'Other';
}

const stats = {};
for (const e of events) {
    const b = bucket(e);
    if (!stats[b]) stats[b] = { total: 0, withImage: 0 };
    stats[b].total++;
    if (e.image) stats[b].withImage++;
}

console.log('Image coverage by source:\n');
console.log('  COUNT   IMG  %     SOURCE');
console.log('  ──────  ───  ───   ──────────────────────');
const sorted = Object.entries(stats).sort((a, b) => b[1].total - a[1].total);
let totalEvts = 0, totalImg = 0;
for (const [src, s] of sorted) {
    const pct = ((s.withImage / s.total) * 100).toFixed(0);
    console.log(`  ${String(s.total).padStart(6)}  ${String(s.withImage).padStart(3)}  ${pct.padStart(3)}%  ${src}`);
    totalEvts += s.total;
    totalImg += s.withImage;
}
console.log('  ──────  ───  ───');
console.log(`  ${String(totalEvts).padStart(6)}  ${String(totalImg).padStart(3)}  ${((totalImg/totalEvts)*100).toFixed(0).padStart(3)}%  TOTAL\n`);

// Show 3 example IMAGE URLs per source so you can see what's currently captured
console.log('Sample image URLs (first 2 per source):\n');
for (const [src, s] of sorted) {
    if (s.withImage === 0) continue;
    const samples = events.filter(e => bucket(e) === src && e.image).slice(0, 2);
    console.log(`  [${src}]`);
    for (const e of samples) {
        console.log(`    "${(e.title||'').slice(0,50)}" → ${e.image.slice(0,80)}${e.image.length>80?'...':''}`);
    }
    console.log('');
}

// Show 5 events from highest-volume image-LACKING sources to inform "where to hunt"
console.log('Sample events WITHOUT images (highest-volume gaps):\n');
const gaps = sorted.filter(([s, x]) => x.total >= 10 && x.withImage / x.total < 0.3);
for (const [src, s] of gaps) {
    const missing = events.filter(e => bucket(e) === src && !e.image).slice(0, 3);
    console.log(`  [${src}] (${s.total - s.withImage}/${s.total} missing)`);
    for (const e of missing) {
        console.log(`    "${(e.title||'').slice(0,60)}" → ${(e.sourceLink||'').slice(0,80)}`);
    }
    console.log('');
}
