// GDELT 2.0 worker — Express-style handler (Vercel Node).

import { supa, startRun, finishRun, isAuthorizedCron } from "../supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../scoring.js";

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

function buildQuery(src) {
  if (src.meta?.query_terms?.length) {
    const terms = src.meta.query_terms.map(t => `"${t}"`).join(" OR ");
    return `(${terms})`;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(src.target)) return `theme:${src.target}`;
  return `"${src.target}"`;
}

function parseGdeltDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

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

    const r = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }
    });
    if (!r.ok) { result.status = `fetch_${r.status}`; return result; }

    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { result.status = "non_json_response"; return result; }

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

      if (tonal.score < 0.2 && !bm.brand_match && !bm.competitor_match) continue;

      upserts.push({
        client_id: clientId, source: SOURCE,
        source_id: `gdelt:${art.url}`,
        source_url: art.url, target: src.target,
        lane: src.lane, agent_id: agentId,
        occurred_at: occurredAt.toISOString(),
        raw: { article: art, query, target_meta: src.meta || {} },
        title: art.title.slice(0, 500), body_excerpt: body.slice(0, 500),
        metric_score: gdeltVelocity(occurredAt),
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
        status: "debug_env_gdelt",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        node_version: process.version
      });
    }

    const summary = { clients: 0, agent_runs: 0, sources_total: 0, sources_processed: 0, ingested: 0, per_source: [], errors: [] };
    const { data: clients, error: cErr } = await supa().from("clients").select("id, name").eq("active", true);
    if (cErr) return res.status(500).json({ error: "clients_fetch_failed", details: cErr.message });

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
