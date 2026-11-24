import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isAuthorized, unauthorized } from "./auth";
import { exportJson, exportZip } from "./export";
import { createMcpServer } from "./mcp";
import { DEFAULT_MAX_BODY_BYTES, MAX_REQUEST_BYTES, byteLength, pathSchema } from "./schemas";
import { D1MemoryStore } from "./storage/d1";
import type { MemoryStore } from "./storage/types";

export interface Env {
  DB: D1Database;
  /** Shared secret (Worker secret). */
  EXCHANGE_TOKEN?: string;
  /** Optional override of the max memory body size in bytes. */
  MAX_BODY_BYTES?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", error: { code, message }, id: null }, status);
}

function maxBodyBytes(env: Env): number {
  const n = Number(env.MAX_BODY_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

/** Split `/route/<token>` into route + decoded token (token segment optional). */
function parseRoute(pathname: string): { route: string; token: string | null; rest: string } {
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  const [, route = "", ...restParts] = trimmed.split("/");
  const rest = restParts.join("/");
  let token: string | null = null;
  if (restParts.length === 1 && restParts[0]) {
    try {
      token = decodeURIComponent(restParts[0]);
    } catch {
      token = null;
    }
  }
  return { route, token, rest };
}

async function handleMcp(request: Request, env: Env, store: MemoryStore, baseUrl: string): Promise<Response> {
  if (request.method !== "POST") {
    // Stateless server: no standalone SSE stream (GET) or session teardown (DELETE).
    return json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null },
      405,
      { Allow: "POST, OPTIONS" },
    );
  }

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_REQUEST_BYTES) return jsonRpcError(413, -32600, "Request too large");
  const raw = await request.text();
  if (byteLength(raw) > MAX_REQUEST_BYTES) return jsonRpcError(413, -32600, "Request too large");

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return jsonRpcError(400, -32700, "Parse error: invalid JSON");
  }

  const server = createMcpServer({ store, baseUrl, maxBodyBytes: maxBodyBytes(env) });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
  }
}

async function handleMemoryGet(rest: string, store: MemoryStore): Promise<Response> {
  const parsed = pathSchema.safeParse(`/${rest}`);
  if (!parsed.success) return json({ error: "invalid path" }, 400);
  const m = await store.get(parsed.data);
  if (!m) return json({ error: "not found" }, 404);
  return new Response(m.body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { route, token, rest } = parseRoute(url.pathname);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (route === "health" && !rest) {
    return new Response("ok", { headers: { "Content-Type": "text/plain" } });
  }

  const store = new D1MemoryStore(env.DB);

  if (route === "mcp") {
    if (rest && token === null) return json({ error: "not found" }, 404);
    if (!(await isAuthorized(request, env.EXCHANGE_TOKEN, token))) return withCors(unauthorized());
    return withCors(await handleMcp(request, env, store, url.origin));
  }

  if (route === "export") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET" });
    if (rest && token === null) return json({ error: "not found" }, 404);
    if (!(await isAuthorized(request, env.EXCHANGE_TOKEN, token))) return unauthorized();
    const format = url.searchParams.get("format") ?? "json";
    if (format === "zip") return exportZip(store);
    if (format === "json") return exportJson(store);
    return json({ error: "format must be 'json' or 'zip'" }, 400);
  }

  if (route === "memory" && rest) {
    // Header auth only: the URL path here is the memory path, not a token.
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET" });
    if (!(await isAuthorized(request, env.EXCHANGE_TOKEN, null))) return unauthorized();
    return handleMemoryGet(rest, store);
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      // Never log tokens, request bodies or memory content: error class only.
      console.error("unhandled error", err instanceof Error ? err.name : typeof err);
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
