// Shared Supabase client for the OBSOLETE Signal Pipeline.
// Server-side (workers) uses the service_role key — bypasses RLS for upserts.
// Browser/dashboard uses the anon key with RLS read policies.

import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL) {
  throw new Error("Missing SUPABASE_URL env var");
}
if (!SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY env var");
}

// Schema-scoped client so we don't have to write `pipeline.` everywhere.
export const supa = createClient(URL, SERVICE_ROLE_KEY, {
  db: { schema: "pipeline" },
  auth: { persistSession: false, autoRefreshToken: false }
});

// ---------- Telemetry helpers ----------

export async function startRun({ clientId, agentId, source }) {
  const { data, error } = await supa
    .from("agent_runs")
    .insert({ client_id: clientId, agent_id: agentId, source, status: "running" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function finishRun(runId, { signalsIngested, signalsNew, signalsScored, errors = [], status = "success" }) {
  const { error } = await supa
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
  // Vercel cron sets this header automatically with CRON_SECRET env var.
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / no secret set — allow
  const auth = req.headers.get?.("authorization") || req.headers.authorization;
  return auth === `Bearer ${secret}`;
}
