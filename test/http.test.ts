import { env } from "cloudflare:workers";
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { TOKEN } from "./helpers";

const ORIGIN = "https://exchange.example";

function fetchWorker(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
}

let rpcId = 0;
function rpc(path: string, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  return fetchWorker(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("GET /health", () => {
  it("is public", async () => {
    const res = await fetchWorker("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("/mcp auth", () => {
  it("rejects requests without a token", async () => {
    const res = await rpc("/mcp", "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("rejects a wrong bearer or path token", async () => {
    expect((await rpc("/mcp", "tools/list", {}, { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await rpc("/mcp/nope", "tools/list")).status).toBe(401);
    expect((await rpc(`/mcp/${TOKEN}/extra`, "tools/list")).status).toBe(404);
  });

  it("accepts a bearer token", async () => {
    const res = await rpc("/mcp", "tools/list", {}, auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toContain("search_memory");
  });

  it("accepts a token in the URL path", async () => {
    const res = await rpc(`/mcp/${encodeURIComponent(TOKEN)}`, "tools/list");
    expect(res.status).toBe(200);
  });
});

describe("/mcp protocol", () => {
  it("handles initialize statelessly (no session id)", async () => {
    const res = await rpc("/mcp", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    }, auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(body.result.serverInfo.name).toBe("exchange");
    expect(body.result.instructions).toMatch(/exchange/);
  });

  it("round-trips a write then read over HTTP across separate requests", async () => {
    const write = await rpc("/mcp", "tools/call", {
      name: "write_memory",
      arguments: { path: "/writing/style.md", description: "Style", body: "- [stated] Short sentences", source: "chatgpt" },
    }, auth);
    expect(write.status).toBe(200);

    const read = await rpc(`/mcp/${TOKEN}`, "tools/call", { name: "read_memory", arguments: { path: "/writing/style.md" } });
    const body = (await read.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content[0]!.text).toContain("Short sentences");
    expect(body.result.content[0]!.text).toContain("source: chatgpt");
  });

  it("rejects GET on /mcp with 405 and bad JSON with 400", async () => {
    expect((await fetchWorker("/mcp", { headers: auth })).status).toBe(405);
    const bad = await fetchWorker("/mcp", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
  });

  it("rejects oversized requests with 413", async () => {
    const res = await rpc("/mcp", "tools/call", {
      name: "write_memory",
      arguments: { path: "/big.md", description: "big", body: "x".repeat(600 * 1024), source: "claude" },
    }, auth);
    expect(res.status).toBe(413);
  });

  it("answers CORS preflight", async () => {
    const res = await fetchWorker("/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});

async function seed() {
  await rpc("/mcp", "tools/call", {
    name: "write_memory",
    arguments: { path: "/writing/style.md", description: "Style", body: "- [stated] Short sentences", source: "claude" },
  }, auth);
}

describe("GET /export", () => {
  it("requires auth", async () => {
    expect((await fetchWorker("/export")).status).toBe(401);
  });

  it("exports JSON by default", async () => {
    await seed();
    const res = await fetchWorker("/export", { headers: auth });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { count: number; memories: { path: string; body: string }[] };
    expect(data.count).toBe(1);
    expect(data.memories[0]!.path).toBe("/writing/style.md");
    expect(data.memories[0]!.body).toContain("Short sentences");
  });

  it("exports a zip of markdown files with a path token", async () => {
    await seed();
    const res = await fetchWorker(`/export/${TOKEN}?format=zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["MEMORY.md", "writing/style.md"]);
    expect(strFromU8(files["writing/style.md"]!)).toContain("Short sentences");
    expect(strFromU8(files["MEMORY.md"]!)).toContain("writing/style.md");
  });

  it("rejects unknown formats", async () => {
    expect((await fetchWorker("/export?format=xml", { headers: auth })).status).toBe(400);
  });
});

describe("GET /memory/<path>", () => {
  it("serves raw markdown with bearer auth only", async () => {
    await seed();
    expect((await fetchWorker("/memory/writing/style.md")).status).toBe(401);
    const res = await fetchWorker("/memory/writing/style.md", { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(await res.text()).toContain("Short sentences");
    expect((await fetchWorker("/memory/nope.md", { headers: auth })).status).toBe(404);
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    expect((await fetchWorker("/")).status).toBe(404);
  });
});
