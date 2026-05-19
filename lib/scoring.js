// Generic scoring helpers — client-agnostic.

import { supa } from "./supabase.js";

// ---------- Client-tonal scoring ----------

const keywordCache = new Map();

export async function getClientKeywords(clientId) {
  if (keywordCache.has(clientId)) return keywordCache.get(clientId);
  const { data, error } = await supa()
    .from("client_keywords")
    .select("pillar, keyword, weight")
    .eq("client_id", clientId);
  if (error) throw error;
  const byPillar = {};
  for (const row of data || []) {
    (byPillar[row.pillar] ||= []).push({
      keyword: row.keyword.toLowerCase(),
      weight: Number(row.weight) || 1.0
    });
  }
  keywordCache.set(clientId, byPillar);
  return byPillar;
}

export function scoreTonal(text, byPillar) {
  const lower = (text || "").toLowerCase();
  let bestScore = 0;
  let bestPillar = null;
  const hits = [];
  for (const [pillar, kws] of Object.entries(byPillar)) {
    let weightedHits = 0;
    for (const k of kws) {
      if (lower.includes(k.keyword)) {
        weightedHits += k.weight;
        hits.push(k.keyword);
      }
    }
    if (weightedHits > 0) {
      const pillarScore = Math.min(weightedHits * 0.25, 1.0);
      if (pillarScore > bestScore) {
        bestScore = pillarScore;
        bestPillar = pillar;
      }
    }
  }
  return { score: bestScore, pillar: bestPillar, hits };
}

// ---------- Brand + competitor mention overlay ----------

const clientMetaCache = new Map();

export async function getClientMeta(clientId) {
  if (clientMetaCache.has(clientId)) return clientMetaCache.get(clientId);
  const { data, error } = await supa()
    .from("clients")
    .select("id, brand_terms, competitor_terms")
    .eq("id", clientId)
    .single();
  if (error) throw error;
  const meta = {
    brand_terms: (data.brand_terms || []).map(t => t.toLowerCase()),
    competitor_terms: (data.competitor_terms || []).map(t => t.toLowerCase())
  };
  clientMetaCache.set(clientId, meta);
  return meta;
}

export function detectBrandMatch(text, meta) {
  const lower = (text || "").toLowerCase();
  const brand = meta.brand_terms.some(t => lower.includes(t));
  const compHit = meta.competitor_terms.find(t => lower.includes(t));
  return { brand_match: brand, competitor_match: compHit || null };
}

// ---------- Velocity scoring ----------

export function defaultVelocity({ engagement, occurredAt }) {
  const ageHours = (Date.now() - new Date(occurredAt).getTime()) / 3_600_000;
  return engagement / Math.max(ageHours, 1);
}

export function wikiVelocity({ todayViews, rollingAvg7 }) {
  if (!rollingAvg7 || rollingAvg7 === 0) return 1.0;
  return todayViews / rollingAvg7;
}
