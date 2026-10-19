import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { parseResilience } from "../infrastructure/resilience/config.mjs";
const defaults = {
  ...parseEnv(
    readFileSync(new URL("../.env.example", import.meta.url), "utf8"),
  ),
  RESILIENCE_REPLICATION_SECRET: "r".repeat(43),
  RESILIENCE_HLS_SECRET: "h".repeat(43),
};
describe("resilience boundaries", () => {
  it("validates the documented topology while preserving bounded resource and retry settings", () => {
    const c = parseResilience(defaults);
    expect(c.RESILIENCE_UPSTREAM_TRIES).toBe(2);
    expect(c.RESILIENCE_API1_HOST).not.toBe(c.RESILIENCE_API2_HOST);
    expect(c.RESILIENCE_DB_POOL_MAX * 2).toBeLessThanOrEqual(20);
  });
  it("rejects peer alias collisions, unsafe config injection and invalid retry/cache limits", () => {
    for (const bad of [
      { RESILIENCE_PRIMARY_HOST: defaults.RESILIENCE_STANDBY_HOST },
      { RESILIENCE_API1_HOST: "postgres" },
      { RESILIENCE_EDGE1_HOST: "host; include /tmp/evil;" },
      { RESILIENCE_UPSTREAM_TRIES: 1000 },
      { RESILIENCE_CACHE_MAX_MB: 0 },
      { CORS_ORIGINS: "http://localhost:5173/;include /tmp/evil;" },
    ])
      expect(() => parseResilience({ ...defaults, ...bad })).toThrow();
  });
  it("does not include the replication credential in validation errors", () => {
    const sensitive = "invalid-credential-do-not-print";
    let message = "";
    try {
      parseResilience({
        ...defaults,
        RESILIENCE_REPLICATION_SECRET: sensitive,
      });
    } catch (e) {
      message = e.message;
    }
    expect(message).toContain("RESILIENCE_REPLICATION_SECRET");
    expect(message).not.toContain(sensitive);
  });
});
