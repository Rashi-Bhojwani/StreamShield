import { afterEach, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { randomUUID } from "node:crypto";
import { type ChaosSnapshot, type ChaosExperiment } from "@streamshield/shared";
import { scenarios } from "../chaos/config.js";
import { experienceSummary } from "./experience.js";
import { monitoringRouter } from "./routes.js";
import { requireUser, PlatformError } from "../platform/security.js";
import type { Resources } from "../platform/resources.js";
import type { PlatformConfig } from "../platform/config.js";
import type { Config } from "../config.js";
vi.mock("../platform/security.js", async (original) => ({
  ...(await original<typeof import("../platform/security.js")>()),
  requireUser: vi.fn(),
}));
const dependency = {
  status: "available" as const,
  simulated: true as const,
  recommendations: ["Discover a live channel"],
};
function snapshot(): ChaosSnapshot {
  return {
    version: 1,
    available: true,
    enabled: true,
    databaseAvailable: true,
    observedAt: new Date().toISOString(),
    serverTime: new Date().toISOString(),
    staleAfterMs: 12000,
    activeId: null,
    faultDurationMs: 20000,
    timeoutMs: 180000,
    scenarios: scenarios.map((s) => ({
      ...s,
      available: s.supported,
      reason: null,
    })),
    experiments: [],
  };
}
function experiment(scenario: ChaosExperiment["scenario"]): ChaosExperiment {
  const at = new Date().toISOString();
  return {
    id: randomUUID(),
    actor: randomUUID(),
    scenario,
    target: "private-target",
    state: "HEALING_OBSERVED",
    createdAt: at,
    updatedAt: at,
    injectedAt: at,
    faultConfirmedAt: at,
    incidentDetectedAt: at,
    actionStartedAt: at,
    actionFinishedAt: null,
    verifiedAt: null,
    finishedAt: null,
    deadline: Date.now() + 180000,
    faultExpiresAt: null,
    incidentId: randomUUID(),
    recoveryIds: [],
    priorRecoveryIds: [],
    reason: "private internal detail",
    mechanism: null,
    cleanup: "NOT_REQUIRED",
    cancelRequestedBy: null,
    databasePersisted: true,
    evidence: { privateSecret: "must-not-be-returned" },
    events: [],
    measurements: {
      detectionMs: null,
      healingStartMs: null,
      actionMs: null,
      restorationMs: null,
      playbackInterruptionMs: null,
    },
  };
}
function app() {
  const a = express();
  a.use(express.json());
  a.use(monitoringRouter({} as Resources, {} as PlatformConfig, {} as Config));
  a.use(
    (
      e: Error,
      _q: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(e instanceof PlatformError ? e.status : 503)
        .json({ error: "unavailable" }),
  );
  return a;
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("CHAOS_URL", "http://controller.internal");
  vi.stubEnv("CHAOS_SECRET", "private-controller-secret");
  vi.stubEnv("HEALER_URL", "http://healer.internal");
  vi.stubEnv("HEALER_SECRET", "private-healer-secret");
  vi.mocked(requireUser).mockResolvedValue({
    user: { id: randomUUID(), role: "viewer" },
  } as Awaited<ReturnType<typeof requireUser>>);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([
  "crash-api",
  "crash-video-gateway",
  "crash-edge",
  "network-timeout",
] as const)(
  "projects actual %s impact without exposing controls or credentials",
  (id) => {
    const s = snapshot();
    s.experiments = [experiment(id)];
    const value = experienceSummary(s, dependency);
    expect(value.state).toBe("recovering");
    expect(value.scenario).toBe(id);
    expect(JSON.stringify(value)).not.toMatch(
      /private-target|must-not-be-returned|private internal detail/,
    );
    if (id === "crash-api" || id === "network-timeout")
      expect(value.message).toMatch(/independent|separate/);
  },
);
it("does not advertise stale history as active live recovery", () => {
  const s = snapshot();
  s.experiments = [experiment("crash-api")];
  s.observedAt = new Date(Date.now() - 60000).toISOString();
  expect(experienceSummary(s, dependency)).toMatchObject({
    state: "unavailable",
    available: false,
    observedAt: null,
    scenario: null,
  });
});
it("requires verified restoration and lets a recovery notice expire", () => {
  const s = snapshot(),
    e = experiment("crash-api");
  s.experiments = [e];
  e.state = "FAILED";
  e.finishedAt = new Date().toISOString();
  expect(experienceSummary(s, dependency).state).toBe("failed");
  e.events = [
    { kind: "BASELINE_REVERIFIED", at: e.finishedAt, detail: "Verified" },
  ];
  expect(experienceSummary(s, dependency).state).toBe("recovered");
  e.finishedAt = new Date(Date.now() - 31000).toISOString();
  expect(experienceSummary(s, dependency).state).toBe("healthy");
});
it("reflects failed dependency reads in the affected feature", () => {
  expect(
    experienceSummary(snapshot(), {
      status: "degraded",
      simulated: true,
      recommendations: [],
    }).recommendations,
  ).toMatchObject({ available: false, items: [] });
});
it("preserves a real dependency 503 as reconnecting rather than healthy or silently absent", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/dependency")
        ? new Response(
            JSON.stringify({
              status: "degraded",
              simulated: true,
              recommendations: [],
            }),
            { status: 503 },
          )
        : new Response(JSON.stringify(snapshot())),
    ),
  );
  const response = await request(app()).get("/experience");
  expect(response.status).toBe(200);
  expect(response.body.recommendations.available).toBe(false);
});
it("allows a viewer to read only the safe projection while keeping administrator operations protected", async () => {
  const s = snapshot();
  s.experiments = [experiment("network-timeout")];
  const fetch = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(String(url).includes("/dependency") ? dependency : s),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const a = app();
  const r = await request(a).get("/experience");
  expect(r.status).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.body.scenario).toBe("network-timeout");
  expect(JSON.stringify(r.body)).not.toMatch(/internal|secret|private-target/);
  expect((await request(a).get("/snapshot")).status).toBe(403);
  expect((await request(a).post("/chaos/experiments").send({})).status).toBe(
    403,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("coalesces concurrent reads without bypassing per-user authorization", async () => {
  const fetch = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).includes("/dependency") ? dependency : snapshot(),
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const a = app();
  const responses = await Promise.all([
    request(a).get("/experience"),
    request(a).get("/experience"),
  ]);
  expect(responses.every((r) => r.status === 200)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(requireUser).toHaveBeenCalledTimes(2);
});
it("rejects an unauthenticated read without contacting internal services", async () => {
  vi.mocked(requireUser).mockRejectedValue(
    new PlatformError(401, "AUTH_REQUIRED", "Sign in"),
  );
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect((await request(app()).get("/experience")).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});
it("does not expose the development feature in production", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect((await request(app()).get("/experience")).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});
