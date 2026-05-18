// Wikipedia Pageviews worker — Stage 2 of the OBSOLETE Signal Pipeline.
//
// Multi-tenant: loops over every active client, pulls each client's wikipedia
// watchlist from pipeline.client_sources, fetches pageview deltas, scores
// velocity + client_tonal, upserts into pipeline.signals.

import { supa, startRun, finishRun, isAuthorizedCron } from "../lib/supabase.js";
import {
  getClientKeywords, scoreTonal,
  getClientMeta, detectBrandMatch,
  wikiVelocity
} from "../lib/scoring.js";

const WIKI_USER_AGENT = "OBSOLETE-Signal-Pipeline/0.1 (https://obsolete.systems; alex@obsolete.systems)";
const SOURCE = "wikipedia";

function fmtDate(d) { return d.toISOString().slice(0, 10).replace(/-/g, ""); }

async function fetchPageviews(articleTitle, daysBack = 8) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (daysBack - 1));
  const encoded = encodeURIComponent(articleTitle.replace(/ /g, "_"));
  const url =
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/` +
    `en.wikipedia/all-access/all-agents/${encoded}/daily/${fmtDate(start)}/${fmtDate(end)}`;
  const res = await fetch(url, { headers: { "User-Agent": WIKI_USER_AGENT, "Accept": "application/json" } });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Wikipedia ${res.status} for ${articleTitle}`);
  }
  return await res.json();
}

async function fetchSummary(articleTitle) {
  const encoded = encodeURIComponent(articleTitle.replace(/ /g, "_"));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
  const res = await fetch(url, { headers: { "User-Agent": WIKI_USER_AGENT, "Accept": "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    title: data.title,
    extract: data.extract,
    url: data.content_urls?.desktop?.page,
    timestamp: data.timestamp
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// ---------- Main worker (defensive — returns clean diagnostic on any failure) ----------

export default async function handler(req) {
  const startTime = Date.now();

  try {
    if (!isAuthorizedCron(req)) return jsonResponse({ error: "unauthorized" }, 401);

    const summary = { clients: 0, agent_runs: 0, sources: 0, ingested: 0, errors: [] };

    const { data: clients, error: cErr } = await supa()
      .from("clients").select("id, name").eq("active", true);
    if (cErr) return jsonResponse({ error: "clients_fetch_failed", details: cErr.message }, 500);
    if (!clients || clients.length === 0) {
      return jsonResponse({ status: "no_active_clients", duration_ms: Date.now() - startTime });
    }

    for (const client of clients) {
      summary.clients++;

      const { data: sources, error: sErr } = await supa()
        .from("client_sources")
        .select("target, target_display, lane, agent_id, why, meta")
        .eq("client_id", client.id)
        .eq("source", SOURCE)
        .eq("active", true);
      if (sErr) { summary.errors.push({ client: client.id, error: sErr.message }); continue; }
      if (!sources || sources.length === 0) continue;

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
        let ingested = 0;
        let scored = 0;
        const runErrors = [];

        for (const src of agentSources) {
          summary.sources++;
          try {
            const pageviews = await fetchPageviews(src.target, 8);
            if (!pageviews?.items || pageviews.items.length < 2) continue;

            const items = pageviews.items;
            const today = items[items.length - 1];
            const prior = items.slice(0, -1);
            const rollingAvg7 = prior.reduce((sum, x) => sum + x.views, 0) / prior.length;
            const velocity = wikiVelocity({ todayViews: today.views, rollingAvg7 });

            if (velocity < 1.3 && today.views < 10000) continue;

            const sum = await fetchSummary(src.target);
            const title = sum?.title || src.target_display || src.target;
            const body = sum?.extract ||
              `Wikipedia pageviews on ${src.target}: ${today.views} views (vs. 7-day avg ${Math.round(rollingAvg7)})`;
            const url = sum?.url ||
              `https://en.wikipedia.org/wiki/${encodeURIComponent(src.target.replace(/ /g, "_"))}`;

            const tonal = scoreTonal(`${title} ${body}`, byPillar);
            const bm = detectBrandMatch(`${title} ${body}`, meta);
            scored++;

            const source_id = `wikipedia:${src.target}:${today.timestamp.slice(0, 8)}`;
            const { error: upErr } = await supa().from("signals").upsert({
              client_id: client.id,
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

            if (upErr) { runErrors.push({ target: src.target, error: upErr.message }); continue; }
            ingested++;
          } catch (err) {
            runErrors.push({ target: src.target, error: String(err.message || err) });
          }
          await new Promise(r => setTimeout(r, 100));
        }

        summary.ingested += ingested;
        if (runErrors.length) summary.errors.push(...runErrors.map(e => ({ ...e, client: client.id, agent: agentId })));

        await finishRun(runId, {
          signalsIngested: ingested,
          signalsNew: ingested,
          signalsScored: scored,
          errors: runErrors,
          status: runErrors.length > 0 ? "partial" : "success"
        });
      }
    }

    summary.duration_ms = Date.now() - startTime;
    return jsonResponse(summary);
  } catch (err) {
    // Top-level catch — returns the actual error so we don't get a generic FUNCTION_INVOCATION_FAILED
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
