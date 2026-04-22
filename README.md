# Nitro Type Team Leaderboards

Leaderboards for tracked [Nitro Type](https://www.nitrotype.com) teams, ranked two ways:

- **Daily Races** — team races over the rolling last 24 hours (per NT team stats)
- **Most Ever** — cumulative team race count (per NT team stats)

Pure static site. All data comes **strictly** from
`https://www.nitrotype.com/api/v2/teams/<TAG>` — one public endpoint, one team
at a time. A GitHub Actions cron hits that endpoint for every tag in
`data/teams.json` and commits an aggregated snapshot back to the repo. The site
loads that static JSON at page load. No Cloudflare Function, no third-party
backend, no scraping.

## Structure

```
nt-leaderboards/
├── index.html                       ← leaderboards page (static)
├── data/
│   ├── teams.json                   ← curated list of NT team tags (seed)
│   └── snapshots/
│       ├── latest.json              ← served by the site
│       └── <YYYY-MM-DD>.json        ← daily archive
├── scripts/
│   └── snapshot-leaderboards.mjs    ← Node 18+ snapshot generator (no deps)
├── .github/workflows/
│   └── snapshot-leaderboards.yml    ← cron @ 00:15 UTC daily
└── README.md
```

## How it works

- `index.html` loads, `fetch('/data/snapshots/latest.json')`, renders two
  tabbed tables. Columns are sortable, teams are searchable, and any team tag
  entered in the **Highlight** box (or passed via `?tag=EXO`) gets the
  accent-colored row. State persists via `localStorage['ntlb:highlight']`.
- `scripts/snapshot-leaderboards.mjs` loads `data/teams.json`, fetches each
  `https://www.nitrotype.com/api/v2/teams/<TAG>` (serial, 2s paced to stay
  under NT's Cloudflare rate-limit), normalizes each team's stats, sorts by
  races for each window, and writes:
  - `data/snapshots/latest.json` (always overwritten)
  - `data/snapshots/<yesterday-UTC>.json` (daily archive)
- `.github/workflows/snapshot-leaderboards.yml` runs the script daily at
  00:15 UTC and commits the updated files with `contents: write`.

## Data fields

Each team in a leaderboard is normalized to:

```json
{
  "rank":       1,
  "tag":        "EXO",
  "name":       "Exonerators",
  "tagColor":   "f15b40",
  "members":    10,
  "leagueTier": 1,
  "races":      6995,
  "wpm":        87.4,
  "accuracy":   94.8
}
```

`races`, `wpm`, and `accuracy` are derived from NT's per-team `stats` array
(`board: "daily"` or `board: "alltime"`):
- `races` = `stats[i].played`
- `wpm`   = `(typed / 5) / (secs / 60)`
- `accuracy` = `(1 - errs / typed) * 100`

## Team list (`data/teams.json`)

To add or remove a team from the leaderboards, edit `data/teams.json`:

```json
{
  "_comment": "…",
  "tags": ["EXO", "PR2W", "NTPD1", "..."]
}
```

Invalid or disbanded tags are skipped gracefully at snapshot time and logged
under `failures` in `latest.json`.

## Deploy (Cloudflare Pages)

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages**
   → **Connect to Git** and select this repo.
2. Project name: `nt-leaderboards` (determines the `*.pages.dev` subdomain).
3. Build command: *(empty)*. Build output directory: `/` (repo root).
4. Deploy. `https://<project>.pages.dev/` serves `index.html`; the JSON is
   served straight from `/data/snapshots/latest.json`.

Any static host works (GitHub Pages, Netlify, Vercel, plain S3) — there is no
server code.

## Local dev

No build step. Just open `index.html` with any static server, e.g.:

```
python3 -m http.server 8000
```

Then visit http://localhost:8000/. To refresh the snapshot yourself:

```
node scripts/snapshot-leaderboards.mjs
```

This takes a few minutes end-to-end because the script deliberately paces
requests to stay polite to NT's Cloudflare bucket.

## Credit

All team data comes from [nitrotype.com](https://www.nitrotype.com)'s own
`/api/v2/teams/<TAG>` endpoint. This project does not scrape any third-party
tracker.
