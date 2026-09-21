(function (root) {
  'use strict';
  var DAY = 86400000;
  function validSnapshot(snap) {
    return !!(snap && Number.isFinite(Date.parse(snap.fetchedAt)) &&
      Array.isArray(snap.columns) && snap.columns[0] === 'date' && snap.columns.includes('n_total') &&
      Array.isArray(snap.rows) && snap.rows.length >= 300 &&
      snap.rows.every(function (row) {
        return Array.isArray(row) && row.length === snap.columns.length && /^\d{4}-\d{2}-\d{2}$/.test(row[0]) &&
          row.slice(1).every(function (n) { return Number.isFinite(n) && n >= 0; });
      }));
  }
  function sourceState(source, now) {
    if (!source || source.status === 'unavailable') return 'Unavailable';
    if (source.status === 'error') return 'Refresh failed · saved data';
    var dates = Object.values(source.groupDates || {});
    var through = dates.length ? dates.sort()[0] : source.dataThrough;
    if (through && now - Date.parse(through.length === 7 ? through + '-01' : through) > (source.expectedLagDays || 7) * DAY) return 'Source delayed';
    if (!source.lastSuccessAt || now - Date.parse(source.lastSuccessAt) > 12 * 3600000) return 'Check overdue';
    return 'Checked';
  }
  var api = { validSnapshot: validSnapshot, sourceState: sourceState };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HormuzDataStatus = api;
})(typeof window === 'object' ? window : globalThis);
