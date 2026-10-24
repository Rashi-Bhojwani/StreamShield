import { capacitySummaries } from "../demo/capacity.js";
import type { Router } from "express";
import { z } from "zod";
import type { Resources } from "../platform/resources.js";
import type { PlatformConfig } from "../platform/config.js";
import type { Config } from "../config.js";
import { checkCsrf, PlatformError } from "../platform/security.js";
import { parseChaosSnapshot } from "@streamshield/shared";
import { scenarios } from "./config.js";
/** Mounted after fresh administrator authorization. APIs have no Docker/Healer control credentials. */
export function chaosRoutes(
  router: Router,
  r: Resources,
  c: PlatformConfig,
  media: Config,
) {
  async function forward(path: string, body?: object) {
    if (!process.env.CHAOS_URL || !process.env.CHAOS_SECRET)
      throw new PlatformError(
        503,
        "CHAOS_UNAVAILABLE",
        "Run the explicitly enabled local chaos deployment.",
      );
    const response = await fetch(process.env.CHAOS_URL + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + process.env.CHAOS_SECRET,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(4500),
    });
    const value = await response.json();
    if (!response.ok)
      throw new PlatformError(
        response.status,
        String(value.code || "CHAOS_UNAVAILABLE"),
        "Experiment denied: " +
          String(value.code || "chaos_unavailable").replaceAll("_", " "),
      );
    return value;
  }
  router.get("/chaos", async (_q, res, next) => {
    try {
      try {
        res.json(parseChaosSnapshot(await forward("/state")));
        return;
      } catch (error) {
        const unavailableReason =
          error instanceof PlatformError && [401, 403].includes(error.status)
            ? "Internal controller authorization was rejected; check the configured service credentials."
            : error instanceof z.ZodError
              ? "Controller response violates the monitoring contract; align service versions and timestamps."
              : "Controller is not configured or its request failed. Retained history is not live evidence.";
        let databaseAvailable = false;
        let rows: { body: unknown }[] = [];
        try {
          if (process.env.CHAOS_URL) {
            rows = (
              await r.db.query(
                "SELECT body FROM chaos_experiments ORDER BY created_at DESC LIMIT 100",
              )
            ).rows;
            databaseAvailable = true;
          }
        } catch {
          databaseAvailable = false;
        }
        res.json({
          version: 1,
          available: false,
          enabled: false,
          databaseAvailable,
          serverTime: new Date().toISOString(),
          staleAfterMs: Number(process.env.OBS_STALE_MS || 12000),
          unavailableReason:
            unavailableReason +
            (process.env.CHAOS_URL && !databaseAvailable
              ? " Experiment history persistence is also unavailable."
              : ""),
          observedAt: null,
          activeId: null,
          faultDurationMs: 0,
          timeoutMs: 0,
          scenarios: scenarios.map((s) => ({
            ...s,
            available: false,
            reason:
              s.reason ||
              "Local chaos controller unavailable or not configured.",
          })),
          experiments: rows.map((r) => r.body),
        });
      }
    } catch (e) {
      next(e);
    }
  });
  router.post("/chaos/experiments", async (req, res, next) => {
    try {
      checkCsrf(
        req.headers.origin,
        req.headers["x-csrf-token"],
        req.headers.cookie,
        media.CORS_ORIGINS,
        c,
      );
      if (
        process.env.NODE_ENV !== "development" ||
        process.env.CHAOS_ENABLED !== "true" ||
        process.env.CHAOS_ENVIRONMENT !== "local-development"
      )
        throw new PlatformError(
          403,
          "CHAOS_DISABLED",
          "Chaos mutations require an explicitly enabled local development deployment.",
        );
      if (c.DEMO_ENABLED) {
        const runs = (await capacitySummaries(r)).filter((run) =>
          ["CREATED", "RUNNING"].includes(run.state),
        );
        if (
          runs.some(
            (run) =>
              run.distributed ||
              run.targetClients > 1000 ||
              run.staleWorkers > 0 ||
              run.actualActive === null ||
              run.freshWorkers < 1 ||
              run.requests + run.connections < 1 ||
              (run.requests > 20 && run.errors / run.requests > 0.02),
          )
        )
          throw new PlatformError(
            409,
            "CAPACITY_FAULT_UNSAFE",
            "Fault injection requires a healthy, current bounded local load stage (<=1000 clients); distributed/high or stale/erroring stages are denied.",
          );
      }
      const b = z
        .object({
          id: z.uuid(),
          scenario: z.enum(scenarios.map((s) => s.id)),
          confirmation: z.string().max(40),
        })
        .strict()
        .parse(req.body);
      res.status(201).json(
        await forward("/experiments", {
          ...b,
          actor: z.uuid().parse(res.locals.monitoringActor),
        }),
      );
    } catch (e) {
      next(
        e instanceof z.ZodError
          ? new PlatformError(
              400,
              "INVALID_EXPERIMENT",
              "Choose a supported scenario and confirm its exact target.",
            )
          : e,
      );
    }
  });
  router.post("/chaos/experiments/:id/cancel", async (req, res, next) => {
    try {
      checkCsrf(
        req.headers.origin,
        req.headers["x-csrf-token"],
        req.headers.cookie,
        media.CORS_ORIGINS,
        c,
      );
      const id = z.uuid().parse(req.params.id);
      res.json(
        await forward("/experiments/" + id + "/cancel", {
          actor: z.uuid().parse(res.locals.monitoringActor),
        }),
      );
    } catch (e) {
      next(
        e instanceof z.ZodError
          ? new PlatformError(
              400,
              "INVALID_EXPERIMENT",
              "Invalid experiment identity.",
            )
          : e,
      );
    }
  });
  // Browser-observed numeric evidence only (clearly labelled as such). Only the
  // administrator who ran the experiment may append, bounded per experiment.
  const evidenceSchema = z
    .object({
      stallCount: z.number().int().min(0).max(10000),
      stallMs: z.number().int().min(0).max(3600000),
      maxStallMs: z.number().int().min(0).max(3600000),
      chatDisconnects: z.number().int().min(0).max(10000),
      chatReconnects: z.number().int().min(0).max(10000),
      requestFailures: z.number().int().min(0).max(100000),
      maxRequestLatencyMs: z.number().int().min(0).max(600000),
      outageMs: z.number().int().min(0).max(3600000),
      edgeSwitches: z.number().int().min(0).max(10000),
      samples: z.number().int().min(1).max(100000),
    })
    .partial()
    .strict()
    .refine((v) => Object.keys(v).length > 0);
  router.post("/chaos/experiments/:id/evidence", async (req, res, next) => {
    try {
      checkCsrf(
        req.headers.origin,
        req.headers["x-csrf-token"],
        req.headers.cookie,
        media.CORS_ORIGINS,
        c,
      );
      const id = z.uuid().parse(req.params.id);
      const metrics = evidenceSchema.parse(req.body);
      const actor = z.uuid().parse(res.locals.monitoringActor);
      const row = (
        await r.db.query(
          "SELECT actor,(SELECT count(*)::int FROM chaos_browser_evidence WHERE experiment_id=$1) AS n FROM chaos_experiments WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!row || row.actor !== actor)
        throw new PlatformError(
          404,
          "EXPERIMENT_NOT_FOUND",
          "No experiment owned by this administrator.",
        );
      if (row.n >= 200)
        throw new PlatformError(
          429,
          "EVIDENCE_LIMIT",
          "Browser evidence limit reached for this experiment.",
        );
      await r.db.query(
        "INSERT INTO chaos_browser_evidence(experiment_id,actor,metrics) VALUES($1,$2,$3)",
        [id, actor, { ...metrics, source: "browser-observed" }],
      );
      res.status(201).json({ recorded: true, source: "browser-observed" });
    } catch (e) {
      next(
        e instanceof z.ZodError
          ? new PlatformError(
              400,
              "INVALID_EVIDENCE",
              "Only bounded numeric browser measurements are accepted.",
            )
          : e,
      );
    }
  });
}
