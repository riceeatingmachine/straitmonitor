import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Explicit public schema. Never copy arbitrary provider, workflow or error fields.
export const SOURCES = {
  rows: 'Hormuz traffic', chokepointRecent: 'Chokepoint comparison',
  chokepointBaselines: 'Chokepoint 2025 baseline', countryRows: 'Country trade',
  countryBaselines: 'Country 2025 baseline', portRows: 'Port activity',
  portBaselines: 'Port 2025 baseline', brent: 'Brent crude',
  polymarket: 'Prediction markets', news: 'Hormuz news', warNews: 'War news', stocks: 'Oil stockpiles'
};
export const STAGES = ['retrieval', 'previews', 'publication', 'verification'];
const RESULTS = ['success', 'failure', 'cancelled', 'skipped', 'unknown'];
const OUTCOMES = ['success', 'partial', 'failure', 'cancelled', 'unknown'];
const TRIGGERS = ['scheduled', 'manual', 'code_update', 'other'];
const CHANGES = ['updated', 'unchanged', 'first_fetch', 'retained', 'unknown'];
export const ERROR_CODES = ['fetch_failed', 'empty_response', 'data_regressed', 'incomplete_response'];
const member = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function publicDate(value) {
  if (timestamp(value)) return timestamp(value);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return null;
  const date = value.length === 7 ? value + '-01' : value;
  return Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date ? value : null;
}
const duration = value => Number.isFinite(value) && value >= 0 && value <= 7 * 86400000 ? Math.round(value) : null;
export function sourceReport(key, source = {}, finishedAt) {
  if (!Object.hasOwn(SOURCES, key)) return null;
  const dataThrough = publicDate(source.dataThrough);
  const lag = { rows: 7, chokepointRecent: 7, countryRows: 7, portRows: 7, brent: 5, news: 2, warNews: 2, polymarket: 1, stocks: 125 }[key];
  const status = member(source.status, ['ok', 'error', 'unavailable'], 'unknown');
  return {
    key, name: SOURCES[key], status,
    checkedAt: timestamp(source.checkedAt), finishedAt: timestamp(source.finishedAt),
    durationMs: duration(source.durationMs), lastSuccessAt: timestamp(source.lastSuccessAt), dataThrough,
    change: member(source.change, CHANGES, 'unknown'),
    errorCode: ERROR_CODES.includes(source.errorCode) ? source.errorCode : null,
    delayed: !!(lag && dataThrough && timestamp(finishedAt) && Date.parse(finishedAt) - Date.parse(dataThrough.length === 7 ? dataThrough + '-01' : dataThrough) > lag * 86400000)
  };
}
export function safeRecord(record) {
  if (!record || !/^[a-f0-9]{20}$/.test(record.id) || !timestamp(record.startedAt)) return null;
  const finishedAt = timestamp(record.finishedAt);
  const sources = Object.keys(SOURCES).flatMap(key => {
    const source = Array.isArray(record.sources) ? record.sources.find(s => s?.key === key) : null;
    return source ? [sourceReport(key, source, finishedAt)] : [];
  });
  return {
    id: record.id, startedAt: timestamp(record.startedAt), finishedAt,
    durationMs: duration(record.durationMs), trigger: member(record.trigger, TRIGGERS, 'other'),
    outcome: member(record.outcome, OUTCOMES, 'unknown'),
    stages: Object.fromEntries(STAGES.map(stage => [stage, member(record.stages?.[stage], RESULTS, 'unknown')])),
    sources, detail: sources.length ? 'recorded' : 'not_recorded'
  };
}
export function makeRecord({ runId, attempt = 1, startedAt, finishedAt, trigger, result, stages, report }) {
  const sources = Object.keys(SOURCES).flatMap(key => report?.sources?.[key] ? [sourceReport(key, report.sources[key], finishedAt)] : []);
  const incomplete = sources.length > 0 && sources.length < Object.keys(SOURCES).length;
  const outcome = result === 'success' ? (incomplete || sources.some(s => s.status !== 'ok') ? 'partial' : 'success') : member(result, OUTCOMES, 'unknown');
  return safeRecord({
    id: createHash('sha256').update(`${runId}:${attempt}`).digest('hex').slice(0, 20), startedAt, finishedAt,
    durationMs: timestamp(startedAt) && timestamp(finishedAt) ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
    trigger: { schedule: 'scheduled', workflow_dispatch: 'manual', push: 'code_update' }[trigger] || 'other',
    outcome, stages, sources
  });
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function saveRecords(dataDir, records) {
  const archiveDir = path.join(dataDir, 'status');
  await mkdir(archiveDir, { recursive: true });
  const previous = await readJson(path.join(dataDir, 'status.json'), { months: [] });
  const months = new Map((previous.months || []).filter(m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m.month)).map(m => [m.month, { month: m.month, count: Number.isSafeInteger(m.count) && m.count >= 0 ? m.count : 0 }]));
  let latest = safeRecord(previous.latest);
  let historySince = timestamp(previous.historySince);
  const grouped = new Map();
  for (const input of records) {
    const record = safeRecord(input);
    if (!record) throw new Error('Invalid public status record');
    const month = record.startedAt.slice(0, 7);
    if (!grouped.has(month)) grouped.set(month, []);
    grouped.get(month).push(record);
    if (!latest || record.startedAt >= latest.startedAt) latest = record;
    if (!historySince || record.startedAt < historySince) historySince = record.startedAt;
  }
  for (const [month, incoming] of grouped) {
    const file = path.join(archiveDir, `${month}.json`);
    const old = await readJson(file, { runs: [] });
    const runs = new Map((old.runs || []).map(safeRecord).filter(Boolean).map(r => [r.id, r]));
    for (const record of incoming) runs.set(record.id, record);
    const ordered = [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    await writeFile(file, JSON.stringify({ schemaVersion: 1, month, runs: ordered }) + '\n');
    months.set(month, { month, count: ordered.length });
  }
  const orderedMonths = [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
  const index = { schemaVersion: 1, updatedAt: new Date().toISOString(), historySince, totalRuns: orderedMonths.reduce((n, m) => n + m.count, 0), months: orderedMonths, latest };
  await writeFile(path.join(dataDir, 'status.json'), JSON.stringify(index) + '\n');
  return index;
}
