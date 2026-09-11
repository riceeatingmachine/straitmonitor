#!/usr/bin/env python3
"""Render the social-preview cards from the current data/snapshot.json.

Outputs (all written next to this script):
  og-image.png             1200 x 630   Open Graph / X / LinkedIn / Slack preview
  social/card-square.png   1080 x 1080  Instagram, Threads, Mastodon
  social/card-story.png    1080 x 1920  Instagram / WhatsApp stories

Usage:  python make-social-cards.py
Needs a local Chrome or Edge (used headless for rendering) and internet access for the web fonts.
"""
import json, os, subprocess, sys, tempfile, statistics, shutil
from datetime import date, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
CRISIS_START = date(2026, 2, 28)

BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
]


def d(s):
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def fmt_int(n):
    return f"{int(round(n)):,}"


def fmt_dwt(n):
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.0f}k"


# ---------- numbers ----------

def compute(snap):
    cols = snap["columns"]
    ix = {c: i for i, c in enumerate(cols)}
    rows = snap["rows"]
    r2025 = [r for r in rows if r[0] <= "2025-12-31"]
    base_total = statistics.mean(r[ix["n_total"]] for r in r2025)
    base_tanker = statistics.mean(r[ix["n_tanker"]] for r in r2025)
    base_cap = statistics.mean(r[ix["capacity"]] for r in r2025)

    last7 = rows[-7:]
    week_total = statistics.mean(r[ix["n_total"]] for r in last7)
    week_tanker = statistics.mean(r[ix["n_tanker"]] for r in last7)
    week_cap = statistics.mean(r[ix["capacity"]] for r in last7)
    latest = rows[-1]
    latest_date = d(latest[0])

    since = [r for r in rows if d(r[0]) >= CRISIS_START]
    missing = sum(max(0.0, base_total - r[ix["n_total"]]) for r in since)
    zero_days = sum(1 for r in since if r[ix["n_total"]] == 0)
    fetched = d(snap["fetchedAt"])
    days = (fetched - CRISIS_START).days  # matches the day counter on the site

    brent = snap["brent"]["series"]
    brent_now = brent[-1][1]
    pre = [p for p in brent if d(p[0]) < CRISIS_START]
    brent_pre = pre[-1][1] if pre else brent[0][1]

    # Exports by country: last 7 days vs 2025 average
    cix = {c: i for i, c in enumerate(snap["countryColumns"])}
    cb = {b["iso3"]: b for b in snap["countryBaselines"]}
    exports = {}
    for iso, b in cb.items():
        recent = [r[cix["export"]] for r in snap["countryRows"] if r[cix["iso3"]] == iso][-7:]
        if recent and b["avg_export"]:
            exports[iso] = (b["country"], statistics.mean(recent) / b["avg_export"])
    worst = sorted(exports.values(), key=lambda t: t[1])[:3]

    # Polymarket: same headline market as the site (the furthest-out "returns to normal by ..." event)
    import re
    normal = None
    for ev in snap.get("polymarket", {}).get("events", []):
        if re.search(r"traffic returns? to normal by", ev["title"], re.I) and len(ev["markets"]) == 1:
            m = ev["markets"][0]
            end = m.get("endDate") or ev.get("endDate")
            if end and (normal is None or d(end) > normal[1]):
                normal = (m["yes"], d(end))

    # Chart series: daily totals plus a 7-day mean
    series = [(d(r[0]), r[ix["n_total"]]) for r in rows]
    smooth = []
    for i in range(len(series)):
        win = series[max(0, i - 6): i + 1]
        smooth.append((series[i][0], statistics.mean(v for _, v in win)))

    return dict(
        base_total=base_total, base_tanker=base_tanker, base_cap=base_cap,
        week_total=week_total, week_tanker=week_tanker, week_cap=week_cap,
        pct=week_total / base_total * 100, latest=latest[ix["n_total"]], latest_date=latest_date,
        missing=missing, zero_days=zero_days, days=days,
        brent_now=brent_now, brent_pre=brent_pre, brent_chg=(brent_now / brent_pre - 1) * 100,
        worst=worst, normal=normal, series=series, smooth=smooth,
        fetched=fetched,
    )


# ---------- chart ----------

def chart_svg(s, w, h, big=False):
    series, smooth = s["series"], s["smooth"]
    x0, y0 = 0, 0
    top = max(max(v for _, v in series), s["base_total"]) * 1.08
    n = len(series)
    px = lambda i: x0 + i / (n - 1) * w
    py = lambda v: y0 + h - v / top * h
    i_cr = next(i for i, (dt, _) in enumerate(series) if dt >= CRISIS_START)
    daily = " ".join(f"{px(i):.1f},{py(v):.1f}" for i, (_, v) in enumerate(series))
    area = f"M{px(0):.1f},{py(0):.1f} " + " ".join(f"L{px(i):.1f},{py(v):.1f}" for i, (_, v) in enumerate(smooth)) + f" L{px(n - 1):.1f},{py(0):.1f} Z"
    line = "M" + " L".join(f"{px(i):.1f},{py(v):.1f}" for i, (_, v) in enumerate(smooth))
    fs = 26 if big else 20
    fsm = 22 if big else 17
    xb = px(i_cr)
    return f"""
<svg viewBox="0 0 {w} {h}" width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
  <defs>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5fb0de" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#5fb0de" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="red" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e8735a" stop-opacity="0.0"/>
      <stop offset="1" stop-color="#e8735a" stop-opacity="0.22"/>
    </linearGradient>
  </defs>
  <rect x="{xb:.1f}" y="0" width="{w - xb:.1f}" height="{h}" fill="url(#red)"/>
  <line x1="0" x2="{w}" y1="{py(s['base_total']):.1f}" y2="{py(s['base_total']):.1f}" stroke="#e1eaf0" stroke-opacity="0.55" stroke-dasharray="6 6" stroke-width="2"/>
  <polyline points="{daily}" fill="none" stroke="#5fb0de" stroke-opacity="0.35" stroke-width="1.2"/>
  <path d="{area}" fill="url(#sea)"/>
  <path d="{line}" fill="none" stroke="#9fd3f2" stroke-width="3" stroke-linejoin="round"/>
  <line x1="{xb:.1f}" x2="{xb:.1f}" y1="0" y2="{h}" stroke="#e8735a" stroke-width="2.5"/>
  <text x="{w}" y="{py(s['base_total']) + fsm + 8:.1f}" text-anchor="end" fill="#e1eaf0" fill-opacity="0.9" font-family="'IBM Plex Mono', Consolas, monospace" font-size="{fsm}" letter-spacing="0.5" paint-order="stroke" stroke="#0c1820" stroke-opacity="0.85" stroke-width="7" stroke-linejoin="round">2025 AVERAGE · {s['base_total']:.0f} SHIPS A DAY</text>
  <text x="{w}" y="{fs + 6}" text-anchor="end" fill="#ffb4a2" font-family="'Barlow Condensed', Bahnschrift, 'Arial Narrow', sans-serif" font-weight="700" font-size="{fs}" letter-spacing="1">CLOSURE · 28 FEB 2026</text>
  <text x="{w}" y="{fs * 2 + 10}" text-anchor="end" fill="#ffb4a2" fill-opacity="0.9" font-family="'IBM Plex Mono', Consolas, monospace" font-size="{fsm}">day {s['days']}</text>
  <circle cx="{px(n - 1):.1f}" cy="{py(smooth[-1][1]):.1f}" r="{7 if big else 5}" fill="#0c1820" stroke="#9fd3f2" stroke-width="3"/>
  <text x="{px(0):.1f}" y="{h + fsm + 10}" fill="#8497a4" font-family="'IBM Plex Mono', Consolas, monospace" font-size="{fsm}">JAN 2025</text>
  <text x="{w}" y="{h + fsm + 10}" text-anchor="end" fill="#8497a4" font-family="'IBM Plex Mono', Consolas, monospace" font-size="{fsm}">{s['latest_date'].strftime('%b %Y').upper()}</text>
</svg>"""


# ---------- cards ----------

CSS = """
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #0c1820; }
body { font-family: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; color: #e1eaf0; -webkit-font-smoothing: antialiased; }
.card { position: relative; overflow: hidden; background:
  radial-gradient(1200px 700px at 85% -10%, rgba(95,176,222,0.22), transparent 60%),
  radial-gradient(900px 600px at -10% 110%, rgba(232,115,90,0.16), transparent 60%),
  #0c1820; }
.grid { position: absolute; inset: 0; background-image:
  linear-gradient(rgba(225,234,240,0.045) 1px, transparent 1px),
  linear-gradient(90deg, rgba(225,234,240,0.045) 1px, transparent 1px);
  background-size: 60px 60px; mask-image: linear-gradient(180deg, rgba(0,0,0,.9), rgba(0,0,0,.25)); }
.eyebrow { font-family: 'IBM Plex Mono', Consolas, monospace; font-size: 20px; letter-spacing: 3px; color: #8497a4; text-transform: uppercase; }
.eyebrow b { color: #ffb4a2; font-weight: 600; }
.display { font-family: 'Barlow Condensed', Bahnschrift, 'Arial Narrow', sans-serif; font-weight: 800; line-height: 0.86; letter-spacing: -1px; color: #fff; }
.display small { font-size: 0.34em; font-weight: 700; color: #9fd3f2; letter-spacing: 0; margin-left: 6px; vertical-align: baseline; }
.headline { font-family: 'Barlow Condensed', Bahnschrift, 'Arial Narrow', sans-serif; font-weight: 700; line-height: 1.0; color: #e1eaf0; text-wrap: balance; }
.headline em { font-style: normal; color: #ffb4a2; }
.badge { display: inline-flex; align-items: center; gap: 10px; font-family: 'IBM Plex Mono', Consolas, monospace; font-weight: 600; font-size: 20px; letter-spacing: 2px; color: #ffb4a2; border: 2px solid rgba(232,115,90,0.7); background: rgba(232,115,90,0.12); padding: 8px 16px; border-radius: 4px; text-transform: uppercase; }
.badge i { width: 12px; height: 12px; border-radius: 50%; background: #e8735a; box-shadow: 0 0 0 5px rgba(232,115,90,0.28); }
.stats { display: grid; gap: 14px; }
.stat { background: rgba(18,36,47,0.85); border: 1px solid rgba(225,234,240,0.12); border-radius: 8px; padding: 14px 18px 12px; }
.stat .k { font-family: 'IBM Plex Mono', Consolas, monospace; font-size: 15px; letter-spacing: 2px; color: #8497a4; text-transform: uppercase; }
.stat .v { font-family: 'Barlow Condensed', Bahnschrift, 'Arial Narrow', sans-serif; font-weight: 700; font-size: 58px; line-height: 1; color: #fff; margin-top: 6px; letter-spacing: -0.5px; }
.stat .v.red { color: #ffb4a2; }
.stat .v.sea { color: #9fd3f2; }
.stat .s { font-size: 16px; color: #b9c7d1; margin-top: 4px; }
.chart { padding-bottom: 34px; }
.foot { display: flex; justify-content: space-between; align-items: center; font-family: 'IBM Plex Mono', Consolas, monospace; font-size: 18px; color: #8497a4; letter-spacing: 1px; }
.foot b { color: #e1eaf0; font-weight: 600; }
"""


def stat(k, v, s, cls=""):
    return f'<div class="stat"><div class="k">{k}</div><div class="v {cls}">{v}</div><div class="s">{s}</div></div>'


def common(s):
    worst = s["worst"][0]
    parts = dict(
        pct=f"{s['pct']:.1f}", days=s["days"],
        ships=f"{s['week_total']:.0f}" if s["week_total"] >= 10 else f"{s['week_total']:.1f}",
        base=f"{s['base_total']:.0f}",
        missing=fmt_int(s["missing"]),
        tanker=f"{(1 - s['week_tanker'] / s['base_tanker']) * 100:.0f}",
        cap=fmt_dwt(s["week_cap"]), basecap=fmt_dwt(s["base_cap"]),
        brent=f"{s['brent_now']:.0f}", brentchg=f"{s['brent_chg']:+.0f}",
        worst_name=worst[0], worst_pct=f"{worst[1] * 100:.1f}",
        normal=f"{s['normal'][0] * 100:.0f}" if s["normal"] else None,
        normal_by=s["normal"][1].strftime("%d %b").lstrip("0") if s["normal"] else None,
        stamp=s["latest_date"].strftime("%d %b %Y").lstrip("0"),
    )
    return parts


def card_og(s):
    p = common(s)
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{CSS}
.card {{ width: 1200px; height: 630px; padding: 40px 52px 34px; display: grid; grid-template-columns: 560px 1fr; grid-template-rows: auto 1fr auto auto; column-gap: 40px; }}
.top {{ grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }}
.badge {{ font-size: 16px; padding: 6px 12px; }}
.left {{ grid-row: 2; display: flex; flex-direction: column; justify-content: flex-end; }}
.display {{ font-size: 224px; margin: 0 0 6px -6px; }}
.headline {{ font-size: 44px; margin-top: 4px; }}
.chart {{ grid-column: 2; grid-row: 2; align-self: end; padding-bottom: 30px; }}
.stats {{ grid-template-columns: repeat(3, 1fr); grid-column: 1 / -1; margin-top: 10px; }}
.stat .v {{ font-size: 48px; }}
.foot {{ grid-column: 1 / -1; margin-top: 14px; }}
</style></head><body><div class="card"><div class="grid"></div>
<div class="top"><div class="eyebrow">Strait of Hormuz · <b>day {p['days']} of the closure</b></div><div class="badge"><i></i>Severely restricted</div></div>
<div class="left">
  <div class="display">{p['pct']}<small>%</small></div>
  <div class="headline">of normal traffic. <em>{p['ships']} ships a day</em> where {p['base']} used to pass.</div>
</div>
<div class="chart">{chart_svg(s, 520, 260)}</div>
<div class="stats">
  {stat('Transits that never came', p['missing'], f'since 28 Feb, vs the 2025 pace', 'red')}
  {stat('Tanker traffic', f"−{p['tanker']}%", f"{p['cap']} dwt a day, was {p['basecap']}", 'red')}
  {stat('Brent crude', f"${p['brent']}", f"{p['brentchg']}% since the closure", 'sea')}
</div>
<div class="foot"><span><b>straitmonitor.com</b> · live tracker, updated twice daily</span><span>IMF PortWatch · {p['stamp']}</span></div>
</div></body></html>"""


def card_square(s):
    p = common(s)
    normal = stat('Traders say back to normal by ' + p['normal_by'], f"{p['normal']}%", 'Polymarket implied probability', 'sea') if p['normal'] else stat('Brent crude', f"${p['brent']}", f"{p['brentchg']}% since the closure", 'sea')
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{CSS}
.card {{ width: 1080px; height: 1080px; padding: 50px 60px 40px; display: flex; flex-direction: column; }}
.top {{ display: flex; justify-content: space-between; align-items: center; }}
.display {{ font-size: 236px; margin: 14px 0 4px -8px; }}
.headline {{ font-size: 48px; max-width: 900px; }}
.chart {{ margin: 24px 0 8px; }}
.stats {{ grid-template-columns: repeat(2, 1fr); gap: 12px; }}
.stat {{ padding: 12px 18px 10px; }}
.stat .v {{ font-size: 50px; }}
.foot {{ margin-top: auto; padding-top: 16px; font-size: 19px; }}
</style></head><body><div class="card"><div class="grid"></div>
<div class="top"><div class="eyebrow">Strait of Hormuz · <b>day {p['days']} of the closure</b></div><div class="badge"><i></i>Severely restricted</div></div>
<div class="display">{p['pct']}<small>%</small></div>
<div class="headline">of normal traffic. <em>{p['ships']} ships a day</em> where {p['base']} used to pass.</div>
<div class="chart">{chart_svg(s, 960, 250, big=True)}</div>
<div class="stats">
  {stat('Transits that never came', p['missing'], 'since 28 Feb, vs the 2025 pace', 'red')}
  {stat('Tanker traffic', f"−{p['tanker']}%", f"{p['cap']} dwt a day, was {p['basecap']}", 'red')}
  {stat(f"{p['worst_name']} seaborne exports", f"{p['worst_pct']}%", 'of its 2025 average, last 7 days', 'red')}
  {normal}
</div>
<div class="foot"><span><b>straitmonitor.com</b></span><span>IMF PortWatch · {p['stamp']}</span></div>
</div></body></html>"""


def card_story(s):
    p = common(s)
    normal = stat('Back to normal by ' + p['normal_by'] + '?', f"{p['normal']}%", 'Polymarket implied probability', 'sea') if p['normal'] else ''
    second = s["worst"][1]
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{CSS}
.card {{ width: 1080px; height: 1920px; padding: 140px 64px 120px; display: flex; flex-direction: column; }}
.eyebrow {{ font-size: 24px; }}
.badge {{ align-self: flex-start; margin-top: 22px; font-size: 22px; }}
.display {{ font-size: 350px; margin: 34px 0 8px -10px; }}
.headline {{ font-size: 68px; max-width: 940px; }}
.chart {{ margin: 44px 0 20px; }}
.stats {{ grid-template-columns: repeat(2, 1fr); gap: 16px; }}
.stat {{ padding: 18px 22px 16px; }}
.stat .k {{ font-size: 17px; }}
.stat .v {{ font-size: 62px; }}
.stat .s {{ font-size: 19px; }}
.foot {{ margin-top: auto; padding-top: 28px; font-size: 22px; }}
</style></head><body><div class="card"><div class="grid"></div>
<div class="eyebrow">Strait of Hormuz · <b>day {p['days']} of the closure</b></div>
<div class="badge"><i></i>Severely restricted</div>
<div class="display">{p['pct']}<small>%</small></div>
<div class="headline">of normal traffic. <em>{p['ships']} ships a day</em> where {p['base']} used to pass.</div>
<div class="chart">{chart_svg(s, 952, 290, big=True)}</div>
<div class="stats">
  {stat('Transits that never came', p['missing'], 'since 28 Feb, vs the 2025 pace', 'red')}
  {stat('Tanker traffic', f"−{p['tanker']}%", f"{p['cap']} dwt a day, was {p['basecap']}", 'red')}
  {stat(f"{p['worst_name']} seaborne exports", f"{p['worst_pct']}%", 'of its 2025 average, last 7 days', 'red')}
  {stat(f"{second[0]} seaborne exports", f"{second[1] * 100:.1f}%", 'of its 2025 average, last 7 days', 'red')}
  {stat('Brent crude', f"${p['brent']}", f"{p['brentchg']}% since the closure", 'sea')}
  {normal}
</div>
<div class="foot"><span><b>straitmonitor.com</b> · updated twice daily</span><span>IMF PortWatch · {p['stamp']}</span></div>
</div></body></html>"""


# ---------- render ----------

def find_browser():
    for b in BROWSERS:
        if os.path.exists(b):
            return b
    for name in ("chrome", "google-chrome", "chromium", "msedge"):
        if shutil.which(name):
            return shutil.which(name)
    sys.exit("No Chrome or Edge found; install one or add its path to BROWSERS.")


def render(browser, html, out, w, h, scale=1):
    tmpdir = tempfile.mkdtemp(prefix="hormuz-card-")
    src = os.path.join(tmpdir, "card.html")
    with open(src, "w", encoding="utf-8") as f:
        f.write(html)
    profile = os.path.join(tmpdir, "profile")
    cmd = [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
           f"--user-data-dir={profile}", f"--window-size={w},{h}", f"--force-device-scale-factor={scale}",
           "--virtual-time-budget=12000", f"--screenshot={out}", "file:///" + src.replace("\\", "/")]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    shutil.rmtree(tmpdir, ignore_errors=True)
    print(f"wrote {os.path.relpath(out, ROOT)}  ({w * scale}x{h * scale})")


def main():
    with open(os.path.join(ROOT, "data", "snapshot.json"), encoding="utf-8") as f:
        snap = json.load(f)
    s = compute(snap)
    p = common(s)
    print(f"{p['pct']}% of normal · {p['ships']} ships/day vs {p['base']} · day {p['days']} · {p['missing']} missing transits · Brent ${p['brent']} ({p['brentchg']}%)")
    browser = find_browser()
    os.makedirs(os.path.join(ROOT, "social"), exist_ok=True)
    render(browser, card_og(s), os.path.join(ROOT, "og-image.png"), 1200, 630)
    render(browser, card_square(s), os.path.join(ROOT, "social", "card-square.png"), 1080, 1080)
    render(browser, card_story(s), os.path.join(ROOT, "social", "card-story.png"), 1080, 1920)


if __name__ == "__main__":
    main()
