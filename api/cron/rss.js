// RSS aggregator worker — Stage 5 of the OBSOLETE Signal Pipeline.
//
// Single worker handles all RSS feeds across all clients. Each feed is one
// row in pipeline.client_sources where source = 'rss' and target = feed URL.
// Supports both RSS 2.0 and Atom feeds via fast-xml-parser.

import { XMLParser } from "fast-xml-parser";
import { supa, startRun, finishRun, isAuthorizedCron } from "../lib/supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../lib/scoring.js";

const SOURCE = "rss";
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

// Normalize an RSS/Atom entry into a flat shape
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
  // RSS 2.0
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
  if (parsed?.["rdf:RDF"]) {
    // RSS 1.0 (RDF)
    return { format: "rss", channel: parsed["rdf:RDF"] };
  }
  return null;
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// Recency-based velocity for RSS items (no engagement available)
// 1.0 for today, halves every 24 hours
function rssVelocity(occurredAt) {
  const ageDays = (Date.now() - new Date(occurredAt).getTime()) / 86_400_000;
  return Math.pow(0.5, Math.max(0, ageDays));
}

async function processFeed(src, { clientId, agentId, byPillar, meta }) {
  const t0 = Date.now();
  const result = { target: src.target, status: "unknown", ingested: 0, items_seen: 0, ms: 0 };

  try {
    const res = await fetchWithTimeout(src.target, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml" }
    });
    if (!res.ok) {
      result.status = `fetch_${res.status}`;
      return result;
    }
    const xml = await res.text();
    let parsed;
    try { parsed = xmlParser.parse(xml); }
    catch (e) {
      result.status = "parse_error";
      result.error = e.message;
      return result;
    }
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

      // Only ingest if there's signal — tonal match OR brand/competitor mention
      if (tonal.score < 0.25 && !bm.brand_match && !bm.competitor_match) continue;

      const source_id = `rss:${src.target}:${item.guid || item.link}`;
      upserts.push({
        client_id: clientId,
        source: SOURCE,
        source_id,
        source_url: item.link,
        target: src.target,
        lane: src.lane,
        agent_id: agentId,
        occurred_at: new Date(pubMs).toISOString(),
        raw: { item: raw, feed_meta: src.meta || {}, feed_title: det.channel.title || src.target_display },
        title: item.title.slice(0, 500),
        body_excerpt: body.slice(0, 500),
        metric_score: rssVelocity(pubMs),
        client_tonal: tonal.score,
        pillar_hint: tonal.pillar,
        brand_match: bm.brand_match,
        competitor_match: bm.competitor_match,
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { "Content-Type": "application/json" }
  });
}

export default async function handler(req) {
  const t0 = Date.now();
  try {
    if (!isAuthorizedCron(req)) return jsonResponse({ error: "unauthorized" }, 401);

    const url = new URL(req.url || "http://x/?", "http://x");
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit"), 10) : null;
    if (url.searchParams.get("debug") === "env") {
      return jsonResponse({ status: "debug_env_rss",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        node_version: process.version });
    }

    const summary = { clients: 0, agent_runs: 0, feeds_total: 0, feeds_processed: 0, ingested: 0, per_feed: [], errors: [] };

    const { data: clients, error: cErr } = await supa()
      .from("clients").select("id, name").eq("active", true);
    if (cErr) return jsonResponse({ error: "clients_fetch_failed", details: cErr.message }, 500);

    outer:
    for (const client of clients || []) {
      summary.clients++;
      const { data: sources, error: sErr } = await supa()
        .from("client_sources")
        .select("target, target_display, lane, agent_id, meta")
        .eq("client_id", client.id).eq("source", SOURCE).eq("active", true);
      if (sErr) { summary.errors.push({ client: client.id, error: sErr.message }); continue; }
      if (!sources?.length) continue;

      summary.feeds_total += sources.length;
      const byPillar = await getClientKeywords(client.id);
      const meta = await getClientMeta(client.id);

      const byAgent = new Map();
      for (const s of sources) {
        if (!byAgent.has(s.agent_id)) byAgent.set(s.agent_id, []);
        byAgent.get(s.agent_id).push(s);
      }

      for (const [agentId, agentSources] of byAgent) {
        summary.agent_runs++;
        const runId = await startRun({ clientId: client.id, agentId, source: SOURCE });

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
        if (errs.length) summary.errors.push(...errs.map(e => ({ ...e, client: client.id, agent: agentId })));

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
    return jsonResponse(summary);
  } catch (err) {
    return jsonResponse({
      error: "handler_threw",
      message: err.message || String(err),
      stack: (err.stack || "").split("\n").slice(0, 6),
      duration_ms: Date.now() - t0
    }, 500);
  }
}
