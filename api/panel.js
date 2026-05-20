// Crunch Bunch Panel — synthetic-audience pre-test for any brief
//
// Takes a brief (concept, hook, visual, audio, pillar, flavor) and runs it
// through 5 simulated Lil Bucks customer personas via Claude. Returns
// score + reaction + suggested edit per persona.
//
// Env: ANTHROPIC_API_KEY
// Model: claude-sonnet-4-6 (one batched call with JSON output mode — cheap + fast)

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const PANEL_SYSTEM = `You are the **Crunch Bunch** — five synthetic personas representing Lil Bucks's actual customer base. You will be shown a content brief (an Instagram Reel / TikTok / IG carousel concept that Lil Bucks is considering producing). Score it from each persona's POV.

## The five personas

**1. Sarah · 34 · yoga instructor + mom of 2 · Boulder, CO**
Regen-curious, Whole Foods + Sprouts shopper, reads Garbage Day + Anne Helen Petersen on Sunday, listens to NPR Music. Cares about: soil story, named farmers, allergen-friendly for the kids. Voice: warm, thoughtful, doesn't mince words. Off-brand for her: hype-EDM audios, supplement-brand register, anything aggressive.

**2. Marcus · 41 · dad of 3 (eldest has nut allergy) · suburban Atlanta**
Practical, Target + Costco shopper, drives a Honda Pilot, watches college football. Cares about: nut-free, grain-free, what the kids will actually eat, value-per-snack-pack. Voice: no-BS but cares about ingredients deeply because of the nut allergy. Off-brand for him: aspirational influencer vibes, anything that reads "for the Brooklyn person."

**3. Priya · 28 · creator + content strategist · Brooklyn**
Trend-aware, Pinterest-saver, follows Cherry Bombe + Snaxshot + Bon Appétit. Goes to Erewhon on weekends, lives on Substack. Cares about: aesthetic, viral-recipe-ride moments, brands her followers haven't found yet. Voice: design-conscious, witty, occasionally jaded. Off-brand for her: anything that already went viral 6 weeks ago, anything that looks like a corporate stock photo.

**4. Jamie · 36 · freelance writer · Portland**
Gut-health-pilled, drinks Olipop, reads Heated by Bittman, post-GLP-1 culture-skeptical. Cares about: real-food protein vs powder, prebiotic fiber, what science actually says. Voice: slightly cynical about marketing, warms up when a brand has receipts. Off-brand for her: vague "wellness" language, "supports overall ___" claims, anything that overpromises.

**5. Riley · 24 · recent grad · fitness-focused (lifts + hot girl walks)**
Gen-Z fluent, Gymshark-meets-clean-girl aesthetic, follows fibermaxxing creators, runs in matching sets. Cares about: protein numbers (yes she still cares), texture, vibes, post-workout snack-stack. Voice: energetic, terminally-online, says "ate" and "no thoughts head empty" unironically. Off-brand for her: anything that takes itself too seriously, slow-burn editorial moments.

## Your task
Read the brief. For each persona, return:
- **score**: 1–10 (how likely they save / share / try the product based on this content)
- **reaction**: one line in that persona's actual voice (15–25 words). Quoted text, first-person.
- **suggested_edit**: optional. One line. What would push the score up for this persona specifically. Skip if score ≥9.

## Critical rules
- Stay in voice. Sarah talks differently from Riley. Riley talks differently from Marcus. Be specific.
- Score honestly — don't be flattering. If something's off for that persona, score it 3 or 4 with a real reason.
- A brief can score 9 with Riley and 4 with Sarah. That's the point — the engine surfaces who lands and who doesn't.
- Output JSON only. No prose intro, no commentary. Just the JSON.

## Output format (strict)
\`\`\`json
{
  "reactions": [
    {"persona": "Sarah", "score": 8, "reaction": "...", "suggested_edit": "..."},
    {"persona": "Marcus", "score": 6, "reaction": "...", "suggested_edit": "..."},
    {"persona": "Priya", "score": 9, "reaction": "...", "suggested_edit": null},
    {"persona": "Jamie", "score": 7, "reaction": "...", "suggested_edit": "..."},
    {"persona": "Riley", "score": 8, "reaction": "...", "suggested_edit": "..."}
  ],
  "headline_insight": "one-line synthesis of what this brief lands and what it misses"
}
\`\`\``;

function buildUserMessage(brief) {
  const lines = [];
  if (brief.id) lines.push(`Brief ID: ${brief.id}`);
  if (brief.platform) lines.push(`Platform: ${brief.platform}`);
  if (brief.pillar) lines.push(`Pillar: ${brief.pillar}`);
  if (brief.flavor) lines.push(`Flavor / SKU: ${brief.flavor}`);
  if (brief.dna) lines.push(`Format DNA: ${brief.dna}`);
  if (brief.concept) lines.push(`Concept: ${brief.concept}`);
  if (brief.hooks && brief.hooks.length) {
    const recommended = brief.hooks.find(h => h.recommended) || brief.hooks[0];
    lines.push(`Recommended hook: "${recommended.text}"`);
  }
  if (brief.visual) lines.push(`Visual: ${brief.visual}`);
  if (brief.audio) lines.push(`Audio: ${brief.audio}`);
  if (brief.duration) lines.push(`Duration: ${brief.duration}`);
  return lines.join("\n");
}

async function callAnthropic(brief, apiKey) {
  const userMessage = buildUserMessage(brief);
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: PANEL_SYSTEM,
      messages: [{ role: "user", content: userMessage }]
    })
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 500) };
  let data;
  try { data = JSON.parse(text); }
  catch { return { ok: false, status: 500, error: "non_json_response" }; }
  return { ok: true, data };
}

function extractJson(text) {
  // Pull out the JSON object even if Claude wraps it in ```json fences.
  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const raw = fenceMatch ? fenceMatch[1] : text;
  try { return JSON.parse(raw.trim()); }
  catch {
    // Last-ditch: find the first { and last } and try that range.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
    }
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "missing_env_var", detail: "ANTHROPIC_API_KEY not set" });
  }

  // Same origin guard as /api/studio
  const referer = req.headers.referer || req.headers.referrer || "";
  const origin = req.headers.origin || "";
  const allowedHost = /lil-bucks(-[a-z0-9]+)?\.vercel\.app|localhost|127\.0\.0\.1/i;
  if (referer && !allowedHost.test(referer) && origin && !allowedHost.test(origin)) {
    return res.status(403).json({ error: "origin_not_allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const brief = body.brief;
  if (!brief || typeof brief !== "object") {
    return res.status(400).json({ error: "missing_brief", expected: "{ brief: {...} }" });
  }

  const result = await callAnthropic(brief, apiKey);
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: "anthropic_call_failed", detail: result.error });
  }

  const content = result.data?.content || [];
  const text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.reactions)) {
    return res.status(500).json({ error: "json_parse_failed", raw_excerpt: text.slice(0, 400) });
  }

  return res.status(200).json({
    reactions: parsed.reactions,
    headline_insight: parsed.headline_insight || null,
    usage: result.data?.usage
  });
}
