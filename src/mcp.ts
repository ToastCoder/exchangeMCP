import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Memory, MemoryStore } from "./storage/types";
import {
  bodySchema,
  descriptionSchema,
  ensureFrontmatter,
  limitSchema,
  nonEmptyBodySchema,
  pathSchema,
  prefixSchema,
  querySchema,
  sourceSchema,
  tagsSchema,
  byteLength,
} from "./schemas";

export const SERVER_NAME = "exchange";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  store: MemoryStore;
  /** Public origin of this Worker, used to build citation URLs (no token included). */
  baseUrl: string;
  maxBodyBytes: number;
}

const INSTRUCTIONS = `exchange is the user's shared, cross-app memory. The same memories are available in Claude, ChatGPT, Gemini and any other connected AI.

At the start of a conversation, call search_memory (or list_memories) to look for memories relevant to the topic, and use what you find.
When the user asks you to remember something, or states a durable fact or preference about themselves, their work or how they want you to behave, save it with write_memory or append_memory.

Store only durable facts the user actually said: preferences, decisions, project context, writing style, recurring people/places. Never store secrets, passwords, API keys, tokens, financial account numbers or other credentials, and do not store your own guesses as facts.

Memory format: one markdown file per topic at a path like /writing/style.md. Body = YAML frontmatter (name, description) followed by bullet lines of the form "- [stated] <fact>". Prefer updating an existing topic file over creating near-duplicates.`;

const SAFETY_NOTE =
  "Memories are for durable facts the user stated (preferences, decisions, context). Never save secrets, passwords, API keys or other credentials.";

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function error(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function memoryUrl(baseUrl: string, path: string): string {
  return `${baseUrl}/memory${path}`;
}

function renderMemory(m: Memory): string {
  const meta = [
    `path: ${m.path}`,
    `description: ${m.description}`,
    `tags: ${JSON.stringify(m.tags)}`,
    `source: ${m.source}`,
    `created_at: ${m.createdAt}`,
    `updated_at: ${m.updatedAt}`,
  ].join("\n");
  return `<!--\n${meta}\n-->\n${m.body}`;
}

/** Build a fresh MCP server bound to a store. Called once per request (stateless). */
export function createMcpServer({ store, baseUrl, maxBodyBytes }: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: INSTRUCTIONS,
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  const path = pathSchema.describe(
    "Memory path, like '/writing/style.md' or '/projects/exchange.md'. Lowercase; '.md' is added if missing.",
  );
  const source = sourceSchema.describe(
    "Which AI client is writing: 'claude', 'chatgpt', 'gemini', 'copilot', etc.",
  );

  server.registerTool(
    "list_memories",
    {
      title: "List memories",
      description:
        "List saved memories as an index of paths with one-line descriptions and last-updated times. " +
        "Use this to see what the user's shared memory contains, optionally under a folder prefix such as '/writing'. " +
        "Then call read_memory for the full content.",
      inputSchema: {
        prefix: prefixSchema.optional().describe("Only list paths starting with this prefix, e.g. '/writing'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ prefix }) => {
      const items = await store.list(prefix);
      if (items.length === 0) return text(prefix ? `No memories under ${prefix}.` : "No memories saved yet.");
      const lines = items.map((m) => `- ${m.path} — ${m.description} (updated ${m.updatedAt})`);
      return text(`${items.length} memor${items.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "read_memory",
    {
      title: "Read memory",
      description:
        "Read one memory file in full (markdown with frontmatter and '- [stated] fact' bullets), plus its metadata. " +
        "Use after list_memories or search_memory to get the complete content.",
      inputSchema: { path },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      const m = await store.get(path);
      return m ? text(renderMemory(m)) : error(`No memory at ${path}. Use list_memories or search_memory to find paths.`);
    },
  );

  server.registerTool(
    "write_memory",
    {
      title: "Write memory",
      description:
        "Create or completely overwrite a memory file. Use when the user asks you to remember something, or states a durable " +
        "fact or preference worth recalling in future chats in any AI app. Read the existing file first if one exists and keep " +
        "facts that are still true. Body convention: YAML frontmatter with name and description, then one line per fact like " +
        "'- [stated] Prefers British spelling'. Frontmatter is added automatically if missing. " +
        SAFETY_NOTE,
      inputSchema: {
        path,
        description: descriptionSchema.describe("One-line summary of what this memory file covers."),
        body: bodySchema(maxBodyBytes).describe(
          `Markdown body (max ${maxBodyBytes} bytes): frontmatter then '- [stated] fact' bullets.`,
        ),
        tags: tagsSchema.optional().describe("Optional topic tags, e.g. ['writing', 'style']."),
        source,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, description, body, tags, source }) => {
      const full = ensureFrontmatter(path, description, body);
      if (byteLength(full) > maxBodyBytes) return error(`body exceeds ${maxBodyBytes} bytes`);
      const m = await store.put({ path, description, body: full, tags: tags ?? [], source });
      return text(`Saved ${m.path} (updated ${m.updatedAt}).`);
    },
  );

  server.registerTool(
    "append_memory",
    {
      title: "Append to memory",
      description:
        "Append one or more lines to the end of an existing memory file without rewriting it, e.g. a new " +
        "'- [stated] fact' bullet. The file must already exist; use write_memory to create it. " +
        SAFETY_NOTE,
      inputSchema: {
        path,
        content: nonEmptyBodySchema(maxBodyBytes).describe("Text to append, typically '- [stated] <fact>' lines."),
        source,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, content, source }) => {
      const res = await store.append(path, content.replace(/\s+$/, "") + "\n", source, maxBodyBytes);
      if (res.ok) return text(`Appended to ${res.memory.path} (updated ${res.memory.updatedAt}).`);
      if (res.reason === "not_found") return error(`No memory at ${path}. Create it first with write_memory.`);
      return error(`Appending would exceed the ${maxBodyBytes}-byte limit for ${path}. Consolidate it with write_memory.`);
    },
  );

  server.registerTool(
    "delete_memory",
    {
      title: "Delete memory",
      description:
        "Permanently delete a memory file. Only use when the user explicitly asks to forget or remove it.",
      inputSchema: { path },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      const deleted = await store.delete(path);
      return deleted ? text(`Deleted ${path}.`) : error(`No memory at ${path}.`);
    },
  );

  server.registerTool(
    "search_memory",
    {
      title: "Search memory",
      description:
        "Full-text search across all memories (paths, descriptions, bodies and tags), ranked by relevance with snippets. " +
        "Call this at the start of a conversation with the topic's key words to recall what the user has told any AI before.",
      inputSchema: {
        query: querySchema.describe("Key words to search for, e.g. 'writing style' or 'exchange project'."),
        limit: limitSchema.optional().describe("Max results (1-50, default 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const hits = await store.search(query, limit ?? 10);
      if (hits.length === 0) return text(`No memories match "${query}".`);
      const lines = hits.map(
        (h, i) =>
          `${i + 1}. ${h.path} — ${h.description}\n   score: ${h.score} · updated: ${h.updatedAt}` +
          (h.tags.length ? ` · tags: ${h.tags.join(", ")}` : "") +
          `\n   ${h.snippet.replace(/\s+/g, " ").trim()}`,
      );
      return text(lines.join("\n"));
    },
  );

  // ---- ChatGPT connector compatibility (deep-research / connector spec) ----

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Search the user's shared memory for relevant saved facts. Returns JSON {results:[{id,title,url}]} where id is the " +
        "memory path; pass it to fetch to read the full memory.",
      inputSchema: { query: querySchema.describe("Search query.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const hits = await store.search(query, 10);
      const results = hits.map((h) => ({ id: h.path, title: h.description, url: memoryUrl(baseUrl, h.path) }));
      return text(JSON.stringify({ results }));
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch",
      description:
        "Fetch one memory by id (the memory path returned by search). Returns JSON {id,title,text,url,metadata}.",
      inputSchema: { id: pathSchema.describe("Memory id (path) from search results.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const m = await store.get(id);
      if (!m) return error(`No memory with id ${id}.`);
      return text(
        JSON.stringify({
          id: m.path,
          title: m.description,
          text: m.body,
          url: memoryUrl(baseUrl, m.path),
          metadata: { tags: m.tags, source: m.source, created_at: m.createdAt, updated_at: m.updatedAt },
        }),
      );
    },
  );

  return server;
}
