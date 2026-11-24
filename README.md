# exchangeMCP

A universal memory server for AI assistants. Add it as a custom connector in Claude, ChatGPT, Gemini or any other MCP client, and any of them can save and recall memories. Something you discuss in one app can then be picked up in another.

- **Runtime:** TypeScript on Cloudflare Workers (free tier)
- **Protocol:** MCP Streamable HTTP, stateless, at `POST /mcp`
- **Storage:** Cloudflare D1 (SQLite) with an FTS5 full-text index, behind a swappable `MemoryStore` interface
- **Auth:** a shared secret, sent either as `Authorization: Bearer <token>` or in the URL path as `/mcp/<token>`

## Memory format

Each memory is one markdown "file", addressed by a path such as `/writing/style.md`. The format mirrors Claude's memory files:

```markdown
---
name: style
description: "How I like my writing"
---

- [stated] Prefers British spelling
- [stated] Short sentences, no em dashes
```

Columns: `path` (unique), `description` (one line), `body` (markdown), `tags` (JSON array), `source` (the AI that last wrote it, e.g. `claude`, `chatgpt`, `gemini`), `created_at`, `updated_at`.

Paths are normalised to lowercase, get a leading `/`, and get `.md` appended if it's missing. Each segment may only contain `a-z 0-9 . _ -`. If `write_memory` receives a body without frontmatter, the frontmatter is added automatically.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_memories(prefix?)` | Index of paths with their descriptions and `updated_at` |
| `read_memory(path)` | Full markdown plus metadata |
| `write_memory(path, description, body, tags?, source)` | Create or overwrite |
| `append_memory(path, content, source)` | Append lines to an existing memory (atomic, size-checked) |
| `delete_memory(path)` | Delete a memory |
| `search_memory(query, limit?)` | Ranked FTS5 (bm25) results with snippets |
| `search(query)` | ChatGPT connector alias. Returns one text item: `{"results":[{"id","title","url"}]}` |
| `fetch(id)` | ChatGPT connector alias. Returns one text item: `{"id","title","text","url","metadata"}` |

For `search` and `fetch`, the `id` is the memory path. The server also sends MCP `instructions` telling clients to check memory at the start of a chat, and to store only durable facts the user stated, never secrets or passwords.

## HTTP routes

| Route | Auth | Description |
| --- | --- | --- |
| `POST /mcp`, `POST /mcp/<token>` | yes | MCP endpoint. `GET` returns 405 because the server is stateless. |
| `GET /export?format=json\|zip` | yes | Backup. JSON, or a zip of `.md` files plus a `MEMORY.md` index. `/export/<token>` also works. |
| `GET /memory/<path>` | Bearer header only | Raw markdown of one memory. This is the `url` used in `search`/`fetch` results. |
| `GET /health` | no | Returns `ok` |

Limits: each memory body is capped at 64 KB (`MAX_BODY_BYTES` in `wrangler.toml`), each request at 512 KB, and every tool input is validated with zod.

## Setup

Prerequisites: Node 20+ and a free Cloudflare account. Everything runs through `npx wrangler`, so you don't need a global install.

```bash
npm install
npx wrangler login
```

### 1. Create the D1 database

```bash
npx wrangler d1 create exchange
```

You don't need to copy the `database_id` anywhere. `wrangler.toml` binds the database by name (`database_name = "exchange"`), and Wrangler looks up the ID in your account when it deploys or runs remote migrations, so the ID never ends up in the repo. If you use a different name, change `database_name` to match. If Wrangler offers to write a `database_id` into `wrangler.toml`, discard that change.

### 2. Apply migrations

```bash
npm run db:migrate:local    # local dev database (.wrangler/)
npm run db:migrate:remote   # the real D1 database
```

### 3. Set the secret

Generate a long random token. Tokens shorter than 16 characters are rejected.

```bash
openssl rand -hex 32
npx wrangler secret put EXCHANGE_TOKEN      # paste the token when prompted
```

For local dev:

```bash
cp .dev.vars.example .dev.vars              # then put a token in .dev.vars
```

### 4. Local dev

```bash
npm run dev                                 # wrangler dev → http://localhost:8787
curl localhost:8787/health
```

Try it with the MCP Inspector (`npx @modelcontextprotocol/inspector`): choose transport "Streamable HTTP", use URL `http://localhost:8787/mcp`, and add the header `Authorization: Bearer <token>`.

### 5. Deploy

```bash
npm run deploy                              # wrangler deploy
```

Your endpoint is `https://exchange-mcp.<your-subdomain>.workers.dev/mcp`.

## Connecting AI clients

Use one of these two URL forms:

- **Header auth (preferred):** `https://…workers.dev/mcp`, with `Authorization: Bearer <token>`
- **URL auth (for UIs without a headers field):** `https://…workers.dev/mcp/<token>`

> Treat the `/mcp/<token>` URL like a password. Anyone who has it can read and write your memories. To revoke it, rotate the secret with `wrangler secret put EXCHANGE_TOKEN`.

Menu names change often, and custom connectors may require a paid plan. The steps below describe the general flow.

### Claude (claude.ai, Desktop, mobile)

1. Go to **Settings → Connectors → Add custom connector**.
2. Name: `exchange`. URL: `https://…workers.dev/mcp/<token>`.
3. Leave the OAuth fields empty, then save. In a chat, enable the connector from the tools menu.

Claude Code:

```bash
claude mcp add --transport http exchange https://…workers.dev/mcp --header "Authorization: Bearer <token>"
```

### ChatGPT

1. Go to **Settings → Apps & Connectors → Advanced** and enable **Developer mode**.
2. **Create** a connector. MCP server URL: `https://…workers.dev/mcp/<token>`. Authentication: **No authentication**, because the token is in the URL.
3. ChatGPT uses `search` and `fetch` for deep research and connector search. In developer mode, every tool is available.

### Gemini

Gemini CLI (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "exchange": {
      "httpUrl": "https://…workers.dev/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

If your Gemini app or Workspace edition lets you add custom MCP connectors, use the same URL. Use `/mcp/<token>` if it has no headers field.

### Any other MCP client

Point a Streamable HTTP client at `/mcp` with the Bearer header, or at `/mcp/<token>`.

## Custom instruction

To make each assistant use the memory consistently, add this line to its custom instructions (Claude: profile preferences; ChatGPT: Customize ChatGPT; Gemini: saved info):

> At the start of a chat, check exchange for relevant memory. Save durable facts there when I ask.

## Backup

```bash
curl -H "Authorization: Bearer $TOKEN" "https://…workers.dev/export" -o exchange.json
curl -H "Authorization: Bearer $TOKEN" "https://…workers.dev/export?format=zip" -o exchange.zip
```

## Tests

```bash
npm test          # Vitest inside workerd (Miniflare) with a real local D1 and migrations applied
npm run typecheck
```

The tests cover the storage layer (CRUD, prefix listing, atomic append, FTS5 ranking, trigger sync, FTS injection), auth (bearer, path token, constant-time compare, fail-closed), every MCP tool (through an in-memory MCP client), and the HTTP routes (401/404/405/413, stateless initialize, export JSON/zip).

## Project layout

```
migrations/0001_init.sql   memories table, FTS5 index, sync triggers
src/index.ts               Worker router (/health, /mcp, /export, /memory)
src/auth.ts                Bearer / path-token auth, constant-time compare, OAuth TODO
src/mcp.ts                 MCP server factory and tool definitions
src/schemas.ts             zod schemas, path normalisation, size limits
src/export.ts              JSON / zip export
src/storage/types.ts       MemoryStore interface
src/storage/d1.ts          D1 implementation
test/                      Vitest suites
```

## Swapping storage

Everything outside `src/storage/` depends only on the `MemoryStore` interface in `src/storage/types.ts`. To move to Postgres or Azure SQL:

1. Implement `MemoryStore`. Use a `tsvector`/GIN index (Postgres) or a full-text index (Azure SQL) in place of FTS5.
2. Construct it in `src/index.ts` instead of `D1MemoryStore`. From a Worker, Postgres can be reached through Hyperdrive.

## Security notes

- Tokens are compared in constant time: both values are SHA-256 hashed, then XOR-compared.
- The server never logs tokens, request bodies or memory content. Unhandled errors log only the error class.
- A URL-path token can still show up in platform request logs. That includes `wrangler dev` output and Cloudflare's request logs, if you enable them. Prefer the Bearer header wherever the client supports it.
- Memories are meant for durable facts, not secrets. The tool descriptions tell every AI client this.
- **TODO (OAuth):** add OAuth 2.1 per the MCP authorization spec, probably with `@cloudflare/workers-oauth-provider`. That would let Claude and ChatGPT run their native connector sign-in and give each client its own revocable token. See the TODO in `src/auth.ts`.

## License

MIT
