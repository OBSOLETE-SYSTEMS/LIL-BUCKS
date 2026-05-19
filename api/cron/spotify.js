// Spotify Charts worker — Express-style.
//
// Requires Spotify Web API Client Credentials (free):
//   1. https://developer.spotify.com/dashboard → Create app
//   2. Copy Client ID + Client Secret
//   3. Add to Vercel env: SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET
//
// Each watchlist source = one playlist ID (e.g., Top 50 USA = 37i9dQZEVXbLp5XoPON0wI).
// We fetch the playlist's tracks, score each title + artist against client keywords,
// and upsert as signals.

import { supa, startRun, finishRun, isAuthorizedCron } from "../../lib/supabase.js";
import { getClientKeywords, scoreTonal, getClientMeta, detectBrandMatch } from "../../lib/scoring.js";

const SOURCE = "spotify_charts";
const FETCH_TIMEOUT_MS = 8000;
const TRACKS_LIMIT = 50;

let _token = null;
let _tokenExpiresAt = 0;

async function getSpotifyToken() {
  if (_token && Date.now() < _tokenExpiresAt - 60_000) return _token;
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("Missing SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET env vars. Register a free Spotify app at developer.spotify.com/dashboard and add the credentials in Vercel.");
  }
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Spotify token request failed (${r.status}): ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  _token = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return _token;
}

async function fetchPlaylistTracks(playlistId, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${TRACKS_LIMIT}&fields=items(added_at,track(id,name,artists(name),album(name,release_date),external_urls.spotify))`;
    const r = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}` },
      signal: ctrl.signal
    });
    if (!r.ok) {
      if (r.status === 404) return null;
      throw new Error(`Spotify playlist ${r.status} for ${playlistId}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function rankVelocity(rank, total = TRACKS_LIMIT) {
  return Math.max(0.02, 1 - (rank - 1) / total);
}

async function processSource(src, { clientId, agentId, byPillar, meta, token }) {
  const t0 = Date.now();
  const result = { target: src.target, status: "unknown", ingested: 0, items_seen: 0, ms: 0 };
  try {
    const tracks = await fetchPlaylistTracks(src.target, token);
    if (!tracks?.items) { result.status = "no_data"; return result; }
    result.items_seen = tracks.items.length;

    const chartDate = new Date().toISOString().slice(0, 10);
    const upserts = [];

    tracks.items.forEach((item, i) => {
      const rank = i + 1;
      const t = item?.track;
      if (!t?.id || !t.name) return;
      const artists = (t.artists || []).map(a => a.name).filter(Boolean).join(", ");
      const url = t.external_urls?.spotify;

      const fulltext = `${t.name} ${artists} ${t.album?.name || ""}`;
      const tonal = scoreTonal(fulltext, byPillar);
      const bm = detectBrandMatch(fulltext, meta);

      // Chart signal gate: tonal hit OR brand mention OR top-5 rank
      if (tonal.score < 0.2 && !bm.brand_match && !bm.competitor_match && rank > 5) return;

      const source_id = `spotify:${t.id}:${src.target}:${chartDate}`;
      upserts.push({
        client_id: clientId, source: SOURCE,
        source_id, source_url: url,
        target: src.target, lane: src.lane, agent_id: agentId,
        occurred_at: item.added_at || new Date().toISOString(),
        raw: { track: t, rank, playlist_id: src.target, chart_meta: src.meta || {} },
        title: `${t.name} · ${artists} · rank ${rank} on ${src.target_display || src.target}`.slice(0, 500),
        body_excerpt: (t.album?.name || "").slice(0, 500),
        metric_score: rankVelocity(rank, tracks.items.length || TRACKS_LIMIT),
        client_tonal: tonal.score,
        pillar_hint: tonal.pillar,
        brand_match: bm.brand_match,
        competitor_match: bm.competitor_match,
        status: "fresh"
      });
    });

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
    if (q.debug === "env") {
      return res.status(200).json({
        status: "debug_env_spotify",
        SUPABASE_URL_set: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        SPOTIFY_CLIENT_ID_set: !!process.env.SPOTIFY_CLIENT_ID,
        SPOTIFY_CLIENT_SECRET_set: !!process.env.SPOTIFY_CLIENT_SECRET,
        spotify_ready: !!process.env.SPOTIFY_CLIENT_ID && !!process.env.SPOTIFY_CLIENT_SECRET,
        node_version: process.version
      });
    }
    const limit = q.limit ? parseInt(q.limit, 10) : null;

    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
      return res.status(503).json({
        status: "spotify_credentials_missing",
        message: "Register a free app at developer.spotify.com/dashboard, add SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET to Vercel env."
      });
    }

    let token;
    try { token = await getSpotifyToken(); }
    catch (err) { return res.status(500).json({ status: "spotify_auth_failed", error: err.message }); }

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
          processSource(src, { clientId: client.id, agentId, byPillar, meta, token })
        ));

        summary.sources_processed += results.length;
        summary.per_source.push(...results.map(r => ({ ...r, client: client.id, agent: agentId })));

        const ingested = results.reduce((s, r) => s + (r.ingested || 0), 0);
        const errs = results.filter(r => r.status?.endsWith("_error"))
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
