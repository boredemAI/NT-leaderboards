// Cloudflare Pages Function: /api/leaderboards
// ----------------------------------------------------------------------------
// Returns two leaderboards of Nitro Type teams:
//
//   - "daily":   teams ranked by races completed in the current UTC day
//   - "allTime": teams ranked by cumulative races since the StarTrack tracker
//                has been recording (effectively "most ever")
//
// Source: ntstartrack.org's public team-leaderboard endpoint, which aggregates
// per-team race/points/wpm over an arbitrary time window.
//
// Caching:
//   - Whole response: Cache-Control s-maxage=300 (5 min edge cache).
//   - Per-window upstream fetches: caches.default keyed by window key, fetched
//     fresh if the cached entry is older than WINDOW_TTL_S.
//
// Query params:
//   tag  - optional team tag to highlight; returned verbatim on the payload.
//          Does not filter results; the page uses it to highlight the row.
//
// Response shape:
//   {
//     generatedAt: <unix ms>,
//     highlight:   <tag or null>,
//     daily:   { window: { start, end, label }, teams: [Team, ...] },
//     allTime: { window: { start, end, label }, teams: [Team, ...] }
//   }
//
// where Team = {
//   rank, tag, name, races, wpm, accuracy, points, leagueTier, tagColor
// }
// ----------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const STARTRACK_API_BASE = 'https://ntstartrack.org/api/team-leaderboard';
const WINDOW_TTL_S       = 5 * 60;         // refresh per-window upstream at most every 5 min
const RESPONSE_MAX_AGE_S = 5 * 60;         // edge cache of final JSON

// Very early start covers everything StarTrack has ever recorded. The tracker
// came online well after this; using a fixed early epoch keeps the cache key
// stable across requests (a "now-based" window would thrash the cache).
const ALLTIME_START_ISO = '2020-01-01 00:00:00';

function pad2(n) { return String(n).padStart(2, '0'); }

function formatStarTrackTs(d) {
  return (
    d.getUTCFullYear() + '-' +
    pad2(d.getUTCMonth() + 1) + '-' +
    pad2(d.getUTCDate()) + ' ' +
    pad2(d.getUTCHours()) + ':' +
    pad2(d.getUTCMinutes()) + ':' +
    pad2(d.getUTCSeconds())
  );
}

function buildUrl(startStr, endStr) {
  const qs = [
    'start_time=' + encodeURIComponent(startStr),
    'end_time='   + encodeURIComponent(endStr),
    'showbot=FALSE',
  ].join('&');
  return `${STARTRACK_API_BASE}?${qs}`;
}

function utcDayBounds(nowMs) {
  const d = new Date(nowMs);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  const end   = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));
  return { start, end };
}

function normalize(raw, windowLabel) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t, i) => ({
      rank:       i + 1,
      tag:        String(t.TeamTag || '').trim(),
      name:       String(t.TeamName || '').replace(/[\f\r\n]+/g, ' ').trim(),
      races:      Number(t.Races) || 0,
      wpm:        Number(t.WPM) || 0,
      accuracy:   Number(t.Accuracy) || 0,
      points:     Number(t.Points) || 0,
      leagueTier: Number(t.leagueTier) || 0,
      tagColor:   t.tagColor ? String(t.tagColor) : null,
      window:     windowLabel,
    }))
    // StarTrack is sorted by Points. We want "races" leaderboards, so re-sort.
    .sort((a, b) => b.races - a.races)
    .map((t, i) => ({ ...t, rank: i + 1 }))
    .filter((t) => t.tag && t.races > 0);
}

async function fetchWindow(startDate, endDate, cacheKeyId, ctx) {
  const startStr = formatStarTrackTs(startDate);
  const endStr   = formatStarTrackTs(endDate);

  const cache    = caches.default;
  const cacheKey = new Request(
    `https://cache.exonerators.internal/leaderboards/${cacheKeyId}`,
    { method: 'GET' },
  );

  const hit = await cache.match(cacheKey);
  if (hit) {
    try { return await hit.json(); } catch { /* refetch */ }
  }

  const res = await fetch(buildUrl(startStr, endStr), {
    headers: {
      'User-Agent': 'ExoneratorsLeaderboards/1.0',
      'Accept':     'application/json',
    },
  });
  if (!res.ok) throw new Error(`StarTrack ${res.status} for ${cacheKeyId}`);

  const raw = await res.json();
  const payload = { raw, fetchedAt: Date.now(), startStr, endStr };

  const cacheResp = new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': `public, max-age=${WINDOW_TTL_S}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResp));

  return payload;
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);

  const rawTag = url.searchParams.get('tag');
  const highlight = rawTag
    ? String(rawTag).toUpperCase().replace(/[^A-Z0-9]/g, '')
    : null;

  const now = Date.now();
  const { start: dayStart, end: dayEnd } = utcDayBounds(now);
  const dayKey = `daily-${dayStart.toISOString().slice(0, 10)}`;

  const allTimeStart = new Date(ALLTIME_START_ISO + 'Z');
  const allTimeEnd   = dayEnd;
  const allTimeKey   = `alltime-${allTimeStart.toISOString().slice(0, 10)}-${dayEnd.toISOString().slice(0, 10)}`;

  try {
    const [daily, allTime] = await Promise.all([
      fetchWindow(dayStart, dayEnd, dayKey, context),
      fetchWindow(allTimeStart, allTimeEnd, allTimeKey, context),
    ]);

    const body = {
      generatedAt: now,
      highlight,
      daily: {
        window: {
          start: daily.startStr,
          end:   daily.endStr,
          label: 'Today (UTC)',
        },
        teams: normalize(daily.raw, 'daily'),
      },
      allTime: {
        window: {
          start: allTime.startStr,
          end:   allTime.endStr,
          label: 'All-time (since tracker start)',
        },
        teams: normalize(allTime.raw, 'allTime'),
      },
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type':  'application/json; charset=utf-8',
        'Cache-Control': `public, s-maxage=${RESPONSE_MAX_AGE_S}`,
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err && err.message || err) }),
      {
        status: 502,
        headers: {
          'Content-Type':  'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...CORS_HEADERS,
        },
      },
    );
  }
}
