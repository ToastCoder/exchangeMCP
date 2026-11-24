import { strToU8, zipSync } from "fflate";
import type { Memory, MemoryStore } from "./storage/types";

function indexMarkdown(memories: Memory[]): string {
  const lines = memories.map((m) => `- [${m.path.slice(1)}](${m.path.slice(1)}) — ${m.description}`);
  return `# exchange memory index\n\n${lines.join("\n")}\n`;
}

/** JSON backup: every memory with metadata and its markdown body. */
export async function exportJson(store: MemoryStore): Promise<Response> {
  const memories = await store.all();
  const payload = {
    exported_at: new Date().toISOString(),
    count: memories.length,
    memories: memories.map((m) => ({
      path: m.path,
      description: m.description,
      tags: m.tags,
      source: m.source,
      created_at: m.createdAt,
      updated_at: m.updatedAt,
      body: m.body,
    })),
  };
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="exchange-export.json"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Zip backup: one .md file per memory at its path, plus MEMORY.md as an index. */
export async function exportZip(store: MemoryStore): Promise<Response> {
  const memories = await store.all();
  const files: Record<string, Uint8Array> = { "MEMORY.md": strToU8(indexMarkdown(memories)) };
  for (const m of memories) files[m.path.slice(1)] = strToU8(m.body);
  const zip = zipSync(files, { level: 6 });
  return new Response(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="exchange-export.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
