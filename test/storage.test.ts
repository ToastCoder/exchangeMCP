import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { D1MemoryStore, buildFtsQuery } from "../src/storage/d1";

const store = () => new D1MemoryStore(env.DB);

const base = {
  description: "How the user likes to write",
  body: "---\nname: style\ndescription: writing\n---\n\n- [stated] Prefers British spelling\n",
  tags: ["writing", "style"],
  source: "claude",
};

describe("D1MemoryStore", () => {
  it("creates and reads a memory", async () => {
    const s = store();
    const created = await s.put({ path: "/writing/style.md", ...base });
    expect(created.path).toBe("/writing/style.md");
    expect(created.tags).toEqual(["writing", "style"]);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const read = await s.get("/writing/style.md");
    expect(read).toEqual(created);
    expect(await s.get("/missing.md")).toBeNull();
  });

  it("overwrites on put while preserving created_at", async () => {
    const s = store();
    const first = await s.put({ path: "/a.md", ...base });
    const second = await s.put({ path: "/a.md", ...base, description: "changed", source: "chatgpt", tags: [] });
    expect(second.description).toBe("changed");
    expect(second.source).toBe("chatgpt");
    expect(second.tags).toEqual([]);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);
    expect((await s.list()).length).toBe(1);
  });

  it("lists by prefix, sorted by path", async () => {
    const s = store();
    await s.put({ path: "/writing/tone.md", ...base });
    await s.put({ path: "/writing/style.md", ...base });
    await s.put({ path: "/work/projects.md", ...base, description: "Projects" });
    expect((await s.list()).map((m) => m.path)).toEqual([
      "/work/projects.md",
      "/writing/style.md",
      "/writing/tone.md",
    ]);
    const writing = await s.list("/writing");
    expect(writing.map((m) => m.path)).toEqual(["/writing/style.md", "/writing/tone.md"]);
    expect(writing[0]).toEqual({ path: "/writing/style.md", description: base.description, updatedAt: expect.any(String) });
    expect(await s.list("/nope")).toEqual([]);
  });

  it("appends with a newline separator and records the source", async () => {
    const s = store();
    await s.put({ path: "/a.md", ...base, body: "line one" });
    const res = await s.append("/a.md", "- [stated] line two\n", "gemini", 2048);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.memory.body).toBe("line one\n- [stated] line two\n");
    expect(res.memory.source).toBe("gemini");
  });

  it("append reports not_found and too_large", async () => {
    const s = store();
    expect(await s.append("/missing.md", "x", "claude", 2048)).toEqual({ ok: false, reason: "not_found" });
    await s.put({ path: "/a.md", ...base, body: "x".repeat(100) });
    expect(await s.append("/a.md", "y".repeat(100), "claude", 150)).toEqual({ ok: false, reason: "too_large" });
    expect((await s.get("/a.md"))!.body).toBe("x".repeat(100));
  });

  it("deletes", async () => {
    const s = store();
    await s.put({ path: "/a.md", ...base });
    expect(await s.delete("/a.md")).toBe(true);
    expect(await s.delete("/a.md")).toBe(false);
    expect(await s.get("/a.md")).toBeNull();
  });

  it("searches with ranking and snippets, kept in sync by triggers", async () => {
    const s = store();
    await s.put({ path: "/writing/style.md", ...base });
    await s.put({
      path: "/food/diet.md",
      description: "Dietary preferences",
      body: "- [stated] Vegetarian, no mushrooms",
      tags: ["food"],
      source: "chatgpt",
    });

    const hits = await s.search("british spelling", 10);
    expect(hits.map((h) => h.path)).toEqual(["/writing/style.md"]);
    expect(hits[0]!.snippet).toContain("**British**");
    expect(hits[0]!.score).toBeGreaterThan(0);

    // Matches tags and stems (porter): "vegetarians" -> vegetarian
    expect((await s.search("vegetarians", 10)).map((h) => h.path)).toEqual(["/food/diet.md"]);
    expect((await s.search("food", 10)).map((h) => h.path)).toEqual(["/food/diet.md"]);

    // OR fallback when not every term matches
    expect((await s.search("mushrooms spaceship", 10)).map((h) => h.path)).toEqual(["/food/diet.md"]);

    // Updates and deletes propagate to the FTS index
    await s.put({ path: "/food/diet.md", description: "Diet", body: "- [stated] Vegan", tags: [], source: "claude" });
    expect(await s.search("mushrooms", 10)).toEqual([]);
    expect((await s.search("vegan", 10)).length).toBe(1);
    await s.delete("/food/diet.md");
    expect(await s.search("vegan", 10)).toEqual([]);
  });

  it("never lets FTS syntax through and respects limit", async () => {
    const s = store();
    for (let i = 0; i < 5; i++) await s.put({ path: `/n${i}.md`, ...base });
    expect(await s.search('"); DROP TABLE memories; -- NEAR( * ', 10)).toBeInstanceOf(Array);
    expect(await s.search("!!! ???", 10)).toEqual([]);
    expect((await s.search("british", 2)).length).toBe(2);
  });

  it("returns all memories for export", async () => {
    const s = store();
    await s.put({ path: "/b.md", ...base });
    await s.put({ path: "/a.md", ...base });
    expect((await s.all()).map((m) => m.path)).toEqual(["/a.md", "/b.md"]);
  });
});

describe("buildFtsQuery", () => {
  it("quotes tokens and drops operators", () => {
    expect(buildFtsQuery('foo "bar" OR baz*', "and")).toBe('"foo" AND "bar" AND "or" AND "baz"');
    expect(buildFtsQuery("a b", "or")).toBe('"a" OR "b"');
    expect(buildFtsQuery("  ", "and")).toBeNull();
  });
});
