// Google Trends worker — Express-style, no auth.
//
// Uses Google's public Daily Trends RSS endpoint to fetch what's trending
// in a region today, then cross-references with the client's watchlist terms.
// For interest-over-time on specific terms, would need the (undocumented)
// explore endpoint with a CSRF token dance — deferred for V2.5.
//
// Daily Trends RSS: https://trends.google.com/trending/rss?geo=US
// Returns top trending search queries in the region as RSS items.
//
// What we ingest: every trending term that either (a) matches the client's
// keyword vocabulary OR (b) overlaps with a brand/competitor term OR
// (c) overlaps with a Google Trends watchlist target on the client.

import { XMLParser } from "fast-xml-parser";
import { supa, startRun, finishRun, isAuthorizedCron } from "../../lib/supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../../lib/scoring.js";

const SOURCE = "google_trends";
const FETCH_TIMEOUT_MS = 8000;

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

// Fetch daily trends RSS for a region. Region is from src.meta.geo, default US.
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

// Velocity based on traffic estimate from the feed (e.g., "20K+", "100K+", "1M+")
function trafficVelocity(trafficLabel) {
  if (!trafficLabel) return 0.5;
  const m = String(trafficLabel).match(/(\d+)([KM]?)\+?/);
  if (!m) return 0.5;
  const n = parseInt(m[1], 10);
  const mult = m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1;
  const raw = n * mult;
  // Normalize: 100K = 1.0, 1M = 1.5, 10M = 2.0
  return Math.min(2.0, Math.log10(Math.max(raw, 1000)) / 5);
}

// Match Google Trends item against the client's watchlist terms (case-insensitive substring)
function matchesWatchlistTerm(itemTitle, watchlistTerms) {
  const lower = (itemTitle || "").toLowerCase();
  return watchlistTerms.find(t => lower.includes(t.toLowerCase()) || t.toLowerCase().includes(lower)) || null;
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
        node_version: process.version
      });
    }

    const summary = { clients: 0, agent_runs: 0, sources_total: 0, ingested: 0, per_geo: {}, errors: [] };

    const { data: clients, error: cErr } = await supa().from("clients").select("id, name").eq("active", true);
    if (cErr) return res.status(500).json({ error: "clients_fetch_failed", details: cErr.message });

    // Cache trends by geo so multiple clients querying same region only hit Google once
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

      // Collect every term the client watches as a Google Trends term
      const watchlistTerms = sources.map(s => s.target);
      const lookupBySrcTarget = new Map(sources.map(s => [s.target.toLowerCase(), s]));

      // Build set of geos to fetch (default US if not specified)
      const geos = new Set();
      for (const s of sources) geos.add((s.meta?.geo || "US").toUpperCase());

      // Fetch trends per geo (cached)
      for (const geo of geos) {
        try {
          if (!trendsByGeo.has(geo)) trendsByGeo.set(geo, await fetchDailyTrends(geo));
        } catch (err) {
          summary.errors.push({ geo, error: String(err.message || err) });
          trendsByGeo.set(geo, []);
        }
      }

      // Group sources by agent for telemetry
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

        for (const src of agentSources) {
          const geo = (src.meta?.geo || "US").toUpperCase();
          const trends = trendsByGeo.get(geo) || [];
          summary.per_geo[geo] = (summary.per_geo[geo] || 0) + 1;

          for (const item of trends) {
            const title = typeof item.title === "object" ? item.title["#text"] : item.title;
            if (!title) continue;
            // For this client+agent's source, does this trending item match?
            const isWatchlist = matchesWatchlistTerm(title, [src.target]);
            const tonal = scoreTonal(title, byPillar);
            const bm = detectBrandMatch(title, meta);
            scored++;

            if (!isWatchlist && tonal.score < 0.3 && !bm.brand_match && !bm.competitor_match) continue;

            const trafficNode = item["ht:approx_traffic"];
            const traffic = typeof trafficNode === "object" ? trafficNode["#text"] : trafficNode;
            const velocity = trafficVelocity(traffic);
            const pubMs = item.pubDate ? Date.parse(item.pubDate) : Date.now();
            const source_id = `google_trends:${geo}:${title}:${new Date(pubMs).toISOString().slice(0,10)}`;

            upserts.push({
              client_id: client.id, source: SOURCE,
              source_id,
              source_url: typeof item.link === "object" ? item.link["#text"] : item.link,
              target: src.target, lane: src.lane, agent_id: agentId,
              occurred_at: new Date(pubMs).toISOString(),
              raw: { item, geo, watchlist_match: src.target, traffic },
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

        // Dedup upserts by source_id within this run (a term could match multiple sources)
        const deduped = Array.from(new Map(upserts.map(u => [u.source_id, u])).values());
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
