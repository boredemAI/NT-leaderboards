# Nitro Type Team Leaderboards

Leaderboards for tracked [Nitro Type](https://www.nitrotype.com) teams, ranked two ways:

- **Daily Races** — team races over the rolling last 24 hours (per NT team stats)
- **Most Ever** — cumulative team race count (per NT team stats)

Static site + one tiny Cloudflare Pages Function for user-submitted team
requests. All leaderboard data comes **strictly** from
`https://www.nitrotype.com/api/v2/teams/<TAG>` — one public endpoint, one team
at a time. A GitHub Actions cron hits that endpoint for every tag in
`data/teams.json` and commits an aggregated snapshot back to the repo. The site
loads that static JSON at page load. No third-party tracker, no scraping.

Users can submit new teams via the **Request a team** button. Submissions are
validated against Nitro Type's own API and appended to `data/teams.json`; the
next hourly snapshot picks them up automatically.

## Structure

```
nt-leaderboards/
├── index.html                       ← leaderboards page (static)
├── data/
│   ├── teams.json                   ← curated list of NT team tags (seed)
│   └── snapshots/
│       ├── latest.json              ← served by the site (rewritten hourly)
│       └── <YYYY-MM-DD>.json        ← closed-day archive (one per UTC day)
├── scripts/
│   └── snapshot-leaderboards.mjs    ← Node 18+ snapshot generator (no deps)
├── functions/api/
│   └── request-team.js              ← Cloudflare Pages Function:
│                                       validates + commits new tag
├── .github/workflows/
│   └── snapshot-leaderboards.yml    ← cron @ :00 every hour (UTC)
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
  - `data/snapshots/<yesterday-UTC>.json` (closed-day archive, written once
    per UTC day; subsequent same-day runs skip it to avoid git churn)
- `.github/workflows/snapshot-leaderboards.yml` runs the script every hour
  (at :00 UTC) and commits the updated files with `contents: write`.

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

## Request-a-team endpoint

`POST /api/request-team` (Cloudflare Pages Function at
`functions/api/request-team.js`). Body: `{ "tag": "NTPD1" }`.

Flow:
1. Sanitizes the tag (letters/numbers, max 10).
2. Fetches `https://www.nitrotype.com/api/v2/teams/<TAG>` to confirm the
   team actually exists (returns 404 if not).
3. Reads the current `data/teams.json` via the GitHub Contents API.
4. If the tag is new, appends it (alphabetically sorted) and commits the
   update with message `feat(data): request adds team <TAG>` (retries up to
   3 times on SHA conflict).
5. Responds `{ tag, name, alreadyTracked }`. The next scheduled snapshot run
   (`.github/workflows/snapshot-leaderboards.yml`, hourly at :00 UTC)
   includes the newly added tag automatically.

## Deploy (Cloudflare Pages)

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages**
   → **Connect to Git** and select this repo.
2. Project name: `nt-leaderboards` (determines the `*.pages.dev` subdomain).
3. Build command: *(empty)*. Build output directory: `/` (repo root).
4. Deploy. `https://<project>.pages.dev/` serves `index.html`; the JSON is
   served straight from `/data/snapshots/latest.json`.
5. **Environment variables** (Settings → Environment variables, *production*):
   | Name            | Required | Value                                                                 |
   | --------------- | -------- | --------------------------------------------------------------------- |
   | `GITHUB_TOKEN`  | yes      | [Fine-scoped PAT][pat] with `Contents: Read and write` on this repo.  |
   | `GITHUB_REPO`   | yes      | `boredemAI/NT-leaderboards`                                           |
   | `GITHUB_BRANCH` | no       | Defaults to `main`.                                                   |
   | `TURNSTILE_SECRET` | no    | If set, `/api/request-team` also requires a Turnstile token.          |

   [pat]: https://github.com/settings/personal-access-tokens/new

Without `GITHUB_TOKEN` + `GITHUB_REPO` set, `/api/request-team` returns 503
and the site's request button shows an error. Leaderboard viewing still works
(pure static JSON).

GitHub Pages / Netlify / Vercel / plain S3 also serve the leaderboard fine,
but the request button only works on a host that supports serverless
functions (Cloudflare Pages Functions or equivalent).

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
