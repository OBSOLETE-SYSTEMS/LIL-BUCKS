// GDELT 2.0 worker — Stage 4 of the OBSOLETE Signal Pipeline.
//
// GDELT 2.0 is a global news + media database with 15-min refresh cadence.
// We query it for (a) theme-coded events (ENTERTAINMENT, CELEBRITY, etc.)
// and (b) brand/competitor mention overlays. Both via the same Doc API.
//
// GDELT Doc API: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
//   https://api.gdeltproject.org/api/v2/doc/doc?query=<TERM>&mode=ArtList&format=json

import { supa, startRun, finishRun, isAuthorizedCron } from "../lib/supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../lib/scoring.js";

const SOURCE = "gdelt";
const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "OBSOLETE-Signal-Pipeline/0.1 (+https://obsolete.systems)";
const MAX_ARTICLES = 50;

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

// Build a GDELT Doc API query from a watchlist source.
// Three modes:
//   1. meta.query_terms array → OR them together as a keyword query
//   2. target looks like a theme code (UPPER_SNAKE) → theme:TARGET
//   3. otherwise → literal phrase search
function buildQuery(src) {
  if (src.meta?.query_terms?.length) {
    const terms = src.meta.query_terms.map(t => `"${t}"`).join(" OR ");
    return `(${terms})`;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(src.target)) {
    return `theme:${src.target}`;
  }
  return `"${src.target}"`;
}

function parseGdeltDate(s) {
  // GDELT uses 20260518T143000Z format
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

// Recency-based velocity for GDELT articles
function gdeltVelocity(occurredAt) {
  const ageHours = (Date.now() - new Date(occurredAt).getTime()) / 3_600_000;
  return Math.max(0.1, Math.pow(0.7, ageHours / 24));
}

async function processSource(src, { clientId, agentId, byPillar, meta }) {
  const t0 = Date.now();
  const result = { target: src.target, status: "unknown", ingested: 0, articles_seen: 0, ms: 0 };

  try {
    const query = buildQuery(src);
    const url = `https://api.gdeltproject.org/api/v2/doc/doc` +
      `?query=${encodeURIComponent(query)}` +
      `&mode=ArtList&format=json&maxrecords=${MAX_ARTICLES}&sort=DateDesc`;

    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }
    });
    if (!res.ok) {
      result.status = `fetch_${res.status}`;
      return result;
    }

    // GDELT sometimes returns HTML on error/empty
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      result.status = "non_json_response";
      return result;
    }

    const articles = parsed?.articles || [];
    result.articles_seen = articles.length;
    const upserts = [];

    for (const art of articles) {
      if (!art.url || !art.title) continue;
      const occurredAt = parseGdeltDate(art.seendate);
      if (!occurredAt) continue;

      const body = `${art.domain || ""} · ${art.sourcecountry || ""} · ${art.language || ""}`;
      const fulltext = `${art.title} ${body}`;
      const tonal = scoreTonal(fulltext, byPillar);
      const bm = detectBrandMatch(art.title, meta);

      // GDELT signal gate: tonal match OR brand mention (skip pure noise)
      if (tonal.score < 0.2 && !bm.brand_match && !bm.competitor_match) continue;

      // Dedup by URL — same article from multiple queries hits the same row
      const source_id = `gdelt:${art.url}`;
      upserts.push({
        client_id: clientId,
        source: SOURCE,
        source_id,
        source_url: art.url,
        target: src.target,
        lane: src.lane,
        agent_id: agentId,
        occurred_at: occurredAt.toISOString(),
        raw: { article: art, query, target_meta: src.meta || {} },
        title: art.title.slice(0, 500),
        body_excerpt: body.slice(0, 500),
        metric_score: gdeltVelocity(occurredAt),
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
      return jsonResponse({ status: "debug_env_gdelt",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        node_version: process.version });
    }

    const summary = { clients: 0, agent_runs: 0, sources_total: 0, sources_processed: 0, ingested: 0, per_source: [], errors: [] };

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

      summary.sources_total += sources.length;
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

        const remaining = limit ? Math.max(0, limit - summary.sources_processed) : agentSources.length;
        const toProcess = agentSources.slice(0, remaining);

        const results = await Promise.all(toProcess.map(src =>
          processSource(src, { clientId: client.id, agentId, byPillar, meta })
        ));

        summary.sources_processed += results.length;
        summary.per_source.push(...results.map(r => ({ ...r, client: client.id, agent: agentId })));
        const ingested = results.reduce((s, r) => s + (r.ingested || 0), 0);
        const errs = results.filter(r => r.status?.endsWith("_error") || r.status === "non_json_response")
          .map(r => ({ target: r.target, error: r.error || r.status }));
        summary.ingested += ingested;
        if (errs.length) summary.errors.push(...errs.map(e => ({ ...e, client: client.id, agent: agentId })));

        await finishRun(runId, {
          signalsIngested: ingested,
          signalsNew: ingested,
          signalsScored: results.reduce((s, r) => s + (r.articles_seen || 0), 0),
          errors: errs,
          status: errs.length ? "partial" : "success"
        });

        if (limit && summary.sources_processed >= limit) break outer;
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
