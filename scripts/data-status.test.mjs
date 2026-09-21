import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import status from '../data-status.js';

test('fresh retrieval cannot hide delayed observations', () => {
  const source = { status: 'ok', dataThrough: '2026-09-13', lastSuccessAt: '2026-09-22T00:00:00Z', expectedLagDays: 7 };
  assert.equal(status.sourceState(source, Date.parse('2026-09-22T01:00:00Z')), 'Publicly available data is delayed');
});
test('group date differences do not hide a delayed country', () => {
  const source = { status: 'ok', dataThrough: '2026-09-22', groupDates: { QAT: '2026-09-11', OMN: '2026-09-22' }, lastSuccessAt: '2026-09-22T00:00:00Z', expectedLagDays: 7 };
  assert.equal(status.sourceState(source, Date.parse('2026-09-22T01:00:00Z')), 'Publicly available data is delayed');
});
test('monthly stock data uses its own publication lag', () => {
  assert.equal(status.sourceState({ status: 'ok', dataThrough: '2026-06', lastSuccessAt: '2026-09-22T00:00:00Z', expectedLagDays: 125 }, Date.parse('2026-09-22T01:00:00Z')), 'Checked');
});
test('failed sources are never shown as checked', () => {
  assert.equal(status.sourceState({ status: 'error' }, Date.now()), 'Refresh failed · saved data');
});
test('malformed snapshots are rejected while existing snapshots remain compatible', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../data/snapshot.json', import.meta.url), 'utf8'));
  assert.equal(status.validSnapshot(snapshot), true);
  assert.equal(status.validSnapshot({ ...snapshot, rows: [] }), false);
  assert.equal(status.validSnapshot({ ...snapshot, fetchedAt: 'invalid' }), false);
  assert.equal(status.validSnapshot({ ...snapshot, rows: snapshot.rows.map(row => [row[0], 'bad']) }), false);
});
