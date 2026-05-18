// Wikipedia Pageviews worker — Stage 2 of the OBSOLETE Signal Pipeline.

import { supa, startRun, finishRun, isAuthorizedCron } from "../lib/supabase.js";
import {
  getClientKeywords, scoreTonal,
  getClientMeta, detectBrandMatch,
  wikiVelocity
} from "../lib/scoring.js";

const WIKI_USER_AGENT = "OBSOLETE-Signal-Pipeline/0.1 (https://obsolete.systems; alex@obsolete.systems)";
const SOURCE = "wikipedia";
const DEFAULT_FETCH_TIMEOUT_MS = 8000;

function fmtDate(d) { return d.toISOString().slice(0, 10).replace(/-/g, ""); }

async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPageviews(articleTitle, daysBack = 8) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (daysBack - 1));
  const encoded = encodeURIComponent(articleTitle.replace(/ /g, "_"));
  const url =
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/` +
    `en.wikipedia/all-access/all-agents/${encoded}/daily/${fmtDate(start)}/${fmtDate(end)}`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": WIKI_USER_AGENT, "Accept": "application/json" }
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Wikipedia pageviews ${res.status} for ${articleTitle}`);
  }
  return await res.json();
}

async function fetchSummary(articleTitle) {
  const encoded = encodeURIComponent(articleTitle.replace(/ /g, "_"));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": WIKI_USER_AGENT, "Accept": "application/json" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: data.title,
      extract: data.extract,
      url: data.content_urls?.desktop?.page,
      timestamp: data.timestamp
    };
  } catch (err) {
    // Summary is nice-to-have; never block ingestion if it fails
    return null;
  }
}

// Process one source — returns { processed, skipped, error }
async function processSource(src, { clientId, agentId, byPillar, meta }) {
  const tStart = Date.now();
  try {
    const pageviews = await fetchPageviews(src.target, 8);
    if (!pageviews?.items || pageviews.items.length < 2) {
      return { target: src.target, status: "no_data", ms: Date.now() - tStart };
    }

    const items = pageviews.items;
    const today = items[items.length - 1];
    const prior = items.slice(0, -1);
    const rollingAvg7 = prior.reduce((sum, x) => sum + x.views, 0) / Math.max(prior.length, 1);
    const velocity = wikiVelocity({ todayViews: today.views, rollingAvg7 });

    if (velocity < 1.3 && today.views < 10000) {
      return { target: src.target, status: "below_threshold", views: today.views, velocity, ms: Date.now() - tStart };
    }

    const sum = await fetchSummary(src.target);
    const title = sum?.title || src.target_display || src.target;
    const body = sum?.extract ||
      `Wikipedia pageviews on ${src.target}: ${today.views} views (vs. 7-day avg ${Math.round(rollingAvg7)})`;
    const url = sum?.url ||
      `https://en.wikipedia.org/wiki/${encodeURIComponent(src.target.replace(/ /g, "_"))}`;

    const tonal = scoreTonal(`${title} ${body}`, byPillar);
    const bm = detectBrandMatch(`${title} ${body}`, meta);

    const source_id = `wikipedia:${src.target}:${today.timestamp.slice(0, 8)}`;
    const { error: upErr } = await supa().from("signals").upsert({
      client_id: clientId,
      source: SOURCE,
      source_id,
      source_url: url,
      target: src.target,
      lane: src.lane,
      agent_id: agentId,
      occurred_at: new Date(
        `${today.timestamp.slice(0, 4)}-${today.timestamp.slice(4, 6)}-${today.timestamp.slice(6, 8)}T00:00:00Z`
      ).toISOString(),
      raw: { pageviews: items, summary: sum, watchlist_meta: src.meta || {} },
      title,
      body_excerpt: body.slice(0, 500),
      metric_score: velocity,
      client_tonal: tonal.score,
      pillar_hint: tonal.pillar,
      brand_match: bm.brand_match,
      competitor_match: bm.competitor_match,
      status: "fresh"
    }, { onConflict: "client_id,source,source_id" });

    if (upErr) return { target: src.target, status: "upsert_error", error: upErr.message, ms: Date.now() - tStart };
    return { target: src.target, status: "ingested", views: today.views, velocity: velocity.toFixed(2), tonal: tonal.score.toFixed(2), pillar: tonal.pillar, ms: Date.now() - tStart };
  } catch (err) {
    return { target: src.target, status: "fetch_error", error: String(err.message || err), ms: Date.now() - tStart };
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// ---------- Main handler ----------

export default async function handler(req) {
  const startTime = Date.now();

  try {
    if (!isAuthorizedCron(req)) return jsonResponse({ error: "unauthorized" }, 401);

    // Parse query params
    const url = new URL(req.url || "http://x/?", "http://x");
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? parseInt(limitRaw, 10) : null;
    const debug = url.searchParams.get("debug");

    // Short-circuit: ?debug=env returns env diagnostic, no Supabase calls
    if (debug === "env") {
      return jsonResponse({
        status: "debug_env",
        env: {
          SUPABASE_URL_set: !!process.env.SUPABASE_URL,
          SUPABASE_URL_prefix: process.env.SUPABASE_URL?.slice(0, 40) || null,
          SUPABASE_URL_endsWith_supabase_co: process.env.SUPABASE_URL?.endsWith(".supabase.co") || false,
          SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
          SUPABASE_SERVICE_ROLE_KEY_len: process.env.SUPABASE_SERVICE_ROLE_KEY?.length || 0,
          SUPABASE_SERVICE_ROLE_KEY_starts_with_eyJ: process.env.SUPABASE_SERVICE_ROLE_KEY?.startsWith("eyJ") || false,
          SUPABASE_ANON_KEY_set: !!process.env.SUPABASE_ANON_KEY,
          SUPABASE_ANON_KEY_len: process.env.SUPABASE_ANON_KEY?.length || 0,
          node_version: process.version,
          region: process.env.VERCEL_REGION || null,
          deployment_id: process.env.VERCEL_DEPLOYMENT_ID || null
        },
        duration_ms: Date.now() - startTime
      });
    }

    // Short-circuit: ?debug=ping does a single Supabase select with a 5s timeout
    if (debug === "ping") {
      const ctrl = new AbortController();
      const pingTimeout = setTimeout(() => ctrl.abort(), 5000);
      try {
        const { data, error, status } = await supa()
          .from("clients").select("id, name").eq("active", true)
          .abortSignal(ctrl.signal);
        return jsonResponse({
          status: "debug_ping",
          supabase_status: status,
          supabase_error: error?.message || null,
          rows: data?.length || 0,
          row_ids: (data || []).map(r => r.id),
          duration_ms: Date.now() - startTime
        });
      } catch (err) {
        return jsonResponse({
          status: "debug_ping_failed",
          error: err.message || String(err),
          aborted: ctrl.signal.aborted,
          duration_ms: Date.now() - startTime
        }, 500);
      } finally {
        clearTimeout(pingTimeout);
      }
    }

    const summary = {
      clients_processed: 0,
      agent_runs: 0,
      sources_total: 0,
      sources_processed: 0,
      ingested: 0,
      per_source: [],
      errors: []
    };

    const { data: clients, error: cErr } = await supa()
      .from("clients").select("id, name").eq("active", true);
    if (cErr) return jsonResponse({ error: "clients_fetch_failed", details: cErr.message }, 500);
    if (!clients || clients.length === 0) {
      return jsonResponse({ status: "no_active_clients", duration_ms: Date.now() - startTime });
    }

    outer:
    for (const client of clients) {
      summary.clients_processed++;

      const { data: sources, error: sErr } = await supa()
        .from("client_sources")
        .select("target, target_display, lane, agent_id, why, meta")
        .eq("client_id", client.id)
        .eq("source", SOURCE)
        .eq("active", true);
      if (sErr) { summary.errors.push({ client: client.id, error: sErr.message }); continue; }
      if (!sources || sources.length === 0) continue;

      summary.sources_total += sources.length;

      const byPillar = await getClientKeywords(client.id);
      const meta = await getClientMeta(client.id);

      // Group by agent
      const byAgent = new Map();
      for (const s of sources) {
        if (!byAgent.has(s.agent_id)) byAgent.set(s.agent_id, []);
        byAgent.get(s.agent_id).push(s);
      }

      for (const [agentId, agentSources] of byAgent) {
        summary.agent_runs++;
        const runId = await startRun({ clientId: client.id, agentId, source: SOURCE });

        // Apply limit at the agent level — process up to N more sources total
        const remainingLimit = limit ? Math.max(0, limit - summary.sources_processed) : agentSources.length;
        const toProcess = agentSources.slice(0, remainingLimit);

        // Parallelize within the agent batch
        const results = await Promise.all(toProcess.map(src =>
          processSource(src, { clientId: client.id, agentId, byPillar, meta })
        ));

        summary.sources_processed += results.length;
        summary.per_source.push(...results.map(r => ({ ...r, client: client.id, agent: agentId })));

        const ingested = results.filter(r => r.status === "ingested").length;
        const scored = results.filter(r => r.status === "ingested" || r.status === "below_threshold").length;
        const errs = results.filter(r => r.status?.endsWith("_error")).map(r => ({ target: r.target, error: r.error }));

        summary.ingested += ingested;
        if (errs.length) summary.errors.push(...errs.map(e => ({ ...e, client: client.id, agent: agentId })));

        await finishRun(runId, {
          signalsIngested: ingested,
          signalsNew: ingested,
          signalsScored: scored,
          errors: errs,
          status: errs.length > 0 ? "partial" : "success"
        });

        if (limit && summary.sources_processed >= limit) break outer;
      }
    }

    summary.duration_ms = Date.now() - startTime;
    summary.limit_applied = limit;
    return jsonResponse(summary);
  } catch (err) {
    return jsonResponse({
      error: "handler_threw",
      message: err.message || String(err),
      stack: (err.stack || "").split("\n").slice(0, 6),
      env_diagnostic: {
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_URL_prefix: process.env.SUPABASE_URL?.slice(0, 30) || null,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        SUPABASE_ANON_KEY_set: !!process.env.SUPABASE_ANON_KEY,
        node_version: process.version
      },
      duration_ms: Date.now() - startTime
    }, 500);
  }
}
