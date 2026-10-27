// Pause-AI: modtager brugerens registreringer fra appen, spørger Claude,
// og sender en beregning tilbage. API-nøglen ligger kun her på serveren
// (som hemmeligheden ANTHROPIC_API_KEY), aldrig i selve appen.
import Anthropic from "@anthropic-ai/sdk";
import { createRemoteJWKSet, jwtVerify } from "jose";

const FIREBASE_PROJECT = "flower-438b9";
const FIREBASE_KEYS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);
const MAX_ENTRIES = 120;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Svaret fra Claude skal altid have præcis denne form
const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tolerance_score", "tolerance_level", "break_days", "start_date", "headline", "explanation", "pattern", "tips"],
  properties: {
    tolerance_score: { type: "integer", description: "0-100, where 100 is extremely high tolerance" },
    tolerance_level: { type: "string", enum: ["low", "moderate", "high", "very_high"] },
    break_days: { type: "integer", description: "Recommended length of the break in days, 0 if no break is needed" },
    start_date: { type: "string", description: "Recommended start date of the break, YYYY-MM-DD" },
    headline: { type: "string", description: "Short recommendation, max 8 words" },
    explanation: { type: "string", description: "2-3 sentences explaining why" },
    pattern: { type: "string", description: "One sentence about the user's usage pattern" },
    tips: { type: "array", items: { type: "string" }, description: "3-4 short practical tips for the break" },
  },
};

const SYSTEM_PROMPT = `You are Pause-AI in a harm-reduction app for adults who use cannabis. Your job is to estimate the user's cannabis tolerance from their own logs and recommend when and how long a tolerance break would make the most sense.

The user message is JSON with:
- today: today's date (YYYY-MM-DD)
- lang: "da" (Danish) or "en" (English). Write every text field in this language.
- profile: optional answers about how long they have used cannabis, their goal, and when they last took a break of at least a week
- entries: logs with date, time, times (sessions in that log), grams, high (how high they got, 1-10), method, product (flower, hash, concentrate, edible, other) and optional thc (%)

How to reason:
- Tolerance builds with frequency and amount. Daily use builds much more tolerance than occasional use, and hash and concentrates count more than flower per gram.
- A falling "high" score for the same or larger amounts is a strong sign of rising tolerance.
- Tolerance starts to drop within about 2 days without use, drops a lot within 1-2 weeks, and is largely reset after about 3-4 weeks.
- Recommend break_days as 0 (no break needed), 2, 7, 14, 21 or 28 depending on how high the tolerance is and the user's goal.
- Pick a concrete start_date: today if tolerance is high, otherwise a day that fits their pattern (for example the weekday they usually use least). Never pick a date before today.
- If the user already has had no logs for some days, count that as an ongoing break.
- If there are only a few logs, say the estimate is uncertain.

Style: friendly, short and practical, like a knowledgeable friend. No moralising. This is not medical advice; if the logs suggest very heavy daily use or the goal is to stop completely, gently suggest talking to a doctor in one of the tips. Only use the data you are given.`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Kun brugere, der er logget ind i appen (Firebase), må bruge AI'en
async function verifyUser(request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, FIREBASE_KEYS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT}`,
      audience: FIREBASE_PROJECT,
    });
    return payload.sub || null;
  } catch {
    return null;
  }
}

function cleanEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, MAX_ENTRIES).map((e) => ({
    date: String(e.date || "").slice(0, 10),
    time: String(e.time || "").slice(0, 5),
    times: Number(e.times) || 0,
    grams: Number(e.grams) || 0,
    high: Number(e.high) || 0,
    method: String(e.method || "").slice(0, 20),
    product: String(e.product || "").slice(0, 20),
    thc: e.thc == null ? null : Number(e.thc) || null,
  }));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const uid = await verifyUser(request);
    if (!uid) return json({ error: "not_logged_in" }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    const entries = cleanEntries(body.entries);
    if (!entries.length) return json({ error: "no_entries" }, 400);

    const input = {
      today: String(body.today || "").slice(0, 10),
      lang: body.lang === "en" ? "en" : "da",
      profile: typeof body.profile === "object" && body.profile ? body.profile : {},
      entries,
    };

    if (!env.ANTHROPIC_API_KEY) return json({ error: "server_key" }, 500);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const response = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        // Hvis en sikkerhedsregel afviser svaret, prøver Anthropic automatisk en anden model
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: RESULT_SCHEMA },
        },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(input) }],
      });

      if (response.stop_reason === "refusal") return json({ error: "refusal" }, 422);
      if (response.stop_reason === "max_tokens") return json({ error: "too_long" }, 502);

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return json(JSON.parse(text));
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) return json({ error: "busy" }, 429);
      if (error instanceof Anthropic.AuthenticationError) return json({ error: "server_key" }, 500);
      if (error instanceof Anthropic.APIError) return json({ error: "ai_error", status: error.status }, 502);
      if (error instanceof SyntaxError) return json({ error: "bad_ai_answer" }, 502);
      console.error(error);
      return json({ error: "server_error" }, 500);
    }
  },
};
