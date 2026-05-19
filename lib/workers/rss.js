// RSS aggregator worker — Express-style handler (Vercel Node).
// Single worker handles all RSS feeds across all clients.

import { XMLParser } from "fast-xml-parser";
import { supa, startRun, finishRun, isAuthorizedCron } from "../supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../scoring.js";

// Single worker handles every RSS/Atom-shaped source.
// Each row carries its actual source_type for routing + provenance.
const RSS_SOURCE_TYPES = ["rss", "letterboxd_rss", "youtube_rss", "press_release_rss"];
const FETCH_TIMEOUT_MS = 8000;
const ITEM_MAX_AGE_DAYS = 14;
const USER_AGENT = "OBSOLETE-Signal-Pipeline/0.1 (+https://obsolete.systems)";

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

function normalizeItem(it, format) {
  if (format === "atom") {
    const link = Array.isArray(it.link)
      ? it.link.find(l => l["@_rel"] !== "self")?.["@_href"]
      : (it.link?.["@_href"] || it.link);
    const summary = typeof it.summary === "object" ? it.summary["#text"] : it.summary;
    const content = typeof it.content === "object" ? it.content["#text"] : it.content;
    return {
      title: typeof it.title === "object" ? it.title["#text"] : it.title,
      link: link || null,
      guid: it.id || link || null,
      pubDate: it.updated || it.published,
      description: summary || content || ""
    };
  }
  const guidObj = typeof it.guid === "object" ? it.guid["#text"] : it.guid;
  const desc = typeof it.description === "object" ? it.description["#text"] : it.description;
  return {
    title: typeof it.title === "object" ? it.title["#text"] : it.title,
    link: typeof it.link === "object" ? it.link["#text"] : it.link,
    guid: guidObj || it.link,
    pubDate: it.pubDate || it["dc:date"],
    description: desc || it["content:encoded"] || ""
  };
}

function detectFormat(parsed) {
  if (parsed?.rss?.channel) return { format: "rss", channel: parsed.rss.channel };
  if (parsed?.feed) return { format: "atom", channel: parsed.feed };
  if (parsed?.["rdf:RDF"]) return { format: "rss", channel: parsed["rdf:RDF"] };
  return null;
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function rssVelocity(occurredAt) {
  const ageDays = (Date.now() - new Date(occurredAt).getTime()) / 86_400_000;
  return Math.pow(0.5, Math.max(0, ageDays));
}

// Build the actual feed URL based on source_type — handles platforms where
// the target stored in client_sources is an ID/handle rather than a full URL.
function buildFeedUrl(src) {
  if (src.source === "youtube_rss") {
    // YouTube channel RSS: target is channel ID, construct full feed URL
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${src.target}`;
  }
  // rss, letterboxd_rss, press_release_rss — target is already a full URL
  return src.target;
}

async function processFeed(src, { clientId, agentId, byPillar, meta }) {
  const t0 = Date.now();
  const feedUrl = buildFeedUrl(src);
  const result = { target: src.target, feed_url: feedUrl, source_type: src.source, status: "unknown", ingested: 0, items_seen: 0, ms: 0 };
  try {
    const r = await fetchWithTimeout(feedUrl, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml" }
    });
    if (!r.ok) { result.status = `fetch_${r.status}`; return result; }
    const xml = await r.text();
    let parsed;
    try { parsed = xmlParser.parse(xml); }
    catch (e) { result.status = "parse_error"; result.error = e.message; return result; }
    const det = detectFormat(parsed);
    if (!det) { result.status = "format_unrecognized"; return result; }

    const items = det.format === "atom"
      ? (Array.isArray(det.channel.entry) ? det.channel.entry : (det.channel.entry ? [det.channel.entry] : []))
      : (Array.isArray(det.channel.item) ? det.channel.item : (det.channel.item ? [det.channel.item] : []));
    result.items_seen = items.length;

    const cutoff = Date.now() - ITEM_MAX_AGE_DAYS * 86_400_000;
    const upserts = [];

    for (const raw of items) {
      const item = normalizeItem(raw, det.format);
      if (!item.title || !item.link) continue;
      const pubMs = item.pubDate ? Date.parse(item.pubDate) : NaN;
      if (Number.isNaN(pubMs) || pubMs < cutoff) continue;

      const body = stripHtml(item.description).slice(0, 800);
      const fulltext = `${item.title} ${body}`;
      const tonal = scoreTonal(fulltext, byPillar);
      const bm = detectBrandMatch(fulltext, meta);

      if (tonal.score < 0.25 && !bm.brand_match && !bm.competitor_match) continue;

      upserts.push({
        client_id: clientId, source: src.source,
        source_id: `${src.source}:${src.target}:${item.guid || item.link}`,
        source_url: item.link, target: src.target,
        lane: src.lane, agent_id: agentId,
        occurred_at: new Date(pubMs).toISOString(),
        raw: { item: raw, feed_meta: src.meta || {}, feed_title: det.channel.title || src.target_display },
        title: item.title.slice(0, 500), body_excerpt: body.slice(0, 500),
        metric_score: rssVelocity(pubMs),
        client_tonal: tonal.score, pillar_hint: tonal.pillar,
        brand_match: bm.brand_match, competitor_match: bm.competitor_match,
        status: "fresh"
      });
    }

    if (upserts.length > 0) {
      const { error } = await supa().from("signals").upsert(upserts, { onConflict: "client_id,source,source_id" });
      if (error) { result.status = "upsert_error"; result.error = error.message; return result; }
      result.ingested = upserts.length;
    }
    result.status = "ok";
    return result;
  } catch (err) {
    result.status = "fetch_error";
    result.error = String(err.message || err);
    return result;
  } finally {
    result.ms = Date.now() - t0;
  }
}

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    if (!isAuthorizedCron(req)) return res.status(401).json({ error: "unauthorized" });

    const q = req.query || {};
    const limit = q.limit ? parseInt(q.limit, 10) : null;
    if (q.debug === "env") {
      return res.status(200).json({
        status: "debug_env_rss",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        source_types_handled: RSS_SOURCE_TYPES,
        node_version: process.version
      });
    }

    const summary = { clients: 0, agent_runs: 0, feeds_total: 0, feeds_processed: 0, ingested: 0, by_source_type: {}, per_feed: [], errors: [] };
    const { data: clients, error: cErr } = await supa().from("clients").select("id, name").eq("active", true);
    if (cErr) return res.status(500).json({ error: "clients_fetch_failed", details: cErr.message });

    outer:
    for (const client of clients || []) {
      summary.clients++;
      const { data: sources, error: sErr } = await supa()
        .from("client_sources")
        .select("source, target, target_display, lane, agent_id, meta")
        .eq("client_id", client.id).in("source", RSS_SOURCE_TYPES).eq("active", true);
      if (sErr) { summary.errors.push({ client: client.id, error: sErr.message }); continue; }
      if (!sources?.length) continue;
      summary.feeds_total += sources.length;

      const byPillar = await getClientKeywords(client.id);
      const meta = await getClientMeta(client.id);

      // Group by (agent_id, source_type) so telemetry attributes per (client, agent, source_type)
      const byAgentSource = new Map();
      for (const s of sources) {
        const key = `${s.agent_id}::${s.source}`;
        if (!byAgentSource.has(key)) byAgentSource.set(key, { agentId: s.agent_id, source: s.source, list: [] });
        byAgentSource.get(key).list.push(s);
      }

      for (const [key, group] of byAgentSource) {
        const { agentId, source: sourceType, list: agentSources } = group;
        summary.agent_runs++;
        const runId = await startRun({ clientId: client.id, agentId, source: sourceType });

        const remaining = limit ? Math.max(0, limit - summary.feeds_processed) : agentSources.length;
        const toProcess = agentSources.slice(0, remaining);

        const results = await Promise.all(toProcess.map(src =>
          processFeed(src, { clientId: client.id, agentId, byPillar, meta })
        ));

        summary.feeds_processed += results.length;
        summary.per_feed.push(...results.map(r => ({ ...r, client: client.id, agent: agentId })));

        const ingested = results.reduce((sum, r) => sum + (r.ingested || 0), 0);
        const errs = results.filter(r => r.status?.endsWith("_error") || r.status === "format_unrecognized")
          .map(r => ({ target: r.target, error: r.error || r.status }));
        summary.ingested += ingested;
        summary.by_source_type[sourceType] = (summary.by_source_type[sourceType] || 0) + ingested;
        if (errs.length) summary.errors.push(...errs.map(e => ({ ...e, client: client.id, agent: agentId, source_type: sourceType })));

        await finishRun(runId, {
          signalsIngested: ingested,
          signalsNew: ingested,
          signalsScored: results.reduce((s, r) => s + (r.items_seen || 0), 0),
          errors: errs,
          status: errs.length ? "partial" : "success"
        });

        if (limit && summary.feeds_processed >= limit) break outer;
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
