// GET /api/agents?client=lilbucks
//
// Returns the agent roster for a client + live telemetry:
//   - sources_watched (count of active client_sources rows for this agent)
//   - last_run_at
//   - ingested_24h
//   - scored_24h
//   - recent_signals (top 3 by decay_score)
//
// Drives the "How It Works" modal — the architecture-as-proof surface.

import { createClient } from "@supabase/supabase-js";

const CACHE_TTL_SECONDS = 60;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export default async function handler(req) {
  const t0 = Date.now();
  try {
    const url = new URL(req.url || "http://x/?", "http://x");
    const clientId = url.searchParams.get("client") || "lilbucks";

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: "config_missing" }, 500);
    }

    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { db: { schema: "pipeline" }, auth: { persistSession: false, autoRefreshToken: false } }
    );

    // 1. Agent roster
    const { data: agents, error: aErr } = await supa
      .from("client_agents")
      .select("agent_id, function, display_name, description, focus, icon, cadence")
      .eq("client_id", clientId)
      .eq("active", true)
      .order("agent_id");
    if (aErr) return jsonResponse({ error: "agents_query_failed", details: aErr.message }, 500);

    if (!agents || agents.length === 0) {
      return jsonResponse({ client: clientId, agents: [], duration_ms: Date.now() - t0 });
    }

    // 2. Source counts per agent
    const { data: sources, error: sErr } = await supa
      .from("client_sources")
      .select("agent_id, source")
      .eq("client_id", clientId)
      .eq("active", true);
    if (sErr) return jsonResponse({ error: "sources_query_failed", details: sErr.message }, 500);

    const sourceCounts = new Map();
    const sourceTypes = new Map();
    for (const s of sources || []) {
      sourceCounts.set(s.agent_id, (sourceCounts.get(s.agent_id) || 0) + 1);
      if (!sourceTypes.has(s.agent_id)) sourceTypes.set(s.agent_id, new Set());
      sourceTypes.get(s.agent_id).add(s.source);
    }

    // 3. Agent activity (last run + 24h counts) — use the view
    const { data: activity } = await supa
      .from("agent_activity")
      .select("agent_id, last_run_at, ingested_24h, scored_24h, sources_watched")
      .eq("client_id", clientId);
    const activityByAgent = new Map((activity || []).map(a => [a.agent_id, a]));

    // 4. Recent signals per agent (top 3 by decay_score)
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

    // 5. Compose response
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

    return jsonResponse({
      client: clientId,
      agents: composed,
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
