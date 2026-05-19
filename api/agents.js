// GET /api/agents?client=lilbucks — Express-style.

import { createClient } from "@supabase/supabase-js";

const CACHE_TTL_SECONDS = 60;

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    const clientId = req.query?.client || "lilbucks";

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "config_missing" });
    }

    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { db: { schema: "pipeline" }, auth: { persistSession: false, autoRefreshToken: false } }
    );

    const { data: agents, error: aErr } = await supa
      .from("client_agents")
      .select("agent_id, function, display_name, description, focus, icon, cadence")
      .eq("client_id", clientId)
      .eq("active", true)
      .order("agent_id");
    if (aErr) return res.status(500).json({ error: "agents_query_failed", details: aErr.message });

    if (!agents || agents.length === 0) {
      return res.status(200).json({ client: clientId, agents: [], duration_ms: Date.now() - t0 });
    }

    const { data: sources } = await supa
      .from("client_sources")
      .select("agent_id, source")
      .eq("client_id", clientId)
      .eq("active", true);

    const sourceCounts = new Map();
    const sourceTypes = new Map();
    for (const s of sources || []) {
      sourceCounts.set(s.agent_id, (sourceCounts.get(s.agent_id) || 0) + 1);
      if (!sourceTypes.has(s.agent_id)) sourceTypes.set(s.agent_id, new Set());
      sourceTypes.get(s.agent_id).add(s.source);
    }

    const { data: activity } = await supa
      .from("agent_activity")
      .select("agent_id, last_run_at, ingested_24h, scored_24h, sources_watched")
      .eq("client_id", clientId);
    const activityByAgent = new Map((activity || []).map(a => [a.agent_id, a]));

    const recentByAgent = new Map();
    for (const a of agents) {
      const { data: recents } = await supa
        .from("signals_scored")
        .select("source, target, title, source_url, lane, occurred_at, metric_score, client_tonal, decay_score, pillar_hint")
        .eq("client_id", clientId)
        .eq("agent_id", a.agent_id)
        .order("decay_score", { ascending: false })
        .limit(3);
      recentByAgent.set(a.agent_id, recents || []);
    }

    const composed = agents.map(a => {
      const act = activityByAgent.get(a.agent_id);
      return {
        ...a,
        sources_count: sourceCounts.get(a.agent_id) || 0,
        source_types: Array.from(sourceTypes.get(a.agent_id) || []),
        last_run_at: act?.last_run_at || null,
        ingested_24h: act?.ingested_24h || 0,
        scored_24h: act?.scored_24h || 0,
        recent_signals: recentByAgent.get(a.agent_id) || []
      };
    });

    res.setHeader("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({
      client: clientId,
      agents: composed,
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
