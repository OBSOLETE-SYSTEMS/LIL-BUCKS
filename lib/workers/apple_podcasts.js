// Apple Podcasts charts worker — Express-style, no auth.
//
// Uses iTunes RSS JSON endpoint:
//   https://itunes.apple.com/us/rss/toppodcasts/limit=50/genre={GENRE_ID}/json
//
// Each watchlist source = one (region, category) chart. Top podcasts in
// that chart become signals, scored against client keywords + brand match.

import { supa, startRun, finishRun, isAuthorizedCron } from "../supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../scoring.js";

const SOURCE = "apple_podcasts_charts";
const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "OBSOLETE-Signal-Pipeline/0.1 (+https://obsolete.systems)";

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

// target_display + meta.category drive the chart URL.
// target is the chart slug (e.g., "society-and-culture") used for dedup.
function buildChartUrl(src) {
  const region = (src.meta?.region || "us").toLowerCase();
  const category = src.meta?.category || "1324"; // default: Society & Culture
  const limit = src.meta?.limit || 50;
  return `https://itunes.apple.com/${region}/rss/toppodcasts/limit=${limit}/genre=${category}/json`;
}

// Chart velocity = inverse of rank (rank #1 = 1.0, rank #50 = 0.02)
function rankVelocity(rank, totalRanks = 50) {
  return Math.max(0.02, 1 - (rank - 1) / totalRanks);
}

async function processSource(src, { clientId, agentId, byPillar, meta }) {
  const t0 = Date.now();
  const result = { target: src.target, status: "unknown", ingested: 0, items_seen: 0, ms: 0 };
  try {
    const url = buildChartUrl(src);
    const r = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }
    });
    if (!r.ok) { result.status = `fetch_${r.status}`; return result; }
    const data = await r.json();
    const entries = data?.feed?.entry || [];
    result.items_seen = entries.length;

    const updatedISO = data?.feed?.updated?.label || new Date().toISOString();
    const chartDate = new Date(updatedISO).toISOString().slice(0, 10);
    const upserts = [];

    entries.forEach((entry, i) => {
      const rank = i + 1;
      const title = entry?.["im:name"]?.label;
      const artist = entry?.["im:artist"]?.label;
      const summary = entry?.summary?.label;
      const link = entry?.link?.attributes?.href || entry?.id?.label;
      const podcastId = entry?.id?.attributes?.["im:id"];
      if (!title || !podcastId) return;

      const fulltext = `${title} ${artist || ""} ${summary || ""}`;
      const tonal = scoreTonal(fulltext, byPillar);
      const bm = detectBrandMatch(fulltext, meta);

      // Chart signal gate: tonal match OR brand mention OR top-5 rank
      if (tonal.score < 0.25 && !bm.brand_match && !bm.competitor_match && rank > 5) return;

      const source_id = `apple_podcasts:${podcastId}:${chartDate}`;
      upserts.push({
        client_id: clientId, source: SOURCE,
        source_id, source_url: link,
        target: src.target, lane: src.lane, agent_id: agentId,
        occurred_at: new Date(updatedISO).toISOString(),
        raw: { entry, rank, chart: src.target, chart_meta: src.meta || {} },
        title: `${title} · ${artist || "Apple Podcasts"} · rank ${rank}`.slice(0, 500),
        body_excerpt: (summary || "").slice(0, 500),
        metric_score: rankVelocity(rank),
        client_tonal: tonal.score,
        pillar_hint: tonal.pillar,
        brand_match: bm.brand_match,
        competitor_match: bm.competitor_match,
        status: "fresh"
      });
    });

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
        status: "debug_env_apple_podcasts",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
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

        const results = await Promise.all(toProcess.map(src =>
          processSource(src, { clientId: client.id, agentId, byPillar, meta })
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
