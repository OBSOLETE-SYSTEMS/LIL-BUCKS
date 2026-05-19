// GET /api/signals?client=lilbucks&lane=CULTURAL&limit=20 — Express style.

import { createClient } from "@supabase/supabase-js";

const CACHE_TTL_SECONDS = 60;

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    const q = req.query || {};
    const clientId = q.client || "lilbucks";
    const lane = q.lane || null;
    const agent = q.agent || null;
    const source = q.source || null;
    const limitRaw = parseInt(q.limit || "20", 10);
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const minTonal = parseFloat(q.min_tonal || "0.25");

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error: "config_missing",
        env: {
          SUPABASE_URL_set: !!process.env.SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY
        }
      });
    }

    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { db: { schema: "pipeline" }, auth: { persistSession: false, autoRefreshToken: false } }
    );

    let qb = supa.from("signals_scored")
      .select("id, source, source_id, source_url, target, lane, agent_id, occurred_at, fetched_at, title, body_excerpt, metric_score, client_tonal, pillar_hint, brand_match, competitor_match, decay_score")
      .eq("client_id", clientId)
      .or(`client_tonal.gte.${minTonal},brand_match.eq.true,competitor_match.not.is.null`)
      .order("decay_score", { ascending: false })
      .limit(limit);

    if (lane) qb = qb.eq("lane", lane);
    if (agent) qb = qb.eq("agent_id", agent);
    if (source) qb = qb.eq("source", source);

    const { data: signals, error } = await qb;
    if (error) return res.status(500).json({ error: "query_failed", details: error.message });

    res.setHeader("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({
      client: clientId,
      filters: { lane, agent, source, limit, min_tonal: minTonal },
      count: signals?.length || 0,
      signals: signals || [],
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - t0
    });
  } catch (err) {
    return res.status(500).json({
      error: "handler_threw",
      message: err.message || String(err),
      duration_ms: Date.now() - t0
    });
  }
}
