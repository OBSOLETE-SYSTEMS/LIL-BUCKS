// GET /api/signals?client=lilbucks&lane=CULTURAL&limit=20
//
// Returns recent signals for a client. Default: 20 signals, all lanes, all agents,
// with tonal score >= 0.25 OR brand match. Sorted by decay-weighted score.
//
// Used by the dashboard's "Live Pulse" strip to surface real-time data.

import { createClient } from "@supabase/supabase-js";

const CACHE_TTL_SECONDS = 60; // CDN cache window

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}

export default async function handler(req) {
  const t0 = Date.now();
  try {
    const url = new URL(req.url || "http://x/?", "http://x");
    const clientId = url.searchParams.get("client") || "lilbucks";
    const lane = url.searchParams.get("lane");
    const agent = url.searchParams.get("agent");
    const source = url.searchParams.get("source");
    const limitRaw = parseInt(url.searchParams.get("limit") || "20", 10);
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const minTonal = parseFloat(url.searchParams.get("min_tonal") || "0.25");

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({
        error: "config_missing",
        env: {
          SUPABASE_URL_set: !!process.env.SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY
        }
      }, 500);
    }

    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { db: { schema: "pipeline" }, auth: { persistSession: false, autoRefreshToken: false } }
    );

    // Use the signals_scored view for freshness-decayed ranking
    let q = supa.from("signals_scored")
      .select("id, source, source_id, source_url, target, lane, agent_id, occurred_at, fetched_at, title, body_excerpt, metric_score, client_tonal, pillar_hint, brand_match, competitor_match, decay_score")
      .eq("client_id", clientId)
      .or(`client_tonal.gte.${minTonal},brand_match.eq.true,competitor_match.not.is.null`)
      .order("decay_score", { ascending: false })
      .limit(limit);

    if (lane) q = q.eq("lane", lane);
    if (agent) q = q.eq("agent_id", agent);
    if (source) q = q.eq("source", source);

    const { data: signals, error } = await q;
    if (error) return jsonResponse({ error: "query_failed", details: error.message }, 500);

    return jsonResponse({
      client: clientId,
      filters: { lane, agent, source, limit, min_tonal: minTonal },
      count: signals?.length || 0,
      signals: signals || [],
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - t0
    });
  } catch (err) {
    return jsonResponse({
      error: "handler_threw",
      message: err.message || String(err),
      duration_ms: Date.now() - t0
    }, 500);
  }
}
