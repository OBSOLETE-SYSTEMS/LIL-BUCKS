// Meta Ad Library worker — Express-style, requires Meta Graph API access token.
//
// Setup (~10 min):
//   1. https://developers.facebook.com → "My Apps" → "Create App"
//   2. App type: "Business" or "Other" → fill basic info
//   3. App dashboard → Settings → Basic → grab App ID + App Secret
//   4. Generate App Access Token: GET https://graph.facebook.com/oauth/access_token
//        ?client_id=APP_ID&client_secret=APP_SECRET&grant_type=client_credentials
//      Returns { "access_token": "...|..." } — that's the META_ACCESS_TOKEN
//   5. Add to Vercel env (all 3 environments):
//        META_ACCESS_TOKEN
//
// The worker queries the Ad Library API for each watched page name (or page_id),
// pulls active ads in the US, scores against client keywords + brand mentions,
// upserts into pipeline.signals.
//
// Note: Meta Ad Library is geographically restricted — the API only returns
// ads from accounts that have verified their identity in their country.
// For US-focused queries, this should work for most major CPG advertisers.

import { supa, startRun, finishRun, isAuthorizedCron } from "../supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../scoring.js";

const SOURCE = "meta_ad_library";
const FETCH_TIMEOUT_MS = 8000;
const MAX_ADS_PER_QUERY = 50;

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

function buildQuery(src, accessToken) {
  // Search by page_id if meta.page_id provided, else by search_terms (page_name)
  const params = new URLSearchParams({
    access_token: accessToken,
    ad_reached_countries: '["US"]',
    ad_active_status: "ACTIVE",
    limit: String(MAX_ADS_PER_QUERY),
    fields: [
      "ad_creative_bodies",
      "ad_creative_link_captions",
      "ad_creative_link_titles",
      "ad_delivery_start_time",
      "ad_delivery_stop_time",
      "ad_snapshot_url",
      "page_name",
      "page_id",
      "currency",
      "impressions",
      "spend"
    ].join(",")
  });
  if (src.meta?.page_id) {
    params.set("search_page_ids", `[${src.meta.page_id}]`);
  } else {
    params.set("search_terms", src.meta?.page_name || src.target);
  }
  return `https://graph.facebook.com/v18.0/ads_archive?${params}`;
}

function adVelocity(ad) {
  // Active ad currently running = high velocity. Use ad_delivery_start_time recency.
  const start = ad.ad_delivery_start_time ? new Date(ad.ad_delivery_start_time).getTime() : Date.now();
  const ageDays = (Date.now() - start) / 86_400_000;
  return Math.max(0.1, Math.pow(0.95, ageDays)); // slow decay; ads accumulate value
}

async function processSource(src, { clientId, agentId, byPillar, meta, accessToken }) {
  const t0 = Date.now();
  const result = { target: src.target, status: "unknown", ingested: 0, ads_seen: 0, ms: 0 };
  try {
    const url = buildQuery(src, accessToken);
    const r = await fetchWithTimeout(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) {
      result.status = `fetch_${r.status}`;
      const err = await r.text();
      result.error = err.slice(0, 300);
      return result;
    }
    const data = await r.json();
    const ads = data?.data || [];
    result.ads_seen = ads.length;
    const upserts = [];

    for (const ad of ads) {
      if (!ad.ad_snapshot_url) continue;
      const adId = ad.id || ad.ad_snapshot_url.split("?id=")[1]?.split("&")[0] || ad.ad_snapshot_url;
      const bodies = (ad.ad_creative_bodies || []).join(" · ");
      const titles = (ad.ad_creative_link_titles || []).join(" · ");
      const captions = (ad.ad_creative_link_captions || []).join(" · ");
      const fulltext = `${ad.page_name || ""} ${titles} ${bodies} ${captions}`;
      const tonal = scoreTonal(fulltext, byPillar);
      const bm = detectBrandMatch(fulltext, meta);

      // Ad library signal gate: page_name match (always relevant if we're tracking
      // this advertiser) OR tonal match OR brand/competitor mention
      const pageMatch = (ad.page_name || "").toLowerCase().includes(src.target.toLowerCase());
      if (!pageMatch && tonal.score < 0.2 && !bm.brand_match && !bm.competitor_match) continue;

      const source_id = `meta_ad:${adId}`;
      upserts.push({
        client_id: clientId, source: SOURCE,
        source_id, source_url: ad.ad_snapshot_url,
        target: src.target, lane: src.lane, agent_id: agentId,
        occurred_at: ad.ad_delivery_start_time
          ? new Date(ad.ad_delivery_start_time).toISOString()
          : new Date().toISOString(),
        raw: { ad, page_meta: src.meta || {} },
        title: `${ad.page_name || src.target} · ${(titles || bodies).slice(0, 100)}`.slice(0, 500),
        body_excerpt: bodies.slice(0, 500),
        metric_score: adVelocity(ad),
        client_tonal: tonal.score,
        pillar_hint: tonal.pillar,
        brand_match: bm.brand_match,
        competitor_match: bm.competitor_match || (pageMatch ? src.target : null),
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
        status: "debug_env_meta_ad_library",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        META_ACCESS_TOKEN_set: !!process.env.META_ACCESS_TOKEN,
        meta_ready: !!process.env.META_ACCESS_TOKEN,
        node_version: process.version
      });
    }
    const limit = q.limit ? parseInt(q.limit, 10) : null;

    if (!process.env.META_ACCESS_TOKEN) {
      return res.status(503).json({
        status: "meta_credentials_missing",
        message: "Register an app at developers.facebook.com, generate an app access token, and add META_ACCESS_TOKEN to Vercel env."
      });
    }
    const accessToken = process.env.META_ACCESS_TOKEN;

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
          processSource(src, { clientId: client.id, agentId, byPillar, meta, accessToken })
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
          signalsScored: results.reduce((s, r) => s + (r.ads_seen || 0), 0),
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
