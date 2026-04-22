#!/usr/bin/env node
// Snapshot Nitro Type team leaderboards to a dated JSON file in data/snapshots/.
//
// Runs in CI via .github/workflows/snapshot-leaderboards.yml on a daily cron.
// Pulls:
//   - yesterday's full UTC-day leaderboard (daily races)
//   - a wide-window leaderboard (effectively "all-time" as tracked)
//
// Writes:
//   data/snapshots/<YYYY-MM-DD>.json   (snapshot for the day just closed)
//   data/snapshots/latest.json         (pointer-style copy of the most recent snapshot)
//
// No dependencies beyond Node 18+'s built-in fetch.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const STARTRACK_API_BASE = 'https://ntstartrack.org/api/team-leaderboard';
const ALLTIME_START_ISO  = '2020-01-01 00:00:00';
const USER_AGENT         = 'ExoneratorsLeaderboardsBot/1.0 (+https://github.com/boredemAI/exonerator)';

const pad2 = (n) => String(n).padStart(2, '0');

function fmtStarTrack(d) {
  return (
    d.getUTCFullYear() + '-' +
    pad2(d.getUTCMonth() + 1) + '-' +
    pad2(d.getUTCDate()) + ' ' +
    pad2(d.getUTCHours()) + ':' +
    pad2(d.getUTCMinutes()) + ':' +
    pad2(d.getUTCSeconds())
  );
}

function isoDate(d) {
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

async function fetchWindow(startStr, endStr) {
  const url =
    STARTRACK_API_BASE +
    '?start_time=' + encodeURIComponent(startStr) +
    '&end_time='   + encodeURIComponent(endStr) +
    '&showbot=FALSE';

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`StarTrack ${res.status} for ${startStr}..${endStr}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('StarTrack: unexpected response shape');
  return raw;
}

function normalize(raw) {
  return raw
    .map((t) => ({
      tag:        String(t.TeamTag || '').trim(),
      name:       String(t.TeamName || '').replace(/[\f\r\n]+/g, ' ').trim(),
      races:      Number(t.Races) || 0,
      wpm:        Number(t.WPM) || 0,
      accuracy:   Number(t.Accuracy) || 0,
      points:     Number(t.Points) || 0,
      leagueTier: Number(t.leagueTier) || 0,
      tagColor:   t.tagColor ? String(t.tagColor) : null,
    }))
    .filter((t) => t.tag && t.races > 0)
    .sort((a, b) => b.races - a.races)
    .map((t, i) => ({ rank: i + 1, ...t }));
}

async function main() {
  const now = new Date();

  // Yesterday (UTC) — the day that just closed.
  const yesterday = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1,
  ));
  const dayStart = new Date(Date.UTC(
    yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 0, 0, 0,
  ));
  const dayEnd = new Date(Date.UTC(
    yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 23, 59, 59,
  ));

  const dayStartStr = fmtStarTrack(dayStart);
  const dayEndStr   = fmtStarTrack(dayEnd);

  const allTimeStart = new Date(ALLTIME_START_ISO + 'Z');
  const allTimeStartStr = fmtStarTrack(allTimeStart);
  const allTimeEndStr   = fmtStarTrack(new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59,
  )));

  console.error('Fetching daily window',   dayStartStr, '->', dayEndStr);
  console.error('Fetching alltime window', allTimeStartStr, '->', allTimeEndStr);

  const [dailyRaw, allTimeRaw] = await Promise.all([
    fetchWindow(dayStartStr, dayEndStr),
    fetchWindow(allTimeStartStr, allTimeEndStr),
  ]);

  const snapshot = {
    generatedAt: now.toISOString(),
    date:        isoDate(yesterday),
    daily: {
      window: { start: dayStartStr, end: dayEndStr, label: 'Yesterday (UTC)' },
      teams:  normalize(dailyRaw),
    },
    allTime: {
      window: { start: allTimeStartStr, end: allTimeEndStr, label: 'All-time (since tracker start)' },
      teams:  normalize(allTimeRaw),
    },
  };

  const outDir = join(process.cwd(), 'data', 'snapshots');
  await mkdir(outDir, { recursive: true });

  const datedPath = join(outDir, `${snapshot.date}.json`);
  const latestPath = join(outDir, 'latest.json');
  const json = JSON.stringify(snapshot, null, 2) + '\n';

  await writeFile(datedPath, json);
  await writeFile(latestPath, json);

  console.error('Wrote', datedPath);
  console.error('Wrote', latestPath);
  console.error(
    'Daily teams:', snapshot.daily.teams.length,
    '| All-time teams:', snapshot.allTime.teams.length,
  );
}

main().catch((err) => {
  console.error('Snapshot failed:', err);
  process.exit(1);
});
