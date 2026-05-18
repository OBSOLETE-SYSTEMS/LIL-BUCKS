// Minimal Vercel function test — no imports, no I/O, no Supabase.
// If this works but /api/cron/wikipedia doesn't, the bug is in wikipedia.js.
// If this doesn't work either, the Vercel deployment itself is broken.

export default function handler(req) {
  return new Response(JSON.stringify({
    status: "ping_ok",
    timestamp: new Date().toISOString(),
    url: req.url || null,
    method: req.method || null,
    node_version: process.version,
    region: process.env.VERCEL_REGION || null,
    deployment_id: process.env.VERCEL_DEPLOYMENT_ID || null,
    deployment_url: process.env.VERCEL_URL || null
  }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
