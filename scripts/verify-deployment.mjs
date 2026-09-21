import { readFile } from 'node:fs/promises';
const expected = JSON.parse(await readFile(new URL('../data/snapshot.json', import.meta.url), 'utf8'));
const deadline = Date.now() + 8 * 60 * 1000;
let error;
while (Date.now() < deadline) {
  try {
    const response = await fetch('https://straitmonitor.com/data/snapshot.json?v=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const actual = await response.json();
    if (Date.parse(actual.fetchedAt) >= Date.parse(expected.fetchedAt) && actual.schemaVersion >= 2 && actual.rows?.length) {
      console.log(`Verified public snapshot: ${actual.fetchedAt}`);
      process.exit(0);
    }
    error = new Error(`Published snapshot is still ${actual.fetchedAt}; expected ${expected.fetchedAt}`);
  } catch (err) { error = err; }
  console.log('Waiting for GitHub Pages to publish the refreshed snapshot…');
  await new Promise(resolve => setTimeout(resolve, 15000));
}
throw error || new Error('Deployment verification timed out');
