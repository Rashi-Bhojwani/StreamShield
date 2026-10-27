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
      r.status(e instanceof PlatformError ? e.status : 500).json({
        code: e instanceof PlatformError ? e.code : "error",
        message: e instanceof PlatformError ? e.message : "error",
      }),
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
it.each(["production", "bad-confirmation", "no-csrf"])(
  "denies unsafe manual restoration requests: %s",
  async (kind) => {
    vi.stubEnv(
      "NODE_ENV",
      kind === "production" ? "production" : "development",
    );
    vi.stubEnv("CHAOS_ENABLED", "true");
    vi.stubEnv("CHAOS_ENVIRONMENT", "local-development");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const r = await request(app())
      .post(
        "/chaos/experiments/c8e2077f-bafb-4e21-bc94-5e152f7b2aaf/restore-media-authority",
      )
      .set("Origin", origin)
      .set("Cookie", "ss_csrf=" + nonce)
      .set("X-CSRF-Token", kind === "no-csrf" ? "" : csrfToken(nonce, c))
      .send({
        confirmation: kind === "bad-confirmation" ? "wrong" : "media-authority",
      });
    expect(r.status).toBe(kind === "bad-confirmation" ? 400 : 403);
    expect(fetch).not.toHaveBeenCalled();
  },
);
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

it("returns honest unavailable metadata when both controller forwarding and history persistence fail", async () => {
  vi.stubEnv("CHAOS_URL", "http://controller:4030");
  vi.stubEnv("CHAOS_SECRET", "x".repeat(43));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
  const response = await request(app()).get("/chaos");
  expect(response.status).toBe(200);
  expect(response.body.available).toBe(false);
  expect(response.body.databaseAvailable).toBe(false);
  expect(response.body.observedAt).toBeNull();
  expect(response.body.unavailableReason).toContain("persistence");
});
it("distinguishes private controller authorization from an expired browser login", async () => {
  vi.stubEnv("CHAOS_URL", "http://controller:4030");
  vi.stubEnv("CHAOS_SECRET", "x".repeat(43));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 }),
    ),
  );
  const response = await request(app()).get("/chaos");
  expect(response.status).toBe(200);
  expect(response.body.available).toBe(false);
  expect(response.body.unavailableReason).toContain(
    "Internal controller authorization",
  );
});

it("preserves the exact safe controller prerequisite reason on a rejected mutation", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("CHAOS_ENABLED", "true");
  vi.stubEnv("CHAOS_ENVIRONMENT", "local-development");
  vi.stubEnv("CHAOS_URL", "http://controller:4030");
  vi.stubEnv("CHAOS_SECRET", "x".repeat(43));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "prerequisites_unavailable",
            reason:
              "Required services have not returned to a healthy baseline: api-2 (DEGRADED, http_503)",
          }),
          { status: 409 },
        ),
    ),
  );
  const r = await request(app())
    .post("/chaos/experiments")
    .set("Origin", origin)
    .set("Cookie", "ss_csrf=" + nonce)
    .set("X-CSRF-Token", csrfToken(nonce, c))
    .send({
      id: "c8e2077f-bafb-4e21-bc94-5e152f7b2aaf",
      scenario: "crash-api",
      confirmation: "api-1",
    });
  expect(r.status).toBe(409);
  expect(r.body.message).toContain("api-2 (DEGRADED, http_503)");
});
