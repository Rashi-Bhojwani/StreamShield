import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { chaosRoutes } from "./routes.js";
import { csrfToken, PlatformError } from "../platform/security.js";
import type { PlatformConfig } from "../platform/config.js";
import type { Config } from "../config.js";
import type { Resources } from "../platform/resources.js";
const c = { CSRF_SECRET: "s".repeat(43) } as PlatformConfig;
const nonce = "n".repeat(43),
  origin = "http://localhost:8080";
function app() {
  const a = express(),
    router = express.Router();
  a.use(express.json());
  router.use((_q, r, next) => {
    r.locals.monitoringActor = "c8e2077f-bafb-4e21-bc94-5e152f7b2aaf";
    next();
  });
  chaosRoutes(router, {} as Resources, c, { CORS_ORIGINS: [origin] } as Config);
  a.use(router);
  a.use(
    (
      e: unknown,
      _q: express.Request,
      r: express.Response,
      _n: express.NextFunction,
    ) =>
      r
        .status(e instanceof PlatformError ? e.status : 500)
        .json({ code: e instanceof PlatformError ? e.code : "error" }),
  );
  return a;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("denies a correctly signed administrative mutation in production before forwarding", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CHAOS_ENABLED", "true");
  vi.stubEnv("CHAOS_ENVIRONMENT", "local-development");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const r = await request(app())
    .post("/chaos/experiments")
    .set("Origin", origin)
    .set("Cookie", "ss_csrf=" + nonce)
    .set("X-CSRF-Token", csrfToken(nonce, c))
    .send({});
  expect(r.status).toBe(403);
  expect(r.body.code).toBe("CHAOS_DISABLED");
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["missing", "forged", "cross-origin"])(
  "denies %s CSRF before forwarding",
  async (kind) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const r = await request(app())
      .post("/chaos/experiments")
      .set("Origin", kind === "cross-origin" ? "http://attacker.test" : origin)
      .set("Cookie", "ss_csrf=" + nonce)
      .set(
        "X-CSRF-Token",
        kind === "missing"
          ? ""
          : kind === "forged"
            ? "forged"
            : csrfToken(nonce, c),
      )
      .send({});
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("CSRF_REJECTED");
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("rejects arbitrary service commands even with correct CSRF and local gate", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("CHAOS_ENABLED", "true");
  vi.stubEnv("CHAOS_ENVIRONMENT", "local-development");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const r = await request(app())
    .post("/chaos/experiments")
    .set("Origin", origin)
    .set("Cookie", "ss_csrf=" + nonce)
    .set("X-CSRF-Token", csrfToken(nonce, c))
    .send({
      id: "c8e2077f-bafb-4e21-bc94-5e152f7b2aaf",
      scenario: "crash-api",
      confirmation: "api-1",
      command: "rm",
      containerId: "arbitrary",
    });
  expect(r.status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
