import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRecord, readJson, saveRecords, timestamp } from './public-status.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(runId || '')) throw new Error('Workflow context is missing');
async function github(endpoint) {
  const response = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Could not read workflow status');
  return response.json();
}
const run = await github(`actions/runs/${runId}`);
const report = await readJson(path.join(root, '.pull-report.json'), null);
const record = makeRecord({
  runId, attempt: process.env.GITHUB_RUN_ATTEMPT || 1,
  startedAt: timestamp(process.env.PULL_STARTED_AT) || run.run_started_at || run.created_at,
  finishedAt: new Date().toISOString(), trigger: run.event,
  result: process.env.PULL_RESULT, report,
  stages: {
    retrieval: process.env.PULL_DATA_RESULT, previews: process.env.PULL_CARDS_RESULT,
    publication: process.env.PULL_PUBLICATION_RESULT, verification: process.env.PULL_VERIFICATION_RESULT
  }
});
if (!record) throw new Error('Could not build a safe public status record');
// Recover completed pulls whose recorder could not publish (for example, cancellation).
// Preserve previously recorded source details; never replace them with a summary.
const dataDir = path.join(root, 'data');
const index = await readJson(path.join(dataDir, 'status.json'), { months: [] });
const known = new Set();
for (const entry of index.months) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(entry.month)) continue;
  const archive = await readJson(path.join(dataDir, 'status', `${entry.month}.json`), { runs: [] });
  for (const old of archive.runs) known.add(old.id);
}
const recovered = [];
try {
  for (let page = 1; page <= 10; page++) {
    const history = await github(`actions/workflows/${run.workflow_id}/runs?branch=main&status=completed&per_page=100&page=${page}`);
    for (const old of history.workflow_runs) {
      if (String(old.id) === String(runId)) continue;
      const summary = makeRecord({ runId: old.id, attempt: old.run_attempt, startedAt: old.run_started_at || old.created_at, finishedAt: old.updated_at, trigger: old.event, result: old.conclusion });
      if (summary && !known.has(summary.id)) { recovered.push(summary); known.add(summary.id); }
    }
    if (history.workflow_runs.length < 100) break;
  }
} catch {
  console.warn('Past pull recovery was unavailable; the current result will still be recorded.');
}
await saveRecords(dataDir, [...recovered, record]);
console.log('Saved public pull status. No raw logs or provider errors were included.');
