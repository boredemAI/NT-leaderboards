// Cloudflare Pages Function: POST /api/request-team
//
// Accepts { tag } from the site's "Request a team" modal, validates the tag
// against Nitro Type's public team API, then commits the new tag to
// data/teams.json via GitHub's REST API so the next scheduled snapshot run
// includes it. Pure serverless — no DB, no queue. Optimistic concurrency is
// handled via the blob's SHA (retries on 409 conflict).
//
// Required environment bindings (set in Cloudflare Pages project settings):
//   GITHUB_TOKEN        Fine-scoped PAT with "contents: write" on this repo.
//   GITHUB_REPO         owner/repo (e.g. "boredemAI/NT-leaderboards").
//   GITHUB_BRANCH       (optional) default: "main".
// Optional:
//   TURNSTILE_SECRET    Cloudflare Turnstile secret; if set, request body
//                       must include a valid `turnstileToken`.

const NT_API = 'https://www.nitrotype.com/api/v2/teams/';
const TEAMS_PATH = 'data/teams.json';
const MAX_COMMIT_RETRIES = 3;

// Encode each path segment but preserve the '/' separators GitHub's
// Contents API expects (encodeURIComponent alone would turn 'data/teams.json'
// into 'data%2Fteams.json' and yield a 404).
function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function sanitizeTag(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

async function verifyTurnstile(secret, token, ip) {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body: form }
  );
  if (!res.ok) return false;
  const body = await res.json().catch(() => ({}));
  return !!body.success;
}

async function fetchNtTeam(tag, signal) {
  const url = NT_API + encodeURIComponent(tag);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'nt-leaderboards-request-team/1.0 (+https://github.com/boredemAI/NT-leaderboards)',
    },
    signal,
  });
  return res;
}

async function ghFetch(env, path, init = {}) {
  const repo = env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/${path}`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nt-leaderboards-request-team/1.0',
    ...(init.headers || {}),
  };
  return fetch(url, { ...init, headers });
}

async function readTeamsFile(env, branch) {
  const res = await ghFetch(
    env,
    `contents/${encodePath(TEAMS_PATH)}?ref=${encodeURIComponent(branch)}`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub GET contents failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  // body.content is base64-encoded
  const b64 = (body.content || '').replace(/\n/g, '');
  const decoded = atob(b64);
  let parsed;
  try { parsed = JSON.parse(decoded); }
  catch (e) { throw new Error(`teams.json is not valid JSON: ${e.message}`); }
  return { parsed, sha: body.sha };
}

function b64encode(str) {
  // UTF-8 safe base64 for Workers runtime
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function commitTeamsFile(env, branch, updatedJsonText, baseSha, tag) {
  const payload = {
    message: `feat(data): request adds team ${tag}`,
    content: b64encode(updatedJsonText),
    sha: baseSha,
    branch,
  };
  const res = await ghFetch(env, `contents/${encodePath(TEAMS_PATH)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return res;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env || !env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json(
      { error: 'Server is not configured to accept team requests yet.' },
      503
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'Request body must be JSON.' }, 400);
  }

  const tag = sanitizeTag(body && body.tag);
  if (!tag || tag.length < 2) {
    return json(
      { error: 'Please provide a valid team tag (2\u201310 letters/numbers).' },
      400
    );
  }

  // Optional Turnstile verification.
  if (env.TURNSTILE_SECRET) {
    const token = body && body.turnstileToken;
    if (!token) return json({ error: 'Captcha required.' }, 400);
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, token, ip);
    if (!ok) return json({ error: 'Captcha verification failed.' }, 403);
  }

  // Validate the team actually exists on Nitro Type.
  let ntBody;
  try {
    const res = await fetchNtTeam(tag);
    if (res.status === 404) {
      return json({ error: `Nitro Type has no team with tag "${tag}".` }, 404);
    }
    if (!res.ok) {
      return json(
        { error: `Couldn\u2019t reach Nitro Type to verify tag (HTTP ${res.status}). Try again in a minute.` },
        502
      );
    }
    ntBody = await res.json().catch(() => null);
  } catch (err) {
    return json(
      { error: `Network error contacting Nitro Type: ${err.message || err}` },
      502
    );
  }

  const status = ntBody && ntBody.status;
  const info = ntBody && ntBody.results && ntBody.results.info;
  if (status !== 'OK' || !info || !info.tag) {
    return json({ error: `Nitro Type didn\u2019t return a valid team for "${tag}".` }, 404);
  }
  const canonicalTag = sanitizeTag(info.tag);
  if (!canonicalTag) {
    return json({ error: `Nitro Type returned an invalid tag for "${tag}".` }, 502);
  }

  // Append to data/teams.json via GitHub API, with retry on conflict.
  const branch = env.GITHUB_BRANCH || 'main';
  for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt++) {
    let current;
    try {
      current = await readTeamsFile(env, branch);
    } catch (err) {
      return json({ error: `Couldn\u2019t read teams.json: ${err.message}` }, 502);
    }

    const parsed = current.parsed || {};
    const existing = Array.isArray(parsed.tags) ? parsed.tags.slice() : [];
    const existingUpper = existing.map((t) => String(t).toUpperCase());
    if (existingUpper.includes(canonicalTag)) {
      return json({
        tag: canonicalTag,
        name: info.name || null,
        alreadyTracked: true,
      });
    }

    existing.push(canonicalTag);
    existing.sort((a, b) => String(a).localeCompare(String(b)));
    const updated = {
      ...parsed,
      tags: existing,
    };
    const updatedText = JSON.stringify(updated, null, 2) + '\n';

    const commitRes = await commitTeamsFile(
      env,
      branch,
      updatedText,
      current.sha,
      canonicalTag
    );
    if (commitRes.ok) {
      return json({
        tag: canonicalTag,
        name: info.name || null,
        alreadyTracked: false,
      });
    }
    if (commitRes.status === 409 || commitRes.status === 422) {
      // Concurrent update; re-read and retry.
      continue;
    }
    const txt = await commitRes.text().catch(() => '');
    return json(
      { error: `GitHub commit failed: ${commitRes.status} ${txt.slice(0, 300)}` },
      502
    );
  }

  return json(
    { error: 'Conflict while committing teams.json after multiple retries. Try again.' },
    503
  );
}

export function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
}
