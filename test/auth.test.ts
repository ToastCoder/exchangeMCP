import { describe, expect, it } from "vitest";
import { bearerToken, isAuthorized, safeEqual } from "../src/auth";

const SECRET = "s3cret-token-0123456789";

describe("safeEqual", () => {
  it("compares values of any length", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abd")).toBe(false);
    expect(await safeEqual("abc", "abcd")).toBe(false);
    expect(await safeEqual("", "")).toBe(true);
  });
});

describe("bearerToken", () => {
  it("parses the Authorization header", () => {
    const req = (h?: string) => new Request("https://x/mcp", { headers: h ? { Authorization: h } : {} });
    expect(bearerToken(req(`Bearer ${SECRET}`))).toBe(SECRET);
    expect(bearerToken(req(`bearer   ${SECRET}  `))).toBe(SECRET);
    expect(bearerToken(req(`Basic abc`))).toBeNull();
    expect(bearerToken(req())).toBeNull();
  });
});

describe("isAuthorized", () => {
  const withHeader = (token: string) =>
    new Request("https://x/mcp", { headers: { Authorization: `Bearer ${token}` } });
  const plain = new Request("https://x/mcp");

  it("accepts a valid bearer token", async () => {
    expect(await isAuthorized(withHeader(SECRET), SECRET, null)).toBe(true);
  });

  it("accepts a valid path token", async () => {
    expect(await isAuthorized(plain, SECRET, SECRET)).toBe(true);
  });

  it("accepts path token even when a wrong header is present", async () => {
    expect(await isAuthorized(withHeader("nope"), SECRET, SECRET)).toBe(true);
  });

  it("rejects missing or wrong tokens", async () => {
    expect(await isAuthorized(plain, SECRET, null)).toBe(false);
    expect(await isAuthorized(withHeader("wrong"), SECRET, null)).toBe(false);
    expect(await isAuthorized(plain, SECRET, "wrong")).toBe(false);
  });

  it("fails closed when the secret is unset or too short", async () => {
    expect(await isAuthorized(withHeader(""), undefined, "")).toBe(false);
    expect(await isAuthorized(withHeader("short"), "short", "short")).toBe(false);
  });
});
