import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SOURCES, makeRecord, saveRecords, sourceReport, safeRecord } from './public-status.mjs';

const base = { runId: 101, startedAt: '2026-09-22T03:17:00Z', finishedAt: '2026-09-22T03:20:00Z', trigger: 'schedule', result: 'success' };
const complete = () => ({ sources: Object.fromEntries(Object.keys(SOURCES).map(key => [key, { status: 'ok', dataThrough: '2026-09-21', change: 'unchanged' }])) });

test('public output discards private metadata and arbitrary provider errors', () => {
  const privateValue = 'PRIVATE_TEST_SENTINEL';
  const report = complete();
  report.sources.rows = { status: 'error', error: privateValue, errorCode: privateValue, name: privateValue, label: privateValue, url: privateValue, checkedAt: privateValue, dataThrough: privateValue, durationMs: privateValue, change: privateValue, account: privateValue };
  report.sources[privateValue] = { status: 'ok' };
  const record = makeRecord({ ...base, actor: privateValue, token: privateValue, report });
  const safe = safeRecord({ ...record, logs: privateValue, repository: privateValue, stages: { retrieval: privateValue } });
  assert.ok(!JSON.stringify(safe).includes(privateValue));
  assert.equal(record.sources[0].name, 'Hormuz traffic');
  assert.equal(record.outcome, 'partial');
  assert.equal(safe.stages.retrieval, 'unknown');
  assert.equal(record.sources[0].errorCode, null);
  assert.match(record.id, /^[a-f0-9]{20}$/);
  assert.equal(record.sources.length, Object.keys(SOURCES).length);
});

test('success, partial data, failure and historical gaps remain distinct', () => {
  assert.equal(makeRecord({ ...base, report: complete() }).outcome, 'success');
  assert.equal(makeRecord({ ...base, report: { sources: { rows: { status: 'ok' } } } }).outcome, 'partial');
  assert.equal(makeRecord({ ...base, result: 'failure', report: complete() }).outcome, 'failure');
  assert.equal(makeRecord({ ...base, result: 'cancelled' }).outcome, 'cancelled');
  const historical = makeRecord(base);
  assert.equal(historical.detail, 'not_recorded');
  assert.equal(historical.outcome, 'success');
  assert.equal(historical.durationMs, 180000);
  assert.equal(historical.trigger, 'scheduled');
  assert.notEqual(historical.id, makeRecord({ ...base, attempt: 2 }).id);
});

test('a successful fetch can contain delayed public data', () => {
  const source = sourceReport('rows', { status: 'ok', dataThrough: '2026-09-13' }, base.finishedAt);
  assert.equal(source.status, 'ok');
  assert.equal(source.delayed, true);
  assert.equal(sourceReport('chokepointBaselines', { status: 'ok', dataThrough: '2025-12-31' }, base.finishedAt).delayed, false);
  assert.equal(sourceReport('privateSource', {}, base.finishedAt), null);
});

test('monthly history retains older pulls, deduplicates and updates rerun details', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'public-status-'));
  try {
    const old = makeRecord({ ...base, runId: 99, startedAt: '2026-08-31T23:17:00Z', finishedAt: '2026-08-31T23:20:00Z' });
    await saveRecords(dir, [old, makeRecord(base)]);
    const detailed = makeRecord({ ...base, report: complete() });
    const index = await saveRecords(dir, [detailed, old]);
    assert.equal(index.totalRuns, 2);
    assert.equal(index.months.length, 2);
    assert.equal(index.latest.sources.length, 12);
    assert.equal(index.historySince, old.startedAt);
    const archive = JSON.parse(await readFile(path.join(dir, 'status/2026-09.json'), 'utf8'));
    assert.equal(archive.runs.length, 1);
    assert.equal(archive.runs[0].detail, 'recorded');
    await writeFile(path.join(dir, 'status/2026-09.json'), 'invalid');
    await assert.rejects(saveRecords(dir, [detailed]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
