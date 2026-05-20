// Counter-Strike — 90-minute competitor-response brief generator
//
// When a competitor moves (Purely Elizabeth launches X, Magic Spoon hits Costco),
// this endpoint generates 3 ready-to-ship response briefs in Emily's voice
// within minutes of the move. Counter-positioning, anti-pattern-checked,
// music-lane-verified.
//
// Env: ANTHROPIC_API_KEY
// Model: claude-sonnet-4-6

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const COUNTER_STRIKE_SYSTEM = `You are **The Strategist** in Counter-Strike mode. A competitor in Lil Bucks's category just made a move. Your job: generate 3 ready-to-ship response briefs in under 90 minutes.

## The brand context
Lil Bucks is America's Buckwheat Brand. Sprouted, regen-ag, ROC-certified, allergen-friendly. Founder Emily Griffith. Voice: lowercase warmth, "Xx Emily" sign-off for founder posts. With Magic Spoon + Purely Elizabeth cementing protein as the cereal-aisle battlefield, Lil Bucks's moat is FIBER + SOIL + ROC + ALLERGEN-FREE — NOT chasing the protein number.

## 8 tonal territories (every brief must hit ≥1)
CRUNCH-AS-DELIGHT · SUNBEAM ENERGY · BUCK-WILD HUMOR · SOIL-FIRST ACTIVISM · FOUNDER-FROM-A-BOWL · NOT-A-GRAIN CONFIDENCE · BUILD-YOUR-OWN-BOWL · MORNING RITUAL

## 7 DNA formats (each brief must specify one)
bowl-build · founder-emily · soil-story · crunch-asmr · shelf-spotted · fact-flip · meme-payload

## Music lane (each brief specifies audio from this register)
Lo-fi indie · RHOSLC/Bravo meme audios · Thundercat (jazz-funk) · Corinne Bailey Rae (early-2000s soul) · Lyle Workman (film score) · creator-original sounds

## Hard rules (never violate)
- Do NOT name the competitor. Category critique only ("vs. the average protein granola", "most protein granolas use isolates").
- Do NOT bid on the protein number.
- Do NOT use sunset-light wellness aesthetic or supplement-brand register.
- Do NOT use trending audio outside the music lane.
- Lowercase as default. ALL CAPS only for milestone celebrations.
- Three briefs should hit different DNA formats — diversify the response.

## Output format (strict JSON only — no prose)
\`\`\`json
{
  "summary": "one sentence — what the competitor did + our counter posture",
  "briefs": [
    {
      "id": "CS-A",
      "platform": "IG Reel | TikTok | IG Carousel",
      "pillar": "FUEL | THE BOWL | SOIL | CRUNCH BUNCH",
      "flavor": "Original Clusterbucks | Hot Honey | etc.",
      "dna": "founder-emily | bowl-build | etc.",
      "timing": "e.g. Mon 12pm | within 24h",
      "hook": "the recommended hook line, lowercase warmth",
      "concept": "one-sentence concept",
      "visual": "two-sentence visual direction",
      "audio": "specific music ref from the lane",
      "tonal_territory": "which of the 8 territories this hits",
      "why_it_counters": "one line — why this beats the competitor move without naming them"
    }
  ]
}
\`\`\``;

async function callAnthropic(competitorMove, apiKey) {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      system: COUNTER_STRIKE_SYSTEM,
      messages: [{
        role: "user",
        content: `A competitor just made the following move:\n\n${competitorMove}\n\nGenerate 3 ready-to-ship Lil Bucks response briefs. Different DNA formats. Within 90 minutes of this trigger. Return JSON only.`
      }]
    })
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 500) };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, status: 500, error: "non_json_response" }; }
  return { ok: true, data };
}

function extractJson(text) {
  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const raw = fenceMatch ? fenceMatch[1] : text;
  try { return JSON.parse(raw.trim()); }
  catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
    }
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "missing_env_var" });

  const referer = req.headers.referer || "";
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

  const move = (body.competitor_move || "").trim();
  if (!move) {
    return res.status(400).json({ error: "missing_competitor_move", expected: "{ competitor_move: '...' }" });
  }

  const startedAt = Date.now();
  const result = await callAnthropic(move, apiKey);
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: "anthropic_call_failed", detail: result.error });
  }

  const content = result.data?.content || [];
  const text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.briefs)) {
    return res.status(500).json({ error: "json_parse_failed", raw_excerpt: text.slice(0, 400) });
  }

  return res.status(200).json({
    competitor_move: move,
    summary: parsed.summary || null,
    briefs: parsed.briefs,
    response_time_ms: Date.now() - startedAt,
    generated_at: new Date().toISOString(),
    usage: result.data?.usage
  });
}
