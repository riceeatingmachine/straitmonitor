/* Hormuz Transit Watch — application script
 *
 * Data: IMF PortWatch (chokepoint transits, country trade estimates, port activity), Brent via Yahoo/FRED,
 *       Google News RSS. All of it arrives through data/snapshot.js, rebuilt every 3 hours by the workflow.
 * Timeline: data/events.js (window.HORMUZ_EVENTS).
 */
(function () {
  'use strict';

  // ---------- Config ----------

  // 'cached': the page reads only data/snapshot.js, which a scheduled job (see .github/workflows) rebuilds
  //           every 3 hours. Visitors' browsers never call an outside API.
  // 'live':   every visitor queries PortWatch and Google News directly (Brent and ports stay from the snapshot).
  var DATA_MODE = 'cached';
  var SNAPSHOT_JSON = 'data/snapshot.json';
  var STALE_AFTER_MS = 12 * 60 * 60 * 1000;

  var BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
  var TRADE_BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Trade_Data_REG/FeatureServer/0/query';

  var PORTWATCH_URL = BASE +
    '?where=' + encodeURIComponent("portid='chokepoint6' AND date >= DATE '2025-01-01'") +
    '&outFields=date,n_total,n_tanker,n_container,n_dry_bulk,n_general_cargo,n_roro,capacity,capacity_tanker' +
    '&orderByFields=date+ASC&resultRecordCount=2000&f=json';

  var CHOKE_RECENT_URL = BASE +
    '?where=' + encodeURIComponent('date >= CURRENT_DATE - 14') +
    '&outFields=date,portid,portname,n_total,n_tanker,capacity&orderByFields=date+ASC&resultRecordCount=2000&f=json';

  var CHOKE_BASELINE_URL = BASE +
    '?where=' + encodeURIComponent('year=2025') +
    '&groupByFieldsForStatistics=portid,portname' +
    '&outStatistics=' + encodeURIComponent(JSON.stringify([
      { statisticType: 'avg', onStatisticField: 'n_total', outStatisticFieldName: 'avg_total' },
      { statisticType: 'avg', onStatisticField: 'n_tanker', outStatisticFieldName: 'avg_tanker' },
      { statisticType: 'avg', onStatisticField: 'capacity', outStatisticFieldName: 'avg_capacity' }
    ])) + '&f=json';

  var NEWS_RSS = 'https://news.google.com/rss/search?q=%22Strait+of+Hormuz%22&hl=en-US&gl=US&ceid=US:en';
  var NEWS_URL = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(NEWS_RSS);
  var WAR_RSS = 'https://news.google.com/rss/search?q=Iran+(war+OR+strike+OR+strikes+OR+missile+OR+missiles+OR+ceasefire+OR+IRGC+OR+blockade+OR+drone+OR+navy+OR+CENTCOM+OR+sanctions)&hl=en-US&gl=US&ceid=US:en';
  var WAR_URL = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(WAR_RSS);

  var CRISIS_START = '2026-02-28';
  var CRISIS_START_MS = Date.UTC(2026, 1, 28, 0, 0, 0);
  var CRISIS_RANGE_START = '2026-02-01';

  var COUNTRIES = [
    { key: 'QAT', name: 'Qatar', note: 'Inside the strait. LNG and condensate from Ras Laffan.' },
    { key: 'KWT', name: 'Kuwait', note: 'Inside the strait. Crude and products from Mina al-Ahmadi.' },
    { key: 'IRQ', name: 'Iraq', note: 'Inside the strait. Crude from the Basra offshore terminals.' },
    { key: 'BHR', name: 'Bahrain', note: 'Inside the strait. Refined products from Sitra.' },
    { key: 'IRN', name: 'Iran', note: 'Inside the strait; ports also under US blockade since April.' },
    { key: 'SAU', name: 'Saudi Arabia', note: 'Gulf terminals inside; Red Sea ports such as Yanbu outside.', partial: true },
    { key: 'ARE', name: 'United Arab Emirates', note: 'Gulf ports inside; Fujairah and Khor Fakkan outside.', partial: true },
    { key: 'OMN', name: 'Oman', note: 'Entirely outside the strait, shown for contrast.', outside: true }
  ];
  var CMETRICS = {
    export: { key: 'export', base: 'avg_export', label: 'exports', fmt: fmtTonnes, perDay: true },
    export_tanker: { key: 'export_tanker', base: 'avg_export_tanker', label: 'tanker exports', fmt: fmtTonnes, perDay: true },
    import: { key: 'import', base: 'avg_import', label: 'imports', fmt: fmtTonnes, perDay: true }
  };

  var PORTS = [
    { key: 'port570', name: 'Yanbu', sub: 'Saudi Arabia · Red Sea', group: 'outside', note: 'Receives Gulf crude through the East–West pipeline; the main bypass route.' },
    { key: 'port362', name: 'Fujairah', sub: 'UAE · Gulf of Oman', group: 'outside', note: 'Fed by the Habshan–Fujairah pipeline; major bunkering and storage hub.' },
    { key: 'port988', name: 'Sohar', sub: 'Oman · Gulf of Oman', group: 'outside', note: 'Refinery and industrial port just outside the strait.' },
    { key: 'port746', name: 'Salalah', sub: 'Oman · Arabian Sea', group: 'outside', note: 'Container transshipment hub far from the strait.' },
    { key: 'port526', name: 'Juaymah', sub: 'Saudi Arabia · Persian Gulf', group: 'inside', note: 'Saudi Arabia’s largest crude loading terminal.' },
    { key: 'port1090', name: 'Ras Laffan', sub: 'Qatar · Persian Gulf', group: 'inside', note: 'The world’s largest LNG export complex.' },
    { key: 'port2479', name: 'Basrah Oil Terminal', sub: 'Iraq · Persian Gulf', group: 'inside', note: 'Iraq’s main crude outlet.' },
    { key: 'port744', name: 'Jebel Ali', sub: 'UAE · Persian Gulf', group: 'inside', note: 'The region’s largest container port.' }
  ];
  var PGROUPS = [
    { id: 'outside', label: 'Outlets outside the strait' },
    { id: 'inside', label: 'Terminals inside the strait' }
  ];
  var PMETRICS = {
    export: { key: 'export', base: 'avg_export', label: 'exports', fmt: fmtTonnes, perDay: true },
    import: { key: 'import', base: 'avg_import', label: 'imports', fmt: fmtTonnes, perDay: true },
    portcalls: { key: 'portcalls', base: 'avg_calls', label: 'port calls', fmt: fmtCalls, perDay: true }
  };

  var COMPARE = [
    'Strait of Hormuz', 'Bab el-Mandeb Strait', 'Suez Canal', 'Cape of Good Hope',
    'Malacca Strait', 'Panama Canal', 'Bosporus Strait', 'Gibraltar Strait'
  ];

  var EVENTS = (window.HORMUZ_EVENTS || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

  var TYPES = [
    { key: 'tanker', label: 'Tankers' },
    { key: 'container', label: 'Container ships' },
    { key: 'dry_bulk', label: 'Dry bulk carriers' },
    { key: 'general_cargo', label: 'General cargo' },
    { key: 'roro', label: 'Ro-Ro / vehicle carriers' }
  ];

  var METRICS = {
    total: { key: 'total', title: 'Daily transits vs. 2025 baseline', unit: 'transits', legend: 'Daily transits', fmt: function (v) { return fmtNum(v, v < 10 && v !== Math.round(v) ? 1 : 0); } },
    tanker: { key: 'tanker', title: 'Daily tanker transits vs. 2025 baseline', unit: 'tankers', legend: 'Daily tanker transits', fmt: function (v) { return fmtNum(v, v < 10 && v !== Math.round(v) ? 1 : 0); } },
    capacity: { key: 'capacity', title: 'Daily deadweight tonnage vs. 2025 baseline', unit: 'dwt', legend: 'Daily capacity (dwt)', fmt: fmtDwt }
  };

  // ---------- State ----------

  var state = {
    rows: [], baseline: null,
    war: 'all', warItems: [], warShowAll: false,   // war tracker filter, the classified headlines, and whether the list is expanded
    bmetric: 'export',   // measure shown in the country balance panel
    stocks: null, stocksShowAll: false,   // JODI crude stock levels by country and whether the list is expanded
    chokeRecent: [], chokeBaselines: {},
    countryRows: {}, countryBaselines: {},
    portRows: {}, portBaselines: {},
    brent: null,
    markets: null,       // {fetchedAt, events: [{slug, title, volume, endDate, description, markets: [{question, short, yes, volume, change1d, change1w, endDate, description}]}]}
    range: 'crisis', brange: 'crisis', metric: 'total', cmetric: 'export', pmetric: 'export',
    views: { countries: 'chart', ports: 'chart', brent: 'chart' },
    source: 'snapshot'
  };

  // ---------- Utilities ----------

  function $(id) { return document.getElementById(id); }

  function parseDate(s) {
    var p = s.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtDate(s, withYear) {
    var d = parseDate(s);
    var out = d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
    if (withYear) out += ' ' + d.getUTCFullYear();
    return out;
  }

  function fmtNum(n, digits) {
    if (n == null || isNaN(n)) return '–';
    if (digits == null) digits = 0;
    return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fmtDwt(v) {
    if (v == null || isNaN(v)) return '–';
    if (v >= 1e6) return fmtNum(v / 1e6, v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e3) return fmtNum(v / 1e3, 0) + 'k';
    return fmtNum(v, 0);
  }

  function fmtTonnes(t) {
    if (t == null || isNaN(t)) return '–';
    if (t >= 1e6) return fmtNum(t / 1e6, 2) + ' Mt';
    if (t >= 1e3) return fmtNum(t / 1e3, 0) + ' kt';
    return fmtNum(t, 0) + ' t';
  }

  function fmtCalls(v) {
    if (v == null || isNaN(v)) return '–';
    return fmtNum(v, v < 10 ? 1 : 0) + (v === 1 ? ' call' : ' calls');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // Percentages keep 1–2 significant digits below 10 so small values never collapse to "0%".
  function fmtPct(p) {
    if (p == null || isNaN(p)) return '–';
    var a = Math.abs(p);
    if (a === 0) return '0';
    if (a < 0.01) return (p < 0 ? '−' : '') + '<0.01';
    if (a >= 10) return fmtNum(p, 0);
    if (a >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
    return String(parseFloat(p.toPrecision(2)));
  }

  function fmtStamp(iso) {
    var t = Date.parse(iso || '');
    if (isNaN(t)) return 'unknown time';
    var d = new Date(t);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function pct(value, base) {
    if (!base) return null;
    return (value / base) * 100;
  }

  function levelFor(p) {
    if (p == null) return '';
    if (p < 25) return 'critical';
    if (p < 75) return 'warn';
    return 'good';
  }

  function mean(arr, key) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i][key];
    return s / arr.length;
  }

  function daysBetween(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
  }

  function isoFromMs(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function todayISO() { return isoFromMs(Date.now()); }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    if (children) children.forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function svgEl(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    return e;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function relTime(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dateStr || '');
    var t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.parse(dateStr);
    if (isNaN(t)) return '';
    var diff = Math.max(0, Date.now() - t);
    var mins = Math.round(diff / 60000);
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' h ago';
    var days = Math.round(hrs / 24);
    if (days < 7) return days + ' d ago';
    var d = new Date(t);
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }

  function fetchJson(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    return fetch(url, { cache: 'no-store', signal: controller.signal }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).finally(function () { clearTimeout(timer); });
  }

  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }

  function rolling7(rows, key) {
    return rows.map(function (r, i) {
      var from = Math.max(0, i - 6), s = 0;
      for (var j = from; j <= i; j++) s += rows[j][key];
      return s / (i - from + 1);
    });
  }

  // ---------- Data shaping ----------

  function normDate(v) {
    if (typeof v === 'number') return isoFromMs(v);
    return String(v).slice(0, 10);
  }

  function rowFromAttrs(a) {
    return {
      date: normDate(a.date),
      total: a.n_total || 0, tanker: a.n_tanker || 0, container: a.n_container || 0,
      dry_bulk: a.n_dry_bulk || 0, general_cargo: a.n_general_cargo || 0, roro: a.n_roro || 0,
      capacity: a.capacity || 0, capacity_tanker: a.capacity_tanker || 0
    };
  }

  function unpack(columns, arrays) {
    return arrays.map(function (arr) {
      var a = {};
      columns.forEach(function (c, i) { a[c] = arr[i]; });
      return a;
    });
  }

  function chokeFromAttrs(a) {
    return { date: normDate(a.date), portid: a.portid, portname: a.portname, total: a.n_total || 0, tanker: a.n_tanker || 0, capacity: a.capacity || 0 };
  }

  function groupSeries(records, keyField, mapper) {
    var out = {};
    records.forEach(function (a) {
      (out[a[keyField]] = out[a[keyField]] || []).push(mapper(a));
    });
    Object.keys(out).forEach(function (k) { out[k].sort(byDate); });
    return out;
  }

  function indexBy(list, field) {
    var out = {};
    (list || []).forEach(function (b) { out[b[field]] = b; });
    return out;
  }

  function computeBaseline(rows) {
    var y2025 = rows.filter(function (r) { return r.date >= '2025-01-01' && r.date <= '2025-12-31'; });
    var b = { days: y2025.length };
    ['total', 'tanker', 'container', 'dry_bulk', 'general_cargo', 'roro', 'capacity', 'capacity_tanker'].forEach(function (k) {
      b[k] = mean(y2025, k);
    });
    return b;
  }

  function loadSnapshot() {
    var snap = window.HORMUZ_SNAPSHOT;
    if (!window.HormuzDataStatus.validSnapshot(snap)) return false;
    state.rows = unpack(snap.columns, snap.rows).map(rowFromAttrs).sort(byDate);
    state.baseline = computeBaseline(state.rows);
    if (snap.chokepointRecent && snap.chokepointColumns) {
      state.chokeRecent = unpack(snap.chokepointColumns, snap.chokepointRecent).map(chokeFromAttrs).sort(byDate);
    }
    state.chokeBaselines = indexBy(snap.chokepointBaselines, 'portname');
    if (snap.countryRows && snap.countryColumns) {
      state.countryRows = groupSeries(unpack(snap.countryColumns, snap.countryRows), 'iso3', function (a) {
        return { date: normDate(a.date), export: a.export || 0, export_tanker: a.export_tanker || 0, import: a.import || 0 };
      });
    }
    state.countryBaselines = indexBy(snap.countryBaselines, 'iso3');
    if (snap.portRows && snap.portColumns) {
      state.portRows = groupSeries(unpack(snap.portColumns, snap.portRows), 'portid', function (a) {
        return { date: normDate(a.date), export: a.export || 0, import: a.import || 0, portcalls: a.portcalls || 0 };
      });
    }
    state.portBaselines = indexBy(snap.portBaselines, 'portid');
    if (snap.brent && snap.brent.series && snap.brent.series.length) {
      state.brent = {
        source: snap.brent.source, label: snap.brent.label, unit: snap.brent.unit,
        series: snap.brent.series.map(function (p) { return { date: normDate(p[0]), price: +p[1] }; }).sort(byDate)
      };
    }
    state.markets = (snap.polymarket && snap.polymarket.events && snap.polymarket.events.length) ? snap.polymarket : null;
    state.stocks = (snap.stocks && snap.stocks.countries) ? snap.stocks : null;
    state.source = 'snapshot';
    return true;
  }

  // Live-mode loaders (unused in cached mode)

  function loadLive() {
    return fetchJson(PORTWATCH_URL).then(function (json) {
      if (!json.features || json.features.length < 300) throw new Error('Unexpected series');
      state.rows = json.features.map(function (f) { return rowFromAttrs(f.attributes); }).sort(byDate);
      state.baseline = computeBaseline(state.rows);
      state.source = 'live';
    });
  }

  function loadChokepoints() {
    return Promise.all([fetchJson(CHOKE_RECENT_URL), fetchJson(CHOKE_BASELINE_URL)]).then(function (res) {
      if (!res[0].features || !res[1].features) throw new Error('No chokepoint data');
      state.chokeRecent = res[0].features.map(function (f) { return chokeFromAttrs(f.attributes); }).sort(byDate);
      var map = {};
      res[1].features.forEach(function (f) { map[f.attributes.portname] = f.attributes; });
      state.chokeBaselines = map;
    });
  }

  function loadCountries() {
    var inList = "ISO3 IN ('" + COUNTRIES.map(function (c) { return c.key; }).join("','") + "')";
    var baseUrl = TRADE_BASE + '?where=' + encodeURIComponent(inList + " AND date >= DATE '2025-01-01' AND date <= DATE '2025-12-31'") +
      '&groupByFieldsForStatistics=ISO3,country&outStatistics=' + encodeURIComponent(JSON.stringify([
        { statisticType: 'avg', onStatisticField: 'export', outStatisticFieldName: 'avg_export' },
        { statisticType: 'avg', onStatisticField: 'export_tanker', outStatisticFieldName: 'avg_export_tanker' },
        { statisticType: 'avg', onStatisticField: 'import', outStatisticFieldName: 'avg_import' }
      ])) + '&f=json';
    var rowReqs = COUNTRIES.map(function (c) {
      var url = TRADE_BASE + '?where=' + encodeURIComponent("ISO3='" + c.key + "' AND date >= DATE '2026-01-01'") +
        '&outFields=date,export,export_tanker,import&orderByFields=date+ASC&resultRecordCount=2000&f=json';
      return fetchJson(url).then(function (json) {
        return { key: c.key, rows: (json.features || []).map(function (f) {
          var a = f.attributes;
          return { date: normDate(a.date), export: a.export || 0, export_tanker: a.export_tanker || 0, import: a.import || 0 };
        }).sort(byDate) };
      });
    });
    return Promise.all([fetchJson(baseUrl), Promise.all(rowReqs)]).then(function (res) {
      var cb = {};
      (res[0].features || []).forEach(function (f) {
        var a = f.attributes;
        cb[a.ISO3] = { iso3: a.ISO3, country: a.country, avg_export: a.avg_export, avg_export_tanker: a.avg_export_tanker, avg_import: a.avg_import };
      });
      if (!Object.keys(cb).length) throw new Error('No country baselines');
      var byKey = {};
      res[1].forEach(function (r) { byKey[r.key] = r.rows; });
      state.countryBaselines = cb;
      state.countryRows = byKey;
    });
  }

  // ---------- URL state ----------

  var HASH_KEYS = {
    range: /^(30|90|crisis|all)$/, metric: /^(total|tanker|capacity)$/, cmetric: /^(export|export_tanker|import)$/,
    pmetric: /^(export|import|portcalls)$/, brange: /^(crisis|all)$/
  };
  var HASH_DEFAULTS = { range: 'crisis', metric: 'total', cmetric: 'export', pmetric: 'export', brange: 'crisis' };

  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return;
    h.split('&').forEach(function (kv) {
      var p = kv.split('=');
      var k = p[0], v = decodeURIComponent(p[1] || '');
      if (HASH_KEYS[k] && HASH_KEYS[k].test(v)) state[k] = v;
    });
  }

  function writeHash() {
    var parts = [];
    Object.keys(HASH_DEFAULTS).forEach(function (k) {
      if (state[k] !== HASH_DEFAULTS[k]) parts.push(k + '=' + encodeURIComponent(state[k]));
    });
    var h = parts.length ? '#' + parts.join('&') : '';
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + h);
  }

  function syncSegments() {
    var map = { '#range-seg': ['data-range', 'range'], '#metric-seg': ['data-metric', 'metric'], '#cmetric-seg': ['data-cmetric', 'cmetric'],
      '#pmetric-seg': ['data-pmetric', 'pmetric'], '#brent-seg': ['data-brange', 'brange'] };
    Object.keys(map).forEach(function (sel) {
      document.querySelectorAll(sel + ' button[' + map[sel][0] + ']').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute(map[sel][0]) === state[map[sel][1]] ? 'true' : 'false');
      });
    });
  }

  // ---------- Header, notices, tiles ----------

  function setDelta(id, p) {
    var e = $(id);
    e.textContent = p == null ? '–' : fmtPct(p) + '% of baseline';
    e.setAttribute('data-level', levelFor(p));
  }

  function setMeter(id, p) {
    $(id).style.width = Math.max(0, Math.min(100, p || 0)) + '%';
  }

  function renderCounter() {
    var diff = Math.max(0, Date.now() - CRISIS_START_MS);
    $('counter-days').textContent = fmtNum(Math.floor(diff / 86400000));
    $('counter-hours').textContent = pad2(Math.floor((diff % 86400000) / 3600000));
    $('counter-mins').textContent = pad2(Math.floor((diff % 3600000) / 60000));
  }

  function renderStale() {
    var box = $('stale-notice');
    var snap = window.HORMUZ_SNAPSHOT;
    if (DATA_MODE !== 'cached' || !snap || !snap.fetchedAt) { box.hidden = true; return; }
    var messages = [];
    var age = Date.now() - Date.parse(snap.fetchedAt);
    if (age > STALE_AFTER_MS) messages.push('The last published check was ' + fmtStamp(snap.fetchedAt) + '. A scheduled update is overdue.');
    var sources = snap.sources || {};
    var delayed = [], failed = [];
    var list = $('source-status-list');
    list.replaceChildren();
    ['rows', 'chokepointRecent', 'countryRows', 'portRows', 'brent', 'news', 'warNews', 'polymarket', 'stocks', 'chokepointBaselines', 'countryBaselines', 'portBaselines'].filter(function (key) { return sources[key]; }).forEach(function (key) {
      var source = sources[key];
      var status = window.HormuzDataStatus.sourceState(source, Date.now());
      if (status === 'Source delayed') delayed.push(source.label);
      if (source.status !== 'ok') failed.push(source.label);
      if (/Baselines$/.test(key)) return;
      var dates = Object.values(source.groupDates || {}).sort();
      var through = source.dataThrough ? (source.dataThrough.length === 7 ? fmtMonth(source.dataThrough) : source.dataThrough.length === 10 ? fmtDate(source.dataThrough, true) : fmtStamp(source.dataThrough)) : 'Not available';
      if (dates.length && dates[0] !== dates[dates.length - 1]) through = fmtDate(dates[0], true) + ' to ' + fmtDate(dates[dates.length - 1], true);
      list.appendChild(el('tr', null, [
        el('th', { scope: 'row', text: source.label }),
        el('td', { text: through }),
        el('td', { text: status }),
        el('td', { text: source.lastSuccessAt ? fmtStamp(source.lastSuccessAt) : 'Not recorded' })
      ]));
    });
    if (delayed.length) messages.push('Source data is delayed: ' + delayed.join(', ') + '. Dates below show the latest published observations.');
    if (failed.length) messages.push('Some feeds could not refresh: ' + failed.join(', ') + '. Last available figures are retained.');
    if (!Object.keys(sources).length && state.rows.length && daysBetween(state.rows[state.rows.length - 1].date, todayISO()) > 7) {
      messages.push('Traffic observations are more than a week old. The site check time is separate from the observation date.');
    }
    $('source-status').hidden = !Object.keys(sources).length;
    box.textContent = messages.join(' ');
    box.hidden = !messages.length;
  }

  function renderHeader() {
    var rows = state.rows, b = state.baseline;
    var latest = rows[rows.length - 1];
    var last7 = rows.slice(-7);
    var week = mean(last7, 'total');
    var pWeek = pct(week, b.total);

    var pill = $('status-pill');
    var level = levelFor(pWeek);
    pill.setAttribute('data-level', level);
    var word = level === 'critical' ? 'Severely restricted' : level === 'warn' ? 'Restricted' : 'Near normal';
    $('status-text').textContent = word + ' · ' + fmtPct(pWeek) + '% of baseline traffic';

    var lag = daysBetween(latest.date, todayISO());
    var meta = 'IMF PortWatch · latest observation ' + fmtDate(latest.date, true) +
      (lag > 0 ? ' (' + lag + ' day' + (lag === 1 ? '' : 's') + ' ago)' : '');
    if (state.source === 'snapshot') meta += ' · saved data';
    $('status-meta').textContent = meta;

    var live = $('live-dot');
    var snap = window.HORMUZ_SNAPSHOT;
    if (state.source === 'live') {
      live.setAttribute('data-state', 'live');
      $('live-text').textContent = 'Live · checked ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (state.source === 'cached') {
      var healthy = snap && Date.now() - Date.parse(snap.fetchedAt) < STALE_AFTER_MS && lag <= 7 &&
        Object.values(snap.sources || {}).every(function (source) { return window.HormuzDataStatus.sourceState(source, Date.now()) === 'Checked'; });
      live.setAttribute('data-state', healthy ? 'live' : 'saved');
      $('live-text').textContent = 'Site checked ' + fmtStamp(snap && snap.fetchedAt) + ' · scheduled every 3 hours';
    } else {
      live.setAttribute('data-state', 'saved');
      $('live-text').textContent = 'Saved data from ' + fmtStamp(snap && snap.fetchedAt);
    }

    $('tile-latest-label').textContent = 'Latest day · ' + fmtDate(latest.date, false);
    $('tile-latest').textContent = fmtNum(latest.total);
    $('tile-latest-cmp').textContent = 'vs 2025 average of ' + fmtNum(b.total, 1);
    var pLatest = pct(latest.total, b.total);
    setDelta('tile-latest-delta', pLatest);
    setMeter('tile-latest-meter', pLatest);

    $('tile-week').textContent = fmtNum(week, 1);
    setDelta('tile-week-delta', pWeek);
    setMeter('tile-week-meter', pWeek);

    var weekTanker = mean(last7, 'tanker');
    $('tile-tanker').textContent = fmtNum(weekTanker, 1);
    $('tile-tanker-cmp').textContent = 'vs 2025 average of ' + fmtNum(b.tanker, 1);
    var pTanker = pct(weekTanker, b.tanker);
    setDelta('tile-tanker-delta', pTanker);
    setMeter('tile-tanker-meter', pTanker);

    var weekDwt = mean(last7, 'capacity');
    $('tile-dwt').textContent = fmtDwt(weekDwt);
    $('tile-dwt-cmp').textContent = 'vs 2025 average of ' + fmtDwt(b.capacity) + ' dwt';
    var pDwt = pct(weekDwt, b.capacity);
    setDelta('tile-dwt-delta', pDwt);
    setMeter('tile-dwt-meter', pDwt);
  }

  // ---------- Auto-written summary ----------

  function renderSummary() {
    var rows = state.rows, b = state.baseline;
    if (!rows.length) return;
    var latest = rows[rows.length - 1];
    var week = mean(rows.slice(-7), 'total');
    var prev = rows.length >= 14 ? mean(rows.slice(-14, -7), 'total') : null;
    var pWeek = pct(week, b.total), pPrev = pct(prev, b.total);
    var parts = [];

    var s1 = 'Traffic through the strait is running at <b>' + fmtPct(pWeek) + '%</b> of its 2025 level, ' +
      fmtNum(week, 1) + ' ships a day on the 7-day average to ' + fmtDate(latest.date, false);
    if (pPrev != null) {
      var diff = pWeek - pPrev;
      s1 += Math.abs(diff) < 0.5 ? ', unchanged from a week earlier.' :
        ', ' + (diff > 0 ? 'up' : 'down') + ' from ' + fmtPct(pPrev) + '% a week earlier.';
    } else s1 += '.';
    parts.push(s1);

    if (state.brent && state.brent.series.length) {
      var all = state.brent.series, last = all[all.length - 1], pre = null;
      for (var i = all.length - 1; i >= 0; i--) if (all[i].date <= '2026-02-27') { pre = all[i]; break; }
      var s2 = 'Brent is at <b>$' + fmtNum(last.price, 2) + '</b>';
      if (pre) {
        var ch = (last.price - pre.price) / pre.price * 100;
        s2 += ', ' + (ch >= 0 ? 'up ' : 'down ') + fmtNum(Math.abs(ch), 0) + '% since the closure began';
      }
      parts.push(s2 + '.');
    }

    var cm = CMETRICS.export;
    var hits = [];
    COUNTRIES.forEach(function (c) {
      if (c.outside || c.partial) return;
      var r = state.countryRows[c.key], base = state.countryBaselines[c.key];
      if (!r || !r.length || !base || !base[cm.base]) return;
      hits.push({ name: c.name, p: mean(r.slice(-7), 'export') / base[cm.base] * 100 });
    });
    if (hits.length >= 2) {
      hits.sort(function (a, b2) { return a.p - b2.p; });
      parts.push('Among the exporters inside the strait, ' + hits[0].name + ' (<b>' + fmtPct(hits[0].p) + '%</b> of normal) and ' +
        hits[1].name + ' (<b>' + fmtPct(hits[1].p) + '%</b>) are shipping the least.');
    }

    var fp = fullPicture();
    if (fp) {
      parts.push('In barrels, Gulf liquids reaching world markets are running at about <b>' + fmtNum(fp.mbpd, 1) + ' million a day</b>, <b>' + fmtPct(fp.share * 100) +
        '%</b> of the pre-war flow' + (fp.tankerShare != null ? ', while only <b>' + fmtPct(fp.tankerShare * 100) + '%</b> of the usual tankers are visible at the strait; the difference is ships running dark or loading beyond it.' : '.'));
    }

    var bal = countryBalance('export').filter(function (r) { return !r.c.outside && !r.c.partial; });
    if (bal.length) {
      var bA = 0, bE = 0;
      bal.forEach(function (r) { bA += r.actual; bE += r.expected; });
      if (bE > 0 && bA < bE) {
        parts.push('Since the closure the ' + bal.length + ' exporters entirely inside the strait have shipped <b>' + fmtTonnes(bE - bA) +
          '</b> less than their 2025 pace, ' + fmtPct(bA / bE * 100) + '% of normal.');
      }
    }

    var drawn = stockRows().filter(function (r) { return r.c.region !== 'Gulf' && r.pct < 100; }).slice(0, 2);
    if (drawn.length === 2) {
      parts.push('Crude stockpiles are being run down: ' + drawn[0].c.name + ' held <b>' + fmtPct(drawn[0].pct) + '%</b> of its pre-closure crude stock in ' +
        fmtMonth(drawn[0].month) + ' and ' + drawn[1].c.name + ' <b>' + fmtPct(drawn[1].pct) + '%</b>.');
    }

    var head = headlineMarket();
    if (head) {
      var when = head.market.endDate ? ' by ' + fmtDate(normDate(head.market.endDate), false) : '';
      parts.push('Polymarket traders put the chance of traffic returning to normal' + when + ' at <b>' + fmtPct(head.market.yes * 100) + '%</b>.');
    }
    $('summary').innerHTML = parts.join(' ');
  }

  // ---------- Main chart ----------

  function rangeRows() {
    var rows = state.rows;
    if (state.range === 'all') return rows;
    if (state.range === 'crisis') return rows.filter(function (r) { return r.date >= CRISIS_RANGE_START; });
    return rows.slice(-parseInt(state.range, 10));
  }

  function movingAverage(rows, allRows, key, window) {
    var startIdx = allRows.indexOf(rows[0]);
    return rows.map(function (r, i) {
      var gi = startIdx + i;
      var from = Math.max(0, gi - window + 1);
      var s = 0, c = 0;
      for (var j = from; j <= gi; j++) { s += allRows[j][key]; c++; }
      return s / c;
    });
  }

  function niceTicks(max, count) {
    var raw = max / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    var ticks = [];
    for (var v = 0; v <= max + 1e-9; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }

  function attachHover(svg, hit, width, m, step, n, onIndex, onLeave) {
    function idx(clientX) {
      var rect = svg.getBoundingClientRect();
      var scale = rect.width / width;
      var localX = (clientX - rect.left) / scale - m.left;
      return Math.max(0, Math.min(n - 1, Math.floor(localX / step)));
    }
    hit.addEventListener('mousemove', function (e) { onIndex(idx(e.clientX)); });
    hit.addEventListener('mouseleave', onLeave);
    hit.addEventListener('touchstart', function (e) { onIndex(idx(e.touches[0].clientX)); }, { passive: true });
  }

  function placeTooltip(tooltip, wrap, svg, width, xPos, topPx) {
    var wrapRect = wrap.getBoundingClientRect();
    var svgRect = svg.getBoundingClientRect();
    var scale = svgRect.width / width;
    var px = (svgRect.left - wrapRect.left) + xPos * scale;
    var tw = tooltip.offsetWidth;
    var left = px + 14;
    if (left + tw > wrap.clientWidth - 4) left = px - tw - 14;
    tooltip.style.left = Math.max(4, left) + 'px';
    tooltip.style.top = (svgRect.top - wrapRect.top + topPx * scale) + 'px';
  }

  function renderChart() {
    var wrap = $('chart');
    var old = wrap.querySelector('svg');
    if (old) old.remove();

    var metric = METRICS[state.metric];
    var key = metric.key;
    $('chart-title').textContent = metric.title;
    $('legend-daily').textContent = metric.legend;

    var rows = rangeRows();
    if (!rows.length) return;
    var b = state.baseline;
    var baseVal = b[key];
    var avg = movingAverage(rows, state.rows, key, 7);

    var width = Math.max(320, wrap.clientWidth - 20);
    var height = width < 560 ? 260 : 320;
    var m = { top: 46, right: 14, bottom: 30, left: key === 'capacity' ? 46 : 38 };
    var plotW = width - m.left - m.right;
    var plotH = height - m.top - m.bottom;
    var n = rows.length;

    var maxVal = Math.max(baseVal, Math.max.apply(null, rows.map(function (r) { return r[key]; })));
    var ticks = niceTicks(maxVal * 1.08, 4);
    var yMax = ticks[ticks.length - 1];

    var step = plotW / n;
    var useBars = step >= 3;
    var barW = useBars ? Math.max(1.5, step - Math.max(1, step * 0.25)) : 0;

    function x(i) { return m.left + i * step + step / 2; }
    function y(v) { return m.top + plotH - (v / yMax) * plotH; }

    var svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + height, width: width, height: height, role: 'img',
      'aria-label': metric.title + ', with 7-day average' });

    var grid = svgEl('g', { class: 'grid' });
    var axis = svgEl('g', { class: 'axis' });
    ticks.forEach(function (t) {
      grid.appendChild(svgEl('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t) }));
      axis.appendChild(svgEl('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', text: key === 'capacity' ? fmtDwt(t) : fmtNum(t) }));
    });
    svg.appendChild(grid);

    var labels = [];
    if (n <= 40) {
      for (var i = 0; i < n; i += 7) labels.push({ i: i, text: fmtDate(rows[i].date, false) });
    } else if (n <= 130) {
      for (var i2 = 0; i2 < n; i2++) {
        var d = parseDate(rows[i2].date);
        if (d.getUTCDate() === 1 || d.getUTCDate() === 15) labels.push({ i: i2, text: fmtDate(rows[i2].date, false) });
      }
    } else {
      for (var i3 = 0; i3 < n; i3++) {
        var d3 = parseDate(rows[i3].date);
        if (d3.getUTCDate() === 1) {
          var everyOther = n > 400 ? d3.getUTCMonth() % 2 === 0 : true;
          if (everyOther) labels.push({ i: i3, text: MONTHS[d3.getUTCMonth()] + (d3.getUTCMonth() === 0 ? ' ' + d3.getUTCFullYear() : '') });
        }
      }
    }
    labels.forEach(function (l) {
      axis.appendChild(svgEl('text', { x: x(l.i), y: height - 10, 'text-anchor': 'middle', text: l.text }));
    });
    axis.appendChild(svgEl('line', { x1: m.left, x2: width - m.right, y1: y(0), y2: y(0) }));
    svg.appendChild(axis);

    var marks = svgEl('g', { class: 'marks' });
    if (useBars) {
      rows.forEach(function (r, i) {
        var h = Math.max(0, y(0) - y(r[key]));
        var rect = svgEl('rect', { class: 'bar', x: x(i) - barW / 2, y: y(r[key]), width: barW, height: h });
        if (r[key] > 0 && barW >= 3) rect.setAttribute('rx', Math.min(2, barW / 2));
        marks.appendChild(rect);
      });
    } else {
      var area = 'M' + x(0) + ',' + y(0);
      var line = '';
      rows.forEach(function (r, i) {
        area += ' L' + x(i) + ',' + y(r[key]);
        line += (i ? ' L' : 'M') + x(i) + ',' + y(r[key]);
      });
      area += ' L' + x(n - 1) + ',' + y(0) + ' Z';
      marks.appendChild(svgEl('path', { class: 'area', d: area }));
      marks.appendChild(svgEl('path', { class: 'daily-line', d: line }));
    }
    svg.appendChild(marks);

    svg.appendChild(svgEl('line', { class: 'baseline', x1: m.left, x2: width - m.right, y1: y(baseVal), y2: y(baseVal) }));
    svg.appendChild(svgEl('text', { class: 'baseline-label', x: width - m.right, y: y(baseVal) - 6, 'text-anchor': 'end',
      text: '2025 baseline ' + metric.fmt(baseVal) + (key === 'capacity' ? ' dwt' : '') + ' / day' }));

    var avgPath = '';
    avg.forEach(function (v, i) { avgPath += (i ? ' L' : 'M') + x(i) + ',' + y(v); });
    svg.appendChild(svgEl('path', { class: 'avg-line', d: avgPath }));

    var evGroup = svgEl('g');
    var visible = [];
    var lastBadgeX = -Infinity, lastRow = 1, num = 0;
    EVENTS.forEach(function (ev) {
      if (!ev.major) return;
      num++;
      var idx = -1;
      for (var q = 0; q < n; q++) if (rows[q].date === ev.date) { idx = q; break; }
      if (idx < 0) return;
      visible.push({ ev: ev, k: num });
      var bx = x(idx);
      var row = (bx - lastBadgeX < 20 && lastRow === 1) ? 0 : 1;
      lastBadgeX = bx; lastRow = row;
      var cy = row === 1 ? m.top - 12 : m.top - 30;
      var g = svgEl('g', { class: 'event' });
      g.appendChild(svgEl('line', { x1: bx, x2: bx, y1: cy + 8, y2: y(0) }));
      g.appendChild(svgEl('circle', { cx: bx, cy: cy, r: 8 }));
      g.appendChild(svgEl('text', { x: bx, y: cy + 3.5, text: String(num) }));
      evGroup.appendChild(g);
    });
    svg.appendChild(evGroup);

    var cross = svgEl('line', { class: 'crosshair', y1: m.top, y2: y(0), visibility: 'hidden' });
    var dot = svgEl('circle', { class: 'hover-dot', r: 4, visibility: 'hidden' });
    svg.appendChild(cross); svg.appendChild(dot);
    var hit = svgEl('rect', { class: 'hit', x: m.left, y: m.top - 20, width: plotW, height: plotH + 20 });
    svg.appendChild(hit);
    wrap.insertBefore(svg, wrap.firstChild);

    var tooltip = $('tooltip');
    attachHover(svg, hit, width, m, step, n, function (i) {
      var r = rows[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(avg[i])); dot.setAttribute('visibility', 'visible');
      tooltip.innerHTML =
        '<div class="t-date">' + fmtDate(r.date, true) + '</div>' +
        '<div class="t-row"><span>Transits</span><b>' + fmtNum(r.total) + '</b></div>' +
        '<div class="t-row"><span>Tankers</span><b>' + fmtNum(r.tanker) + '</b></div>' +
        '<div class="t-row"><span>Capacity</span><b>' + fmtDwt(r.capacity) + ' dwt</b></div>' +
        '<div class="t-row"><span>7-day avg (' + metric.unit + ')</span><b>' + metric.fmt(avg[i]) + '</b></div>' +
        '<div class="t-row"><span>Of 2025 baseline</span><b>' + fmtPct(pct(r[key], baseVal)) + '%</b></div>';
      tooltip.hidden = false;
      placeTooltip(tooltip, wrap, svg, width, x(i), m.top);
    }, function () {
      cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tooltip.hidden = true;
    });

    var list = $('events');
    list.innerHTML = '';
    visible.forEach(function (v) {
      list.appendChild(el('li', null, [
        el('span', { class: 'n', text: String(v.k) }),
        el('span', { class: 'd', text: fmtDate(v.ev.date, false) }),
        el('span', { text: v.ev.label })
      ]));
    });
    if (!visible.length) list.appendChild(el('li', { text: 'No marked events in this range.' }));
  }

  // ---------- Prediction markets ----------

  function fmtUsd(v) {
    if (v == null || isNaN(v)) return '';
    if (v >= 1e6) return '$' + fmtNum(v / 1e6, 1) + 'M';
    if (v >= 1e3) return '$' + fmtNum(v / 1e3, 0) + 'k';
    return '$' + fmtNum(v, 0);
  }

  function fmtChange(c) {
    if (c == null || isNaN(c) || Math.abs(c) < 0.0005) return { text: '–', dir: '' };
    var pts = c * 100;
    return { text: (pts > 0 ? '+' : '−') + fmtPct(Math.abs(pts)) + ' pt', dir: pts > 0 ? 'up' : 'down' };
  }

  // The "traffic returns to normal by <date>?" single-market events form a ladder; the latest date is the headline.
  function normalLadder() {
    var pm = state.markets;
    if (!pm) return [];
    return pm.events
      .filter(function (e) { return /traffic returns? to normal by/i.test(e.title) && e.markets.length === 1; })
      .map(function (e) { return { event: e, market: e.markets[0], endDate: normDate(e.markets[0].endDate || e.endDate || '9999') }; })
      .sort(function (a, b) { return a.endDate < b.endDate ? -1 : 1; });
  }

  function headlineMarket() {
    var ladder = normalLadder();
    if (!ladder.length) return null;
    var last = ladder[ladder.length - 1];
    return { event: last.event, market: last.market };
  }

  function renderMarkets() {
    var box = $('pm');
    var note = $('pm-note');
    box.innerHTML = '';
    var pm = state.markets;
    if (!pm) {
      box.appendChild(el('div', { class: 'pm-pending', html:
        'Prediction-market odds appear here once the scheduled refresh has reached Polymarket’s public API. ' +
        'Until then, see the <a href="https://polymarket.com/iran/strait-of-hormuz" target="_blank" rel="noopener">Strait of Hormuz markets on Polymarket</a> directly.' }));
      note.textContent = '';
      return;
    }

    var ladder = normalLadder();
    var head = headlineMarket();
    var used = {};
    if (head) {
      ladder.forEach(function (l) { used[l.event.slug] = true; });
      var m = head.market;
      var hero = el('div', { class: 'pm-hero' });
      hero.appendChild(el('div', { class: 'pm-big', html: fmtPct(m.yes * 100) + '<small>%</small>' }));
      var right = el('div');
      right.appendChild(el('h3', null, [el('a', { href: 'https://polymarket.com/event/' + encodeURIComponent(head.event.slug), target: '_blank', rel: 'noopener',
        style: 'color:inherit;text-decoration:none', text: head.event.title || m.question })]));
      var ch = fmtChange(m.change1w);
      var meta = el('div', { class: 'pm-meta' });
      meta.appendChild(el('span', { text: 'Chance of “Yes”' }));
      if (ch.text !== '–') meta.appendChild(el('span', { class: 'delta', 'data-dir': ch.dir === 'up' ? 'down' : 'up', text: ch.text + ' this week' }));
      if (m.volume) meta.appendChild(el('span', { text: fmtUsd(m.volume) + ' traded' }));
      if (m.endDate) meta.appendChild(el('span', { text: 'closes ' + fmtDate(normDate(m.endDate), true) }));
      right.appendChild(meta);
      var bar = el('div', { class: 'pm-bar', 'aria-hidden': 'true' });
      bar.appendChild(el('i', { style: 'width:' + Math.max(0.5, m.yes * 100) + '%' }));
      right.appendChild(bar);
      hero.appendChild(right);

      if (ladder.length > 1) {
        var lad = el('div', { class: 'pm-ladder' });
        lad.appendChild(el('div', { class: 'eyebrow', text: 'By date' }));
        ladder.forEach(function (l) {
          var lm = l.market;
          var lc = fmtChange(lm.change1w);
          var row = el('div', { class: 'pm-row' });
          var label = (/by (.+?)\??$/i.exec(l.event.title) || [])[1] || fmtDate(l.endDate, false);
          row.appendChild(el('div', { class: 'q', text: label.replace(/^end of /i, 'end of '), title: l.event.title }));
          row.appendChild(el('div', { class: 'p', text: fmtPct(lm.yes * 100) + '%' }));
          row.appendChild(el('div', { class: 'c', 'data-dir': lc.dir, text: lc.text }));
          var track = el('div', { class: 'track', 'aria-hidden': 'true' });
          track.appendChild(el('i', { style: 'width:' + Math.max(0.5, lm.yes * 100) + '%' }));
          row.appendChild(track);
          lad.appendChild(row);
        });
        hero.appendChild(lad);
      }

      var descText = (m.description || '') + ' ' + (head.event.description || '');
      var thr = /(?:equal to or above|at or above|above|at least|exceeds?|more than|greater than)\s*(\d{2,3})\b/i.exec(descText) ||
        /(\d{2,3})\s*(?:or more\s*|\+\s*)?(?:daily\s*)?(?:vessel|ship|transit)/i.exec(descText);
      if (thr && /portwatch/i.test(descText) && state.rows.length) {
        var need = +thr[1];
        var week = mean(state.rows.slice(-7), 'total');
        hero.appendChild(el('div', { class: 'pm-gap', html:
          'These markets resolve on the same PortWatch series charted above. “Normal” means a 7-day average above <b>' + fmtNum(need) + '</b> transits a day; the latest is <b>' +
          fmtNum(week, 1) + '</b>, so traffic would have to rise roughly <b>' + fmtNum(need / Math.max(week, 0.1), 0) + '×</b>.' }));
      }
      box.appendChild(hero);
    }

    var others = pm.events.filter(function (e) { return !used[e.slug] && e.markets.length; })
      .sort(function (a, b) { return (b.volume || 0) - (a.volume || 0); }).slice(0, 10);
    var groups = el('div', { class: 'pm-groups' });
    others.forEach(function (ev) {
      var g = el('div', { class: 'pm-group' });
      g.appendChild(el('h3', null, [el('a', { href: 'https://polymarket.com/event/' + encodeURIComponent(ev.slug), target: '_blank', rel: 'noopener', text: ev.title })]));
      if (ev.volume) g.appendChild(el('div', { class: 'pm-vol', text: fmtUsd(ev.volume) + ' traded' }));
      var ms = ev.markets.slice();
      var distinctDates = {};
      ms.forEach(function (x) { if (x.endDate) distinctDates[normDate(x.endDate)] = true; });
      var dated = ms.length > 1 && Object.keys(distinctDates).length === ms.length;
      ms.sort(dated ? function (a, b) { return normDate(a.endDate) < normDate(b.endDate) ? -1 : 1; } : function (a, b) { return b.yes - a.yes; });
      ms.slice(0, 7).forEach(function (x) {
        var c = fmtChange(x.change1w);
        var row = el('div', { class: 'pm-row' });
        row.appendChild(el('div', { class: 'q', text: x.short || x.question, title: x.question }));
        row.appendChild(el('div', { class: 'p', text: fmtPct(x.yes * 100) + '%' }));
        row.appendChild(el('div', { class: 'c', 'data-dir': c.dir, text: c.text }));
        var track = el('div', { class: 'track', 'aria-hidden': 'true' });
        track.appendChild(el('i', { style: 'width:' + Math.max(0.5, x.yes * 100) + '%' }));
        row.appendChild(track);
        g.appendChild(row);
      });
      groups.appendChild(g);
    });
    if (others.length) box.appendChild(groups);

    note.textContent = 'Prices as of ' + fmtStamp(pm.fetchedAt) + '. Change is over the past week in percentage points. Source: Polymarket public API.';
  }

  // ---------- Other chokepoints ----------

  function renderChokepoints() {
    var box = $('chokepoints');
    var note = $('chokepoints-note');
    box.innerHTML = '';
    if (!state.chokeRecent.length) {
      box.appendChild(el('div', { class: 'empty', text: 'Chokepoint comparison unavailable.' }));
      return;
    }
    var byName = {};
    state.chokeRecent.forEach(function (r) { (byName[r.portname] = byName[r.portname] || []).push(r); });
    var items = [], latestDate = '';
    COMPARE.forEach(function (name) {
      var rows = byName[name], base = state.chokeBaselines[name];
      if (!rows || !base) return;
      var avg = mean(rows.slice(-7), 'total');
      if (rows[rows.length - 1].date > latestDate) latestDate = rows[rows.length - 1].date;
      items.push({ name: name, avg: avg, base: base.avg_total, p: pct(avg, base.avg_total), hormuz: name === 'Strait of Hormuz' });
    });
    var maxP = Math.max(100, Math.max.apply(null, items.map(function (i) { return i.p; })));
    items.forEach(function (it) {
      var row = el('div', { class: 'cp-row' + (it.hormuz ? ' is-hormuz' : '') });
      row.appendChild(el('div', { class: 'cp-name', text: it.name }));
      var track = el('div', { class: 'cp-track', 'aria-hidden': 'true' });
      track.appendChild(el('i', { class: 'cp-fill', style: 'width:' + Math.max(0.5, (it.p / maxP) * 100) + '%' }));
      track.appendChild(el('i', { class: 'cp-100', style: 'left:' + (100 / maxP) * 100 + '%' }));
      row.appendChild(track);
      row.appendChild(el('div', { class: 'cp-vals', html:
        '<span class="delta" data-level="' + (it.p < 25 ? 'critical' : it.p < 75 ? 'warn' : '') + '">' + fmtPct(it.p) + '%</span>' +
        '<span class="cp-sub">' + fmtNum(it.avg, it.avg < 20 ? 1 : 0) + ' vs ' + fmtNum(it.base, 0) + ' / day</span>' }));
      box.appendChild(row);
    });
    note.textContent = 'Seven-day average ending ' + fmtDate(latestDate, true) + ' as a share of each passage’s own 2025 daily mean. The marker is 100%.';
  }

  // ---------- Small multiples (countries, ports) ----------

  function renderMultiples(cfg) {
    var box = $(cfg.box);
    var tooltip = $(cfg.tooltip);
    box.querySelectorAll('.cty, .cty-group, .mm-table').forEach(function (n) { n.remove(); });
    var metric = cfg.metric;
    var computed = [], latestDate = '';

    cfg.items.forEach(function (item) {
      var rows = cfg.rows[item.key], base = cfg.baselines[item.key];
      if (!rows || !rows.length || !base || !base[metric.base]) return;
      var baseVal = base[metric.base];
      var series = rolling7(rows, metric.key);
      var pctSeries = series.map(function (v) { return (v / baseVal) * 100; });
      var crisisRows = rows.filter(function (r) { return r.date >= CRISIS_START; });
      if (rows[rows.length - 1].date > latestDate) latestDate = rows[rows.length - 1].date;
      computed.push({
        item: item, rows: rows, baseVal: baseVal, series: series, pctSeries: pctSeries,
        headline: pctSeries[pctSeries.length - 1],
        crisisPct: crisisRows.length ? (mean(crisisRows, metric.key) / baseVal) * 100 : null,
        latest: rows[rows.length - 1].date
      });
    });

    if (!computed.length) {
      box.appendChild(el('div', { class: 'cty empty', text: cfg.emptyText }));
      $(cfg.note).textContent = '';
      return;
    }

    if (cfg.view === 'table') {
      var table = el('table', { class: 'mm-table' });
      table.appendChild(el('thead', null, [el('tr', null, [
        el('th', { text: cfg.nameHeader }), el('th', { text: 'Now (7-day avg)' }), el('th', { text: '2025 average' }),
        el('th', { text: '% of 2025' }), el('th', { text: 'Since 28 Feb' }), el('th', { text: 'Latest' })
      ])]));
      var tbody = el('tbody');
      computed.forEach(function (c) {
        tbody.appendChild(el('tr', null, [
          el('td', { text: c.item.name + (c.item.sub ? ' · ' + c.item.sub : '') }),
          el('td', { text: metric.fmt(c.series[c.series.length - 1]) + (metric.perDay ? '/day' : '') }),
          el('td', { text: metric.fmt(c.baseVal) + (metric.perDay ? '/day' : '') }),
          el('td', null, [el('span', { class: 'delta', 'data-level': levelFor(c.headline), text: fmtPct(c.headline) + '%' })]),
          el('td', { text: c.crisisPct == null ? '–' : fmtPct(c.crisisPct) + '%' }),
          el('td', { text: fmtDate(c.latest, false) })
        ]));
      });
      table.appendChild(tbody);
      var wrapT = el('div', { class: 'table-wrap mm-table' });
      wrapT.appendChild(table);
      box.appendChild(wrapT);
    } else {
      var currentGroup = null;
      computed.forEach(function (c) {
        var item = c.item;
        if (cfg.groups && item.group !== currentGroup) {
          currentGroup = item.group;
          var g = cfg.groups.filter(function (gg) { return gg.id === currentGroup; })[0];
          if (g) box.appendChild(el('div', { class: 'cty-group eyebrow', text: g.label }));
        }
        box.appendChild(buildTile(c, metric, box, tooltip));
      });
    }

    $(cfg.note).textContent = 'Latest estimate ' + fmtDate(latestDate, true) + '. Headline figure is the 7-day average of ' + metric.label +
      ' as a share of the 2025 daily mean; charts run from 1 Jan 2026 and are capped at 300% for readability. Source: IMF PortWatch.';
  }

  function buildTile(c, metric, box, tooltip) {
    var item = c.item, rows = c.rows, n = rows.length, series = c.series, pctSeries = c.pctSeries;
    var tile = el('div', { class: 'cty' + (item.outside ? ' outside' : '') });
    tile.appendChild(el('div', { class: 'cty-head' }, [
      el('div', { class: 'cty-title' }, [
        el('div', { class: 'cty-name', text: item.name }),
        item.sub ? el('div', { class: 'cty-sub', text: item.sub }) : null
      ]),
      el('div', { class: 'cty-pct', 'data-level': levelFor(c.headline), text: fmtPct(c.headline) + '%' })
    ]));

    var W = 300, H = 96, m = { top: 6, right: 6, bottom: 16, left: 30 };
    var pw = W - m.left - m.right, ph = H - m.top - m.bottom;
    var maxP = Math.max.apply(null, pctSeries);
    var yMax = Math.min(Math.max(130, Math.ceil(maxP * 1.05 / 10) * 10), 300);
    function x(i) { return m.left + (i / Math.max(1, n - 1)) * pw; }
    function y(p) { return m.top + ph - (Math.min(p, yMax) / yMax) * ph; }

    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': item.name + ' ' + metric.label + ', 7-day average as a share of the 2025 mean' });
    var axis = svgEl('g', { class: 'sp-axis' });
    [0, yMax].forEach(function (t) {
      axis.appendChild(svgEl('line', { x1: m.left, x2: W - m.right, y1: y(t), y2: y(t) }));
      axis.appendChild(svgEl('text', { x: m.left - 5, y: y(t) + 3, 'text-anchor': 'end', text: t + '%' }));
    });
    axis.appendChild(svgEl('text', { x: m.left - 5, y: y(100) + 3, 'text-anchor': 'end', text: '100%' }));
    rows.forEach(function (r, i) {
      var d = parseDate(r.date);
      if (d.getUTCDate() === 1 && d.getUTCMonth() % 2 === 0) {
        axis.appendChild(svgEl('text', { x: x(i), y: H - 4, 'text-anchor': 'middle', text: MONTHS[d.getUTCMonth()] }));
      }
    });
    svg.appendChild(axis);

    var area = 'M' + x(0) + ',' + y(0), line = '';
    pctSeries.forEach(function (p, i) {
      area += ' L' + x(i) + ',' + y(p);
      line += (i ? ' L' : 'M') + x(i) + ',' + y(p);
    });
    area += ' L' + x(n - 1) + ',' + y(0) + ' Z';
    svg.appendChild(svgEl('path', { class: 'sp-area', d: area }));
    svg.appendChild(svgEl('line', { class: 'sp-base', x1: m.left, x2: W - m.right, y1: y(100), y2: y(100) }));
    for (var k = 0; k < n; k++) {
      if (rows[k].date === CRISIS_START) {
        svg.appendChild(svgEl('line', { class: 'sp-event', x1: x(k), x2: x(k), y1: m.top, y2: y(0) }));
        break;
      }
    }
    svg.appendChild(svgEl('path', { class: 'sp-line', d: line }));

    var cross = svgEl('line', { class: 'sp-cross', y1: m.top, y2: y(0), visibility: 'hidden' });
    var dot = svgEl('circle', { class: 'sp-dot', r: 3, visibility: 'hidden' });
    svg.appendChild(cross); svg.appendChild(dot);
    var hit = svgEl('rect', { class: 'sp-hit', x: m.left, y: 0, width: pw, height: H });
    svg.appendChild(hit);
    tile.appendChild(svg);

    tile.appendChild(el('div', { class: 'cty-vals', html:
      '<span><b>' + metric.fmt(series[n - 1]) + '</b>' + (metric.perDay ? '/day' : '') + ' now vs <b>' + metric.fmt(c.baseVal) + '</b> in 2025</span>' +
      '<span>since 28 Feb: <b>' + (c.crisisPct == null ? '–' : fmtPct(c.crisisPct) + '%') + '</b></span>' }));
    tile.appendChild(el('div', { class: 'cty-note', text: item.note }));

    function show(clientX) {
      var rect = svg.getBoundingClientRect();
      var scale = rect.width / W;
      var i = Math.round(((clientX - rect.left) / scale - m.left) / pw * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(pctSeries[i])); dot.setAttribute('visibility', 'visible');
      tooltip.innerHTML =
        '<div class="t-date">' + escapeHtml(item.name) + ' · ' + fmtDate(rows[i].date, true) + '</div>' +
        '<div class="t-row"><span>That day</span><b>' + metric.fmt(rows[i][metric.key]) + '</b></div>' +
        '<div class="t-row"><span>7-day average</span><b>' + metric.fmt(series[i]) + (metric.perDay ? '/day' : '') + '</b></div>' +
        '<div class="t-row"><span>Of 2025 mean</span><b>' + fmtPct(pctSeries[i]) + '%</b></div>';
      tooltip.hidden = false;
      var boxRect = box.getBoundingClientRect();
      var px = rect.left - boxRect.left + x(i) * scale;
      var tw = tooltip.offsetWidth;
      var left = px + 12;
      if (left + tw > box.clientWidth - 4) left = px - tw - 12;
      tooltip.style.left = Math.max(4, left) + 'px';
      tooltip.style.top = (rect.top - boxRect.top - 4) + 'px';
    }
    function hide() { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tooltip.hidden = true; }
    hit.addEventListener('mousemove', function (e) { show(e.clientX); });
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('touchstart', function (e) { show(e.touches[0].clientX); }, { passive: true });
    return tile;
  }

  function renderCountries() {
    renderMultiples({
      box: 'countries', tooltip: 'cty-tooltip', note: 'countries-note', items: COUNTRIES,
      rows: state.countryRows, baselines: state.countryBaselines, metric: CMETRICS[state.cmetric],
      view: state.views.countries, nameHeader: 'Country', emptyText: 'Country trade data unavailable.'
    });
  }

  // ---------- The full picture: liquids reaching world markets ----------

  var PRE_WAR_MBPD = 20;        // EIA: roughly 20 million barrels a day of petroleum liquids crossed Hormuz in 2024
  var BBL_PER_TONNE = 7.33;     // crude-oil average; products and gas differ, so barrels here are an equivalent, not a measurement
  var BYPASS_PORTS = ['port570', 'port362'];   // Yanbu (Red Sea) and Fujairah (Gulf of Oman); Oman comes from its national figure

  function last7(rows, key) { return rows && rows.length ? mean(rows.slice(-7), key) : 0; }

  // PortWatch tanker exports of the eight Gulf states, split into cargo that must cross Hormuz and cargo loaded at
  // outlets beyond it, each against its 2025 pace; the shares are then scaled to the EIA pre-war flow for a barrels figure.
  function fullPicture() {
    var total = 0, totalBase = 0, outside = 0, outsideBase = 0, have = 0, latest = '';
    COUNTRIES.forEach(function (c) {
      var r = state.countryRows[c.key], b = state.countryBaselines[c.key];
      if (!r || !r.length || !b || !b.avg_export_tanker) return;
      have++;
      var now = last7(r, 'export_tanker');
      total += now; totalBase += b.avg_export_tanker;
      if (c.outside) { outside += now; outsideBase += b.avg_export_tanker; }
      if (r[r.length - 1].date > latest) latest = r[r.length - 1].date;
    });
    if (have < 6 || !totalBase) return null;
    BYPASS_PORTS.forEach(function (pid) {
      var r = state.portRows[pid], b = state.portBaselines[pid];
      if (!r || !r.length || !b || !b.avg_export) return;
      outside += last7(r, 'export'); outsideBase += b.avg_export;
    });
    outside = Math.min(outside, total); outsideBase = Math.min(outsideBase, totalBase);
    var scale = PRE_WAR_MBPD / totalBase;   // mb/d per tonne-a-day of PortWatch exports
    var tk = state.rows.length ? mean(state.rows.slice(-7), 'tanker') : null;
    var tkBase = state.baseline ? state.baseline.tanker : null;
    return {
      latest: latest, scale: scale,
      total: total, totalBase: totalBase, share: total / totalBase, mbpd: total * scale,
      inside: total - outside, insideBase: totalBase - outsideBase,
      outside: outside, outsideBase: outsideBase,
      tankers: tk, tankersBase: tkBase, tankerShare: (tk != null && tkBase) ? tk / tkBase : null
    };
  }

  function renderFullPicture() {
    var box = $('fullpic'), note = $('fullpic-note');
    box.innerHTML = '';
    var f = fullPicture();
    if (!f) {
      box.appendChild(el('div', { class: 'empty', text: 'Trade data unavailable.' }));
      note.textContent = '';
      return;
    }
    box.appendChild(el('div', { class: 'bal-total' }, [
      el('div', { class: 'k', text: 'Gulf liquids reaching world markets by sea · 7-day average to ' + fmtDate(f.latest, false) }),
      el('div', { class: 'v', 'data-dir': f.share < 1 ? 'deficit' : 'surplus', html: '≈ ' + fmtNum(f.mbpd, 1) + '<small>million barrels a day · ' + fmtPct(f.share * 100) + '% of normal</small>' }),
      el('div', { class: 's', html: '<b>' + fmtTonnes(f.total) + '</b> a day of tanker exports from the eight Gulf states against <b>' + fmtTonnes(f.totalBase) +
        '</b> in 2025, scaled to the <b>' + PRE_WAR_MBPD + ' mb/d</b> that crossed Hormuz before the war' })
    ]));

    function row(name, tag, now, base, sub) {
      var pct = base ? now / base * 100 : 0, down = pct < 100;
      var r = el('div', { class: 'bal-row', 'data-dir': down ? 'deficit' : 'surplus' });
      r.appendChild(el('div', { class: 'bal-name', html: '<b>' + name + '</b><small>' + tag + '</small>' }));
      var bar = el('div', { class: 'bal-bar', 'aria-hidden': 'true' });
      bar.appendChild(el('i', { style: 'width:' + (Math.min(100, Math.abs(pct - 100)) / 2).toFixed(1) + '%' }));
      r.appendChild(bar);
      r.appendChild(el('div', { class: 'bal-val', html: '<b>' + fmtPct(pct) + '%</b><small>of 2025</small>' }));
      r.appendChild(el('div', { class: 'bal-sub', text: sub }));
      box.appendChild(r);
    }
    row('Loaded inside the strait', 'must cross Hormuz', f.inside, f.insideBase,
      '≈ ' + fmtNum(f.inside * f.scale, 1) + ' mb/d equivalent · ' + fmtTonnes(f.inside) + ' a day now, ' + fmtTonnes(f.insideBase) + ' in 2025 · Gulf-state tanker exports less the bypass outlets');
    row('Bypass outlets', 'Yanbu, Fujairah and Oman', f.outside, f.outsideBase,
      '≈ ' + fmtNum(f.outside * f.scale, 1) + ' mb/d equivalent · ' + fmtTonnes(f.outside) + ' a day now, ' + fmtTonnes(f.outsideBase) + ' in 2025 · ' +
      (f.outside >= f.outsideBase ? '+' : '−') + fmtTonnes(Math.abs(f.outside - f.outsideBase)) + ' a day against the 2025 pace');
    if (f.tankerShare != null) {
      row('Tankers seen at the strait', 'AIS transits, both directions', f.tankers, f.tankersBase,
        fmtNum(f.tankers, 1) + ' a day now, ' + fmtNum(f.tankersBase, 0) + ' in 2025 · the gap to the loaded volume above is ships running dark or loading beyond the strait');
    }
    note.innerHTML = 'Tonnes are IMF PortWatch model estimates of tanker exports (crude, products and gas together). The barrels figure applies the same share of normal to the EIA’s pre-war Hormuz flow of about ' +
      PRE_WAR_MBPD + ' million barrels a day; at ' + BBL_PER_TONNE + ' barrels a tonne PortWatch’s 2025 tonnage alone would read lower, so the share is the robust number and the barrels are a scaled equivalent. ' +
      'Satellite-based trackers that count loadings rather than transponder signals reach broadly similar shares. <a href="methodology.html#full-picture">How this is calculated</a>.';
  }

  // ---------- Country balance since the closure ----------

  // For each country: tonnes shipped since the closure against its 2025 daily average over the same days.
  function countryBalance(metricKey) {
    var m = CMETRICS[metricKey];
    var out = [];
    COUNTRIES.forEach(function (c) {
      var rows = state.countryRows[c.key], base = state.countryBaselines[c.key];
      if (!rows || !rows.length || !base || !base[m.base]) return;
      var since = rows.filter(function (r) { return r.date >= CRISIS_START; });
      if (!since.length) return;
      var actual = 0;
      since.forEach(function (r) { actual += r[m.key] || 0; });
      var perDay = base[m.base];
      var expected = perDay * since.length;
      out.push({ c: c, days: since.length, last: since[since.length - 1].date, actual: actual, expected: expected, perDay: perDay,
        diff: actual - expected, pct: expected ? (actual - expected) / expected * 100 : 0 });
    });
    out.sort(function (a, b) { return a.pct - b.pct; });
    return out;
  }

  function renderBalance() {
    var box = $('balance'), note = $('balance-note');
    box.innerHTML = '';
    var m = CMETRICS[state.bmetric];
    var rows = countryBalance(state.bmetric);
    if (!rows.length) {
      box.appendChild(el('div', { class: 'empty', text: 'Country trade data unavailable.' }));
      note.textContent = '';
      return;
    }

    var inside = rows.filter(function (r) { return !r.c.outside && !r.c.partial; });
    if (inside.length) {
      var tA = 0, tE = 0, maxDays = 0;
      inside.forEach(function (r) { tA += r.actual; tE += r.expected; maxDays = Math.max(maxDays, r.days); });
      var tDiff = tA - tE;
      box.appendChild(el('div', { class: 'bal-total' }, [
        el('div', { class: 'k', text: 'Combined ' + (tDiff < 0 ? 'shortfall' : 'surplus') + ' in ' + m.label + ' · ' + inside.length + ' countries entirely inside the strait' }),
        el('div', { class: 'v', 'data-dir': tDiff < 0 ? 'deficit' : 'surplus', text: (tDiff < 0 ? '−' : '+') + fmtTonnes(Math.abs(tDiff)) }),
        el('div', { class: 's', html: '<b>' + fmtTonnes(tA) + '</b> shipped against <b>' + fmtTonnes(tE) + '</b> at the 2025 pace, ' +
          fmtPct(tE ? tA / tE * 100 : 0) + '% of normal over ' + maxDays + ' days' })
      ]));
    }

    var cap = Math.max(100, Math.max.apply(null, rows.map(function (r) { return Math.abs(r.pct); })));
    rows.forEach(function (r) {
      var deficit = r.diff < 0;
      var sign = deficit ? '−' : '+';
      var w = Math.abs(r.pct) / cap * 50;
      var row = el('div', { class: 'bal-row', 'data-dir': deficit ? 'deficit' : 'surplus' });
      var tag = r.c.outside ? 'outside the strait' : r.c.partial ? 'partly outside' : 'inside the strait';
      row.appendChild(el('div', { class: 'bal-name', html: '<b>' + escapeHtml(r.c.name) + '</b><small>' + tag + '</small>' }));
      var bar = el('div', { class: 'bal-bar', 'aria-hidden': 'true' });
      bar.appendChild(el('i', { style: 'width:' + w.toFixed(1) + '%' }));
      row.appendChild(bar);
      row.appendChild(el('div', { class: 'bal-val', html: '<b>' + sign + fmtTonnes(Math.abs(r.diff)) + '</b><small>' + sign + fmtPct(Math.abs(r.pct)) + '%</small>' }));
      var lost = r.perDay ? Math.abs(r.diff) / r.perDay : 0;
      row.appendChild(el('div', { class: 'bal-sub', text: fmtTonnes(r.actual) + ' shipped · ' + fmtTonnes(r.expected) + ' at the 2025 pace · ' +
        (deficit ? fmtNum(lost, 0) + ' of ' + r.days + ' days’ worth lost' : fmtNum(lost, 0) + ' extra days’ worth shipped in ' + r.days + ' days') }));
      box.appendChild(row);
    });

    var last = rows.reduce(function (a, r) { return r.last > a ? r.last : a; }, '');
    note.textContent = 'IMF PortWatch daily trade estimates in tonnes, summed from 28 Feb 2026 to ' + fmtDate(last, true) +
      '. “At the 2025 pace” is the country’s 2025 daily average multiplied by the number of days. Saudi Arabia and the UAE also ship from ports outside the strait, so their national totals include cargo re-routed to Yanbu, Fujairah and Khor Fakkan; the ports panel separates the two.';
  }

  // ---------- Oil stockpiles ----------

  var STOCK_SHOW = 10;   // countries shown before the "Show more" button
  var STOCK_PRE = '2026-02';   // the last full month before the closure

  function fmtMb(kb) { return fmtNum(kb / 1000, kb >= 10000 ? 0 : 1) + ' Mb'; }
  function fmtMonth(mo) { return MONTHS[+mo.slice(5, 7) - 1] + ' ' + mo.slice(0, 4); }

  // Per country: latest month-end crude stock against the last month before the closure, plus days of refinery runs.
  function stockRows() {
    var s = state.stocks;
    if (!s || !s.countries) return [];
    var out = [];
    s.countries.forEach(function (c) {
      var ser = c.series || [];
      if (!ser.length) return;
      var last = ser[ser.length - 1];
      var pre = null;
      for (var i = ser.length - 1; i >= 0; i--) { if (ser[i][0] <= STOCK_PRE) { pre = ser[i]; break; } }
      if (!pre || pre === last || !pre[1]) return;
      var mo = last[0];
      var dim = new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7), 0)).getUTCDate();
      var days = last[2] ? last[1] / (last[2] / dim) : null;
      out.push({ c: c, month: mo, stock: last[1], pre: pre[1], preMonth: pre[0], pct: last[1] / pre[1] * 100, days: days });
    });
    out.sort(function (a, b) { return a.pct - b.pct; });
    return out;
  }

  function renderStocks() {
    var box = $('stocks'), note = $('stocks-note');
    box.innerHTML = '';
    var rows = stockRows();
    if (!rows.length) {
      box.appendChild(el('div', { class: 'empty', text: 'Stock data unavailable.' }));
      note.textContent = '';
      return;
    }

    var importers = rows.filter(function (r) { return r.c.region !== 'Gulf'; });
    if (importers.length) {
      var now = 0, pre = 0;
      importers.forEach(function (r) { now += r.stock; pre += r.pre; });
      var diff = now - pre;
      box.appendChild(el('div', { class: 'bal-total' }, [
        el('div', { class: 'k', text: 'Crude on hand across the ' + importers.length + ' reporting importing countries, each at its latest month' }),
        el('div', { class: 'v', 'data-dir': diff < 0 ? 'deficit' : 'surplus', html: fmtPct(pre ? now / pre * 100 : 0) + '%<small>of the ' + fmtMonth(STOCK_PRE) + ' level</small>' }),
        el('div', { class: 's', html: '<b>' + fmtMb(now) + '</b> now against <b>' + fmtMb(pre) + '</b> before the closure, ' + (diff < 0 ? '−' : '+') + fmtMb(Math.abs(diff)) })
      ]));
    }

    var shown = state.stocksShowAll ? rows : rows.slice(0, STOCK_SHOW);
    var cap = Math.max(100, Math.max.apply(null, rows.map(function (r) { return Math.abs(r.pct - 100); })));
    shown.forEach(function (r) {
      var down = r.pct < 100;
      var row = el('div', { class: 'bal-row', 'data-dir': down ? 'deficit' : 'surplus' });
      row.appendChild(el('div', { class: 'bal-name', html: '<b>' + escapeHtml(r.c.name) + '</b><small>' + escapeHtml(r.c.region) + ' · ' + fmtMonth(r.month) + '</small>' }));
      var bar = el('div', { class: 'bal-bar', 'aria-hidden': 'true' });
      bar.appendChild(el('i', { style: 'width:' + (Math.abs(r.pct - 100) / cap * 50).toFixed(1) + '%' }));
      row.appendChild(bar);
      row.appendChild(el('div', { class: 'bal-val', html: '<b>' + fmtPct(r.pct) + '%</b><small>of ' + fmtMonth(r.preMonth) + '</small>' }));
      row.appendChild(el('div', { class: 'bal-sub', text: fmtMb(r.stock) + ' of crude on hand · ' +
        (r.days ? fmtNum(r.days, 0) + ' days of refinery runs' : 'refinery runs not reported') + ' · ' +
        (down ? '−' : '+') + fmtMb(Math.abs(r.stock - r.pre)) + ' since ' + fmtMonth(r.preMonth) }));
      box.appendChild(row);
    });
    if (rows.length > shown.length) {
      var more = el('button', { type: 'button', class: 'btn', text: 'Show ' + (rows.length - shown.length) + ' more countries' });
      more.addEventListener('click', function () { state.stocksShowAll = true; renderStocks(); });
      box.appendChild(el('div', { class: 'more' }, [more]));
    }

    var missing = state.stocks.countries.filter(function (c) { return !(c.series && c.series.length); }).map(function (c) { return c.name; });
    var su = state.stocks.sourceUpdated;
    var release = '';
    if (su) {
      release = ' Source file last modified ' + fmtDate(su, true) + '.';
    }
    note.textContent = 'JODI-Oil month-end closing stocks of crude oil, as reported by each government, with refinery intake for the days-of-cover figure; latest month in the dataset ' +
      fmtMonth(state.stocks.latest) + '.' + release + ' Reporting lags by two to three months and levels may or may not include strategic reserves depending on the country.' +
      (missing.length ? ' Not reported, so not shown: ' + missing.join(', ') + '.' : '');
  }

  function renderPorts() {
    renderMultiples({
      box: 'ports', tooltip: 'port-tooltip', note: 'ports-note', items: PORTS, groups: PGROUPS,
      rows: state.portRows, baselines: state.portBaselines, metric: PMETRICS[state.pmetric],
      view: state.views.ports, nameHeader: 'Port', emptyText: 'Port data unavailable.'
    });
  }

  // ---------- Brent crude ----------

  function setPriceDelta(id, now, ref) {
    var e = $(id);
    if (!ref) { e.textContent = '–'; e.removeAttribute('data-dir'); return; }
    var p = ((now - ref) / ref) * 100;
    e.textContent = (p >= 0 ? '+' : '−') + fmtNum(Math.abs(p), 0) + '% (' + fmtNum(ref, 2) + ')';
    e.setAttribute('data-dir', p >= 0 ? 'up' : 'down');
  }

  function renderBrent() {
    var wrap = $('brent-chart');
    wrap.querySelectorAll('svg, .mm-table').forEach(function (n) { n.remove(); });
    var b = state.brent;
    if (!b || !b.series.length) {
      $('brent-price').textContent = '–';
      $('brent-note').textContent = 'Oil price data unavailable.';
      return;
    }
    var all = b.series;
    var latest = all[all.length - 1];
    var y2025 = all.filter(function (p) { return p.date <= '2025-12-31'; });
    var avg2025 = y2025.length ? y2025.reduce(function (s, p) { return s + p.price; }, 0) / y2025.length : null;
    var preWar = null;
    for (var i = all.length - 1; i >= 0; i--) { if (all[i].date <= '2026-02-27') { preWar = all[i]; break; } }

    $('brent-price').textContent = '$' + fmtNum(latest.price, 2);
    setPriceDelta('brent-vs-prewar', latest.price, preWar && preWar.price);
    setPriceDelta('brent-vs-2025', latest.price, avg2025);
    $('brent-sub').textContent = b.unit + ' · ' + b.label;
    $('brent-note').textContent = 'Latest ' + fmtDate(latest.date, true) +
      (preWar ? '. Last pre-closure price $' + fmtNum(preWar.price, 2) + ' on ' + fmtDate(preWar.date, false) : '') +
      (b.source === 'FRED' ? '. Daily spot price from the US EIA via FRED, published about two trading days in arrears.' : '. Front-month ICE Brent futures, daily close, via Yahoo Finance.');

    if (state.views.brent === 'table') {
      var recent = all.slice(-20).reverse();
      var table = el('table');
      table.appendChild(el('thead', null, [el('tr', null, [
        el('th', { text: 'Date' }), el('th', { text: 'Close ($)' }), el('th', { text: 'Day change' }), el('th', { text: 'vs 2025 avg' })
      ])]));
      var tbody = el('tbody');
      recent.forEach(function (p, idx) {
        var prev = all[all.length - 1 - idx - 1];
        var ch = prev ? (p.price - prev.price) : null;
        var vs = avg2025 ? (p.price - avg2025) / avg2025 * 100 : null;
        tbody.appendChild(el('tr', null, [
          el('td', { text: fmtDate(p.date, true) }),
          el('td', { text: fmtNum(p.price, 2) }),
          el('td', { text: ch == null ? '–' : (ch >= 0 ? '+' : '−') + fmtNum(Math.abs(ch), 2) }),
          el('td', { text: vs == null ? '–' : (vs >= 0 ? '+' : '−') + fmtNum(Math.abs(vs), 0) + '%' })
        ]));
      });
      table.appendChild(tbody);
      var wrapT = el('div', { class: 'table-wrap mm-table' });
      wrapT.appendChild(table);
      wrap.appendChild(wrapT);
      return;
    }

    var pts = state.brange === 'all' ? all : all.filter(function (p) { return p.date >= CRISIS_RANGE_START; });
    var n = pts.length;
    if (n < 2) return;

    var width = Math.max(260, wrap.clientWidth - 20);
    var height = 190;
    var m = { top: 12, right: 44, bottom: 24, left: 34 };
    var pw = width - m.left - m.right, ph = height - m.top - m.bottom;
    var prices = pts.map(function (p) { return p.price; });
    var lo = Math.min.apply(null, prices.concat(avg2025 ? [avg2025] : []));
    var hi = Math.max.apply(null, prices.concat(avg2025 ? [avg2025] : []));
    var pad = (hi - lo) * 0.12 || 5;
    var rawStep = ((hi + pad) - (lo - pad)) / 4;
    var stepY = [5, 10, 20, 25, 50, 100].filter(function (s) { return s >= rawStep; })[0] || 100;
    var yMin = Math.floor((lo - pad) / stepY) * stepY, yMax = Math.ceil((hi + pad) / stepY) * stepY;
    var t0 = parseDate(pts[0].date).getTime(), t1 = parseDate(pts[n - 1].date).getTime();
    function x(d) { return m.left + ((parseDate(d).getTime() - t0) / Math.max(1, t1 - t0)) * pw; }
    function y(v) { return m.top + ph - ((v - yMin) / (yMax - yMin)) * ph; }

    var svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + height, width: width, height: height, role: 'img',
      'aria-label': 'Brent crude price, ' + b.unit });
    var grid = svgEl('g', { class: 'grid' }), axis = svgEl('g', { class: 'axis' });
    for (var tv = yMin; tv <= yMax + 1e-9; tv += stepY) {
      grid.appendChild(svgEl('line', { x1: m.left, x2: width - m.right, y1: y(tv), y2: y(tv) }));
      axis.appendChild(svgEl('text', { x: m.left - 6, y: y(tv) + 4, 'text-anchor': 'end', text: fmtNum(tv, 0) }));
    }
    svg.appendChild(grid);
    var lastMonth = -1;
    pts.forEach(function (p) {
      var d = parseDate(p.date);
      if (d.getUTCMonth() !== lastMonth) {
        lastMonth = d.getUTCMonth();
        var show = n > 200 ? d.getUTCMonth() % 3 === 0 : d.getUTCMonth() % 2 === 0;
        if (show && d.getUTCDate() <= 7) {
          axis.appendChild(svgEl('text', { x: x(p.date), y: height - 8, 'text-anchor': 'middle',
            text: MONTHS[d.getUTCMonth()] + (d.getUTCMonth() === 0 ? ' ' + d.getUTCFullYear() : '') }));
        }
      }
    });
    svg.appendChild(axis);

    var area = 'M' + x(pts[0].date) + ',' + y(yMin), line = '';
    pts.forEach(function (p, i) {
      area += ' L' + x(p.date) + ',' + y(p.price);
      line += (i ? ' L' : 'M') + x(p.date) + ',' + y(p.price);
    });
    area += ' L' + x(pts[n - 1].date) + ',' + y(yMin) + ' Z';
    svg.appendChild(svgEl('path', { class: 'price-area', d: area }));
    if (avg2025) {
      svg.appendChild(svgEl('line', { class: 'baseline', x1: m.left, x2: width - m.right, y1: y(avg2025), y2: y(avg2025) }));
      svg.appendChild(svgEl('text', { class: 'baseline-label', x: m.left + 4, y: y(avg2025) - 5, text: '2025 avg $' + fmtNum(avg2025, 0) }));
    }
    if (pts[0].date <= CRISIS_START && pts[n - 1].date >= CRISIS_START) {
      svg.appendChild(svgEl('line', { class: 'sp-event', x1: x(CRISIS_START), x2: x(CRISIS_START), y1: m.top, y2: y(yMin) }));
    }
    svg.appendChild(svgEl('path', { class: 'price-line', d: line }));
    svg.appendChild(svgEl('circle', { class: 'end-dot', cx: x(latest.date), cy: y(latest.price), r: 3.5 }));
    svg.appendChild(svgEl('text', { class: 'end-label', x: x(latest.date) + 7, y: y(latest.price) + 4, text: fmtNum(latest.price, 0) }));

    var cross = svgEl('line', { class: 'crosshair', y1: m.top, y2: y(yMin), visibility: 'hidden' });
    var dot = svgEl('circle', { class: 'hover-dot', r: 4, visibility: 'hidden' });
    svg.appendChild(cross); svg.appendChild(dot);
    var hit = svgEl('rect', { class: 'hit', x: m.left, y: 0, width: pw, height: height });
    svg.appendChild(hit);
    wrap.insertBefore(svg, wrap.firstChild);

    var tooltip = $('brent-tooltip');
    function show(clientX) {
      var rect = svg.getBoundingClientRect();
      var scale = rect.width / width;
      var tx = t0 + (((clientX - rect.left) / scale - m.left) / pw) * (t1 - t0);
      var best = 0, bd = Infinity;
      for (var q = 0; q < n; q++) {
        var dd = Math.abs(parseDate(pts[q].date).getTime() - tx);
        if (dd < bd) { bd = dd; best = q; }
      }
      var p = pts[best];
      cross.setAttribute('x1', x(p.date)); cross.setAttribute('x2', x(p.date)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(p.date)); dot.setAttribute('cy', y(p.price)); dot.setAttribute('visibility', 'visible');
      tooltip.innerHTML = '<div class="t-date">' + fmtDate(p.date, true) + '</div>' +
        '<div class="t-row"><span>Brent</span><b>$' + fmtNum(p.price, 2) + '</b></div>' +
        (avg2025 ? '<div class="t-row"><span>vs 2025 avg</span><b>' + (p.price >= avg2025 ? '+' : '−') + fmtNum(Math.abs((p.price - avg2025) / avg2025 * 100), 0) + '%</b></div>' : '');
      tooltip.hidden = false;
      placeTooltip(tooltip, wrap, svg, width, x(p.date), m.top);
    }
    function hide() { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tooltip.hidden = true; }
    hit.addEventListener('mousemove', function (e) { show(e.clientX); });
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('touchstart', function (e) { show(e.touches[0].clientX); }, { passive: true });
  }

  // ---------- Vessel mix ----------

  function renderMix() {
    var b = state.baseline;
    var last7 = state.rows.slice(-7);
    var box = $('mix');
    box.innerHTML = '';
    var maxBase = Math.max.apply(null, TYPES.map(function (t) { return b[t.key]; }));
    TYPES.forEach(function (t) {
      var now = mean(last7, t.key), base = b[t.key], p = pct(now, base);
      box.appendChild(el('div', { class: 'type', text: t.label }));
      box.appendChild(el('div', { class: 'bars', 'aria-hidden': 'true' }, [
        el('i', { class: 'now', style: 'width:' + Math.max(0.5, (now / maxBase) * 100) + '%' }),
        el('i', { style: 'width:' + Math.max(0.5, (base / maxBase) * 100) + '%' })
      ]));
      box.appendChild(el('div', { class: 'vals', html:
        '<b>' + fmtNum(now, 1) + '</b> vs ' + fmtNum(base, 1) + ' · <b>' + fmtPct(p) + '%</b>' }));
    });
  }

  // ---------- Table ----------

  function renderTable() {
    var b = state.baseline;
    var tbody = $('table').querySelector('tbody');
    tbody.innerHTML = '';
    state.rows.slice(-14).reverse().forEach(function (r) {
      var p = pct(r.total, b.total);
      tbody.appendChild(el('tr', null, [
        el('td', { text: fmtDate(r.date, true) }),
        el('td', { text: fmtNum(r.total) }),
        el('td', { text: fmtNum(r.tanker) }),
        el('td', { text: fmtNum(r.container) }),
        el('td', { text: fmtNum(r.dry_bulk) }),
        el('td', { text: fmtNum(r.general_cargo + r.roro) }),
        el('td', { text: fmtNum(r.capacity) }),
        el('td', null, [el('span', { class: 'delta', 'data-level': levelFor(p), text: fmtPct(p) + '%' })])
      ]));
    });
  }

  // ---------- Timeline ----------

  function renderTimeline() {
    var list = $('timeline');
    list.innerHTML = '';
    var dateIndex = {};
    state.rows.forEach(function (r) { dateIndex[r.date] = r; });
    var majorNum = 0;
    var numbered = EVENTS.map(function (ev) {
      if (ev.major) majorNum++;
      return { ev: ev, num: ev.major ? majorNum : null };
    });
    numbered.slice().reverse().forEach(function (item) {
      var ev = item.ev, r = dateIndex[ev.date];
      var li = el('li', { class: ev.major ? 'major' : '' });
      li.appendChild(el('div', { class: 'tl-date' }, [
        el('span', { class: 'd', text: fmtDate(ev.date, true) }),
        item.num ? el('span', { class: 'n', text: String(item.num) }) : null
      ]));
      li.appendChild(el('div', { class: 'tl-body' }, [
        el('p', { text: ev.label }),
        r ? el('span', { class: 'tl-count', text: fmtNum(r.total) + ' transit' + (r.total === 1 ? '' : 's') + ' that day' }) : null
      ]));
      list.appendChild(li);
    });
    if (!EVENTS.length) list.appendChild(el('li', { text: 'No timeline entries. Add them in data/events.js.' }));
  }

  // ---------- News ----------

  function splitTitle(title) {
    var i = title.lastIndexOf(' - ');
    if (i > 10 && i > title.length - 60) return { headline: title.slice(0, i).trim(), source: title.slice(i + 3).trim() };
    return { headline: title, source: '' };
  }

  function renderNews(items, meta) {
    var list = $('news');
    list.innerHTML = '';
    if (!items.length) {
      list.appendChild(el('li', { class: 'empty', text: 'No headlines available right now.' }));
      return;
    }
    var seen = {};
    items.forEach(function (it) {
      var t = it.source ? { headline: it.title || '', source: it.source } : splitTitle(it.title || '');
      var key = t.headline.toLowerCase().slice(0, 80);
      if (seen[key]) return;
      seen[key] = true;
      list.appendChild(el('li', null, [
        el('div', { class: 'src', html: '<b>' + escapeHtml(t.source || 'News') + '</b><span>' + escapeHtml(relTime(it.pubDate)) + '</span>' }),
        el('a', { href: it.link, target: '_blank', rel: 'noopener', text: t.headline })
      ]));
    });
    $('news-updated').textContent = meta;
  }

  function loadNews() {
    var btn = $('news-refresh');
    var notice = $('news-notice');
    btn.disabled = true;
    notice.hidden = true;
    return fetchJson(NEWS_URL)
      .then(function (json) {
        if (json.status !== 'ok' || !json.items) throw new Error('Feed error');
        var items = json.items.slice().sort(function (a, b) { return (a.pubDate < b.pubDate) ? 1 : -1; }).slice(0, 14);
        renderNews(items, 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      })
      .catch(function () {
        var snap = window.HORMUZ_SNAPSHOT;
        var items = (snap && snap.news) ? snap.news : [];
        var when = snap && snap.fetchedAt ? snap.fetchedAt.slice(0, 10) : '';
        notice.textContent = 'The live feed could not be reached. Showing headlines saved with the site' + (when ? ' on ' + fmtDate(when, true) : '') + '.';
        notice.hidden = false;
        renderNews(items, 'Saved headlines');
      })
      .then(function () { btn.disabled = false; });
  }

  function renderNewsFromSnapshot() {
    var snap = window.HORMUZ_SNAPSHOT;
    $('news-notice').hidden = true;
    renderNews((snap && snap.news) || [], sourceStamp('news'));
  }

  function sourceStamp(key) {
    var snap = window.HORMUZ_SNAPSHOT;
    var source = snap && snap.sources && snap.sources[key];
    if (!source) return 'Saved in snapshot ' + fmtStamp(snap && snap.fetchedAt);
    return (source.lastSuccessAt ? 'Fetched ' + fmtStamp(source.lastSuccessAt) : 'Last successful fetch not recorded') +
      (source.status === 'ok' ? '' : ' · refresh failed');
  }

  // ---------- War tracker ----------

  // Rough keyword classifier for headlines; first match wins, so kinetic events outrank the politics around them.
  var WAR_CATS = [
    { key: 'strikes', label: 'Strikes', re: /\bstrikes?\b|\bstruck\b|missile|\bdrone\b|attack|\bbomb(?:s|ed|ing|ings)?\b|rocket|explosion|\bkilled\b|air ?raid|shell(?:ing|ed)|\bhits?\b|destroy|intercept/i },
    { key: 'naval', label: 'Naval & shipping', re: /\bnavy\b|naval|warship|destroyer|carrier|fleet|tanker|vessel|\bships?\b|shipping|seiz|\bmines?\b|convoy|escort|centcom|blockade|\bports?\b|strait|hormuz|red sea|houthi|saildrone|sail drone/i },
    { key: 'diplomacy', label: 'Diplomacy', re: /cease-?fire|truce|\btalks\b|negotiat|agreement|\bdeal\b|memorandum|summit|envoy|diplomat|\bpeace\b|mediat|\bUN\b|united nations|security council|brics|joint statement|pause/i },
    { key: 'economy', label: 'Sanctions & oil', re: /sanction|embargo|tariff|treasury|\boil\b|brent|crude|\blng\b|\bgas\b|barrel|opec|\bprices?\b|markets?\b|insur|freight|econom|inflation|energy/i },
    { key: 'politics', label: 'Politics', re: /trump|congress|senate|election|midterm|white house|pentagon|netanyahu|khamenei|\bvance\b|president|minister|parliament|poll/i }
  ];

  var WAR_SHOW = 25; // headlines shown before the "Show more" button

  function classifyWar(title) {
    for (var i = 0; i < WAR_CATS.length; i++) if (WAR_CATS[i].re.test(title)) return WAR_CATS[i];
    return { key: 'other', label: 'Update' };
  }

  function warKey(title) { return String(title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 80); }

  // The broad feed matches "Iran" anywhere in an article, which lets in unrelated stories (a Baltic drone incident,
  // Ukraine items); keep only headlines that themselves name the conflict, the region or the oil market.
  var WAR_RELEVANT = /iran|islamic republic|tehran|hormuz|gulf|houthi|yemen|red sea|irgc|khamenei|centcom|strait|tanker|opec|brent|crude|\boil\b|israel|middle east|persian|saudi|kuwait|qatar|bahrain|\buae\b|emirat|oman|iraq|bab.el.mandeb|fujairah|yanbu/i;

  function dayLabel(dateStr) {
    var t = Date.parse(dateStr || '');
    if (isNaN(t)) return 'Undated';
    var d = new Date(t), now = new Date();
    var key = function (x) { return x.getFullYear() * 10000 + x.getMonth() * 100 + x.getDate(); };
    if (key(d) === key(now)) return 'Today';
    if (key(d) === key(new Date(now.getTime() - 86400000))) return 'Yesterday';
    return d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  function setWarItems(items) {
    var seen = {}, out = [];
    items.forEach(function (it) {
      var t = it.source ? { headline: it.title || '', source: it.source } : splitTitle(it.title || '');
      var key = warKey(t.headline);
      if (!t.headline || seen[key] || !WAR_RELEVANT.test(t.headline)) return;
      seen[key] = true;
      var cat = classifyWar(t.headline);
      out.push({ headline: t.headline, source: t.source, link: it.link, pubDate: it.pubDate, cat: cat.key, label: cat.label });
    });
    out.sort(function (a, b) { return (a.pubDate || '') < (b.pubDate || '') ? 1 : -1; });
    state.warItems = out;
    renderWarList();
  }

  function renderWarList() {
    var list = $('war');
    list.innerHTML = '';
    var all = state.warItems.filter(function (it) { return state.war === 'all' || it.cat === state.war; });
    if (!all.length) {
      list.appendChild(el('li', { class: 'empty', text: state.warItems.length ? 'Nothing in this category right now.' : 'No developments available right now.' }));
    }
    var items = state.warShowAll ? all : all.slice(0, WAR_SHOW);
    var lastDay = null;
    items.forEach(function (it) {
      var day = dayLabel(it.pubDate);
      if (day !== lastDay) { list.appendChild(el('li', { class: 'day', text: day })); lastDay = day; }
      list.appendChild(el('li', { class: 'item' }, [
        el('div', { class: 'src' }, [
          el('span', { class: 'tag', 'data-cat': it.cat, text: it.label }),
          el('b', { text: it.source || 'News' }),
          el('span', { class: 'when', text: relTime(it.pubDate) })
        ]),
        el('a', { href: it.link, target: '_blank', rel: 'noopener', text: it.headline })
      ]));
    });
    if (all.length > items.length) {
      var more = el('button', { type: 'button', class: 'btn', text: 'Show ' + (all.length - items.length) + ' more' });
      more.addEventListener('click', function () { state.warShowAll = true; renderWarList(); });
      list.appendChild(el('li', { class: 'more' }, [more]));
    }
    var counts = {};
    state.warItems.forEach(function (it) { counts[it.cat] = (counts[it.cat] || 0) + 1; });
    document.querySelectorAll('#war-seg button[data-war]').forEach(function (b) {
      var k = b.getAttribute('data-war');
      var c = b.querySelector('i');
      if (c) c.textContent = k === 'all' ? state.warItems.length : (counts[k] || 0);
    });
  }

  // The tracker merges the broad war feed with the Hormuz headlines, deduplicated by title.
  function warSourceItems() {
    var snap = window.HORMUZ_SNAPSHOT;
    return ((snap && snap.warNews) || []).concat((snap && snap.news) || []);
  }

  function renderWarFromSnapshot() {
    var snap = window.HORMUZ_SNAPSHOT;
    $('war-notice').hidden = true;
    setWarItems(warSourceItems());
    $('war-updated').textContent = sourceStamp('warNews');
  }

  function loadWar() {
    var btn = $('war-refresh');
    var notice = $('war-notice');
    btn.disabled = true;
    notice.hidden = true;
    return Promise.all([fetchJson(WAR_URL), fetchJson(NEWS_URL).catch(function () { return null; })])
      .then(function (res) {
        var war = res[0], hz = res[1];
        if (war.status !== 'ok' || !war.items) throw new Error('Feed error');
        setWarItems(war.items.concat(hz && hz.items ? hz.items : []));
        $('war-updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      })
      .catch(function () {
        var snap = window.HORMUZ_SNAPSHOT;
        var when = snap && snap.fetchedAt ? snap.fetchedAt.slice(0, 10) : '';
        notice.textContent = 'The live feed could not be reached. Showing developments saved with the site' + (when ? ' on ' + fmtDate(when, true) : '') + '.';
        notice.hidden = false;
        setWarItems(warSourceItems());
        $('war-updated').textContent = 'Saved developments';
      })
      .then(function () { btn.disabled = false; });
  }

  // ---------- Wiring ----------

  function renderAll() {
    renderStale();
    renderHeader();
    renderSummary();
    renderChart();
    renderMix();
    renderTable();
    renderTimeline();
    renderChokepoints();
    renderCountries();
    renderFullPicture();
    renderBalance();
    renderStocks();
    renderPorts();
    renderBrent();
    renderMarkets();
  }

  function wireSegment(selector, attr, onChange) {
    var buttons = document.querySelectorAll(selector + ' button[' + attr + ']');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (b2) { b2.setAttribute('aria-pressed', b2 === btn ? 'true' : 'false'); });
        onChange(btn.getAttribute(attr));
      });
    });
  }

  readHash();
  syncSegments();

  wireSegment('#range-seg', 'data-range', function (v) { state.range = v; writeHash(); renderChart(); });
  wireSegment('#metric-seg', 'data-metric', function (v) { state.metric = v; writeHash(); renderChart(); });
  wireSegment('#cmetric-seg', 'data-cmetric', function (v) { state.cmetric = v; writeHash(); renderCountries(); });
  wireSegment('#bmetric-seg', 'data-bmetric', function (v) { state.bmetric = v; renderBalance(); });
  wireSegment('#pmetric-seg', 'data-pmetric', function (v) { state.pmetric = v; writeHash(); renderPorts(); });
  wireSegment('#war-seg', 'data-war', function (v) { state.war = v; state.warShowAll = false; renderWarList(); });
  wireSegment('#brent-seg', 'data-brange', function (v) { state.brange = v; writeHash(); renderBrent(); });
  wireSegment('#countries-view', 'data-view', function (v) { state.views.countries = v; renderCountries(); });
  wireSegment('#ports-view', 'data-view', function (v) { state.views.ports = v; renderPorts(); });
  wireSegment('#brent-view', 'data-view', function (v) { state.views.brent = v; renderBrent(); });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { renderChart(); renderBrent(); }, 120);
  });

  renderCounter();
  setInterval(renderCounter, 30000);
  setInterval(renderStale, 10 * 60 * 1000);

  // Cached mode: pick up a newer snapshot.json (published by the scheduled job) without a reload.
  var snapshotRequest = null;
  function refreshSnapshot() {
    if (!/^https?:/.test(location.protocol)) return Promise.resolve();
    if (snapshotRequest) return snapshotRequest;
    var buttons = [$('data-refresh'), $('news-refresh'), $('war-refresh')];
    buttons.forEach(function (btn) { btn.disabled = true; });
    function feedback(message) {
      $('refresh-status').textContent = message;
      $('news-updated').textContent = sourceStamp('news') + ' · ' + message;
      $('war-updated').textContent = sourceStamp('warNews') + ' · ' + message;
    }
    feedback('Checking for published updates…');
    snapshotRequest = fetchJson(SNAPSHOT_JSON + '?v=' + Date.now())
      .then(function (json) {
        if (!window.HormuzDataStatus.validSnapshot(json)) throw new Error('The published data file is incomplete');
        var current = window.HORMUZ_SNAPSHOT;
        if (current && Date.parse(json.fetchedAt) < Date.parse(current.fetchedAt)) throw new Error('The server returned an older snapshot');
        if (current && json.fetchedAt === current.fetchedAt) {
          feedback('Checked · you have the latest published snapshot.');
          renderStale();
          return;
        }
        window.HORMUZ_SNAPSHOT = json;
        loadSnapshot();
        state.source = 'cached';
        renderAll();
        renderNewsFromSnapshot();
        renderWarFromSnapshot();
        feedback('Loaded the latest published snapshot.');
      })
      .catch(function () { feedback('Could not check for updates. Saved figures remain; please retry.'); })
      .finally(function () {
        buttons.forEach(function (btn) { btn.disabled = false; });
        snapshotRequest = null;
      });
    return snapshotRequest;
  }

  var haveSnapshot = loadSnapshot();

  if (DATA_MODE === 'cached') {
    if (!haveSnapshot) {
      $('status-text').textContent = 'Data file missing';
      $('status-meta').textContent = 'data/snapshot.js was not found. Run the build script or the workflow.';
    } else {
      state.source = 'cached';
      renderAll();
      renderNewsFromSnapshot();
      renderWarFromSnapshot();
    }
    $('news-refresh').addEventListener('click', refreshSnapshot);
    $('war-refresh').addEventListener('click', refreshSnapshot);
    $('data-refresh').addEventListener('click', refreshSnapshot);

    var CHECK_EVERY = 15 * 60 * 1000;
    var lastCheck = Date.now();
    // Recover from a cached or missing snapshot.js immediately on every page load.
    refreshSnapshot();
    setInterval(function () { lastCheck = Date.now(); refreshSnapshot(); }, CHECK_EVERY);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck > CHECK_EVERY) {
        lastCheck = Date.now();
        refreshSnapshot();
      }
    });
    return;
  }

  // ---------- Live mode ----------

  if (haveSnapshot) { renderAll(); renderNewsFromSnapshot(); renderWarFromSnapshot(); }

  function afterLive() { renderHeader(); renderSummary(); renderChart(); renderMix(); renderTable(); renderTimeline(); }

  loadLive().then(afterLive).catch(function (err) {
    if (!haveSnapshot) {
      $('status-text').textContent = 'Traffic data unavailable';
      $('status-meta').textContent = 'Could not reach IMF PortWatch (' + err.message + ').';
    } else {
      $('status-meta').textContent += ' · live update failed';
    }
  });
  loadChokepoints().then(renderChokepoints).catch(function () {});
  loadCountries().then(function () { renderCountries(); renderBalance(); renderFullPicture(); renderSummary(); }).catch(function () {});
  $('news-refresh').addEventListener('click', loadNews);
  loadNews();
  $('war-refresh').addEventListener('click', loadWar);
  loadWar();

  var TRAFFIC_EVERY = 60 * 60 * 1000, NEWS_EVERY = 10 * 60 * 1000;
  var lastTraffic = Date.now(), lastNews = Date.now();
  function refreshTraffic() {
    lastTraffic = Date.now();
    loadLive().then(afterLive).catch(function () {});
    loadChokepoints().then(renderChokepoints).catch(function () {});
    loadCountries().then(function () { renderCountries(); renderBalance(); renderFullPicture(); renderSummary(); }).catch(function () {});
  }
  function refreshNews() { lastNews = Date.now(); loadNews(); loadWar(); }
  setInterval(refreshTraffic, TRAFFIC_EVERY);
  setInterval(refreshNews, NEWS_EVERY);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastTraffic > TRAFFIC_EVERY) refreshTraffic();
    if (Date.now() - lastNews > NEWS_EVERY) refreshNews();
  });
})();
