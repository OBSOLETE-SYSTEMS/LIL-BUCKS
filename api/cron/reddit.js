// Reddit worker — Express-style, requires Reddit script-app OAuth.
//
// Setup (5 min):
//   1. https://www.reddit.com/prefs/apps → "create another app"
//   2. App type: 'script', name: 'obsolete-signal-pipeline', redirect: http://localhost:8080
//   3. Capture client_id (under app name) + secret
//   4. Use a dedicated Reddit account for the script (not your personal)
//   5. Add to Vercel env (all 3 environments):
//        REDDIT_CLIENT_ID
//        REDDIT_CLIENT_SECRET
//        REDDIT_USERNAME
//        REDDIT_PASSWORD
//        REDDIT_USER_AGENT (e.g., "obsolete-signal-pipeline/0.1 by /u/YOUR_USERNAME")
//
// The worker fetches /hot and /rising for each watched subreddit, scores
// velocity (engagement-per-hour), tonal match, brand/competitor mentions,
// and upserts into pipeline.signals. Skips subs flagged with
// meta.requires_safety_filter until Gap 3 (moderation pass) is built.

import { supa, startRun, finishRun, isAuthorizedCron } from "../../lib/supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../../lib/scoring.js";

const SOURCE = "reddit";
const FETCH_TIMEOUT_MS = 8000;

let _token = null;
let _tokenExpiresAt = 0;

async function getRedditToken() {
  if (_token && Date.now() < _tokenExpiresAt - 60_000) return _token;
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;
  const ua = process.env.REDDIT_USER_AGENT;
  if (!id || !secret || !username || !password || !ua) {
    throw new Error("Missing Reddit env vars (REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET + REDDIT_USERNAME + REDDIT_PASSWORD + REDDIT_USER_AGENT). Register a script app at reddit.com/prefs/apps.");
  }
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const r = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": ua
    },
    body: `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Reddit token request failed (${r.status}): ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  _token = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return _token;
}

async function fetchSubreddit(token, sub, sort = "hot", limit = 25) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`https://oauth.reddit.com/r/${sub}/${sort}.json?limit=${limit}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": process.env.REDDIT_USER_AGENT
      },
      signal: ctrl.signal
    });
    if (!r.ok) {
      if (r.status === 404) return null;
      throw new Error(`Reddit ${sort} ${r.status} for r/${sub}`);
    }
    const data = await r.json();
    return (data?.data?.children || []).map(c => c.data);
  } finally {
    clearTimeout(timer);
  }
}

// Velocity = engagement per hour. Comments weighted 2x.
function redditVelocity(post) {
  const ageHours = (Date.now() / 1000 - post.created_utc) / 3600;
  const engagement = (post.ups || 0) + (post.num_comments || 0) * 2;
  return engagement / Math.max(ageHours, 1);
}

async function processSubreddit(src, { clientId, agentId, byPillar, meta, token }) {
  const t0 = Date.now();
  const result = { target: src.target, status: "unknown", ingested: 0, items_seen: 0, ms: 0 };

  // Skip subs that require the Gap 3 safety filter until we build it
  if (src.meta?.requires_safety_filter) {
    result.status = "skipped_safety_filter";
    return result;
  }

  try {
    const [hot, rising] = await Promise.all([
      fetchSubreddit(token, src.target, "hot", 25),
      fetchSubreddit(token, src.target, "rising", 25)
    ]);
    const all = [...(hot || []), ...(rising || [])];
    if (!all.length) { result.status = "no_data"; return result; }

    // Dedup by post id
    const unique = Array.from(new Map(all.map(p => [p.id, p])).values());
    result.items_seen = unique.length;

    const upserts = [];

    for (const post of unique) {
      if (!post.id || !post.title) continue;
      const velocity = redditVelocity(post);
      const fulltext = `${post.title} ${post.selftext || ""}`;
      const tonal = scoreTonal(fulltext, byPillar);
      const bm = detectBrandMatch(fulltext, meta);

      // Signal gate: tonal match >= 0.25 OR brand mention OR velocity >= 50 (rising hot)
      if (tonal.score < 0.25 && !bm.brand_match && !bm.competitor_match && velocity < 50) continue;

      const source_id = `reddit:${post.id}`;
      upserts.push({
        client_id: clientId, source: SOURCE,
        source_id, source_url: `https://reddit.com${post.permalink}`,
        target: src.target, lane: src.lane, agent_id: agentId,
        occurred_at: new Date(post.created_utc * 1000).toISOString(),
        raw: { post, watchlist_meta: src.meta || {} },
        title: post.title.slice(0, 500),
        body_excerpt: (post.selftext || "").slice(0, 500),
        metric_score: velocity,
        client_tonal: tonal.score,
        pillar_hint: tonal.pillar,
        brand_match: bm.brand_match,
        competitor_match: bm.competitor_match,
        status: "fresh"
      });
    }

    if (upserts.length > 0) {
      const { error } = await supa().from("signals").upsert(upserts, { onConflict: "client_id,source,source_id" });
      if (error) { result.status = "upsert_error"; result.error = error.message; return result; }
      result.ingested = upserts.length;
    }
    result.status = "ok";
    return result;
  } catch (err) {
    result.status = "fetch_error";
    result.error = String(err.message || err);
    return result;
  } finally {
    result.ms = Date.now() - t0;
  }
}

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    if (!isAuthorizedCron(req)) return res.status(401).json({ error: "unauthorized" });

    const q = req.query || {};
    if (q.debug === "env") {
      return res.status(200).json({
        status: "debug_env_reddit",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        REDDIT_CLIENT_ID_set: !!process.env.REDDIT_CLIENT_ID,
        REDDIT_CLIENT_SECRET_set: !!process.env.REDDIT_CLIENT_SECRET,
        REDDIT_USERNAME_set: !!process.env.REDDIT_USERNAME,
        REDDIT_PASSWORD_set: !!process.env.REDDIT_PASSWORD,
        REDDIT_USER_AGENT_set: !!process.env.REDDIT_USER_AGENT,
        reddit_ready: !!process.env.REDDIT_CLIENT_ID && !!process.env.REDDIT_CLIENT_SECRET && !!process.env.REDDIT_USERNAME && !!process.env.REDDIT_PASSWORD && !!process.env.REDDIT_USER_AGENT,
        node_version: process.version
      });
    }
    const limit = q.limit ? parseInt(q.limit, 10) : null;

    let token;
    try { token = await getRedditToken(); }
    catch (err) {
      return res.status(503).json({
        status: "reddit_credentials_missing_or_invalid",
        error: err.message,
        message: "Register a script app at reddit.com/prefs/apps and add the 5 REDDIT_* env vars in Vercel."
      });
    }

    const summary = { clients: 0, agent_runs: 0, sources_total: 0, sources_processed: 0, ingested: 0, per_source: [], errors: [] };
    const { data: clients, error: cErr } = await supa().from("clients").select("id, name").eq("active", true);
    if (cErr) return res.status(500).json({ error: "clients_fetch_failed", details: cErr.message });

    outer:
    for (const client of clients || []) {
      summary.clients++;
      const { data: sources, error: sErr } = await supa()
        .from("client_sources")
        .select("target, target_display, lane, agent_id, meta")
        .eq("client_id", client.id).eq("source", SOURCE).eq("active", true);
      if (sErr) { summary.errors.push({ client: client.id, error: sErr.message }); continue; }
      if (!sources?.length) continue;
      summary.sources_total += sources.length;

      const byPillar = await getClientKeywords(client.id);
      const meta = await getClientMeta(client.id);

      const byAgent = new Map();
      for (const s of sources) {
        if (!byAgent.has(s.agent_id)) byAgent.set(s.agent_id, []);
        byAgent.get(s.agent_id).push(s);
      }

      for (const [agentId, agentSources] of byAgent) {
        summary.agent_runs++;
        const runId = await startRun({ clientId: client.id, agentId, source: SOURCE });

        const remaining = limit ? Math.max(0, limit - summary.sources_processed) : agentSources.length;
        const toProcess = agentSources.slice(0, remaining);

        const results = await Promise.all(toProcess.map(src =>
          processSubreddit(src, { clientId: client.id, agentId, byPillar, meta, token })
        ));

        summary.sources_processed += results.length;
        summary.per_source.push(...results.map(r => ({ ...r, client: client.id, agent: agentId })));

        const ingested = results.reduce((s, r) => s + (r.ingested || 0), 0);
        const errs = results.filter(r => r.status?.endsWith("_error"))
          .map(r => ({ target: r.target, error: r.error || r.status }));
        summary.ingested += ingested;
        if (errs.length) summary.errors.push(...errs.map(e => ({ ...e, client: client.id, agent: agentId })));

        await finishRun(runId, {
          signalsIngested: ingested,
          signalsNew: ingested,
          signalsScored: results.reduce((s, r) => s + (r.items_seen || 0), 0),
          errors: errs,
          status: errs.length ? "partial" : "success"
        });

        if (limit && summary.sources_processed >= limit) break outer;
      }
    }

    summary.duration_ms = Date.now() - t0;
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(500).json({
      error: "handler_threw",
      message: err.message || String(err),
      stack: (err.stack || "").split("\n").slice(0, 6),
      duration_ms: Date.now() - t0
    });
  }
}
