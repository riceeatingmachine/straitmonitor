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
    if (value == null || (Array.isArray(value) && !value.length)) throw new Error('Source returned no data');
    const info = describe(value);
    const oldInfo = previous?.[key] == null ? {} : describe(previous[key]);
    if (oldInfo.dataThrough && info.dataThrough < oldInfo.dataThrough) throw new Error(`Source regressed from ${oldInfo.dataThrough} to ${info.dataThrough}`);
    for (const [group, date] of Object.entries(oldInfo.groupDates || {})) {
      if (!info.groupDates?.[group] || info.groupDates[group] < date) throw new Error(`Source omitted or regressed ${group}`);
    }
    sources[key] = { label, checkedAt, lastSuccessAt: now(), status: 'ok', ...info };
    console.log(`${label}: ok${info.dataThrough ? `, data through ${info.dataThrough}` : ''}`);
    return value;
  } catch (error) {
    const fallback = previous?.[key];
    sources[key] = { label, checkedAt, lastSuccessAt: prior?.lastSuccessAt || null, status: fallback == null ? 'unavailable' : 'error', error: error.message, ...(fallback == null ? {} : describe(fallback)) };
    console.warn(`::warning::${label}: ${error.message}; ${fallback == null ? 'unavailable' : 'keeping previous data'}`);
    if (key === 'rows' && !fallback?.length) throw error;
    return fallback ?? null;
  }
}
