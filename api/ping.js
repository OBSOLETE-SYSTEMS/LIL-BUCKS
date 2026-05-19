// Minimal Vercel function test — Express-style handler.
// If THIS works but the Web API style versions don't, we'll
// refactor all the workers + API endpoints to Express style.

export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.status(200).end(JSON.stringify({
    status: "ping_ok_express",
    timestamp: new Date().toISOString(),
    url: req.url || null,
    method: req.method || null,
    node_version: process.version,
    region: process.env.VERCEL_REGION || null
  }, null, 2));
}
