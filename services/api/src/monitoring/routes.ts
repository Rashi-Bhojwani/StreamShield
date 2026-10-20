import { localAdmission } from "./admission.js";
import { recoveryRoutes } from "../healing/routes.js";
import express from "express";
import { z } from "zod";
import type { Resources } from "../platform/resources.js";
import { requireUser, PlatformError, rate } from "../platform/security.js";
import { durableSnapshot } from "./store.js";
import { metricQueries, finitePoints } from "./queries.js";
export function monitoringRouter(r: Resources) {
  const router = express.Router();
  const fallback = localAdmission();
  router.use(async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const auth = await requireUser(r, req);
      if (auth.user.role !== "administrator")
        throw new PlatformError(
          403,
          "ADMIN_REQUIRED",
          "Administrator access is required.",
        );
      if (r.redis.isReady) {
        try {
          await rate(r, "monitoring:" + auth.user.id, 120, 60000);
        } catch (error) {
          if (error instanceof PlatformError && error.code === "RATE_LIMITED")
            throw error;
          if (!fallback(auth.user.id))
            throw new PlatformError(
              429,
              "RATE_LIMITED",
              "Monitoring admission limit reached.",
            );
        }
      } else if (!fallback(auth.user.id))
        throw new PlatformError(
          429,
          "RATE_LIMITED",
          "Monitoring admission limit reached.",
        );
      next();
    } catch (e) {
      next(e);
    }
  });
  recoveryRoutes(router, r);
  router.get("/snapshot", async (_req, res, next) => {
    try {
      let snapshot;
      if (process.env.OBS_URL && process.env.OBS_SECRET) {
        try {
          const response = await fetch(process.env.OBS_URL + "/snapshot", {
            headers: { Authorization: "Bearer " + process.env.OBS_SECRET },
            signal: AbortSignal.timeout(2000),
          });
          if (!response.ok) throw new Error("observer");
          snapshot = await response.json();
        } catch {
          snapshot = { ...(await durableSnapshot(r.db)), stale: true };
        }
      } else snapshot = { ...(await durableSnapshot(r.db)), stale: true };
      const now = Date.now();
      try {
        const counts = await Promise.all(
          ["primary", "standby", "single"].map((source) =>
            r.redis.zCount("monitoring:playback:" + source, now, "+inf"),
          ),
        );
        snapshot.playback = {
          reports: counts.reduce((a, b) => a + b, 0),
          advancing: counts.reduce((a, b) => a + b, 0),
          standby: counts[1],
          checkedAt: new Date().toISOString(),
          label:
            "Recent browser-reported advancing players · approximate, 30s leases",
        };
      } catch {
        snapshot.playback = {
          reports: 0,
          advancing: 0,
          standby: 0,
          checkedAt: null,
          label: "Browser observations unavailable",
        };
      }
      res.json(snapshot);
    } catch (e) {
      next(e);
    }
  });
  router.get("/incidents", async (req, res, next) => {
    try {
      const q = z
        .object({
          severity: z.enum(["warning", "critical"]).optional(),
          component: z
            .string()
            .regex(/^[a-z0-9-]{1,40}$/)
            .optional(),
          status: z.enum(["active", "resolved"]).optional(),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
          order: z.enum(["newest", "oldest"]).default("newest"),
        })
        .strict()
        .parse(req.query);
      const where =
        "WHERE ($1::text IS NULL OR severity=$1) AND ($2::text IS NULL OR component=$2) AND ($3::text IS NULL OR ($3='active' AND resolved_at IS NULL) OR ($3='resolved' AND resolved_at IS NOT NULL))";
      const params = [
        q.severity || null,
        q.component || null,
        q.status || null,
      ];
      const rows = await r.db.query(
        "SELECT * FROM monitoring_incidents " +
          where +
          " ORDER BY detected_at " +
          (q.order === "oldest" ? "ASC" : "DESC") +
          ",id LIMIT 21 OFFSET $4",
        [...params, q.offset],
      );
      res.json({
        incidents: rows.rows.slice(0, 20),
        nextOffset: rows.rows.length > 20 ? q.offset + 20 : null,
      });
    } catch (e) {
      next(
        e instanceof z.ZodError
          ? new PlatformError(
              400,
              "INVALID_FILTER",
              "Invalid incident filters.",
            )
          : e,
      );
    }
  });
  router.get("/incidents/:id", async (req, res, next) => {
    try {
      const id = z.uuid().parse(req.params.id);
      const row = (
        await r.db.query("SELECT * FROM monitoring_incidents WHERE id=$1", [id])
      ).rows[0];
      if (!row)
        throw new PlatformError(
          404,
          "INCIDENT_NOT_FOUND",
          "Incident not found.",
        );
      const events = (
        await r.db.query(
          "SELECT state,at,evidence FROM monitoring_incident_events WHERE incident_id=$1 ORDER BY seq LIMIT 100",
          [id],
        )
      ).rows;
      res.json({ ...row, events });
    } catch (e) {
      next(
        e instanceof z.ZodError
          ? new PlatformError(400, "INVALID_ID", "Invalid incident identity.")
          : e,
      );
    }
  });
  let cache: { at: number; body: unknown } | undefined,
    pending: Promise<unknown> | undefined;
  router.get("/metrics", async (req, res) => {
    if (Object.keys(req.query).length) {
      res.status(400).json({
        error: {
          code: "INVALID_QUERY",
          message: "Only fixed operational queries are supported.",
        },
      });
      return;
    }
    if (cache && Date.now() - cache.at < 10000) {
      res.json(cache.body);
      return;
    }
    pending ||= (async () => {
      const end = Math.floor(Date.now() / 1000),
        start = end - 600;
      let available = true;
      const series = [];
      // Three workers bound total deadline below the browser API budget; coalesce concurrent admins.
      for (let offset = 0; offset < metricQueries.length; offset += 3) {
        const batch = await Promise.all(
          metricQueries.slice(offset, offset + 3).map(async (item) => {
            let points: [number, number][] = [];
            try {
              if (!process.env.PROMETHEUS_URL) throw new Error("disabled");
              const url = new URL(
                "/api/v1/query_range",
                process.env.PROMETHEUS_URL,
              );
              url.search = new URLSearchParams({
                query: item.query,
                start: String(start),
                end: String(end),
                step: "10",
              }).toString();
              const response = await fetch(url, {
                signal: AbortSignal.timeout(700),
              });
              if (!response.ok) throw new Error("metrics");
              const data = await response.json();
              if (data.status !== "success") throw new Error("metrics");
              points = finitePoints(data.data?.result?.[0]?.values);
            } catch {
              available = false;
            }
            return {
              id: item.id,
              label: item.label,
              unit: item.unit,
              points,
            };
          }),
        );
        series.push(...batch);
      }
      const body = { available, checkedAt: new Date().toISOString(), series };
      cache = { at: Date.now(), body };
      return body;
    })().finally(() => {
      pending = undefined;
    });
    res.json(await pending);
  });
  return router;
}
