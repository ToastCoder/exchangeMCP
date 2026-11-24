/**
 * Shared-secret auth.
 *
 * Accepted forms (many connector UIs cannot set custom headers):
 *   1. `Authorization: Bearer <token>`
 *   2. A token as the last path segment: `/mcp/<token>`, `/export/<token>`
 *
 * The expected token is the `EXCHANGE_TOKEN` Worker secret. Tokens are never
 * logged.
 *
 * TODO(oauth): Replace/augment the shared secret with OAuth 2.1 (MCP
 * authorization spec) so Claude/ChatGPT can run their native connector sign-in
 * flow and we can issue per-client, revocable tokens. Likely approach:
 * `@cloudflare/workers-oauth-provider` wrapping this Worker, storing grants in
 * KV, with this shared secret kept as an admin/backup credential.
 */

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/**
 * Constant-time string comparison. Both values are hashed first so the
 * comparison always covers 32 bytes regardless of input length.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}

/** Extract a bearer token from the Authorization header, if any. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Check a request against the configured secret. `pathToken` is the token
 * taken from the URL path (already URL-decoded), if the route has one.
 */
export async function isAuthorized(
  request: Request,
  expected: string | undefined,
  pathToken: string | null,
): Promise<boolean> {
  // Fail closed if the secret is missing or trivially short.
  if (!expected || expected.length < 16) return false;
  const candidates = [bearerToken(request), pathToken].filter((t): t is string => !!t);
  if (candidates.length === 0) return false;
  for (const candidate of candidates) {
    if (await safeEqual(candidate, expected)) return true;
  }
  return false;
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="exchange"',
    },
  });
}
