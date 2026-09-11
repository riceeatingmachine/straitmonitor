# Renders og-image.png (1200x630) for social previews, using the current data/snapshot.json.
# Usage: powershell -ExecutionPolicy Bypass -File make-og-image.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$snap = Get-Content (Join-Path $root 'data\snapshot.json') -Raw | ConvertFrom-Json

$rows = @($snap.rows | Where-Object { $_[0] -ge '2026-02-01' })
$y2025 = @($snap.rows | Where-Object { $_[0] -le '2025-12-31' } | ForEach-Object { [double]$_[1] })
$baseline = ($y2025 | Measure-Object -Average).Average
$last7 = @($rows | Select-Object -Last 7 | ForEach-Object { [double]$_[1] })
$week = ($last7 | Measure-Object -Average).Average
$pct = [math]::Round($week / $baseline * 100)
$latestDate = [DateTime]::ParseExact($rows[-1][0], 'yyyy-MM-dd', $null).ToString('d MMM yyyy')

$W = 1200; $H = 630
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'

$bg = [System.Drawing.ColorTranslator]::FromHtml('#0c1820')
$panel = [System.Drawing.ColorTranslator]::FromHtml('#12242f')
$ink = [System.Drawing.ColorTranslator]::FromHtml('#e1eaf0')
$muted = [System.Drawing.ColorTranslator]::FromHtml('#8497a4')
$sea = [System.Drawing.ColorTranslator]::FromHtml('#5fb0de')
$red = [System.Drawing.ColorTranslator]::FromHtml('#e8735a')
$g.Clear($bg)

# Chart area on the right
$cx = 700; $cy = 110; $cw = 440; $ch = 400
$g.FillRectangle((New-Object System.Drawing.SolidBrush $panel), $cx, $cy, $cw, $ch)
$maxVal = [math]::Max($baseline, (($rows | ForEach-Object { [double]$_[1] }) | Measure-Object -Maximum).Maximum) * 1.1
$n = $rows.Count
$step = $cw / $n
$barBrush = New-Object System.Drawing.SolidBrush $sea
for ($i = 0; $i -lt $n; $i++) {
  $v = [double]$rows[$i][1]
  $h = [int]($v / $maxVal * ($ch - 20))
  if ($h -gt 0) { $g.FillRectangle($barBrush, [float]($cx + $i * $step), [float]($cy + $ch - $h), [float][math]::Max(1, $step - 1), [float]$h) }
}
$by = $cy + $ch - ($baseline / $maxVal * ($ch - 20))
$pen = New-Object System.Drawing.Pen $muted, 2
$pen.DashStyle = 'Dash'
$g.DrawLine($pen, [float]$cx, [float]$by, [float]($cx + $cw), [float]$by)
$fSmall = New-Object System.Drawing.Font('Consolas', [single]16)
$g.DrawString(("2025 baseline {0:N1} / day" -f $baseline), $fSmall, (New-Object System.Drawing.SolidBrush $muted), [float]($cx + $cw - 300), [float]($by - 26))
# closure marker
$ci = [array]::IndexOf(@($rows | ForEach-Object { $_[0] }), '2026-02-28')
if ($ci -ge 0) {
  $pen2 = New-Object System.Drawing.Pen $red, 2
  $pen2.DashStyle = 'Dot'
  $mx = $cx + $ci * $step
  $g.DrawLine($pen2, [float]$mx, [float]$cy, [float]$mx, [float]($cy + $ch))
  $g.DrawString('28 Feb closure', $fSmall, (New-Object System.Drawing.SolidBrush $red), [float]($mx + 6), [float]($cy + 6))
}

# Text on the left
$bold = [System.Drawing.FontStyle]::Bold
$fEyebrow = New-Object System.Drawing.Font('Consolas', [single]18)
$fTitle = New-Object System.Drawing.Font('Arial Narrow', [single]66, $bold)
$fBig = New-Object System.Drawing.Font('Arial Narrow', [single]120, $bold)
$fBody = New-Object System.Drawing.Font('Arial', [single]19)
$inkBrush = New-Object System.Drawing.SolidBrush $ink
$mutedBrush = New-Object System.Drawing.SolidBrush $muted
$dot = [string][char]0x00B7
$g.DrawString("STRAIT OF HORMUZ $dot DAILY TRANSIT CALLS", $fEyebrow, $mutedBrush, 60, 70)
$g.DrawString('Hormuz Transit', $fTitle, $inkBrush, 54, 105)
$g.DrawString('Watch', $fTitle, $inkBrush, 54, 180)
$g.DrawString(("{0}%" -f $pct), $fBig, (New-Object System.Drawing.SolidBrush $red), 44, 300)
$g.DrawString('of normal traffic', $fBody, $inkBrush, 62, 455)
$g.DrawString(("7-day average to {0} $dot IMF PortWatch" -f $latestDate), $fBody, $mutedBrush, 62, 490)
$g.DrawString("Traffic, Gulf exports, Brent crude and news $dot updated twice daily", $fBody, $mutedBrush, 62, 560)

$out = Join-Path $root 'og-image.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "Wrote og-image.png ($((Get-Item $out).Length) bytes)"
