import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { understandableLog, logRoutes } from "./logs.js";
import { monitoringRouter } from "./routes.js";
import { requireUser, PlatformError } from "../platform/security.js";
import type { Resources } from "../platform/resources.js";
import type { PlatformConfig } from "../platform/config.js";
import type { Config } from "../config.js";
vi.mock("../platform/security.js", async (original) => ({
  ...(await original<typeof import("../platform/security.js")>()),
  requireUser: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
const at = new Date().toISOString();
it("explains escalation and human intervention without returning private raw details", () => {
  const secret = "private-stream-key-never-display";
  const e = understandableLog("experiment", {
    id: "1",
    at,
    component: "media-authority",
    kind: "HUMAN_ACTION_REQUIRED",
    reason: secret,
  });
  expect(e).toMatchObject({
    level: "warning",
    component: "Media authorization",
  });
  expect(e?.nextStep).toContain("privileged");
  expect(JSON.stringify(e)).not.toContain(secret);
  expect(
    understandableLog("experiment", { id: "2", at, kind: secret }),
  ).toBeNull();
  expect(
    understandableLog("recovery", {
      id: "3",
      at,
      state: "ESCALATED",
      reason: "control_precondition_rejected:unsafe_container_state",
    })?.nextStep,
  ).toContain("safety check rejected");
  expect(
    understandableLog("experiment", {
      id: "4",
      at,
      kind: "COMPLETED",
      manual: true,
    })?.message,
  ).toContain("not automatically healed");
});
it("returns bounded newest-first events and explicitly reports missing history sources", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [{ id: "1", at, component: "api-1", state: "HEALTHY" }],
    })
    .mockRejectedValueOnce(Error("db"))
    .mockResolvedValueOnce({
      rows: [
        {
          id: "2",
          at,
          component: "media-authority",
          kind: "HUMAN_ACTION_REQUIRED",
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] });
  const app = express();
  const router = express.Router();
  logRoutes(router, { db: { query } } as unknown as Resources);
  app.use(router);
  const r = await request(app).get("/logs?hours=6");
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({
    partial: true,
    unavailableSources: ["recovery"],
    truncated: false,
  });
  expect(r.body.entries).toHaveLength(2);
  expect(
    query.mock.calls.every(
      ([sql, args]) => sql.includes("LIMIT 501") && args.length === 2,
    ),
  ).toBe(true);
});
it("rejects log readers without administrator permission before touching history", async () => {
  const query = vi.fn();
  vi.mocked(requireUser).mockResolvedValue({
    user: { id: "viewer", role: "viewer" },
  } as never);
  const app = express();
  app.use(
    monitoringRouter(
      { db: { query } } as unknown as Resources,
      {} as PlatformConfig,
      {} as Config,
    ),
  );
  app.use(
    (
      e: PlatformError,
      _q: express.Request,
      r: express.Response,
      _next: express.NextFunction,
    ) => r.status(e.status).json({ code: e.code }),
  );
  const r = await request(app).get("/logs");
  expect(r.status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});
it("marks a fully unavailable database as missing logs instead of healthy empty history", async () => {
  const app = express();
  const router = express.Router();
  logRoutes(router, {
    db: { query: vi.fn().mockRejectedValue(Error("down")) },
  } as unknown as Resources);
  app.use(router);
  const r = await request(app).get("/logs");
  expect(r.body).toMatchObject({
    partial: true,
    entries: [],
    unavailableSources: ["health", "recovery", "experiment", "broadcast"],
  });
});
