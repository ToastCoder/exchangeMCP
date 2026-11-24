import type {
  AppendResult,
  Memory,
  MemoryStore,
  MemorySummary,
  SearchHit,
  WriteMemoryInput,
} from "./types";

interface MemoryRow {
  path: string;
  description: string;
  body: string;
  tags: string;
  source: string;
  created_at: string;
  updated_at: string;
}

interface SearchRow {
  path: string;
  description: string;
  tags: string;
  updated_at: string;
  snippet: string;
  score: number;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const COLUMNS = "path, description, body, tags, source, created_at, updated_at";

function parseTags(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function toMemory(row: MemoryRow): Memory {
  return {
    path: row.path,
    description: row.description,
    body: row.body,
    tags: parseTags(row.tags),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Turn free text into a safe FTS5 MATCH expression. Every word is quoted, so
 * user input can never inject FTS5 operators or cause syntax errors.
 */
export function buildFtsQuery(query: string, mode: "and" | "or"): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const unique = [...new Set(tokens)].slice(0, 16);
  if (unique.length === 0) return null;
  return unique.map((t) => `"${t}"`).join(mode === "and" ? " AND " : " OR ");
}

export class D1MemoryStore implements MemoryStore {
  constructor(private readonly db: D1Database) {}

  async list(prefix?: string): Promise<MemorySummary[]> {
    const stmt = prefix
      ? this.db
          .prepare(
            "SELECT path, description, updated_at FROM memories WHERE substr(path, 1, ?2) = ?1 ORDER BY path",
          )
          .bind(prefix, prefix.length)
      : this.db.prepare("SELECT path, description, updated_at FROM memories ORDER BY path");
    const { results } = await stmt.all<Pick<MemoryRow, "path" | "description" | "updated_at">>();
    return results.map((r) => ({ path: r.path, description: r.description, updatedAt: r.updated_at }));
  }

  async get(path: string): Promise<Memory | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM memories WHERE path = ?1`)
      .bind(path)
      .first<MemoryRow>();
    return row ? toMemory(row) : null;
  }

  async put(input: WriteMemoryInput): Promise<Memory> {
    const row = await this.db
      .prepare(
        `INSERT INTO memories (path, description, body, tags, source)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
           description = excluded.description,
           body        = excluded.body,
           tags        = excluded.tags,
           source      = excluded.source,
           updated_at  = ${NOW}
         RETURNING ${COLUMNS}`,
      )
      .bind(input.path, input.description, input.body, JSON.stringify(input.tags), input.source)
      .first<MemoryRow>();
    if (!row) throw new Error("write failed");
    return toMemory(row);
  }

  async append(path: string, content: string, source: string, maxBodyBytes: number): Promise<AppendResult> {
    const contentBytes = new TextEncoder().encode(content).byteLength;
    // Single atomic statement: adds a newline separator when needed and refuses
    // to grow the body past the limit (+1 accounts for the possible separator).
    const row = await this.db
      .prepare(
        `UPDATE memories SET
           body = body
                  || CASE WHEN body = '' OR substr(body, -1) = char(10) THEN '' ELSE char(10) END
                  || ?2,
           source = ?3,
           updated_at = ${NOW}
         WHERE path = ?1 AND length(CAST(body AS BLOB)) + 1 + ?4 <= ?5
         RETURNING ${COLUMNS}`,
      )
      .bind(path, content, source, contentBytes, maxBodyBytes)
      .first<MemoryRow>();
    if (row) return { ok: true, memory: toMemory(row) };
    const exists = await this.db.prepare("SELECT 1 AS x FROM memories WHERE path = ?1").bind(path).first();
    return { ok: false, reason: exists ? "too_large" : "not_found" };
  }

  async delete(path: string): Promise<boolean> {
    const res = await this.db.prepare("DELETE FROM memories WHERE path = ?1").bind(path).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    // Prefer documents containing every term; fall back to any term.
    for (const mode of ["and", "or"] as const) {
      const match = buildFtsQuery(query, mode);
      if (!match) return [];
      const { results } = await this.db
        .prepare(
          `SELECT m.path, m.description, m.tags, m.updated_at,
                  snippet(memories_fts, -1, '**', '**', '…', 16) AS snippet,
                  bm25(memories_fts, 2.0, 3.0, 1.0, 2.0) AS score
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.rowid
           WHERE memories_fts MATCH ?1
           ORDER BY score
           LIMIT ?2`,
        )
        .bind(match, limit)
        .all<SearchRow>();
      if (results.length > 0 || mode === "or") {
        return results.map((r) => ({
          path: r.path,
          description: r.description,
          tags: parseTags(r.tags),
          updatedAt: r.updated_at,
          snippet: r.snippet,
          // bm25() is "lower is better" and negative; flip it so higher is better.
          // Significant-figure rounding: tiny corpora yield very small bm25 values.
          score: Number((-r.score).toPrecision(4)),
        }));
      }
    }
    return [];
  }

  async all(): Promise<Memory[]> {
    const { results } = await this.db.prepare(`SELECT ${COLUMNS} FROM memories ORDER BY path`).all<MemoryRow>();
    return results.map(toMemory);
  }
}
