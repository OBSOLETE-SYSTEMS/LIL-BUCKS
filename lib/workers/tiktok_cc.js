// TikTok Creative Center worker — Express-style, no auth.
//
// Uses TikTok's public Creative Center "creative_radar" API endpoints —
// the same calls the public ads.tiktok.com/business/creativecenter page
// makes when you load it as a user. No authentication required, but the
// endpoints can be brittle: TikTok occasionally adds anti-scrape measures
// (signed headers, rate limits) without notice.
//
// Endpoints used:
//   POPULAR HASHTAGS:
//     https://ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list
//       ?period=7&page=1&limit=50&order_by=popular&country_code=US
//   POPULAR SOUNDS:
//     https://ads.tiktok.com/creative_radar_api/v1/popular_trend/song/list
//       ?period=7&page=1&limit=50&order_by=popular&country_code=US
//
// If TikTok blocks these without warning, the worker returns the actual
// error in the per-source diagnostic so we know to swap approaches
// (e.g., TikTok Research API once approved, or Playwright fallback).
//
// Source target format in client_sources:
//   target = "food_beverage_us_7d" / "sounds_us_7d" / etc. (slug identifier)
//   meta = { region: "US", category: "Food & Beverage" | null, type: "hashtags"|"sounds", window: "7d" }

import { supa, startRun, finishRun, isAuthorizedCron } from "../supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../scoring.js";

const SOURCE = "tiktok_cc";
const FETCH_TIMEOUT_MS = 10000;

// Industry IDs in TikTok Creative Center — used to filter hashtags by category
const INDUSTRY_IDS = {
  "Food & Beverage": "26000000",
  "Beauty & Personal Care": "23000000",
  "Lifestyle": "30000000",
  "Family": "27000000",
  "Pets": "37000000"
};

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

function buildHeaders() {
  // TikTok Creative Center expects these headers; some are "fingerprint" headers
  // it expects from the JS that loads the page. We mimic them.
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://ads.tiktok.com",
    "Referer": "https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Anonymous-User-Id": "00000000-0000-0000-0000-000000000001",
    "Timestamp": String(Date.now()),
    "Web-Id": "0000000000000000000"
  };
}

function buildUrl(src) {
  const type = src.meta?.type || "hashtags";
  const region = (src.meta?.region || "US").toUpperCase();
  const window = src.meta?.window || "7";  // 7, 30, 120
  const period = window.toString().replace("d", "");
  const limit = 50;

  if (type === "sounds") {
    return `https://ads.tiktok.com/creative_radar_api/v1/popular_trend/song/list?period=${period}&page=1&limit=${limit}&order_by=popular&country_code=${region}`;
  }
  // hashtags (default)
  const params = new URLSearchParams({
    period, page: "1", limit: String(limit),
    order_by: "popular", country_code: region
  });
  const industryName = src.meta?.category;
  if (industryName && INDUSTRY_IDS[industryName]) {
    params.set("industry_id", INDUSTRY_IDS[industryName]);
  }
  return `https://ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list?${params}`;
}

// Velocity from TikTok view counts (raw publish_cnt for hashtags, post_cnt for sounds)
function tiktokVelocity(item, type) {
  const views = type === "sounds" ? (item.user_cnt || item.post_cnt || 0) : (item.publish_cnt || 0);
  // Normalize: 1M = 1.0, 10M = 1.5, 100M = 2.0
  return Math.min(2.0, Math.log10(Math.max(views, 1000)) / 6);
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
    const data = await r.json();
    if (data.code !== 0) {
      result.status = `api_code_${data.code}`;
      result.error = data.msg || JSON.stringify(data).slice(0, 300);
      return result;
    }
    const list = data?.data?.list || [];
    result.items_seen = list.length;
    const upserts = [];
    const type = src.meta?.type || "hashtags";

    for (const item of list) {
      // Hashtag shape: { hashtag_name, hashtag_id, country_code, industry_id, is_promoted, publish_cnt, video_views, trend, ... }
      // Sound shape: { song_id, song_title, song_url, user_cnt, post_cnt, country, ... }
      const isHashtag = type === "hashtags";
      const name = isHashtag ? (item.hashtag_name || item.name) : (item.song_title || item.title);
      const itemId = isHashtag ? (item.hashtag_id || item.id) : (item.song_id || item.id);
      if (!name || !itemId) continue;

      const labelText = isHashtag
        ? `#${name} · ${item.publish_cnt ?? "?"} videos · trend rank`
        : `${name} · ${item.user_cnt ?? "?"} users · TikTok sound`;
      const tonal = scoreTonal(name, byPillar);
      const bm = detectBrandMatch(name, meta);

      // Signal gate: tonal match OR brand/competitor mention OR top 10 (already filtered to popular)
      if (tonal.score < 0.25 && !bm.brand_match && !bm.competitor_match && upserts.length >= 10) continue;

      const sourceUrl = isHashtag
        ? `https://www.tiktok.com/tag/${encodeURIComponent(name)}`
        : (item.song_url || `https://www.tiktok.com/music/${encodeURIComponent(itemId)}`);

      upserts.push({
        client_id: clientId, source: SOURCE,
        source_id: `tiktok_cc:${type}:${itemId}:${new Date().toISOString().slice(0, 10)}`,
        source_url: sourceUrl,
        target: src.target, lane: src.lane, agent_id: agentId,
        occurred_at: new Date().toISOString(),
        raw: { item, type, watchlist_meta: src.meta || {} },
        title: labelText.slice(0, 500),
        body_excerpt: (item.trend?.join(", ") || "").slice(0, 500),
        metric_score: tiktokVelocity(item, type),
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
        status: "debug_env_tiktok_cc",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        node_version: process.version,
        note: "TikTok Creative Center uses public endpoints — no auth required, but they may add anti-scrape measures without warning."
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
        const errs = results.filter(r => r.status?.endsWith("_error") || r.status?.startsWith("api_code"))
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
