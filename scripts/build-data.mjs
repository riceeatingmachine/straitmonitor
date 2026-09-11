// Builds data/snapshot.json and data/snapshot.js from the live sources.
// Runs on Node 18+ with no dependencies. Used by the GitHub Actions workflow twice a day;
// can also be run by hand:  node scripts/build-data.mjs
//
// Each section falls back to the previously saved data if its source is unreachable,
// so one flaky feed never wipes out the rest. The Hormuz series itself must succeed.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const jsonPath = path.join(dataDir, 'snapshot.json');
const jsPath = path.join(dataDir, 'snapshot.js');

const BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
const TRADE_BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Trade_Data_REG/FeatureServer/0/query';
const COUNTRIES = ['QAT', 'KWT', 'IRQ', 'BHR', 'IRN', 'SAU', 'ARE', 'OMN'];
const COUNTRY_COLUMNS = ['iso3', 'date', 'export', 'export_tanker', 'import'];
const PORTS_BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Ports_Data/FeatureServer/0/query';
// Yanbu, Fujairah, Sohar, Salalah (outside the strait); Juaymah, Ras Laffan, Basrah Oil Terminal, Jebel Ali (inside)
const PORTS = ['port570', 'port362', 'port988', 'port746', 'port526', 'port1090', 'port2479', 'port744'];
const PORT_COLUMNS = ['portid', 'date', 'export', 'import', 'portcalls'];
const NEWS_RSS = 'https://news.google.com/rss/search?q=%22Strait+of+Hormuz%22&hl=en-US&gl=US&ceid=US:en';
// Broader feed for the war tracker: strikes, naval incidents, diplomacy, sanctions and the oil market.
const WAR_RSS = 'https://news.google.com/rss/search?q=Iran+(war+OR+strike+OR+strikes+OR+missile+OR+missiles+OR+ceasefire+OR+IRGC+OR+blockade+OR+drone+OR+navy+OR+CENTCOM+OR+sanctions)&hl=en-US&gl=US&ceid=US:en';

const COLUMNS = ['date', 'n_total', 'n_tanker', 'n_container', 'n_dry_bulk', 'n_general_cargo', 'n_roro', 'capacity', 'capacity_tanker'];
const CHOKE_COLUMNS = ['date', 'portid', 'portname', 'n_total', 'n_tanker', 'capacity'];

async function query(params, base = BASE) {
  const url = base + '?' + new URLSearchParams({ ...params, f: 'json' });
  const res = await fetch(url, { headers: { 'User-Agent': 'hormuz-transit-watch/1.0' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`PortWatch HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`PortWatch error: ${JSON.stringify(json.error)}`);
  if (!Array.isArray(json.features)) throw new Error('PortWatch: no features');
  return json.features.map((f) => f.attributes);
}

function isoDate(v) {
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

async function fetchHormuz() {
  const rows = await query({
    where: "portid='chokepoint6' AND date >= DATE '2025-01-01'",
    outFields: COLUMNS.join(','),
    orderByFields: 'date ASC',
    resultRecordCount: '2000'
  });
  if (rows.length < 300) throw new Error(`Hormuz series unexpectedly short (${rows.length} rows)`);
  return rows
    .map((a) => COLUMNS.map((c) => (c === 'date' ? isoDate(a[c]) : a[c] ?? 0)))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

async function fetchChokepointRecent() {
  const rows = await query({
    where: 'date >= CURRENT_DATE - 14',
    outFields: CHOKE_COLUMNS.join(','),
    orderByFields: 'date ASC',
    resultRecordCount: '2000'
  });
  return rows.map((a) => CHOKE_COLUMNS.map((c) => (c === 'date' ? isoDate(a[c]) : a[c] ?? 0)));
}

async function fetchChokepointBaselines() {
  const rows = await query({
    where: 'year=2025',
    groupByFieldsForStatistics: 'portid,portname',
    outStatistics: JSON.stringify([
      { statisticType: 'avg', onStatisticField: 'n_total', outStatisticFieldName: 'avg_total' },
      { statisticType: 'avg', onStatisticField: 'n_tanker', outStatisticFieldName: 'avg_tanker' },
      { statisticType: 'avg', onStatisticField: 'capacity', outStatisticFieldName: 'avg_capacity' }
    ])
  });
  return rows.map((a) => ({
    portid: a.portid, portname: a.portname,
    avg_total: a.avg_total, avg_tanker: a.avg_tanker, avg_capacity: a.avg_capacity
  }));
}

// Country-level daily trade estimates (metric tons) for the Gulf states, since 2026-01-01.
async function fetchCountryRows() {
  const perCountry = await Promise.all(COUNTRIES.map((iso) => query({
    where: `ISO3='${iso}' AND date >= DATE '2026-01-01'`,
    outFields: 'date,export,export_tanker,import',
    orderByFields: 'date ASC',
    resultRecordCount: '2000'
  }, TRADE_BASE).then((rows) => rows.map((a) => [iso, isoDate(a.date), a.export ?? 0, a.export_tanker ?? 0, a.import ?? 0]))));
  const rows = perCountry.flat();
  if (rows.length < 100) throw new Error(`Country trade series unexpectedly small (${rows.length} rows)`);
  return rows;
}

async function fetchCountryBaselines() {
  const rows = await query({
    where: `ISO3 IN ('${COUNTRIES.join("','")}') AND date >= DATE '2025-01-01' AND date <= DATE '2025-12-31'`,
    groupByFieldsForStatistics: 'ISO3,country',
    outStatistics: JSON.stringify([
      { statisticType: 'avg', onStatisticField: 'export', outStatisticFieldName: 'avg_export' },
      { statisticType: 'avg', onStatisticField: 'export_tanker', outStatisticFieldName: 'avg_export_tanker' },
      { statisticType: 'avg', onStatisticField: 'import', outStatisticFieldName: 'avg_import' }
    ])
  }, TRADE_BASE);
  if (rows.length < 5) throw new Error('Country baselines unexpectedly small');
  return rows.map((a) => ({ iso3: a.ISO3, country: a.country, avg_export: a.avg_export, avg_export_tanker: a.avg_export_tanker, avg_import: a.avg_import }));
}

async function fetchPortRows() {
  const perPort = await Promise.all(PORTS.map((pid) => query({
    where: `portid='${pid}' AND date >= DATE '2026-01-01'`,
    outFields: 'date,export,import,portcalls',
    orderByFields: 'date ASC',
    resultRecordCount: '2000'
  }, PORTS_BASE).then((rows) => rows.map((a) => [pid, isoDate(a.date), a.export ?? 0, a.import ?? 0, a.portcalls ?? 0]))));
  const rows = perPort.flat();
  if (rows.length < 100) throw new Error(`Port series unexpectedly small (${rows.length} rows)`);
  return rows;
}

async function fetchPortBaselines() {
  const rows = await query({
    where: `year=2025 AND portid IN ('${PORTS.join("','")}')`,
    groupByFieldsForStatistics: 'portid,portname,country',
    outStatistics: JSON.stringify([
      { statisticType: 'avg', onStatisticField: 'export', outStatisticFieldName: 'avg_export' },
      { statisticType: 'avg', onStatisticField: 'import', outStatisticFieldName: 'avg_import' },
      { statisticType: 'avg', onStatisticField: 'portcalls', outStatisticFieldName: 'avg_calls' }
    ])
  }, PORTS_BASE);
  if (rows.length < 5) throw new Error('Port baselines unexpectedly small');
  return rows.map((a) => ({ portid: a.portid, portname: a.portname, country: a.country, avg_export: a.avg_export, avg_import: a.avg_import, avg_calls: a.avg_calls }));
}

// Brent crude: ICE front-month futures via Yahoo Finance (current), EIA daily spot via FRED as fallback.
async function fetchBrentFred() {
  const res = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; hormuz-transit-watch/1.0)' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
  const lines = (await res.text()).split('\n').slice(1);
  const series = [];
  for (const line of lines) {
    const [date, value] = line.trim().split(',');
    if (!date || date < '2025-01-01' || !value || value === '.') continue;
    series.push([date, Number(value)]);
  }
  if (series.length < 200) throw new Error(`FRED Brent series too short (${series.length})`);
  return { source: 'FRED', label: 'Brent spot, FOB Europe (EIA via FRED)', unit: 'USD per barrel', series };
}

async function fetchBrentYahoo() {
  const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?range=2y&interval=1d', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error('Yahoo: no result');
  const closes = r.indicators.quote[0].close;
  const series = [];
  r.timestamp.forEach((t, i) => {
    if (closes[i] == null) return;
    const d = new Date(t * 1000).toISOString().slice(0, 10);
    if (d >= '2025-01-01') series.push([d, Math.round(closes[i] * 100) / 100]);
  });
  if (series.length < 200) throw new Error('Yahoo Brent series too short');
  return { source: 'Yahoo', label: 'ICE Brent front-month futures, daily close', unit: 'USD per barrel', series };
}

async function fetchBrent() {
  try { return await fetchBrentYahoo(); }
  catch (err) { console.warn(`Brent via Yahoo failed (${err.message}); trying FRED`); return await fetchBrentFred(); }
}

// Polymarket prediction markets on the crisis, via the public Gamma API (no key).
// Discovery: a text search for "hormuz" plus the highest-volume open events tagged "iran", filtered by keyword.
const PM_KEYWORDS = /hormuz|strait|ceasefire|cease-fire|peace deal|peace agreement|blockade|brent|oil price|crude/i;
const PM_PINNED_SLUGS = [
  'strait-of-hormuz-traffic-returns-to-normal-by-december-31',
  'us-x-iran-permanent-peace-deal-by',
  'us-x-iran-ceasefire-extended-by'
];

async function pmGet(path) {
  const res = await fetch('https://gamma-api.polymarket.com' + path, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; hormuz-transit-watch/1.0)', Accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`Polymarket HTTP ${res.status} for ${path}`);
  return res.json();
}

function pmParseList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

function pmNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function pmShapeEvent(ev) {
  const markets = (ev.markets || [])
    .filter((m) => m && m.closed !== true && m.archived !== true)
    .map((m) => {
      const outcomes = pmParseList(m.outcomes);
      const prices = pmParseList(m.outcomePrices).map(Number);
      let yes = null;
      const yi = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
      if (yi >= 0 && Number.isFinite(prices[yi])) yes = prices[yi];
      else if (Number.isFinite(prices[0])) yes = prices[0];
      return {
        question: m.question || '',
        short: m.groupItemTitle || '',
        yes,
        volume: pmNum(m.volumeNum ?? m.volume),
        change1d: pmNum(m.oneDayPriceChange),
        change1w: pmNum(m.oneWeekPriceChange),
        endDate: m.endDate || ev.endDate || null,
        description: (m.description || '').slice(0, 600)
      };
    })
    .filter((m) => m.yes != null);
  return {
    slug: ev.slug, title: ev.title || '', volume: pmNum(ev.volumeNum ?? ev.volume), liquidity: pmNum(ev.liquidityNum ?? ev.liquidity),
    endDate: ev.endDate || null, description: (ev.description || '').slice(0, 600), markets
  };
}

async function fetchPolymarket() {
  const found = new Map();
  const add = (ev) => { if (ev && ev.slug && !ev.closed && !found.has(ev.slug)) found.set(ev.slug, ev); };

  const [search, tagged] = await Promise.allSettled([
    pmGet('/public-search?q=hormuz&limit_per_type=30'),
    pmGet('/events?tag_slug=iran&closed=false&order=volume&ascending=false&limit=80')
  ]);
  if (search.status === 'fulfilled') (search.value?.events || []).forEach(add);
  if (tagged.status === 'fulfilled') (Array.isArray(tagged.value) ? tagged.value : []).filter((ev) => PM_KEYWORDS.test(ev.title || '')).forEach(add);

  // Pinned events: always try, and fill in markets where the discovery response omitted them.
  for (const slug of PM_PINNED_SLUGS.concat([...found.keys()])) {
    const ev = found.get(slug);
    if (ev && Array.isArray(ev.markets) && ev.markets.length) continue;
    try {
      const full = await pmGet('/events?slug=' + encodeURIComponent(slug));
      const e = Array.isArray(full) ? full[0] : full;
      if (e) found.set(slug, e);
    } catch (err) { console.warn(`Polymarket: could not load ${slug} (${err.message})`); }
  }

  const events = [...found.values()].map(pmShapeEvent).filter((e) => e.markets.length)
    .sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 20);
  if (!events.length) throw new Error('Polymarket: no usable events');
  return { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), events };
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decodeEntities(m[1]) : '';
}

async function fetchFeed(url, limit) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; hormuz-transit-watch/1.0)' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Google News HTTP ${res.status}`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const seen = new Set();
  const out = [];
  for (const block of items) {
    let title = tag(block, 'title');
    const source = tag(block, 'source');
    const link = tag(block, 'link');
    const pub = tag(block, 'pubDate');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    const key = title.toLowerCase().slice(0, 80);
    if (!title || !link || seen.has(key)) continue;
    seen.add(key);
    const t = Date.parse(pub);
    out.push({ title, link, source, pubDate: isNaN(t) ? null : new Date(t).toISOString() });
  }
  if (!out.length) throw new Error('Google News: no items parsed');
  out.sort((a, b) => (a.pubDate < b.pubDate ? 1 : -1));
  return out.slice(0, limit);
}

const fetchNews = () => fetchFeed(NEWS_RSS, 20);
const fetchWarNews = () => fetchFeed(WAR_RSS, 40);

async function loadExisting() {
  try { return JSON.parse(await readFile(jsonPath, 'utf8')); } catch { return null; }
}

async function section(name, fn, fallback) {
  try {
    const value = await fn();
    console.log(`${name}: ok (${Array.isArray(value) ? value.length + ' items' : 'object'})`);
    return value;
  } catch (err) {
    if (fallback !== undefined) {
      console.warn(`${name}: FAILED (${err.message}); keeping previous data`);
      return fallback;
    }
    throw err;
  }
}

const previous = await loadExisting();

const rows = await fetchHormuz(); // must succeed
console.log(`Hormuz series: ${rows.length} rows, ${rows[0][0]} to ${rows[rows.length - 1][0]}`);

const snapshot = {
  fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  columns: COLUMNS,
  rows,
  chokepointColumns: CHOKE_COLUMNS,
  chokepointRecent: await section('Chokepoint recent', fetchChokepointRecent, previous?.chokepointRecent),
  chokepointBaselines: await section('Chokepoint baselines', fetchChokepointBaselines, previous?.chokepointBaselines),
  countryColumns: COUNTRY_COLUMNS,
  countryRows: await section('Country trade rows', fetchCountryRows, previous?.countryRows),
  countryBaselines: await section('Country baselines', fetchCountryBaselines, previous?.countryBaselines),
  portColumns: PORT_COLUMNS,
  portRows: await section('Port rows', fetchPortRows, previous?.portRows),
  portBaselines: await section('Port baselines', fetchPortBaselines, previous?.portBaselines),
  brent: await section('Brent', fetchBrent, previous?.brent),
  polymarket: await section('Polymarket', fetchPolymarket, previous?.polymarket ?? null),
  news: await section('News', fetchNews, previous?.news),
  warNews: await section('War news', fetchWarNews, previous?.warNews ?? [])
};

await mkdir(dataDir, { recursive: true });
const json = JSON.stringify(snapshot);
await writeFile(jsonPath, json + '\n');
await writeFile(jsPath, `window.HORMUZ_SNAPSHOT = ${json};\n`);
console.log(`Wrote ${path.relative(root, jsonPath)} and ${path.relative(root, jsPath)} (${json.length} bytes)`);
