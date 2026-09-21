(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var index = null, runs = [], visibleCount = 20, request = null, revision = 0;
  var outcomes = { success: 'Successful', partial: 'Partial data', failure: 'Failed', cancelled: 'Cancelled', unknown: 'Not recorded' };
  var triggers = { scheduled: 'Scheduled', manual: 'Manual', code_update: 'Code update', other: 'Refresh' };
  var stages = { retrieval: 'Data retrieval', previews: 'Social previews', publication: 'Publication', verification: 'Public site check' };
  var stageResults = { success: 'Passed', failure: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled', unknown: 'Not recorded' };
  var changes = { updated: 'Updated', unchanged: 'Unchanged', first_fetch: 'First fetch', retained: 'Saved data retained', unknown: 'Not recorded' };
  var errors = { fetch_failed: 'The source could not be fetched.', empty_response: 'The source returned no usable data.', data_regressed: 'The response was older than the saved data.', incomplete_response: 'The response was incomplete.' };
  function node(tag, text, className) {
    var el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function time(value) {
    var date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : 'Not recorded';
  }
  function dataDate(value) {
    if (!value) return 'Not available';
    if (/^\d{4}-\d{2}$/.test(value)) return new Date(value + '-01').toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' });
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value).toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
    return time(value);
  }
  function duration(ms) {
    if (!Number.isFinite(ms)) return 'Duration not recorded';
    return ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round(ms % 60000 / 1000) + 's';
  }
  async function get(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await fetch(url + '?v=' + Date.now(), { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Status unavailable');
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  function badge(result) {
    var el = node('span', outcomes[result] || outcomes.unknown, 'pull-badge');
    el.dataset.result = Object.hasOwn(outcomes, result) ? result : 'unknown';
    return el;
  }
  function sourceTable(sources) {
    var wrap = node('div', null, 'pull-table-scroll'), table = node('table', null, 'pull-table');
    var head = node('thead'), headings = node('tr');
    ['Public source', 'Fetch result', 'Data change', 'Data through', 'Duration'].forEach(function (label) { var th = node('th', label); th.scope = 'col'; headings.appendChild(th); });
    head.appendChild(headings); table.appendChild(head);
    var body = node('tbody');
    sources.forEach(function (source) {
      var tr = node('tr'), th = node('th', source.name); th.scope = 'row'; tr.appendChild(th);
      var result = source.status === 'ok' ? 'Fetched' : source.status === 'error' ? 'Failed · saved data' : source.status === 'unavailable' ? 'Unavailable' : 'Not recorded';
      var cell = node('td', result, source.status === 'ok' ? 'pull-source-ok' : 'pull-source-failed');
      if (source.errorCode && errors[source.errorCode]) cell.appendChild(node('small', errors[source.errorCode]));
      tr.appendChild(cell); tr.appendChild(node('td', changes[source.change] || changes.unknown));
      cell = node('td', dataDate(source.dataThrough));
      if (source.delayed) cell.appendChild(node('small', 'Publicly available data is delayed'));
      tr.appendChild(cell); tr.appendChild(node('td', duration(source.durationMs))); body.appendChild(tr);
    });
    table.appendChild(body); wrap.appendChild(table); return wrap;
  }
  function render() {
    var filter = $('history-filter').value;
    var filtered = runs.filter(function (run) { return filter === 'all' || (filter === 'success' ? run.outcome === 'success' : run.outcome !== 'success'); });
    var container = $('pull-history');
    var open = new Set(Array.from(container.querySelectorAll('details[open]')).map(function (el) { return el.dataset.id; }));
    container.replaceChildren();
    filtered.slice(0, visibleCount).forEach(function (run) {
      var detail = node('details', null, 'pull-run'); detail.dataset.id = run.id; detail.open = open.has(run.id);
      var summary = node('summary');
      var date = node('time', time(run.startedAt)); date.dateTime = run.startedAt;
      summary.appendChild(date); summary.appendChild(badge(run.outcome));
      var passed = run.sources.filter(function (s) { return s.status === 'ok'; }).length;
      summary.appendChild(node('span', (triggers[run.trigger] || triggers.other) + ' · ' + duration(run.durationMs) + ' · ' + (run.sources.length ? passed + '/' + run.sources.length + ' sources fetched' : 'Source details not recorded'), 'pull-run-meta'));
      detail.appendChild(summary);
      var body = node('div', null, 'pull-run-body'), phaseList = node('div', null, 'pull-stages');
      Object.keys(stages).forEach(function (stage) { phaseList.appendChild(node('span', stages[stage] + ': ' + (stageResults[run.stages[stage]] || stageResults.unknown))); });
      body.appendChild(phaseList);
      if (run.sources.length) body.appendChild(sourceTable(run.sources));
      else body.appendChild(node('p', 'Source-level results were not recorded for this pull. Its overall outcome is shown above.', 'pull-detail-note'));
      body.appendChild(node('p', 'Finished ' + time(run.finishedAt) + ' UTC', 'pull-detail-note'));
      detail.appendChild(body); container.appendChild(detail);
    });
    if (!filtered.length) container.appendChild(node('p', 'No pulls match this filter.', 'pull-empty'));
    $('history-more').hidden = filtered.length <= visibleCount;
    $('history-more').textContent = 'Show ' + Math.min(20, Math.max(0, filtered.length - visibleCount)) + ' more pulls';
  }
  async function loadMonth() {
    var month = $('history-month').value;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    var ticket = ++revision;
    var archive = await get('data/status/' + month + '.json');
    if (ticket !== revision) return;
    if (archive.month !== month || !Array.isArray(archive.runs)) throw new Error('Invalid history');
    runs = archive.runs; render();
  }
  function overview() {
    var latest = index.latest;
    $('total-pulls').textContent = Number(index.totalRuns).toLocaleString('en-GB');
    $('history-since').textContent = 'Since ' + dataDate(index.historySince && index.historySince.slice(0, 10));
    $('latest-result').textContent = latest ? outcomes[latest.outcome] || outcomes.unknown : 'No pulls yet';
    $('latest-time').textContent = latest ? time(latest.finishedAt) + ' UTC' : '';
    $('history-published').textContent = 'History last published ' + time(index.updatedAt) + ' UTC.';
    var messages = [];
    if (latest && Date.now() - Date.parse(latest.startedAt) > 36 * 3600000) messages.push('A scheduled pull is overdue.');
    if (latest && latest.sources.some(function (s) { return s.delayed; })) messages.push('Publicly available data is delayed. A successful fetch can still return an older observation.');
    if (latest && latest.outcome !== 'success') messages.push('The latest pull needs attention. Expand its results below.');
    $('pull-notice').textContent = messages.join(' '); $('pull-notice').hidden = !messages.length;
  }
  function refresh() {
    if (request) return request;
    $('history-refresh').disabled = true;
    $('history-check').textContent = 'Checking published status…';
    request = get('data/status.json').then(async function (value) {
      if (value.schemaVersion !== 1 || !Array.isArray(value.months)) throw new Error('Invalid index');
      index = value; var selected = $('history-month').value;
      $('history-month').replaceChildren();
      value.months.filter(function (m) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(m.month); }).forEach(function (m) {
        var option = node('option', dataDate(m.month) + ' · ' + m.count + ' pulls'); option.value = m.month; $('history-month').appendChild(option);
      });
      if (value.months.some(function (m) { return m.month === selected; })) $('history-month').value = selected;
      overview(); await loadMonth(); $('history-check').textContent = 'Showing the latest published results.';
    }).catch(function () {
      $('history-check').textContent = 'Could not load published status. Please retry; any previously loaded results remain below.';
    }).finally(function () { $('history-refresh').disabled = false; request = null; });
    return request;
  }
  $('history-refresh').addEventListener('click', refresh);
  $('history-month').addEventListener('change', function () {
    visibleCount = 20; runs = []; render(); $('history-check').textContent = 'Loading this month…';
    loadMonth().then(function () { $('history-check').textContent = 'Showing published results.'; }).catch(function () { $('history-check').textContent = 'Could not load this month. Please retry.'; });
  });
  $('history-filter').addEventListener('change', function () { visibleCount = 20; render(); });
  $('history-more').addEventListener('click', function () { visibleCount += 20; render(); });
  refresh();
  setInterval(function () { if (document.visibilityState === 'visible') refresh(); }, 5 * 60000);
})();
