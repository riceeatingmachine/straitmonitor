# Hormuz Transit Watch

A static site that tracks daily commercial vessel transits through the Strait of Hormuz, compares them with the
2025 baseline and with other chokepoints, and lists a crisis timeline, the latest news and a war tracker.

## How it stays current

The page itself never calls an outside API. It reads `data/snapshot.js`, which a scheduled job rebuilds twice a
day (03:17 and 15:17 UTC) from the live sources and commits back to the repository. Because the data is a plain
file, any number of visitors costs zero API calls and there are no rate limits to hit. An open tab checks for a
newer `data/snapshot.json` once an hour.

```
[GitHub Actions cron]  -->  scripts/build-data.mjs  -->  data/snapshot.js + snapshot.json  -->  commit  -->  GitHub Pages serves it
```

If you would rather have every browser fetch live data itself, set `DATA_MODE = 'live'` at the top of `app.js`.

## Deploy on GitHub Pages at straitmonitor.com (free)

1. Create a new **public** GitHub repository and upload the contents of this folder (keep the `.github`, `data` and
   `scripts` folders and the `CNAME` file). Drag-and-drop in the GitHub web interface works; so does GitHub Desktop.
2. In the repository go to **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`.
3. Still on the Pages page, enter `straitmonitor.com` under **Custom domain** and save. GitHub checks the DNS
   below; once it passes, tick **Enforce HTTPS** (the certificate is issued automatically, free).
4. At your domain registrar, add these DNS records:

   | Type | Name | Value |
   |---|---|---|
   | A | @ | 185.199.108.153 |
   | A | @ | 185.199.109.153 |
   | A | @ | 185.199.110.153 |
   | A | @ | 185.199.111.153 |
   | CNAME | www | `<your-github-user>.github.io` |

   Remove any parking A or CNAME records the registrar added. DNS changes can take up to an hour to propagate.
5. Go to the **Actions** tab, open **Update data**, and click **Run workflow** once to confirm it works.
   From then on it runs by itself twice a day.

The workflow already declares `permissions: contents: write`, which is what it needs to commit the refreshed data.
The `CNAME` file in the repository root keeps the custom domain attached across deployments; do not delete it.

Any other static host works too (Netlify, Cloudflare Pages, plain web hosting). Upload `index.html`, `styles.css`,
`app.js` and the `data` folder; then either point the host's own scheduled builds at `node scripts/build-data.mjs`,
or run `build-snapshot.ps1` yourself now and then and upload the two files it writes.

## Local preview

Double-click `index.html`, or serve the folder over HTTP:

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

then open http://localhost:8765/. To refresh the data by hand on Windows (no Node required):

```
powershell -ExecutionPolicy Bypass -File build-snapshot.ps1
```

## Editing the timeline

Events live in `data/events.js` as a plain list of `{ date, label, major }` entries. Edit that file, in the GitHub web
editor if you like; nothing else needs to change. Entries marked `major: true` are also numbered on the traffic chart.

## Social cards

`python make-social-cards.py` draws three cards from the current `data/snapshot.json`, using a local Chrome or Edge
headlessly (web fonts are fetched from Google Fonts, so it needs internet access):

- `og-image.png` (1200 x 630) – the link preview for X, LinkedIn, Slack, iMessage and WhatsApp
- `social/card-square.png` (1080 x 1080) – Instagram feed, Threads, Mastodon
- `social/card-story.png` (1080 x 1920) – Instagram and WhatsApp stories

Each card leads with the share of normal traffic, the ships-per-day comparison and a chart of the collapse, then the
transits that never happened since the closure, the tanker drop, the worst-hit exporters, Brent and the Polymarket
odds. The workflow re-runs the script after every data refresh and stamps the day's date onto the `?v=` of the
`og:image` and `twitter:image` tags in `index.html`, so the published cards always show the current day count and
figures and link previews fetch the fresh image. The `og:image`, `og:url` and canonical tags point at
`https://straitmonitor.com/`; change them if the site ever moves.

## Analytics

`index.html` loads Google Analytics (gtag.js, property `G-4L4W1HVJ27`) at the top of `<head>`. It is the only
third-party script on the page; remove that block to run without analytics.

## Data sources

- **Traffic:** IMF PortWatch, "Daily Chokepoints Data" (ArcGIS FeatureServer), `portid = chokepoint6` for Hormuz.
  Daily transit calls estimated from satellite AIS; published with a lag of roughly 3 to 5 days.
- **Baseline:** mean daily count over calendar year 2025 from the same dataset (about 85.5 transits a day,
  48 of them tankers). The chokepoint comparison uses each passage's own 2025 mean.
- **The full picture:** computed in the browser from the country and port trade rows: tanker exports of all eight Gulf states (7-day average) as a share of their 2025 pace, split into cargo loaded at the bypass outlets (Yanbu, Fujairah, Oman) and the remainder that must cross Hormuz, with the share scaled to the EIA's pre-war Hormuz flow (`PRE_WAR_MBPD`, 20 million b/d) for a barrels-a-day equivalent. `methodology.html` explains it and compares counts with flow estimates.
- **Country balance:** computed in the browser from the same country trade rows: tonnes shipped since 28 Feb 2026 against the country's 2025 daily average times the number of days, shown as a shortfall or surplus per country and combined for the states entirely inside the strait.
- **Country exports:** IMF PortWatch "Daily Trade Data" (country level, `Daily_Trade_Data_REG`), estimated
  import and export tonnes per day for Qatar, Kuwait, Iraq, Bahrain, Iran, Saudi Arabia, the UAE and Oman,
  compared with each country's 2025 daily mean. Model estimates, not customs data.
- **Ports:** IMF PortWatch "Daily Ports Data" for Yanbu, Fujairah, Sohar and Salalah (outside the strait) and
  Juaymah, Ras Laffan, Basrah Oil Terminal and Jebel Ali (inside): daily port calls and estimated tonnes vs 2025.
- **Brent:** ICE front-month futures daily close via Yahoo Finance; EIA daily spot via FRED as fallback.
- **Prediction markets:** Polymarket's public Gamma API. The builder searches for Hormuz events, adds the highest-volume
  open events tagged "iran" whose titles mention the strait, ceasefire, peace deal, blockade or oil, and always tries the
  pinned slugs in `PM_PINNED_SLUGS`. Home networks often block the API; the GitHub runner does not.
- **News:** Google News RSS for the phrase "Strait of Hormuz", parsed directly by the build script.
- **Oil stockpiles:** the JODI-Oil primary dataset (a 23 MB zip of monthly country data from jodidata.org), from which the builder keeps month-end closing stocks of crude oil and refinery intake since January 2025 for about thirty countries. The page shows each country's latest month as a share of its February 2026 level and as days of refinery runs.
- **War tracker:** a second Google News RSS search for the wider Iran war (strikes, missiles, ceasefire, IRGC, blockade, sanctions and so on), up to 40 headlines, merged with the Hormuz headlines and sorted into categories by keyword in the browser.
- **Timeline:** `data/events.js`, compiled by hand from public reporting.

## Files

- `index.html` – page structure, including the schematic map
- `styles.css` – theme (light and dark), layout, chart styling
- `app.js` – rendering, baseline maths, chart, timeline, cached/live data modes

When you change `styles.css` or `app.js`, bump the `?v=` number on their two references in `index.html` so browsers and
the Cloudflare cache fetch the new files instead of serving a copy cached for up to four hours. The workflow does the
same for `data/snapshot.js`, `data/events.js` and `og-image.png` on every refresh, stamping the run time onto them.
- `data/snapshot.js`, `data/snapshot.json` – the generated data (committed; rebuilt by the workflow)
- `data/events.js` – the hand-maintained timeline
- `og-image.png`, `social/`, `make-social-cards.py` – social cards and the script that draws them
- `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `site.webmanifest`, `make-favicons.py` – the site icon (the strait as a chokepoint) and the script that renders the raster sizes from the SVG
- `scripts/build-data.mjs` – data builder used by the workflow (Node 18+, no dependencies)
- `.github/workflows/update-data.yml` – the twice-daily schedule
- `build-snapshot.ps1` – Windows equivalent of the builder
- `serve.ps1` – optional local static server
