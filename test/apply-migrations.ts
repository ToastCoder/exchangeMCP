import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Start every test from an empty table (triggers keep the FTS index in sync).
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM memories").run();
});
