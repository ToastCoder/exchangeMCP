import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      EXCHANGE_TOKEN: string;
      MAX_BODY_BYTES: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
