import { readFile } from 'node:fs/promises';
const expected = JSON.parse(await readFile(new URL('../data/status.json', import.meta.url), 'utf8'));
const deadline = Date.now() + 8 * 60 * 1000;
while (Date.now() < deadline) {
  try {
    const response = await fetch('https://straitmonitor.com/data/status.json?v=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (response.ok) {
      const actual = await response.json();
      if (actual.latest?.id === expected.latest?.id && actual.totalRuns >= expected.totalRuns) {
        console.log('Verified the public pull history.');
        process.exit(0);
      }
    }
  } catch { /* Publication may still be in progress; retry without exposing errors. */ }
  console.log('Waiting for the public pull history to be published…');
  await new Promise(resolve => setTimeout(resolve, 15000));
}
throw new Error('Public pull history did not update before the verification deadline');
