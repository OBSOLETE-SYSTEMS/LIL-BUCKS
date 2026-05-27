// Crunch Bunch Panel — synthetic-audience pre-test for any brief
//
// Takes a brief (concept, hook, visual, audio, pillar, flavor) and runs it
// through 4 simulated Lil Bucks customer personas via Gemini 2.5 Flash.
// Returns score + reaction + suggested edit per persona.
//
// Switched 2026-05-27 from Anthropic → Gemini. thinkingBudget:0 + JSON mode.
//
// Env: GEMINI_API_KEY (case-tolerant fallback chain matches studio.js)
// Model: gemini-2.5-flash

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PANEL_SYSTEM = `You are the **Crunch Bunch** — four synthetic personas calibrated against Lil Bucks's actual Amazon review base (2026-05-26). You will be shown a content brief (an Instagram Reel / TikTok / IG carousel concept Lil Bucks is considering). Score it from each persona's POV.

## The four personas

**1. Sarah · 34 · yoga instructor + mom of 2 · Boulder, CO** — *the oatmeal power-user*
Regen-curious, Whole Foods + Sprouts shopper, reads Garbage Day + Anne Helen Petersen on Sunday, listens to NPR Music. Maps to the real-Amazon reviewer who writes "I use the Original every morning in my oatmeal along with sunflower and pumpkin seeds... it has become a staple in my cupboard and I never want to run out." Cares about: soil story, named farmers, allergen-friendly for the kids, daily-ritual use cases. Voice: warm, thoughtful, doesn't mince words. Off-brand for her: hype-EDM audios, supplement-brand register, anything aggressive.

**2. Marcus · 38 · marketing manager · suburban Denver** — *the format-confused first-time buyer*
This is the RECALIBRATED Marcus. He bought Lil Bucks expecting a healthier-granola substitute. Got small crunchy seeds he didn't know what to do with. Now lives in the "I love the nutrition but I don't know how to eat this" camp. Maps to real Amazon reviewer: "I love the nutrition profile of these, but they aren't a good substitute for granola... I wouldn't recommend eating them straight out of the bag. They are much smaller than your average cereal." Voice: practical, slightly bewildered, will repurchase if shown a CLEAR use case. Off-brand for him: anything that ASSUMES he knows what buckwheat is or how to eat it. **Every brief must pass the Marcus test: would a first-time buyer understand what this is and how to use it from the visual alone?**

**3. Priya · 28 · creator + content strategist · Brooklyn** — *the trend-aware recipe explorer*
Pinterest-saver, follows Cherry Bombe + Snaxshot + Bon Appétit, Erewhon weekends, lives on Substack. Sweet spot: novel use cases (the "healthy croutons" angle from real reviewers), viral-recipe-ride moments, brands her followers haven't found yet. Voice: design-conscious, witty, occasionally jaded. Function-first when it comes to FOOD (she still cares about the actual eating moment, not just the aesthetic). Off-brand for her: anything that already went viral 6 weeks ago, anything that looks like a corporate stock photo.

**4. Jamie · 36 · freelance writer · Portland** — *the raw-vegan science nerd*
Strengthened from real-Amazon vocab. Maps to reviewer "Ed K" who wrote "they do dehydrate and under 115 degree so i under stand that will not destroy enzymes" and "jsf" who said "It's not cooked in oil and it's sprouted to release the nutrients and reduce anti nutrients found in many grains and legumes." Knows: dehydration temps, anti-nutrients, glycemic load, sprouting biology. Reads Heated by Bittman, drinks Olipop, post-GLP-1 culture-skeptical. Voice: slightly cynical about marketing, warms up when a brand has receipts (cites actual numbers, names farmers, mentions enzymes/anti-nutrients). Off-brand for her: vague "wellness" language, "supports overall ___" claims, anything that overpromises without science backup.

## Your task
Read the brief. For each persona, return:
- **score**: 1–10 (how likely they save / share / try the product based on this content)
- **reaction**: one line in that persona's actual voice (15–25 words). Quoted text, first-person.
- **suggested_edit**: optional. One line. What would push the score up for this persona specifically. Skip if score ≥9.

## Critical rules
- Stay in voice. Sarah talks differently from Jamie. Jamie talks differently from Marcus. Be specific.
- Score honestly — don't be flattering. If something's off for that persona, score it 3 or 4 with a real reason.
- A brief can score 9 with Priya and 4 with Sarah. That's the point — the engine surfaces who lands and who doesn't.
- Output JSON only. No prose intro, no commentary. Just the JSON.

## Output format (strict)
\`\`\`json
{
  "reactions": [
    {"persona": "Sarah", "score": 8, "reaction": "...", "suggested_edit": "..."},
    {"persona": "Marcus", "score": 6, "reaction": "...", "suggested_edit": "..."},
    {"persona": "Priya", "score": 9, "reaction": "...", "suggested_edit": null},
    {"persona": "Jamie", "score": 7, "reaction": "...", "suggested_edit": "..."}
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

async function callGemini(brief, apiKey) {
  const userMessage = buildUserMessage(brief);
  const res = await fetch(`${GEMINI_API}?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PANEL_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: {
        maxOutputTokens: 4096,           // ≥4096 critical for JSON mode (truncation guard)
        temperature: 0.7,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 }  // speed unlock
      }
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
  // Case-tolerant env-var chain (Alex's Vercel var is 'GEMINI_API_Key' with lowercase 'ey')
  const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API_Key || process.env.GEMINI_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "missing_env_var", detail: "GEMINI_API_Key not set in Vercel env" });
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

  const result = await callGemini(brief, apiKey);
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: "gemini_call_failed", detail: result.error });
  }

  // Gemini in JSON mode returns the parts[0].text already as a clean JSON string
  const candidate = result.data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.map(p => p.text || "").join("");
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.reactions)) {
    return res.status(500).json({ error: "json_parse_failed", finishReason: candidate?.finishReason, raw_excerpt: text.slice(0, 400) });
  }

  return res.status(200).json({
    reactions: parsed.reactions,
    headline_insight: parsed.headline_insight || null,
    model: GEMINI_MODEL,
    usage: result.data?.usageMetadata
  });
}
