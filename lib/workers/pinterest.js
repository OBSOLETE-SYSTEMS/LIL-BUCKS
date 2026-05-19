// Pinterest Trends Explorer worker — Express-style, no auth.
//
// Pinterest's public-facing trends explorer (trends.pinterest.com) loads
// data via internal JSON endpoints. We mimic a real browser session and
// call those endpoints directly. No auth required; may be brittle if
// Pinterest adds anti-scrape measures.
//
// The page calls: https://trends.pinterest.com/api/v1/top-trends/
// with region + category params. Returns JSON with trending search
// terms, their interest scores, and adjacent terms.
//
// Source target format:
//   target = "US_food_drink" / "US_lifestyle" / etc.
//   meta = { region: "US", category: "food_drink", time_window: "weekly" }

import { supa, startRun, finishRun, isAuthorizedCron } from "../supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../scoring.js";

const SOURCE = "pinterest_trends";
const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

function buildHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://trends.pinterest.com",
    "Referer": "https://trends.pinterest.com/"
  };
}

function buildUrl(src) {
  const region = (src.meta?.region || "US").toUpperCase();
  const category = src.meta?.category || "";
  const params = new URLSearchParams({
    region,
    time_window: src.meta?.time_window || "weekly"
  });
  if (category) params.set("category", category);
  // Pinterest internal endpoint — verified shape; may shift if Pinterest reorgs
  return `https://trends.pinterest.com/api/v1/top-trends/?${params}`;
}

function pinterestVelocity(item) {
  // Pinterest returns growth_pct or interest_score on items. Normalize 0-2 scale.
  const growth = parseFloat(item.growth_pct || item.growth || 0);
  const interest = parseFloat(item.interest_score || item.score || 50);
  // Combine growth + interest — high-growth low-interest = early signal, both high = mass moment
  return Math.min(2.0, (growth / 100) + (interest / 100));
}

async function processSource(src, { clientId, agentId, byPillar, meta }) {
  const t0 = Date.now();
  const result = { target: src.target, status: "unknown", ingested: 0, items_seen: 0, ms: 0 };
  try {
    const url = buildUrl(src);
    const r = await fetchWithTimeout(url, { headers: buildHeaders() });
    if (!r.ok) {
      result.status = `fetch_${r.status}`;
      result.error = (await r.text()).slice(0, 300);
      return result;
    }
    // Pinterest sometimes returns HTML when blocking; try parsing JSON safely
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch { result.status = "non_json_response"; result.error = text.slice(0, 200); return result; }

    // Pinterest's API has shifted formats; check common shapes
    const trends = data?.trends || data?.data || data?.top_trends || [];
    if (!Array.isArray(trends)) {
      result.status = "unexpected_shape";
      result.error = JSON.stringify(Object.keys(data || {})).slice(0, 200);
      return result;
    }
    result.items_seen = trends.length;
    const upserts = [];

    for (const item of trends) {
      const term = item.keyword || item.query || item.term || item.name;
      if (!term) continue;
      const itemId = item.id || term.toLowerCase().replace(/\s+/g, "_");

      const labelText = `${term} · Pinterest ${src.meta?.category || src.target}`;
      const tonal = scoreTonal(term, byPillar);
      const bm = detectBrandMatch(term, meta);
      const velocity = pinterestVelocity(item);

      // Signal gate: tonal >= 0.2 OR brand match OR top-15 (Pinterest is high-quality signal)
      if (tonal.score < 0.2 && !bm.brand_match && !bm.competitor_match && upserts.length >= 15) continue;

      upserts.push({
        client_id: clientId, source: SOURCE,
        source_id: `pinterest_trends:${src.target}:${itemId}:${new Date().toISOString().slice(0, 10)}`,
        source_url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(term)}`,
        target: src.target, lane: src.lane, agent_id: agentId,
        occurred_at: new Date().toISOString(),
        raw: { item, watchlist_meta: src.meta || {} },
        title: labelText.slice(0, 500),
        body_excerpt: (item.context || item.description || "").slice(0, 500),
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
        status: "debug_env_pinterest",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        note: "Pinterest Trends Explorer scrape — public endpoints. May break if Pinterest adds anti-scrape.",
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
        const errs = results.filter(r => r.status?.endsWith("_error") || r.status === "non_json_response" || r.status === "unexpected_shape")
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
