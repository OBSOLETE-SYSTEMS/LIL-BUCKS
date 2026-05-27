// Google Trends · Interest-Over-Time worker (multi-tenant)
//
// Companion to google_trends.js (which pulls the daily-trending RSS list).
// This worker queries Google Trends Explore API for EACH client's watched
// keyword, fetches the past 7 days of interest-over-time data, computes
// velocity (today vs. 7-day rolling avg), and surfaces a signal when
// the term is spiking.
//
// Why both workers:
//   - daily-trending catches broad cultural waves (Trump · NBA Finals · etc.)
//   - interest-over-time catches NICHE-VOCAB spikes — "lentil dip" or
//     "snackle box" trending in food-shopper search even when they never
//     hit the national trending list.
//
// Endpoints (unauthenticated public Google Trends widget API):
//   1. POST-ish to /trends/api/explore — returns widget tokens
//   2. GET /trends/api/widgetdata/multiline?token=... — returns time-series
//
// Google returns text-prefixed JSON: ")]}',\n{actual json}"
//
// Rate-pacing: 350ms between requests + 2 requests per term = ~700ms/term.
// For ~30 terms per client × 3 clients = ~90 terms × 700ms = ~63s per run.
// Cron schedule: once daily at 11 UTC (7am ET).
//
// Source_id format: `gt_iot:{geo}:{term}:{YYYY-MM-DD}` so signals from this
// worker dedupe per day per term per geo, separate from daily-trends signals.

import { supa, startRun, finishRun, isAuthorizedCron } from "../supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../scoring.js";

const SOURCE = "google_trends";  // shared source-type with daily-trending worker; distinguished by source_id prefix
const SOURCE_ID_PREFIX = "gt_iot";
const FETCH_TIMEOUT_MS = 12000;
const REQUEST_DELAY_MS = 350;
const VELOCITY_THRESHOLD = 1.3;  // 30% above 7-day rolling average = "spiking"
const TRENDS_PREFIX = ")]}',\n";

// Browser-style UA — Google Trends widget API blocks "good citizen" UA strings from cloud IPs
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

function parseTrendsResponse(text) {
  if (text.startsWith(TRENDS_PREFIX)) {
    return JSON.parse(text.slice(TRENDS_PREFIX.length));
  }
  return JSON.parse(text);
}

async function fetchExplore(term, geo = "US") {
  const req = {
    comparisonItem: [{ keyword: term, geo, time: "now 7-d" }],
    category: 0,
    property: ""
  };
  const url = `https://trends.google.com/trends/api/explore?hl=en-US&tz=-300&req=${encodeURIComponent(JSON.stringify(req))}&geo=${geo}`;
  const r = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://trends.google.com/"
    }
  });
  if (!r.ok) throw new Error(`Trends explore HTTP ${r.status}`);
  const text = await r.text();
  return parseTrendsResponse(text);
}

async function fetchTimeSeries(token, widgetRequest) {
  const url = `https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=-300&req=${encodeURIComponent(JSON.stringify(widgetRequest))}&token=${token}`;
  const r = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://trends.google.com/"
    }
  });
  if (!r.ok) throw new Error(`Trends widgetdata HTTP ${r.status}`);
  const text = await r.text();
  return parseTrendsResponse(text);
}

async function getInterestOverTime(term, geo = "US") {
  const explore = await fetchExplore(term, geo);
  const widgets = explore?.widgets || [];
  const tsWidget = widgets.find(w => w.id === "TIMESERIES");
  if (!tsWidget?.token || !tsWidget?.request) return null;

  await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));

  const ts = await fetchTimeSeries(tsWidget.token, tsWidget.request);
  const timeline = ts?.default?.timelineData || [];
  return timeline.map(t => ({
    time: t.time,
    formattedTime: t.formattedTime,
    value: Array.isArray(t.value) ? (t.value[0] || 0) : 0
  }));
}

function computeVelocity(timeline) {
  if (!timeline || timeline.length < 3) return null;
  const today = timeline[timeline.length - 1];
  const prior = timeline.slice(0, -1);
  const avg = prior.reduce((s, t) => s + t.value, 0) / Math.max(prior.length, 1);
  if (avg === 0) return null;
  return {
    todayValue: today.value,
    priorAvg: avg,
    velocity: today.value / avg,
    pointCount: timeline.length
  };
}

async function processClient(client, summary, optionalLimit = null) {
  const { data: sources, error: sErr } = await supa()
    .from("client_sources")
    .select("target, target_display, lane, agent_id, meta")
    .eq("client_id", client.id).eq("source", SOURCE).eq("active", true);
  if (sErr) { summary.errors.push({ client: client.id, error: sErr.message }); return; }
  if (!sources?.length) return;

  summary.clients++;

  const meta = await getClientMeta(client.id);
  const byPillar = await getClientKeywords(client.id);
  const upserts = [];

  // Optional limit (for debugging) — process only N sources per client
  const toProcess = optionalLimit ? sources.slice(0, optionalLimit) : sources;
  summary.sources_total += toProcess.length;

  // Start a run record for telemetry
  const runId = await startRun({ clientId: client.id, agentId: toProcess[0]?.agent_id, source: SOURCE });

  for (const src of toProcess) {
    const term = src.target;
    const geo = src.meta?.geo || "US";

    try {
      const timeline = await getInterestOverTime(term, geo);
      summary.terms_processed++;

      const v = computeVelocity(timeline);
      if (!v) {
        summary.terms_no_data++;
        continue;
      }

      if (v.velocity < VELOCITY_THRESHOLD) {
        summary.terms_below_threshold++;
        continue;
      }

      // Spiking term — surface as signal
      const tonal = scoreTonal(term, byPillar);
      const bm = detectBrandMatch(term, meta);
      const today = new Date().toISOString().slice(0, 10);
      const sourceId = `${SOURCE_ID_PREFIX}:${geo}:${term}:${today}`;

      upserts.push({
        client_id: client.id,
        source: SOURCE,
        source_id: sourceId,
        source_url: `https://trends.google.com/trends/explore?q=${encodeURIComponent(term)}&geo=${geo}&date=now%207-d`,
        target: term,
        lane: src.lane,
        agent_id: src.agent_id,
        occurred_at: new Date().toISOString(),
        raw: { term, geo, timeline, velocity: v.velocity, todayValue: v.todayValue, priorAvg: v.priorAvg },
        title: `Interest spike · "${term}" (${geo})`,
        body_excerpt: `Search interest spiking — today's value ${v.todayValue} vs. 7-day avg ${v.priorAvg.toFixed(1)} (${v.velocity.toFixed(2)}× baseline)`,
        metric_score: Math.min(2.0, v.velocity),
        client_tonal: tonal.score,
        pillar_hint: tonal.pillar,
        brand_match: bm.brand_match,
        competitor_match: bm.competitor_match,
        status: "fresh"
      });
      summary.terms_spiking++;

    } catch (e) {
      summary.errors.push({ client: client.id, term, error: e.message.slice(0, 200) });
    }

    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
  }

  let ingested = 0;
  if (upserts.length > 0) {
    const { error: upErr } = await supa().from("signals").upsert(upserts, { onConflict: "client_id,source,source_id" });
    if (upErr) summary.errors.push({ client: client.id, upsertError: upErr.message });
    else ingested = upserts.length;
  }
  summary.signals_ingested += ingested;

  await finishRun(runId, {
    signalsIngested: ingested,
    signalsNew: ingested,
    signalsScored: summary.terms_processed,
    errors: summary.errors.filter(e => e.client === client.id)
  });
}

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    if (!isAuthorizedCron(req)) return res.status(401).json({ error: "unauthorized" });

    const q = req.query || {};
    if (q.debug === "env") {
      return res.status(200).json({
        status: "debug_env_google_trends_iot",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        mode: "interest-over-time per watched term · velocity-spike detection",
        velocity_threshold: VELOCITY_THRESHOLD,
        request_delay_ms: REQUEST_DELAY_MS,
        node_version: process.version
      });
    }

    const summary = {
      clients: 0,
      sources_total: 0,
      terms_processed: 0,
      terms_spiking: 0,
      terms_below_threshold: 0,
      terms_no_data: 0,
      signals_ingested: 0,
      errors: []
    };

    const { data: clients, error: cErr } = await supa().from("clients").select("id, name").eq("active", true);
    if (cErr) return res.status(500).json({ error: "clients_fetch_failed", details: cErr.message });

    const onlyClient = q.client || null;
    const limitPerClient = q.limit ? parseInt(q.limit, 10) : null;

    const clientsToProcess = onlyClient
      ? (clients || []).filter(c => c.id === onlyClient)
      : (clients || []);

    for (const client of clientsToProcess) {
      await processClient(client, summary, limitPerClient);
    }

    summary.duration_ms = Date.now() - t0;
    return res.status(200).json(summary);

  } catch (e) {
    return res.status(500).json({
      error: "google_trends_iot_failed",
      message: e.message,
      duration_ms: Date.now() - t0
    });
  }
}
