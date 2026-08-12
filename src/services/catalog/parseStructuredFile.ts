import * as XLSX from "xlsx";

export interface ParsedProductRow {
  name: string;
  price: number;
  description?: string;
  category?: string;
  stock?: number;
}

// CSV and XLSX are already tabular — SheetJS reads both through the same
// API, so there's no need to hand these to an LLM at all. This is faster,
// free, and more reliable than AI extraction for anything already
// structured.
export function parseStructuredCatalog(buffer: Buffer): ParsedProductRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  return rows
    .map(normalizeRow)
    .filter((r): r is ParsedProductRow => r !== null);
}

function normalizeRow(row: Record<string, unknown>): ParsedProductRow | null {
  // Accept common header variants case-insensitively, since not everyone's
  // spreadsheet will use the exact sample-template column names.
  const get = (keys: string[]) => {
    for (const key of Object.keys(row)) {
      if (keys.includes(key.trim().toLowerCase())) return row[key];
    }
    return undefined;
  };

  const name = String(get(["name", "product name", "title"]) ?? "").trim();
  const priceRaw = get(["price", "mrp", "amount"]);
  const price = Number(priceRaw);

  if (!name || priceRaw === undefined || priceRaw === "" || Number.isNaN(price)) return null;

  return {
    name,
    price,
    description: String(get(["description", "desc"]) ?? "").trim() || undefined,
    category: String(get(["category", "type"]) ?? "").trim() || undefined,
    stock: Number(get(["stock", "quantity", "qty"]) ?? 0) || 0,
  };
}