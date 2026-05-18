// Supabase connectivity test — touches Supabase but with a hard 5s timeout.
// Diagnoses whether `supa().from(...)` hangs in the Vercel runtime.

import { createClient } from "@supabase/supabase-js";

export default async function handler(req) {
  const t0 = Date.now();
  const result = {
    env: {
      SUPABASE_URL_set: !!process.env.SUPABASE_URL,
      SUPABASE_URL_prefix: process.env.SUPABASE_URL?.slice(0, 40) || null,
      SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_SERVICE_ROLE_KEY_len: process.env.SUPABASE_SERVICE_ROLE_KEY?.length || 0
    }
  };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ...result, status: "missing_env_vars", duration_ms: Date.now() - t0 }, null, 2),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }

  try {
    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { db: { schema: "pipeline" }, auth: { persistSession: false, autoRefreshToken: false } }
    );
    result.client_created_ms = Date.now() - t0;

    // Race the query against a 5s hard timeout so we don't hit the function-level 60s wall
    const queryStart = Date.now();
    const query = supa.from("clients").select("id, name").eq("active", true);
    const race = await Promise.race([
      query.then(r => ({ kind: "result", r })),
      new Promise(resolve => setTimeout(() => resolve({ kind: "timeout" }), 5000))
    ]);
    result.query_ms = Date.now() - queryStart;

    if (race.kind === "timeout") {
      result.status = "supabase_query_timeout_at_5s";
      result.duration_ms = Date.now() - t0;
      return new Response(JSON.stringify(result, null, 2),
        { status: 504, headers: { "Content-Type": "application/json" } });
    }

    const { data, error } = race.r;
    result.status = error ? "supabase_query_error" : "supabase_query_ok";
    result.supabase_error = error?.message || null;
    result.rows = data?.length || 0;
    result.row_ids = (data || []).map(r => r.id);
    result.duration_ms = Date.now() - t0;
    return new Response(JSON.stringify(result, null, 2),
      { status: error ? 500 : 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    result.status = "handler_threw";
    result.error = err.message || String(err);
    result.stack = (err.stack || "").split("\n").slice(0, 6);
    result.duration_ms = Date.now() - t0;
    return new Response(JSON.stringify(result, null, 2),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
