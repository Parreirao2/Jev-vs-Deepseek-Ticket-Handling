// Regenerates data/<scenario>.json for one or all scenarios.
// Usage: node scripts/generate-tickets.js [scenario-key]
const fs = require('fs');
const path = require('path');
const { SCENARIOS } = require('../lib/scenarios');

const requested = process.argv[2];
const keys = requested ? [requested] : Object.keys(SCENARIOS);

for (const key of keys) {
  const scenario = SCENARIOS[key];
  if (!scenario) {
    console.error(`Unknown scenario "${key}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  const items = scenario.generate(150);
  const outPath = path.join(__dirname, '..', 'data', `${key}.json`);
  fs.writeFileSync(outPath, JSON.stringify(items, null, 2));
  console.log(`Generated ${items.length} items -> data/${key}.json`);
}
