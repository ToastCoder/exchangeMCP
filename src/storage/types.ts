/**
 * Storage abstraction for memories.
 *
 * Everything above this interface (MCP tools, HTTP routes, export) talks only to
 * `MemoryStore`, so the D1 implementation can be swapped for Postgres, Azure SQL,
 * etc. without touching the rest of the server.
 */

export interface Memory {
  /** Unique, normalised path such as `/writing/style.md`. */
  path: string;
  /** One-line summary used in indexes and search results. */
  description: string;
  /** Markdown body (frontmatter + `- [stated] fact` bullets by convention). */
  body: string;
  tags: string[];
  /** Which AI client last wrote the memory, e.g. `claude`, `chatgpt`, `gemini`. */
  source: string;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

export interface MemorySummary {
  path: string;
  description: string;
  updatedAt: string;
}

export interface SearchHit {
  path: string;
  description: string;
  tags: string[];
  updatedAt: string;
  /** Short excerpt with matches wrapped in `**`. */
  snippet: string;
  /** Relevance score; higher is better. */
  score: number;
}

export interface WriteMemoryInput {
  path: string;
  description: string;
  body: string;
  tags: string[];
  source: string;
}

export type AppendResult =
  | { ok: true; memory: Memory }
  | { ok: false; reason: "not_found" | "too_large" };

export interface MemoryStore {
  /** Index of memories, optionally restricted to paths starting with `prefix`. Sorted by path. */
  list(prefix?: string): Promise<MemorySummary[]>;
  get(path: string): Promise<Memory | null>;
  /** Create or overwrite. `createdAt` is preserved on overwrite. */
  put(input: WriteMemoryInput): Promise<Memory>;
  /** Append text to an existing memory's body, atomically enforcing `maxBodyBytes`. */
  append(path: string, content: string, source: string, maxBodyBytes: number): Promise<AppendResult>;
  /** Returns true when a memory was deleted. */
  delete(path: string): Promise<boolean>;
  /** Ranked full-text search. */
  search(query: string, limit: number): Promise<SearchHit[]>;
  /** Every memory, for export/backup. */
  all(): Promise<Memory[]>;
}
