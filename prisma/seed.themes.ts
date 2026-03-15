import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const themes = [
  { id: "aurora",   name: "Aurora",   category: "fashion",     previewBg: "#0f0f1a", accentColor: "#a78bfa", layout: "editorial", tags: ["dark","luxury","fashion"] },
  { id: "saffron",  name: "Saffron",  category: "food",        previewBg: "#fff7ed", accentColor: "#f97316", layout: "bold",      tags: ["warm","food","vibrant"] },
  { id: "slate",    name: "Slate",    category: "electronics", previewBg: "#0f172a", accentColor: "#38bdf8", layout: "grid",      tags: ["dark","tech","minimal"] },
  { id: "blossom",  name: "Blossom",  category: "beauty",      previewBg: "#fff1f2", accentColor: "#fb7185", layout: "luxury",    tags: ["soft","beauty","pastel"] },
  { id: "verdant",  name: "Verdant",  category: "general",     previewBg: "#f0fdf4", accentColor: "#22c55e", layout: "minimal",   tags: ["clean","green","fresh"] },
  { id: "obsidian", name: "Obsidian", category: "furniture",   previewBg: "#1c1917", accentColor: "#d4a867", layout: "editorial", tags: ["dark","premium","warm"] },
  { id: "ivory",    name: "Ivory",    category: "fashion",     previewBg: "#fafaf9", accentColor: "#292524", layout: "luxury",    tags: ["minimal","editorial","clean"] },
  { id: "citrus",   name: "Citrus",   category: "food",        previewBg: "#fefce8", accentColor: "#eab308", layout: "bold",      tags: ["bright","food","playful"] },
  { id: "midnight", name: "Midnight", category: "electronics", previewBg: "#020617", accentColor: "#6366f1", layout: "grid",      tags: ["dark","futuristic","tech"] },
  { id: "coral",    name: "Coral",    category: "beauty",      previewBg: "#fff8f1", accentColor: "#ea580c", layout: "minimal",   tags: ["warm","beauty","modern"] },
  { id: "forest",   name: "Forest",   category: "general",     previewBg: "#14532d", accentColor: "#bbf7d0", layout: "editorial", tags: ["dark","nature","bold"] },
  { id: "birch",    name: "Birch",    category: "furniture",   previewBg: "#fdf8f0", accentColor: "#92400e", layout: "luxury",    tags: ["natural","warm","premium"] },
];

async function main() {
  console.log("Seeding themes...");
  for (const theme of themes) {
    await prisma.theme.upsert({
      where: { id: theme.id },
      update: theme,
      create: theme,
    });
    console.log(`  ✓ ${theme.name}`);
  }
  console.log(`\n✅ Seeded ${themes.length} themes`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());