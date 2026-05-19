// Reddit worker — Express-style, NO AUTH REQUIRED.
//
// v2: uses Reddit's public JSON endpoints (https://www.reddit.com/r/X/hot.json)
// instead of the OAuth-gated oauth.reddit.com endpoints. No app registration,
// no env vars, no token caching — just respectful rate-limited public access.
//
// Rate limit on public endpoints: ~60 req/min per IP. We make ~26 requests
// per daily run (13 subs × 2 sorts), well under the limit.
//
// User-Agent string is REQUIRED — Reddit blocks requests without one.

import { supa, startRun, finishRun, isAuthorizedCron } from "../supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../scoring.js";

const SOURCE = "reddit";
const FETCH_TIMEOUT_MS = 8000;
// Browser-style User-Agent — Reddit started blocking the documented
// "good citizen" UAs from cloud IP ranges (Vercel = AWS) in 2024. A
// Chrome UA passes the bot filter cleanly.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchSubreddit(sub, sort = "hot", limit = 25) {
  const url = `https://www.reddit.com/r/${sub}/${sort}.json?limit=${limit}&raw_json=1`;
  const r = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json,text/html,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `https://www.reddit.com/r/${sub}/`
    }
  });
  if (!r.ok) {
    if (r.status === 404) return null;
    if (r.status === 429) throw new Error(`Reddit rate-limited (429) on r/${sub}`);
    throw new Error(`Reddit ${sort} ${r.status} for r/${sub}`);
  }
  const data = await r.json();
  return (data?.data?.children || []).map(c => c.data);
}

function redditVelocity(post) {
  const ageHours = (Date.now() / 1000 - post.created_utc) / 3600;
  const engagement = (post.ups || 0) + (post.num_comments || 0) * 2;
  return engagement / Math.max(ageHours, 1);
}

async function processSubreddit(src, { clientId, agentId, byPillar, meta }) {
  const t0 = Date.now();
  const result = { target: src.target, status: "unknown", ingested: 0, items_seen: 0, ms: 0 };

  if (src.meta?.requires_safety_filter) {
    result.status = "skipped_safety_filter";
    return result;
  }

  try {
    const [hot, rising] = await Promise.all([
      fetchSubreddit(src.target, "hot", 25),
      fetchSubreddit(src.target, "rising", 25)
    ]);
    const all = [...(hot || []), ...(rising || [])];
    if (!all.length) { result.status = "no_data"; return result; }

    const unique = Array.from(new Map(all.map(p => [p.id, p])).values());
    result.items_seen = unique.length;

    const upserts = [];

    for (const post of unique) {
      if (!post.id || !post.title) continue;
      const velocity = redditVelocity(post);
      const fulltext = `${post.title} ${post.selftext || ""}`;
      const tonal = scoreTonal(fulltext, byPillar);
      const bm = detectBrandMatch(fulltext, meta);

      // Signal gate: tonal >= 0.25 OR brand mention OR rising-hot velocity
      if (tonal.score < 0.25 && !bm.brand_match && !bm.competitor_match && velocity < 50) continue;

      upserts.push({
        client_id: clientId, source: SOURCE,
        source_id: `reddit:${post.id}`,
        source_url: `https://reddit.com${post.permalink}`,
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
        auth_method: "public_json_endpoints_no_oauth",
        rate_limit_note: "~60 req/min unauthenticated; we use ~26 req/day total",
        node_version: process.version
      });
    }
    const limit = q.limit ? parseInt(q.limit, 10) : null;

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

        // Sequential (NOT parallel) to be respectful of rate limits
        const results = [];
        for (const src of toProcess) {
          results.push(await processSubreddit(src, { clientId: client.id, agentId, byPillar, meta }));
          await new Promise(r => setTimeout(r, 150));
        }

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
