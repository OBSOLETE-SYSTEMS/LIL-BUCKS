// Google Trends worker — Express-style, no auth, AGGRESSIVE INGEST.
//
// v2 approach: instead of only ingesting trending terms that MATCH a watchlist
// target, we fetch the broad daily-trends-for-each-region feed and ingest
// EVERY trending term that scores tonal >= 0.15 OR matches a brand/competitor
// term. This converts Google Trends into a discovery surface (what is the
// audience asking that overlaps our vocab) instead of just a tracker.

import { XMLParser } from "fast-xml-parser";
import { supa, startRun, finishRun, isAuthorizedCron } from "../supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../scoring.js";

const SOURCE = "google_trends";
const FETCH_TIMEOUT_MS = 8000;
const MIN_TONAL_SCORE = 0.15;  // lower than per-source workers — discovery mode

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false
});

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchDailyTrends(geo = "US") {
  const url = `https://trends.google.com/trending/rss?geo=${geo}`;
  const r = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "OBSOLETE-Signal-Pipeline/0.1 (+https://obsolete.systems)",
      "Accept": "application/rss+xml, application/xml, text/xml"
    }
  });
  if (!r.ok) throw new Error(`Google Trends RSS ${r.status} for geo=${geo}`);
  const xml = await r.text();
  const parsed = xmlParser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];
  return Array.isArray(items) ? items : [items];
}

function trafficVelocity(trafficLabel) {
  if (!trafficLabel) return 0.5;
  const m = String(trafficLabel).match(/(\d+)([KM]?)\+?/);
  if (!m) return 0.5;
  const n = parseInt(m[1], 10);
  const mult = m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1;
  const raw = n * mult;
  return Math.min(2.0, Math.log10(Math.max(raw, 1000)) / 5);
}

// Find which watchlist target (if any) overlaps with this trending term
function findOverlappingWatchlistTarget(trendingTitle, watchlistSources) {
  const lower = (trendingTitle || "").toLowerCase();
  for (const s of watchlistSources) {
    const t = (s.target || "").toLowerCase();
    if (!t) continue;
    if (lower.includes(t) || t.includes(lower)) return s;
  }
  return null;
}

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    if (!isAuthorizedCron(req)) return res.status(401).json({ error: "unauthorized" });

    const q = req.query || {};
    if (q.debug === "env") {
      return res.status(200).json({
        status: "debug_env_google_trends",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        mode: "aggressive_v2 — ingest all trending terms passing tonal/brand gate",
        min_tonal_threshold: MIN_TONAL_SCORE,
        node_version: process.version
      });
    }

    const summary = { clients: 0, agent_runs: 0, sources_total: 0, trending_terms_total: 0, ingested: 0, per_geo: {}, errors: [] };

    const { data: clients, error: cErr } = await supa().from("clients").select("id, name").eq("active", true);
    if (cErr) return res.status(500).json({ error: "clients_fetch_failed", details: cErr.message });

    const trendsByGeo = new Map();

    for (const client of clients || []) {
      summary.clients++;
      const { data: sources, error: sErr } = await supa()
        .from("client_sources")
        .select("target, target_display, lane, agent_id, meta")
        .eq("client_id", client.id).eq("source", SOURCE).eq("active", true);
      if (sErr) { summary.errors.push({ client: client.id, error: sErr.message }); continue; }
      if (!sources?.length) continue;
      summary.sources_total += sources.length;

      const byPillar = await getClientKeywords(client.id);
      const meta = await getClientMeta(client.id);

      const geos = new Set();
      for (const s of sources) geos.add((s.meta?.geo || "US").toUpperCase());

      for (const geo of geos) {
        try {
          if (!trendsByGeo.has(geo)) trendsByGeo.set(geo, await fetchDailyTrends(geo));
        } catch (err) {
          summary.errors.push({ geo, error: String(err.message || err) });
          trendsByGeo.set(geo, []);
        }
      }

      // Pick a default agent for unmatched-but-relevant trending terms
      const defaultAgent = sources[0]?.agent_id || "pulse";
      const defaultLane = sources[0]?.lane || "CULTURAL";

      // Group sources by agent
      const byAgent = new Map();
      for (const s of sources) {
        if (!byAgent.has(s.agent_id)) byAgent.set(s.agent_id, []);
        byAgent.get(s.agent_id).push(s);
      }

      for (const [agentId, agentSources] of byAgent) {
        summary.agent_runs++;
        const runId = await startRun({ clientId: client.id, agentId, source: SOURCE });
        const upserts = [];
        let scored = 0;
        let termsSeen = 0;

        for (const geo of geos) {
          const trends = trendsByGeo.get(geo) || [];
          summary.per_geo[geo] = (summary.per_geo[geo] || 0) + 1;

          for (const item of trends) {
            const title = typeof item.title === "object" ? item.title["#text"] : item.title;
            if (!title) continue;
            termsSeen++;

            // Look for watchlist overlap within THIS agent's sources only
            const overlap = findOverlappingWatchlistTarget(title, agentSources);
            // Only the default agent acts as the "general bucket" for unmatched-but-relevant terms
            const isOwnedByThisAgent = overlap || agentId === defaultAgent;
            if (!isOwnedByThisAgent) continue;

            const tonal = scoreTonal(title, byPillar);
            const bm = detectBrandMatch(title, meta);
            scored++;

            // AGGRESSIVE GATE — any of these qualifies:
            //   (a) overlap with a watchlist target
            //   (b) tonal score >= 0.15 (broad keyword vocab match)
            //   (c) brand_match OR competitor_match
            if (!overlap && tonal.score < MIN_TONAL_SCORE && !bm.brand_match && !bm.competitor_match) continue;

            const trafficNode = item["ht:approx_traffic"];
            const traffic = typeof trafficNode === "object" ? trafficNode["#text"] : trafficNode;
            const velocity = trafficVelocity(traffic);
            const pubMs = item.pubDate ? Date.parse(item.pubDate) : Date.now();
            const lane = overlap?.lane || defaultLane;
            const target = overlap?.target || `trending:${geo}`;

            upserts.push({
              client_id: client.id, source: SOURCE,
              source_id: `google_trends:${geo}:${title}:${new Date(pubMs).toISOString().slice(0,10)}`,
              source_url: typeof item.link === "object" ? item.link["#text"] : item.link,
              target, lane, agent_id: agentId,
              occurred_at: new Date(pubMs).toISOString(),
              raw: { item, geo, traffic, overlap_target: overlap?.target || null, watchlist_match: !!overlap },
              title: title.slice(0, 500),
              body_excerpt: (typeof item.description === "object" ? item.description["#text"] : item.description || "").slice(0, 500),
              metric_score: velocity,
              client_tonal: tonal.score,
              pillar_hint: tonal.pillar,
              brand_match: bm.brand_match,
              competitor_match: bm.competitor_match,
              status: "fresh"
            });
          }
        }

        const deduped = Array.from(new Map(upserts.map(u => [u.source_id, u])).values());
        summary.trending_terms_total = Math.max(summary.trending_terms_total, termsSeen);
        let ingested = 0;
        if (deduped.length > 0) {
          const { error } = await supa().from("signals").upsert(deduped, { onConflict: "client_id,source,source_id" });
          if (error) summary.errors.push({ client: client.id, agent: agentId, error: error.message });
          else ingested = deduped.length;
        }
        summary.ingested += ingested;

        await finishRun(runId, {
          signalsIngested: ingested,
          signalsNew: ingested,
          signalsScored: scored,
          errors: [],
          status: "success"
        });
      }
    }

    summary.duration_ms = Date.now() - t0;
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(500).json({
      error: "handler_threw",
      message: err.message || String(err),
      stack: (err.stack || "").split("\n").slice(0, 6),
      duration_ms: Date.now() - t0
    });
  }
}
