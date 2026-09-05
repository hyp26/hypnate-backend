import Groq from "groq-sdk";
import type { ParsedProductRow } from "./parseStructuredFile";
import { ENV } from "../../config/env";

// CHANGED: was constructed at module load (`const groq = new Groq(...)`),
// which meant a missing GROQ_API_KEY crashed the entire server on startup —
// this whole file gets require'd transitively through onboarding.controller
// just for the CSV/business/payments routes too. Building it lazily, only
// when AI extraction is actually invoked, means a missing key only fails
// that one request instead of taking down login/orders/everything else.
let groqClient: Groq | null = null;

function getGroqClient(): Groq {
  if (!ENV.GROQ_API_KEY) {
    throw new Error(
      "AI catalog extraction isn't configured (GROQ_API_KEY is missing). CSV/XLSX uploads still work without it."
    );
  }
  if (!groqClient) {
    groqClient = new Groq({ apiKey: ENV.GROQ_API_KEY });
  }
  return groqClient;
}

// Llama 3.3 70B on Groq: strong enough for structured extraction, fast, and
// comfortably inside the free tier for onboarding-volume traffic. Override
// via env if you want to try a different open model later.
const MODEL = ENV.GROQ_MODEL || "llama-3.3-70b-versatile";

// Keep the output schema strict — this is the one place a model going
// off-script (extra prose, markdown fences, invented fields) would break
// the whole upload.
const SYSTEM_PROMPT = `You extract product catalogs from raw document text.
Read the text and return every distinct product you can find.

Respond with ONLY a JSON object of this exact shape, no prose, no markdown:
{
  "products": [
    { "name": string, "price": number, "description": string | null, "category": string | null, "stock": number | null }
  ]
}

Rules:
- "price" must be a plain number (no currency symbols, no commas).
- If stock isn't mentioned, use null.
- If you find no products, return { "products": [] }.
- Never invent products that aren't in the text.`;

export async function extractProductsWithAI(rawText: string): Promise<ParsedProductRow[]> {
  // Most catalogs comfortably fit in context; if someone uploads something
  // huge, trim rather than fail outright — a partial catalog beats none.
  const text = rawText.slice(0, 40000);

  const completion = await getGroqClient().chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("AI extraction returned no content");

  let parsed: { products?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI extraction returned malformed JSON");
  }

  if (!Array.isArray(parsed.products)) {
    throw new Error("AI extraction response did not include a products array");
  }

  return parsed.products
    .map((p: any): ParsedProductRow | null => {
      const name = String(p?.name ?? "").trim();
      const price = Number(p?.price);
      if (!name || Number.isNaN(price)) return null;
      return {
        name,
        price,
        description: p?.description ? String(p.description).trim() : undefined,
        category: p?.category ? String(p.category).trim() : undefined,
        stock: Number.isFinite(Number(p?.stock)) ? Number(p.stock) : 0,
      };
    })
    .filter((p): p is ParsedProductRow => p !== null);
}