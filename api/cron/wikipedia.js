// Wikipedia Pageviews worker — Stage 2 of the OBSOLETE Signal Pipeline.
//
// Multi-tenant: loops over every active client, pulls each client's wikipedia
// watchlist from pipeline.client_sources, fetches pageview deltas, scores
// velocity + client_tonal, upserts into pipeline.signals.
//
// Schedule: daily at 9am ET (`0 13 * * *` UTC). See vercel.json.
//
// Wikipedia REST API used:
//   https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/{ARTICLE}/daily/{START}/{END}

import { supa, startRun, finishRun, isAuthorizedCron } from "../lib/supabase.js";
import {
  getClientKeywords, scoreTonal,
  getClientMeta, detectBrandMatch,
  wikiVelocity
} from "../lib/scoring.js";

const WIKI_USER_AGENT = "OBSOLETE-Signal-Pipeline/0.1 (https://obsolete.systems; alex@obsolete.systems)";
const SOURCE = "wikipedia";

// ---------- Wikipedia fetch helpers ----------

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchPageviews(articleTitle, daysBack = 8) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1); // Wikipedia pageview data lags ~1 day
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

// ---------- Main worker ----------

export default async function handler(req) {
  if (!isAuthorizedCron(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const startTime = Date.now();
  const summary = { clients: 0, agent_runs: 0, sources: 0, ingested: 0, errors: [] };

  // 1. Pull all active clients (multi-tenant from day 1)
  const { data: clients, error: cErr } = await supa
    .from("clients").select("id, name").eq("active", true);
  if (cErr) return new Response(JSON.stringify({ error: cErr.message }), { status: 500 });

  for (const client of clients || []) {
    summary.clients++;

    // 2. Pull this client's wikipedia watchlist
    const { data: sources, error: sErr } = await supa
      .from("client_sources")
      .select("target, target_display, lane, agent_id, why, meta")
      .eq("client_id", client.id)
      .eq("source", SOURCE)
      .eq("active", true);
    if (sErr) {
      summary.errors.push({ client: client.id, error: sErr.message });
      continue;
    }
    if (!sources || sources.length === 0) continue;

    // 3. Load client's tonal vocab + brand/competitor terms (cached per invocation)
    const byPillar = await getClientKeywords(client.id);
    const meta = await getClientMeta(client.id);

    // 4. Group sources by agent_id so telemetry attributes per (client, agent)
    const byAgent = new Map();
    for (const s of sources) {
      if (!byAgent.has(s.agent_id)) byAgent.set(s.agent_id, []);
      byAgent.get(s.agent_id).push(s);
    }

    // 5. One agent_run per (client, agent)
    for (const [agentId, agentSources] of byAgent) {
      summary.agent_runs++;
      const runId = await startRun({ clientId: client.id, agentId, source: SOURCE });
      let ingested = 0;
      let scored = 0;
      let runErrors = [];

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

          // Ingest gate: spike >= 1.3x baseline OR absolute >= 10k views (catches mass-relevant pages)
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

          // 6. Upsert — one row per (client, page, day)
          const source_id = `wikipedia:${src.target}:${today.timestamp.slice(0, 8)}`;
          const { error: upErr } = await supa.from("signals").upsert({
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

          if (upErr) {
            runErrors.push({ target: src.target, error: upErr.message });
            continue;
          }
          ingested++;
        } catch (err) {
          runErrors.push({ target: src.target, error: String(err.message || err) });
        }

        // Polite throttle — Wikipedia tolerates higher but no need to push it
        await new Promise(r => setTimeout(r, 100));
      }

      summary.ingested += ingested;
      if (runErrors.length) summary.errors.push(...runErrors.map(e => ({ ...e, client: client.id, agent: agentId })));

      await finishRun(runId, {
        signalsIngested: ingested,
        signalsNew: ingested,           // V1: no new-vs-update distinction
        signalsScored: scored,
        errors: runErrors,
        status: runErrors.length > 0 ? "partial" : "success"
      });
    }
  }

  summary.duration_ms = Date.now() - startTime;
  return new Response(JSON.stringify(summary, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
}
