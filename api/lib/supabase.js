// Shared Supabase client for the OBSOLETE Signal Pipeline.
// Lazy init pattern: env-var check happens at first call, NOT at module load,
// so import never crashes the function — handler can return a clean diagnostic.

import { createClient } from "@supabase/supabase-js";

let _supa = null;

export function supa() {
  if (_supa) return _supa;
  const URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) {
    throw new Error(
      `Missing Supabase env vars. SUPABASE_URL set: ${!!URL}, ` +
      `SUPABASE_SERVICE_ROLE_KEY set: ${!!KEY}. ` +
      `Add them in Vercel Project Settings → Environment Variables (all 3 envs checked).`
    );
  }
  _supa = createClient(URL, KEY, {
    db: { schema: "pipeline" },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return _supa;
}

// ---------- Telemetry helpers ----------

export async function startRun({ clientId, agentId, source }) {
  const { data, error } = await supa()
    .from("agent_runs")
    .insert({ client_id: clientId, agent_id: agentId, source, status: "running" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function finishRun(runId, { signalsIngested, signalsNew, signalsScored, errors = [], status = "success" }) {
  const { error } = await supa()
    .from("agent_runs")
    .update({
      finished_at: new Date().toISOString(),
      signals_ingested: signalsIngested,
      signals_new: signalsNew,
      signals_scored: signalsScored,
      errors: errors,
      status
    })
    .eq("id", runId);
  if (error) throw error;
}

// ---------- Verify Vercel cron auth ----------

export function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / no secret set — allow
  const auth = (typeof req.headers?.get === "function")
    ? req.headers.get("authorization")
    : req.headers?.authorization;
  return auth === `Bearer ${secret}`;
}
