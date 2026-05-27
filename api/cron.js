// Cron dispatcher — Vercel-friendly single endpoint.
//
// Each worker lives in /lib/workers/. They're imported here and routed
// based on ?worker=NAME. This keeps us under Vercel Hobby's 12-function
// project cap while still running 9+ independent ingest workers on
// staggered cron schedules.
//
// Usage:
//   /api/cron?worker=wikipedia           → run Wikipedia worker
//   /api/cron?worker=rss&limit=2         → run RSS worker, limited
//   /api/cron?worker=wikipedia&debug=env → diagnostic
//   /api/cron                            → return list of available workers

import wikipedia       from "../lib/workers/wikipedia.js";
import rss             from "../lib/workers/rss.js";
import gdelt           from "../lib/workers/gdelt.js";
import apple_podcasts  from "../lib/workers/apple_podcasts.js";
import spotify         from "../lib/workers/spotify.js";
import reddit          from "../lib/workers/reddit.js";
import meta_ad_library from "../lib/workers/meta_ad_library.js";
import google_trends   from "../lib/workers/google_trends.js";
import google_trends_iot from "../lib/workers/google_trends_iot.js";
import tiktok_cc       from "../lib/workers/tiktok_cc.js";
import pinterest       from "../lib/workers/pinterest.js";

const WORKERS = {
  wikipedia,
  rss,
  gdelt,
  apple_podcasts,
  spotify,
  reddit,
  meta_ad_library,
  google_trends,
  google_trends_iot,
  tiktok_cc,
  pinterest
};

export default async function handler(req, res) {
  const worker = req.query?.worker;
  if (!worker) {
    return res.status(200).json({
      status: "cron_dispatcher_ready",
      available_workers: Object.keys(WORKERS),
      usage: "GET /api/cron?worker={name} — optionally append &limit=N or &debug=env"
    });
  }
  const fn = WORKERS[worker];
  if (!fn) {
    return res.status(400).json({
      error: "unknown_worker",
      requested: worker,
      available: Object.keys(WORKERS)
    });
  }
  return fn(req, res);
}
