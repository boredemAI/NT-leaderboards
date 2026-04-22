#!/usr/bin/env node
// Build Nitro Type team leaderboards by calling the public NT team API for every
// tag in data/teams.json, then writing aggregated leaderboards to data/snapshots/.
//
// Data source (strictly): https://www.nitrotype.com/api/v2/teams/<TAG>
// Each response includes stats[{board:'daily',played}, {board:'alltime',played}]
// plus team meta. We sort by races (played) for both windows and re-rank.
//
// Runs on a schedule via .github/workflows/snapshot-leaderboards.yml and can also
// run locally: `node scripts/snapshot-leaderboards.mjs`.
//
// Outputs:
//   data/snapshots/latest.json      (always updated, used by the site)
//   data/snapshots/<YYYY-MM-DD>.json (written once per UTC day — yesterday's
//                                    closed-day archive; overwritten if re-run)
//
// No dependencies beyond Node 18+ built-in fetch.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const NT_TEAM_API = 'https://www.nitrotype.com/api/v2/teams/';
const TEAMS_FILE  = join(process.cwd(), 'data', 'teams.json');
const OUT_DIR     = join(process.cwd(), 'data', 'snapshots');
const USER_AGENT  = 'nt-leaderboards/1.0 (+https://github.com/boredemAI/NT-leaderboards)';
const CONCURRENCY = 1;            // serial — Cloudflare in front of NT aggressively rate-limits (1015)
const PER_REQ_DELAY_MS = 2000;    // pause between requests to stay under the bucket
const TIMEOUT_MS  = 15000;
const RETRIES     = 4;            // includes long backoff if we ever trip 1015

const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) =>
  d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());

async function loadTagList() {
  const raw = JSON.parse(await readFile(TEAMS_FILE, 'utf8'));
  const tags = Array.isArray(raw) ? raw : raw.tags;
  if (!Array.isArray(tags)) throw new Error('teams.json must be an array or {tags:[]}');
  return [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTeam(tag) {
  const url = NT_TEAM_API + encodeURIComponent(tag);
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (res.status === 404) return { tag, ok: false, status: 404 };
      if (res.status === 429 || res.status === 503) {
        // Cloudflare rate-limit — long backoff.
        const wait = 5000 * Math.pow(2, attempt);
        console.error(`[${tag}] HTTP ${res.status}; backing off ${wait}ms`);
        await sleep(wait);
        lastErr = new Error('HTTP ' + res.status);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (body?.status !== 'OK' || !body?.results) {
        throw new Error('Unexpected body status ' + body?.status);
      }
      return { tag, ok: true, body: body.results };
    } catch (err) {
      clearTimeout(to);
      lastErr = err;
      if (attempt < RETRIES) await sleep(500 * (attempt + 1));
    }
  }
  return { tag, ok: false, error: String(lastErr?.message || lastErr) };
}

async function pool(items, worker, size, perItemDelay = 0) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
      if (perItemDelay > 0) await sleep(perItemDelay);
    }
  });
  await Promise.all(runners);
  return results;
}

function computeTeamMetrics(body) {
  const info = body?.info || {};
  const stats = Array.isArray(body?.stats) ? body.stats : [];
  const daily  = stats.find((s) => s?.board === 'daily')   || {};
  const alltime = stats.find((s) => s?.board === 'alltime') || {};

  const num = (v) => (v == null ? 0 : Number(v)) || 0;

  const dailyPlayed = num(daily.played);
  const dailySecs   = num(daily.secs);
  const dailyTyped  = num(daily.typed);
  const dailyErrs   = num(daily.errs);
  const dailyWords  = dailyTyped / 5;
  const dailyMins   = dailySecs / 60;
  const dailyWpm    = dailyMins > 0 ? dailyWords / dailyMins : 0;
  const dailyAcc    = dailyTyped > 0 ? Math.max(0, 1 - dailyErrs / dailyTyped) * 100 : 0;

  const allPlayed = num(alltime.played);
  const allSecs   = num(alltime.secs);
  const allTyped  = num(alltime.typed);
  const allErrs   = num(alltime.errs);
  const allWords  = allTyped / 5;
  const allMins   = allSecs / 60;
  const allWpm    = allMins > 0 ? allWords / allMins : 0;
  const allAcc    = allTyped > 0 ? Math.max(0, 1 - allErrs / allTyped) * 100 : 0;

  return {
    meta: {
      tag:        String(info.tag || '').trim(),
      name:       String(info.name || '').replace(/[\f\r\n]+/g, ' ').trim(),
      tagColor:   info.tagColor ? String(info.tagColor) : null,
      members:    num(info.members),
      leagueTier: num(info.leagueTier),
    },
    daily: {
      races:    dailyPlayed,
      wpm:      Math.round(dailyWpm  * 10) / 10,
      accuracy: Math.round(dailyAcc  * 10) / 10,
      seconds:  dailySecs,
    },
    allTime: {
      races:    allPlayed,
      wpm:      Math.round(allWpm  * 10) / 10,
      accuracy: Math.round(allAcc  * 10) / 10,
      seconds:  allSecs,
    },
  };
}

function rank(teams, window) {
  return teams
    .map((t) => ({
      tag:        t.meta.tag,
      name:       t.meta.name,
      tagColor:   t.meta.tagColor,
      members:    t.meta.members,
      leagueTier: t.meta.leagueTier,
      races:      t[window].races,
      wpm:        t[window].wpm,
      accuracy:   t[window].accuracy,
    }))
    .filter((t) => t.tag && t.races > 0)
    .sort((a, b) => b.races - a.races)
    .map((t, i) => ({ rank: i + 1, ...t }));
}

async function main() {
  const now = new Date();
  const todayStr     = isoDate(now);
  const yesterdayStr = isoDate(new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1,
  )));

  const tags = await loadTagList();
  console.error('Fetching', tags.length, 'teams via NT public API at concurrency', CONCURRENCY);

  let ok = 0;
  const failures = [];
  const results = await pool(
    tags,
    async (tag) => {
      const r = await fetchTeam(tag);
      if (r.ok) { ok++; return computeTeamMetrics(r.body); }
      failures.push({ tag, reason: r.status ? `HTTP ${r.status}` : (r.error || 'unknown') });
      return null;
    },
    CONCURRENCY,
    PER_REQ_DELAY_MS,
  );

  const teams = results.filter(Boolean);
  const snapshot = {
    generatedAt: now.toISOString(),
    date:        todayStr,
    source:      'https://www.nitrotype.com/api/v2/teams/<TAG>',
    tagsFetched: tags.length,
    ok, fail: failures.length, failures,
    daily: {
      window: { label: 'Last 24 hours (NT rolling)' },
      teams:  rank(teams, 'daily'),
    },
    allTime: {
      window: { label: 'All-time per NT team stats' },
      teams:  rank(teams, 'allTime'),
    },
  };

  await mkdir(OUT_DIR, { recursive: true });
  const latestPath = join(OUT_DIR, 'latest.json');
  const archivePath = join(OUT_DIR, `${yesterdayStr}.json`);
  const json = JSON.stringify(snapshot, null, 2) + '\n';

  await writeFile(latestPath, json);
  // Daily archive of the closed UTC day — safe to overwrite (last write of the day wins).
  await writeFile(archivePath, json);

  console.error('Wrote', latestPath);
  console.error('Wrote', archivePath);
  console.error(
    `Teams — ok:${ok} fail:${fail} | daily leaderboard:${snapshot.daily.teams.length} | all-time:${snapshot.allTime.teams.length}`,
  );
}

main().catch((err) => {
  console.error('Snapshot failed:', err);
  process.exit(1);
});
