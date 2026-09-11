# Rebuilds data/snapshot.json and data/snapshot.js from the live sources, for Windows machines without Node.
# The GitHub Actions workflow uses scripts/build-data.mjs to do the same thing on a schedule.
# Usage: powershell -ExecutionPolicy Bypass -File build-snapshot.ps1
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query'
$jsonPath = Join-Path $root 'data\snapshot.json'
$jsPath = Join-Path $root 'data\snapshot.js'

$previous = $null
if (Test-Path $jsonPath) { try { $previous = Get-Content $jsonPath -Raw | ConvertFrom-Json } catch {} }

# 1. Hormuz daily series since 2025-01-01 (must succeed)
$u = "${base}?where=portid%3D%27chokepoint6%27+AND+date+%3E%3D+DATE+%272025-01-01%27&outFields=date,n_total,n_tanker,n_container,n_dry_bulk,n_general_cargo,n_roro,capacity,capacity_tanker&orderByFields=date+ASC&resultRecordCount=2000&f=json"
$r = Invoke-RestMethod -Uri $u -UseBasicParsing
$rows = @($r.features | ForEach-Object { $a = $_.attributes; ,@($a.date, $a.n_total, $a.n_tanker, $a.n_container, $a.n_dry_bulk, $a.n_general_cargo, $a.n_roro, $a.capacity, $a.capacity_tanker) })
if ($rows.Count -lt 300) { throw "Hormuz series unexpectedly short ($($rows.Count) rows)" }
Write-Host "Hormuz rows: $($rows.Count) ($($rows[0][0]) to $($rows[-1][0]))"

# 2. All chokepoints: last 14 days
$recent = $null
try {
  $u2 = "${base}?where=date+%3E%3D+CURRENT_DATE+-+14&outFields=date,portid,portname,n_total,n_tanker,capacity&orderByFields=date+ASC&resultRecordCount=2000&f=json"
  $r2 = Invoke-RestMethod -Uri $u2 -UseBasicParsing
  $recent = @($r2.features | ForEach-Object { $a = $_.attributes; ,@($a.date, $a.portid, $a.portname, $a.n_total, $a.n_tanker, $a.capacity) })
  Write-Host "Recent chokepoint rows: $($recent.Count)"
} catch { Write-Warning "Chokepoint recent failed: $_"; if ($previous) { $recent = $previous.chokepointRecent } }

# 3. All chokepoints: 2025 averages
$baselines = $null
try {
  $stats = '[{"statisticType":"avg","onStatisticField":"n_total","outStatisticFieldName":"avg_total"},{"statisticType":"avg","onStatisticField":"n_tanker","outStatisticFieldName":"avg_tanker"},{"statisticType":"avg","onStatisticField":"capacity","outStatisticFieldName":"avg_capacity"}]'
  $u3 = "${base}?where=year%3D2025&groupByFieldsForStatistics=portid,portname&outStatistics=$([Uri]::EscapeDataString($stats))&f=json"
  $r3 = Invoke-RestMethod -Uri $u3 -UseBasicParsing
  $baselines = @($r3.features | ForEach-Object { $a = $_.attributes; [ordered]@{ portid = $a.portid; portname = $a.portname; avg_total = $a.avg_total; avg_tanker = $a.avg_tanker; avg_capacity = $a.avg_capacity } })
  Write-Host "Chokepoint baselines: $($baselines.Count)"
} catch { Write-Warning "Chokepoint baselines failed: $_"; if ($previous) { $baselines = $previous.chokepointBaselines } }

# 3b. Gulf states: country-level daily trade estimates (metric tons) since 2026-01-01, plus 2025 averages
$tradeBase = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Trade_Data_REG/FeatureServer/0/query'
$isoList = @('QAT','KWT','IRQ','BHR','IRN','SAU','ARE','OMN')
$countryRows = $null
$countryBaselines = $null
try {
  $countryRows = @()
  foreach ($iso in $isoList) {
    $w = [Uri]::EscapeDataString("ISO3='$iso' AND date >= DATE '2026-01-01'")
    $uc = "${tradeBase}?where=$w&outFields=date,export,export_tanker,import&orderByFields=date+ASC&resultRecordCount=2000&f=json"
    $rc = Invoke-RestMethod -Uri $uc -UseBasicParsing
    $countryRows += @($rc.features | ForEach-Object { $a = $_.attributes; ,@($iso, $a.date, $a.export, $a.export_tanker, $a.import) })
  }
  $inList = "ISO3 IN ('" + ($isoList -join "','") + "')"
  $cstats = '[{"statisticType":"avg","onStatisticField":"export","outStatisticFieldName":"avg_export"},{"statisticType":"avg","onStatisticField":"export_tanker","outStatisticFieldName":"avg_export_tanker"},{"statisticType":"avg","onStatisticField":"import","outStatisticFieldName":"avg_import"}]'
  $ub = "${tradeBase}?where=$([Uri]::EscapeDataString("$inList AND date >= DATE '2025-01-01' AND date <= DATE '2025-12-31'"))&groupByFieldsForStatistics=ISO3,country&outStatistics=$([Uri]::EscapeDataString($cstats))&f=json"
  $rb = Invoke-RestMethod -Uri $ub -UseBasicParsing
  $countryBaselines = @($rb.features | ForEach-Object { $a = $_.attributes; [ordered]@{ iso3 = $a.ISO3; country = $a.country; avg_export = $a.avg_export; avg_export_tanker = $a.avg_export_tanker; avg_import = $a.avg_import } })
  if ($countryRows.Count -lt 100 -or $countryBaselines.Count -lt 5) { throw "Country trade data unexpectedly small" }
  Write-Host "Country trade rows: $($countryRows.Count); baselines: $($countryBaselines.Count)"
} catch { Write-Warning "Country trade failed: $_"; if ($previous) { $countryRows = $previous.countryRows; $countryBaselines = $previous.countryBaselines } }

# 3d. Key ports: daily port calls and estimated tonnes since 2026-01-01, plus 2025 averages
$portsBase = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Ports_Data/FeatureServer/0/query'
$portIds = @('port570','port362','port988','port746','port526','port1090','port2479','port744')
$portRows = $null
$portBaselines = $null
try {
  $portRows = @()
  foreach ($portId in $portIds) {
    $w = [Uri]::EscapeDataString("portid='$portId' AND date >= DATE '2026-01-01'")
    $up = "${portsBase}?where=$w&outFields=date,export,import,portcalls&orderByFields=date+ASC&resultRecordCount=2000&f=json"
    $rp = Invoke-RestMethod -Uri $up -UseBasicParsing -TimeoutSec 60
    $portRows += @($rp.features | ForEach-Object { $a = $_.attributes; ,@($portId, $a.date, $a.export, $a.import, $a.portcalls) })
  }
  $pin = "portid IN ('" + ($portIds -join "','") + "')"
  $pstats = '[{"statisticType":"avg","onStatisticField":"export","outStatisticFieldName":"avg_export"},{"statisticType":"avg","onStatisticField":"import","outStatisticFieldName":"avg_import"},{"statisticType":"avg","onStatisticField":"portcalls","outStatisticFieldName":"avg_calls"}]'
  $ub = "${portsBase}?where=$([Uri]::EscapeDataString("year=2025 AND $pin"))&groupByFieldsForStatistics=portid,portname,country&outStatistics=$([Uri]::EscapeDataString($pstats))&f=json"
  $rb = Invoke-RestMethod -Uri $ub -UseBasicParsing -TimeoutSec 60
  $portBaselines = @($rb.features | ForEach-Object { $a = $_.attributes; [ordered]@{ portid = $a.portid; portname = $a.portname; country = $a.country; avg_export = $a.avg_export; avg_import = $a.avg_import; avg_calls = $a.avg_calls } })
  if ($portRows.Count -lt 100 -or $portBaselines.Count -lt 5) { throw "Port data unexpectedly small" }
  Write-Host "Port rows: $($portRows.Count); baselines: $($portBaselines.Count)"
} catch { Write-Warning "Ports failed: $_"; if ($previous) { $portRows = $previous.portRows; $portBaselines = $previous.portBaselines } }

# 3c. Brent crude price: ICE front-month futures via Yahoo Finance (current); EIA daily spot via FRED as fallback.
$brent = $null
try {
  $y = Invoke-RestMethod -Uri 'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?range=2y&interval=1d' -UseBasicParsing -UserAgent 'Mozilla/5.0' -TimeoutSec 30
  $res = $y.chart.result[0]; $ts = $res.timestamp; $cl = $res.indicators.quote[0].close
  $series = @()
  for ($i = 0; $i -lt $ts.Count; $i++) {
    if ($null -eq $cl[$i]) { continue }
    $d = [DateTimeOffset]::FromUnixTimeSeconds($ts[$i]).UtcDateTime.ToString('yyyy-MM-dd')
    if ($d -ge '2025-01-01') { $series += ,@($d, [math]::Round([double]$cl[$i], 2)) }
  }
  if ($series.Count -lt 200) { throw "Yahoo Brent series too short ($($series.Count))" }
  $brent = [ordered]@{ source = 'Yahoo'; label = 'ICE Brent front-month futures, daily close'; unit = 'USD per barrel'; series = $series }
  Write-Host "Brent (Yahoo): $($series.Count) points, last $($series[-1][0]) = $($series[-1][1])"
} catch {
  Write-Warning "Brent via Yahoo failed: $_"
  try {
    $csv = (Invoke-WebRequest -Uri 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU' -UseBasicParsing -UserAgent 'Mozilla/5.0' -TimeoutSec 20).Content
    $series = @()
    foreach ($line in ($csv -split "`n" | Select-Object -Skip 1)) {
      $parts = $line.Trim() -split ','
      if ($parts.Count -lt 2 -or $parts[0] -lt '2025-01-01' -or $parts[1] -eq '.' -or $parts[1] -eq '') { continue }
      $series += ,@($parts[0], [double]$parts[1])
    }
    if ($series.Count -lt 200) { throw "FRED Brent series too short ($($series.Count))" }
    $brent = [ordered]@{ source = 'FRED'; label = 'Brent spot, FOB Europe (EIA via FRED)'; unit = 'USD per barrel'; series = $series }
    Write-Host "Brent (FRED): $($series.Count) points, last $($series[-1][0]) = $($series[-1][1])"
  } catch { Write-Warning "Brent via FRED failed: $_"; if ($previous) { $brent = $previous.brent } }
}

# 3e. Polymarket prediction markets (public Gamma API). Often blocked on home networks; the workflow runner reaches it.
$polymarket = $null
try {
  $pmHeaders = @{ 'Accept' = 'application/json' }
  $found = [ordered]@{}
  $kw = 'hormuz|strait|ceasefire|cease-fire|peace deal|peace agreement|blockade|brent|oil price|crude'
  try {
    $s = Invoke-RestMethod -Uri 'https://gamma-api.polymarket.com/public-search?q=hormuz&limit_per_type=30' -UseBasicParsing -TimeoutSec 20 -Headers $pmHeaders -UserAgent 'Mozilla/5.0'
    foreach ($ev in @($s.events)) { if ($ev.slug -and -not $ev.closed -and -not $found.Contains($ev.slug)) { $found[$ev.slug] = $ev } }
  } catch { Write-Warning "Polymarket search failed: $($_.Exception.Message)" }
  try {
    $t = Invoke-RestMethod -Uri 'https://gamma-api.polymarket.com/events?tag_slug=iran&closed=false&order=volume&ascending=false&limit=80' -UseBasicParsing -TimeoutSec 20 -Headers $pmHeaders -UserAgent 'Mozilla/5.0'
    foreach ($ev in @($t)) { if ($ev.slug -and ($ev.title -match $kw) -and -not $found.Contains($ev.slug)) { $found[$ev.slug] = $ev } }
  } catch { Write-Warning "Polymarket tag query failed: $($_.Exception.Message)" }
  $pinned = @('strait-of-hormuz-traffic-returns-to-normal-by-december-31','us-x-iran-permanent-peace-deal-by','us-x-iran-ceasefire-extended-by')
  foreach ($slug in ($pinned + @($found.Keys))) {
    $ev = $found[$slug]
    if ($ev -and $ev.markets -and @($ev.markets).Count -gt 0) { continue }
    try {
      $full = Invoke-RestMethod -Uri ("https://gamma-api.polymarket.com/events?slug=" + [Uri]::EscapeDataString($slug)) -UseBasicParsing -TimeoutSec 20 -Headers $pmHeaders -UserAgent 'Mozilla/5.0'
      $e = @($full)[0]
      if ($e) { $found[$slug] = $e }
    } catch {}
  }
  $events = @()
  foreach ($ev in $found.Values) {
    $markets = @()
    foreach ($m in @($ev.markets)) {
      if (-not $m -or $m.closed -eq $true) { continue }
      # PowerShell 5.1 returns a JSON array as one Object[] item; assign first, then enumerate.
      $outcomes = @(); $prices = @()
      try { $oArr = if ($m.outcomes -is [string]) { ConvertFrom-Json -InputObject $m.outcomes } else { $m.outcomes }; $outcomes = @($oArr | ForEach-Object { [string]$_ }) } catch {}
      try { $pArr = if ($m.outcomePrices -is [string]) { ConvertFrom-Json -InputObject $m.outcomePrices } else { $m.outcomePrices }; $prices = @($pArr | ForEach-Object { [double]$_ }) } catch {}
      $yi = [array]::IndexOf(@($outcomes | ForEach-Object { $_.ToLower() }), 'yes')
      $yes = $null
      if ($yi -ge 0 -and $prices.Count -gt $yi) { $yes = $prices[$yi] } elseif ($prices.Count -gt 0) { $yes = $prices[0] }
      if ($null -eq $yes) { continue }
      $vol = if ($null -ne $m.volumeNum) { [double]$m.volumeNum } elseif ($m.volume) { [double]$m.volume } else { $null }
      $markets += [ordered]@{ question = [string]$m.question; short = [string]$m.groupItemTitle; yes = $yes; volume = $vol
        change1d = $(if ($null -ne $m.oneDayPriceChange) { [double]$m.oneDayPriceChange } else { $null })
        change1w = $(if ($null -ne $m.oneWeekPriceChange) { [double]$m.oneWeekPriceChange } else { $null })
        endDate = $(if ($m.endDate) { [string]$m.endDate } else { [string]$ev.endDate })
        description = $(if ($m.description) { ([string]$m.description).Substring(0, [math]::Min(600, ([string]$m.description).Length)) } else { '' }) }
    }
    if (-not $markets.Count) { continue }
    $evol = if ($null -ne $ev.volumeNum) { [double]$ev.volumeNum } elseif ($ev.volume) { [double]$ev.volume } else { 0 }
    $events += [ordered]@{ slug = [string]$ev.slug; title = [string]$ev.title; volume = $evol; endDate = [string]$ev.endDate
      description = $(if ($ev.description) { ([string]$ev.description).Substring(0, [math]::Min(600, ([string]$ev.description).Length)) } else { '' }); markets = $markets }
  }
  $events = @($events | Sort-Object -Property volume -Descending | Select-Object -First 20)
  if (-not $events.Count) { throw 'no usable events' }
  $polymarket = [ordered]@{ fetchedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); events = $events }
  Write-Host "Polymarket: $($events.Count) events"
} catch { Write-Warning "Polymarket failed: $_"; if ($previous -and $previous.polymarket) { $polymarket = $previous.polymarket } }

# 4. News straight from the Google News RSS feeds (no relay service)
function Get-Feed([string]$url, [int]$limit) {
  $rss = Invoke-RestMethod -Uri $url -UseBasicParsing -UserAgent 'Mozilla/5.0 (compatible; hormuz-transit-watch/1.0)'
  $seen = @{}
  $items = @()
  foreach ($item in $rss) {
    $title = [string]$item.title
    $source = if ($item.source) { [string]$item.source.'#text' } else { '' }
    if ($source -and $title.EndsWith(" - $source")) { $title = $title.Substring(0, $title.Length - $source.Length - 3).Trim() }
    $key = $title.ToLower(); if ($key.Length -gt 80) { $key = $key.Substring(0, 80) }
    if (-not $title -or $seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $pub = $null
    try { $pub = ([DateTime]::Parse($item.pubDate, [Globalization.CultureInfo]::InvariantCulture)).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } catch {}
    $items += [ordered]@{ title = $title; link = [string]$item.link; source = $source; pubDate = $pub }
  }
  return @($items | Sort-Object -Property pubDate -Descending | Select-Object -First $limit)
}
$news = $null
try {
  $news = Get-Feed 'https://news.google.com/rss/search?q=%22Strait+of+Hormuz%22&hl=en-US&gl=US&ceid=US:en' 20
  Write-Host "News items: $($news.Count)"
} catch { Write-Warning "News failed: $_"; if ($previous) { $news = $previous.news } }
$warNews = @()
try {
  $warNews = Get-Feed 'https://news.google.com/rss/search?q=Iran+(war+OR+strike+OR+strikes+OR+missile+OR+missiles+OR+ceasefire+OR+IRGC+OR+blockade+OR+drone+OR+navy+OR+CENTCOM+OR+sanctions)&hl=en-US&gl=US&ceid=US:en' 40
  Write-Host "War news items: $($warNews.Count)"
} catch { Write-Warning "War news failed: $_"; if ($previous -and $previous.warNews) { $warNews = $previous.warNews } }

$snap = [ordered]@{
  fetchedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  columns = @('date','n_total','n_tanker','n_container','n_dry_bulk','n_general_cargo','n_roro','capacity','capacity_tanker')
  rows = $rows
  chokepointColumns = @('date','portid','portname','n_total','n_tanker','capacity')
  chokepointRecent = $recent
  chokepointBaselines = $baselines
  countryColumns = @('iso3','date','export','export_tanker','import')
  countryRows = $countryRows
  countryBaselines = $countryBaselines
  portColumns = @('portid','date','export','import','portcalls')
  portRows = $portRows
  portBaselines = $portBaselines
  brent = $brent
  polymarket = $polymarket
  news = $news
  warNews = $warNews
}
$json = $snap | ConvertTo-Json -Depth 6 -Compress
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($jsonPath, $json + "`n", $utf8)
[IO.File]::WriteAllText($jsPath, "window.HORMUZ_SNAPSHOT = $json;`n", $utf8)
Write-Host "Wrote data\snapshot.json and data\snapshot.js ($($json.Length) bytes)"
