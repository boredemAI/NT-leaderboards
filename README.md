# Nitro Type Team Leaderboards

Live leaderboards of every tracked [Nitro Type](https://www.nitrotype.com) team, ranked two ways:

- **Daily Races** — races completed in the current UTC day
- **Most Ever** — cumulative races since the tracker started

Deployed as a static Cloudflare Pages site with one Pages Function; a daily GitHub Actions cron commits a historical JSON snapshot to the repo.

## Structure

```
nt-leaderboards/
├── index.html                       ← leaderboards page (static)
├── functions/
│   └── api/
│       └── leaderboards.js          ← Cloudflare Pages Function → /api/leaderboards
├── scripts/
│   └── snapshot-leaderboards.mjs    ← daily snapshot generator (Node 18+, no deps)
├── .github/workflows/
│   └── snapshot-leaderboards.yml    ← daily cron at 00:15 UTC
├── data/snapshots/                  ← committed historical snapshots
└── README.md
```

## How it works

- `index.html` fetches `/api/leaderboards` on load and renders two tabbed tables.
  Columns are sortable, teams are searchable, and any team tag entered in the
  **Highlight** box (or passed via `?tag=EXO`) gets the accent-colored row.
- `functions/api/leaderboards.js` is a Cloudflare Pages Function that pulls two
  windows from [ntstartrack.org](https://ntstartrack.org)'s public
  `team-leaderboard` endpoint (current UTC day + a wide 2020→now window), sorts
  them by `races`, and returns a unified JSON payload. The final response is
  edge-cached for 5 minutes and each upstream window is independently cached
  for 5 minutes via `caches.default`.
- `scripts/snapshot-leaderboards.mjs` is a standalone Node script that does the
  same thing, but for yesterday's closed UTC day, and writes
  `data/snapshots/<YYYY-MM-DD>.json` plus `data/snapshots/latest.json`.
- `.github/workflows/snapshot-leaderboards.yml` runs that script every day at
  00:15 UTC and commits the new file with `contents: write` permission.

## Deploy (Cloudflare Pages)

1. Sign in at https://dash.cloudflare.com → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git** and select this repo.
2. Project name: `nt-leaderboards` (determines the `*.pages.dev` subdomain).
3. Build settings: no build command, no output directory — Cloudflare Pages
   will serve the repo root as-is and auto-detect `functions/`.
4. Deploy. You'll get a URL like `https://nt-leaderboards.pages.dev`.

## Verify

- Homepage: `https://<project>.pages.dev/`
- API:      `https://<project>.pages.dev/api/leaderboards`

  Returns JSON shaped like:
  ```json
  {
    "generatedAt": 1776884583000,
    "highlight": null,
    "daily":   { "window": {...}, "teams": [ { "rank": 1, "tag": "ZH", "name": "Zero Hour", "races": 5440, ... } ] },
    "allTime": { "window": {...}, "teams": [ ... ] }
  }
  ```

## Snapshots

Each snapshot file under `data/snapshots/` is a full capture of both
leaderboards at the time the cron fired, so over time the repo accumulates a
per-day history you can diff, chart, or reimport. `latest.json` always points
at the most recent snapshot.

## Local dev

No build step. To preview the static page, just open `index.html` in a browser
(the fetch will fail because `/api/leaderboards` isn't there — pass the repo
through `wrangler pages dev .` if you need the function too:

```
npx wrangler@latest pages dev .
```

## Credit

Aggregate team data comes from the excellent community tracker
[ntstartrack.org](https://ntstartrack.org). Nitro Type itself is at
[nitrotype.com](https://www.nitrotype.com).
