import Groq from "groq-sdk";
import { ENV } from "../../config/env";

export interface ExtractedCatalogProduct {
  name: string;
  price: number;
  description?: string | null;
  category?: string | null;
  stock?: number;
}

const CURRENT_GROQ_MODEL = "openai/gpt-oss-120b";
const RETIRED_MODELS = new Set([
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
]);

const client = new Groq({ apiKey: ENV.GROQ_API_KEY || undefined });

const normalizeProducts = (value: unknown): ExtractedCatalogProduct[] => {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as any).products)
      ? (value as any).products
      : [];

  return rows.flatMap((row: any) => {
    const name = String(row?.name ?? row?.product_name ?? "").trim();
    const price = Number.parseFloat(
      String(row?.price ?? row?.selling_price ?? row?.amount ?? "").replace(/[,₹$]/g, "")
    );

    if (!name || !Number.isFinite(price) || price < 0) return [];

    const stock = Number.parseInt(String(row?.stock ?? row?.quantity ?? 0), 10);

    return [{
      name,
      price,
      description: row?.description ? String(row.description).trim() : null,
      category: row?.category ? String(row.category).trim() : null,
      stock: Number.isFinite(stock) ? stock : 0,
    }];
  });
};

const requestExtraction = async (model: string, text: string) => {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: 12000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Extract products from the supplied catalogue text. Return only JSON with a products array. " +
          "Each product must contain name and numeric price. Include description, category and numeric stock when available. " +
          "Do not invent products or prices. If a field is missing, use null or 0.",
      },
      {
        role: "user",
        content: `Catalogue text:\n\n${text.slice(0, 120000)}`,
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI returned an empty catalogue response");

  return normalizeProducts(JSON.parse(content));
};

export const extractProductsWithAI = async (
  text: string
): Promise<ExtractedCatalogProduct[]> => {
  if (!ENV.GROQ_API_KEY) {
    throw Object.assign(new Error("GROQ_API_KEY is not configured"), { status: 503 });
  }

  const configured = String(ENV.GROQ_MODEL || "").trim();
  const preferred = configured && !RETIRED_MODELS.has(configured)
    ? configured
    : CURRENT_GROQ_MODEL;

  try {
    return await requestExtraction(preferred, text);
  } catch (error: any) {
    const message = String(error?.message || error || "");
    const shouldRetry = preferred !== CURRENT_GROQ_MODEL && /model|not found|404/i.test(message);

    if (!shouldRetry) throw error;
    return requestExtraction(CURRENT_GROQ_MODEL, text);
  }
};
