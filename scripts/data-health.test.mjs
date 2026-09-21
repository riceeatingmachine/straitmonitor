import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPages, refreshSection, latestDate, groupDates } from './data-health.mjs';

test('ArcGIS pagination retains all rows even when the server caps page size', async () => {
  const offsets = [];
  const result = await collectPages(async p => {
    offsets.push(p.resultOffset);
    return p.resultOffset === '0'
      ? { features: [{ attributes: { date: '2026-09-11' } }], exceededTransferLimit: true }
      : { features: [{ attributes: { date: '2026-09-12' } }], exceededTransferLimit: false };
  }, { resultRecordCount: '2000' });
  assert.deepEqual(offsets, ['0', '1']);
  assert.equal(result.length, 2);
});

test('empty truncated pages fail instead of looping or accepting partial data', async () => {
  await assert.rejects(collectPages(async () => ({ features: [], exceededTransferLimit: true }), {}), /no progress/);
});

const describe = rows => ({ dataThrough: latestDate(rows, 1), groupDates: groupDates(rows, 0, 1) });
const oldRows = [['OMN', '2026-09-11'], ['QAT', '2026-09-12']];
const previous = { countryRows: oldRows, sources: { countryRows: { lastSuccessAt: '2026-09-15T00:00:00Z' } } };

test('a failed feed keeps both the data and its original success timestamp', async () => {
  const sources = {};
  const result = await refreshSection({ key: 'countryRows', label: 'Trade', previous, sources, describe, fetcher: async () => { throw new Error('HTTP 503'); } });
  assert.equal(result, oldRows);
  assert.equal(sources.countryRows.status, 'error');
  assert.equal(sources.countryRows.lastSuccessAt, '2026-09-15T00:00:00Z');
  assert.equal(sources.countryRows.dataThrough, '2026-09-12');
});

test('partial country responses cannot silently replace complete saved data', async () => {
  const sources = {};
  const result = await refreshSection({ key: 'countryRows', label: 'Trade', previous, sources, describe, fetcher: async () => [['QAT', '2026-09-13']] });
  assert.equal(result, oldRows);
  assert.equal(sources.countryRows.errorCode, 'incomplete_response');
});

test('successful retrieval records the observation date without changing it to today', async () => {
  const sources = {};
  await refreshSection({ key: 'countryRows', label: 'Trade', previous, sources, describe, fetcher: async () => oldRows, now: () => '2026-09-22T00:00:00Z' });
  assert.equal(sources.countryRows.status, 'ok');
  assert.equal(sources.countryRows.dataThrough, '2026-09-12');
  assert.equal(sources.countryRows.lastSuccessAt, '2026-09-22T00:00:00Z');
  assert.equal(sources.countryRows.change, 'unchanged');
  assert.equal(sources.countryRows.durationMs, 0);
});

test('a failed optional source with no history stays explicitly unavailable', async () => {
  const sources = {};
  assert.equal(await refreshSection({ key: 'news', label: 'News', sources, fetcher: async () => [] }), null);
  assert.equal(sources.news.status, 'unavailable');
  assert.equal(sources.news.lastSuccessAt, null);
});

test('traffic failure without a saved snapshot fails the build', async () => {
  await assert.rejects(refreshSection({ key: 'rows', label: 'Traffic', sources: {}, fetcher: async () => [] }), /empty_response/);
});

test('provider errors are replaced by fixed public error codes', async () => {
  const sources = {};
  const result = await refreshSection({ key: 'countryRows', label: 'Trade', previous, sources, describe, fetcher: async () => { throw new Error('PRIVATE_TEST_SENTINEL'); } });
  assert.equal(result, oldRows);
  assert.equal(sources.countryRows.errorCode, 'fetch_failed');
  assert.equal(sources.countryRows.change, 'retained');
  assert.ok(!JSON.stringify(sources).includes('PRIVATE_TEST_SENTINEL'));
});
