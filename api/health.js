// Supabase connectivity test — Express-style.
// Tests createClient + a 5s-timeout query so we get a clean diagnostic
// instead of waiting 60s for the function-level timeout.

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
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
    return res.status(500).json({ ...result, status: "missing_env_vars", duration_ms: Date.now() - t0 });
  }

  try {
    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { db: { schema: "pipeline" }, auth: { persistSession: false, autoRefreshToken: false } }
    );
    result.client_created_ms = Date.now() - t0;

    const queryStart = Date.now();
    const race = await Promise.race([
      supa.from("clients").select("id, name").eq("active", true)
        .then(r => ({ kind: "result", r })),
      new Promise(resolve => setTimeout(() => resolve({ kind: "timeout" }), 5000))
    ]);
    result.query_ms = Date.now() - queryStart;

    if (race.kind === "timeout") {
      result.status = "supabase_query_timeout_at_5s";
      result.duration_ms = Date.now() - t0;
      return res.status(504).json(result);
    }

    const { data, error } = race.r;
    result.status = error ? "supabase_query_error" : "supabase_query_ok";
    result.supabase_error = error?.message || null;
    result.rows = data?.length || 0;
    result.row_ids = (data || []).map(r => r.id);
    result.duration_ms = Date.now() - t0;
    return res.status(error ? 500 : 200).json(result);
  } catch (err) {
    result.status = "handler_threw";
    result.error = err.message || String(err);
    result.stack = (err.stack || "").split("\n").slice(0, 6);
    result.duration_ms = Date.now() - t0;
    return res.status(500).json(result);
  }
}
