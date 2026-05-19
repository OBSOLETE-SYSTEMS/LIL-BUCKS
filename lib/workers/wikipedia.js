// Wikipedia Pageviews worker — Express-style handler (Vercel Node).
//
// Multi-tenant: loops over every active client, pulls each client's wikipedia
// watchlist from pipeline.client_sources, fetches pageview deltas, scores
// velocity + client_tonal, upserts into pipeline.signals.

import { supa, startRun, finishRun, isAuthorizedCron } from "../supabase.js";
import {
  getClientKeywords, scoreTonal,
  getClientMeta, detectBrandMatch,
  wikiVelocity
} from "../scoring.js";

const WIKI_USER_AGENT = "OBSOLETE-Signal-Pipeline/0.1 (https://obsolete.systems; alex@obsolete.systems)";
const SOURCE = "wikipedia";
const DEFAULT_FETCH_TIMEOUT_MS = 8000;

function fmtDate(d) { return d.toISOString().slice(0, 10).replace(/-/g, ""); }

async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
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
  const r = await fetchWithTimeout(url, {
    headers: { "User-Agent": WIKI_USER_AGENT, "Accept": "application/json" }
  });
  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(`Wikipedia pageviews ${r.status} for ${articleTitle}`);
  }
  return await r.json();
}

async function fetchSummary(articleTitle) {
  const encoded = encodeURIComponent(articleTitle.replace(/ /g, "_"));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
  try {
    const r = await fetchWithTimeout(url, {
      headers: { "User-Agent": WIKI_USER_AGENT, "Accept": "application/json" }
    });
    if (!r.ok) return null;
    const data = await r.json();
    return {
      title: data.title,
      extract: data.extract,
      url: data.content_urls?.desktop?.page,
      timestamp: data.timestamp
    };
  } catch (e) {
    return null;
  }
}

async function processSource(src, { clientId, agentId, byPillar, meta }) {
  const t0 = Date.now();
  try {
    const pageviews = await fetchPageviews(src.target, 8);
    if (!pageviews?.items || pageviews.items.length < 2) {
      return { target: src.target, status: "no_data", ms: Date.now() - t0 };
    }

    const items = pageviews.items;
    const today = items[items.length - 1];
    const prior = items.slice(0, -1);
    const rollingAvg7 = prior.reduce((s, x) => s + x.views, 0) / Math.max(prior.length, 1);
    const velocity = wikiVelocity({ todayViews: today.views, rollingAvg7 });

    if (velocity < 1.3 && today.views < 10000) {
      return { target: src.target, status: "below_threshold", views: today.views, velocity, ms: Date.now() - t0 };
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
    const { error } = await supa().from("signals").upsert({
      client_id: clientId, source: SOURCE, source_id,
      source_url: url, target: src.target, lane: src.lane, agent_id: agentId,
      occurred_at: new Date(
        `${today.timestamp.slice(0, 4)}-${today.timestamp.slice(4, 6)}-${today.timestamp.slice(6, 8)}T00:00:00Z`
      ).toISOString(),
      raw: { pageviews: items, summary: sum, watchlist_meta: src.meta || {} },
      title, body_excerpt: body.slice(0, 500),
      metric_score: velocity, client_tonal: tonal.score, pillar_hint: tonal.pillar,
      brand_match: bm.brand_match, competitor_match: bm.competitor_match,
      status: "fresh"
    }, { onConflict: "client_id,source,source_id" });

    if (error) return { target: src.target, status: "upsert_error", error: error.message, ms: Date.now() - t0 };
    return { target: src.target, status: "ingested", views: today.views, velocity: velocity.toFixed(2), tonal: tonal.score.toFixed(2), pillar: tonal.pillar, ms: Date.now() - t0 };
  } catch (err) {
    return { target: src.target, status: "fetch_error", error: String(err.message || err), ms: Date.now() - t0 };
  }
}

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    if (!isAuthorizedCron(req)) return res.status(401).json({ error: "unauthorized" });

    const q = req.query || {};
    const limit = q.limit ? parseInt(q.limit, 10) : null;
    const debug = q.debug;

    if (debug === "env") {
      return res.status(200).json({
        status: "debug_env",
        env: {
          SUPABASE_URL_set: !!process.env.SUPABASE_URL,
          SUPABASE_URL_prefix: process.env.SUPABASE_URL?.slice(0, 40) || null,
          SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
          node_version: process.version,
          region: process.env.VERCEL_REGION || null
        },
        duration_ms: Date.now() - t0
      });
    }

    const summary = { clients_processed: 0, agent_runs: 0, sources_total: 0, sources_processed: 0, ingested: 0, per_source: [], errors: [] };

    const { data: clients, error: cErr } = await supa()
      .from("clients").select("id, name").eq("active", true);
    if (cErr) return res.status(500).json({ error: "clients_fetch_failed", details: cErr.message });
    if (!clients?.length) return res.status(200).json({ status: "no_active_clients", duration_ms: Date.now() - t0 });

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

    summary.duration_ms = Date.now() - t0;
    summary.limit_applied = limit;
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(500).json({
      error: "handler_threw",
      message: err.message || String(err),
      stack: (err.stack || "").split("\n").slice(0, 6),
      env_diagnostic: {
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY
      },
      duration_ms: Date.now() - t0
    });
  }
}
