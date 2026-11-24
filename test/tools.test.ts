import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp";
import { D1MemoryStore } from "../src/storage/d1";
import { MAX_BODY } from "./helpers";

let client: Client;

beforeEach(async () => {
  const server = createMcpServer({
    store: new D1MemoryStore(env.DB),
    baseUrl: "https://exchange.example",
    maxBodyBytes: MAX_BODY,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = res.content[0];
  return { text: first && first.type === "text" ? first.text : "", isError: res.isError === true };
}

const write = (path: string, extra: Record<string, unknown> = {}) =>
  call("write_memory", {
    path,
    description: "Writing style",
    body: "- [stated] Prefers British spelling",
    tags: ["Writing", "writing", "style"],
    source: "Claude",
    ...extra,
  });

describe("tool listing", () => {
  it("exposes all tools with descriptions and annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["append_memory", "delete_memory", "fetch", "list_memories", "read_memory", "search", "search_memory", "write_memory"].sort(),
    );
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(40);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.write_memory!.description).toMatch(/passwords/);
    expect(byName.search!.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_memory!.annotations?.destructiveHint).toBe(true);
    expect(byName.write_memory!.inputSchema.required).toEqual(
      expect.arrayContaining(["path", "description", "body", "source"]),
    );
  });

  it("sends server instructions", () => {
    expect(client.getInstructions()).toMatch(/Never store secrets/);
  });
});

describe("write_memory / read_memory", () => {
  it("normalises input, adds frontmatter and reads back", async () => {
    const w = await write("Writing/Style");
    expect(w.isError).toBe(false);
    expect(w.text).toContain("/writing/style.md");

    const r = await call("read_memory", { path: "/writing/style.md" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("source: claude");
    expect(r.text).toContain('tags: ["writing","style"]');
    expect(r.text).toContain('---\nname: style\ndescription: "Writing style"\n---');
    expect(r.text).toContain("- [stated] Prefers British spelling");
  });

  it("keeps an existing frontmatter untouched", async () => {
    const body = "---\nname: custom\ndescription: mine\n---\n- [stated] x\n";
    await write("/a.md", { body });
    const stored = await new D1MemoryStore(env.DB).get("/a.md");
    expect(stored!.body).toBe(body);
  });

  it("rejects invalid paths, sources and oversized bodies", async () => {
    expect((await write("/../etc/passwd")).isError).toBe(true);
    expect((await write("/a/.hidden.md")).isError).toBe(true);
    expect((await write("/a b.md")).isError).toBe(true);
    expect((await write("/ok.md", { source: "not a client!" })).isError).toBe(true);
    expect((await write("/ok.md", { description: "  " })).isError).toBe(true);
    expect((await write("/ok.md", { body: "x".repeat(MAX_BODY + 1) })).isError).toBe(true);
    expect((await call("list_memories", {})).text).toBe("No memories saved yet.");
  });

  it("errors when reading a missing memory", async () => {
    const r = await call("read_memory", { path: "/nope.md" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No memory at /nope.md");
  });
});

describe("list_memories", () => {
  it("returns an index, optionally filtered by prefix", async () => {
    await write("/writing/style.md");
    await write("/food/diet.md", { description: "Diet" });
    const all = await call("list_memories", {});
    expect(all.text).toMatch(/^2 memories:/);
    expect(all.text).toContain("- /food/diet.md — Diet (updated ");
    const writing = await call("list_memories", { prefix: "writing" });
    expect(writing.text).toMatch(/^1 memory:/);
    expect(writing.text).not.toContain("/food/");
  });
});

describe("append_memory", () => {
  it("appends lines to an existing memory", async () => {
    await write("/a.md");
    const a = await call("append_memory", { path: "/a.md", content: "- [stated] Uses Oxford commas", source: "gemini" });
    expect(a.isError).toBe(false);
    const r = await call("read_memory", { path: "/a.md" });
    expect(r.text).toMatch(/British spelling\n- \[stated\] Uses Oxford commas\n$/);
    expect(r.text).toContain("source: gemini");
  });

  it("errors on missing memory, empty content and size overflow", async () => {
    expect((await call("append_memory", { path: "/x.md", content: "hi", source: "claude" })).text).toMatch(/write_memory/);
    await write("/a.md");
    expect((await call("append_memory", { path: "/a.md", content: "   ", source: "claude" })).isError).toBe(true);
    const big = "y".repeat(MAX_BODY - 50);
    const r = await call("append_memory", { path: "/a.md", content: big, source: "claude" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/limit/);
  });
});

describe("delete_memory", () => {
  it("deletes and reports missing", async () => {
    await write("/a.md");
    expect((await call("delete_memory", { path: "/a.md" })).isError).toBe(false);
    expect((await call("delete_memory", { path: "/a.md" })).isError).toBe(true);
  });
});

describe("search_memory", () => {
  it("returns ranked results with snippets", async () => {
    await write("/writing/style.md");
    await write("/food/diet.md", { description: "Diet", body: "- [stated] Vegetarian", tags: ["food"] });
    const r = await call("search_memory", { query: "british", limit: 5 });
    expect(r.text).toMatch(/^1\. \/writing\/style\.md — Writing style/);
    expect(r.text).toContain("**British**");
    expect((await call("search_memory", { query: "zzz" })).text).toBe('No memories match "zzz".');
    expect((await call("search_memory", { query: "x", limit: 0 })).isError).toBe(true);
  });
});

describe("ChatGPT aliases", () => {
  it("search returns {results:[{id,title,url}]}", async () => {
    await write("/writing/style.md");
    const r = await call("search", { query: "spelling" });
    expect(JSON.parse(r.text)).toEqual({
      results: [
        { id: "/writing/style.md", title: "Writing style", url: "https://exchange.example/memory/writing/style.md" },
      ],
    });
    expect(JSON.parse((await call("search", { query: "nothing" })).text)).toEqual({ results: [] });
  });

  it("fetch returns {id,title,text,url,metadata}", async () => {
    await write("/writing/style.md");
    const r = await call("fetch", { id: "/writing/style.md" });
    const doc = JSON.parse(r.text);
    expect(doc).toMatchObject({
      id: "/writing/style.md",
      title: "Writing style",
      url: "https://exchange.example/memory/writing/style.md",
      metadata: { tags: ["writing", "style"], source: "claude" },
    });
    expect(doc.text).toContain("British spelling");
    expect(doc.metadata.created_at).toBeTruthy();
    expect((await call("fetch", { id: "/nope.md" })).isError).toBe(true);
  });
});
