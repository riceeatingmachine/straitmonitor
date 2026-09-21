// Keep retrieval time separate from the dates actually covered by a source.
export function latestDate(rows, index = 0) {
  return (rows || []).reduce((latest, row) => typeof row[index] === 'string' && row[index] > latest ? row[index] : latest, '') || null;
}

export function groupDates(rows, groupIndex, dateIndex) {
  const dates = {};
  for (const row of rows || []) {
    const key = row[groupIndex], date = row[dateIndex];
    if (!dates[key] || date > dates[key]) dates[key] = date;
  }
  return dates;
}

export async function collectPages(fetchPage, params) {
  const rows = [];
  let offset = 0;
  for (let page = 0; page < 1000; page++) {
    const result = await fetchPage({ ...params, resultOffset: String(offset) });
    rows.push(...result.features.map(f => f.attributes));
    if (!result.exceededTransferLimit) return rows;
    if (!result.features.length) throw new Error('PortWatch pagination made no progress');
    if (params.outStatistics) throw new Error('PortWatch statistics response was truncated');
    offset += result.features.length;
  }
  throw new Error('PortWatch pagination limit exceeded');
}

export async function refreshSection({ key, label, fetcher, previous, sources, describe = () => ({}), now = () => new Date().toISOString() }) {
  const checkedAt = now();
  const prior = previous?.sources?.[key];
  try {
    const value = await fetcher();
    if (value == null || (Array.isArray(value) && !value.length)) throw new PullError('empty_response');
    const info = describe(value);
    const oldInfo = previous?.[key] == null ? {} : describe(previous[key]);
    if (oldInfo.dataThrough && info.dataThrough < oldInfo.dataThrough) throw new PullError('data_regressed');
    for (const [group, date] of Object.entries(oldInfo.groupDates || {})) {
      if (!info.groupDates?.[group] || info.groupDates[group] < date) throw new PullError('incomplete_response');
    }
    const finishedAt = now();
    const comparable = value => key === 'polymarket' ? value?.events : value;
    const change = previous?.[key] == null ? 'first_fetch' : JSON.stringify(comparable(value)) === JSON.stringify(comparable(previous[key])) ? 'unchanged' : 'updated';
    sources[key] = { label, checkedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(checkedAt), lastSuccessAt: finishedAt, status: 'ok', change, ...info };
    console.log(`${label}: ok${info.dataThrough ? `, data through ${info.dataThrough}` : ''}`);
    return value;
  } catch (error) {
    const fallback = previous?.[key];
    const finishedAt = now();
    const errorCode = error instanceof PullError ? error.code : 'fetch_failed';
    sources[key] = { label, checkedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(checkedAt), lastSuccessAt: prior?.lastSuccessAt || null, status: fallback == null ? 'unavailable' : 'error', errorCode, change: fallback == null ? 'unknown' : 'retained', ...(fallback == null ? {} : describe(fallback)) };
    console.warn(`::warning::${label}: ${errorCode}; ${fallback == null ? 'unavailable' : 'keeping previous data'}`);
    if (key === 'rows' && !fallback?.length) throw new PullError(errorCode);
    return fallback ?? null;
  }
}

class PullError extends Error {
  constructor(code) { super(code); this.code = code; }
}
