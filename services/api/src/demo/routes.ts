import express from "express";
import { z } from "zod";
import type { Resources } from "../platform/resources.js";
import type { PlatformConfig } from "../platform/config.js";
import type { Config } from "../config.js";
import type { Catalog } from "../platform/catalog.js";
import { PlatformError, checkCsrf } from "../platform/security.js";
import { consumeLocalTicket } from "./guests.js";
import { presenceCount } from "../platform/realtime.js";
import { capacityAgentRoutes, capacitySummaries } from "./capacity.js";
export function demoRoutes(
  r: Resources,
  c: PlatformConfig,
  media: Config,
  catalog: Catalog,
) {
  const router = express.Router();
  router.use("/capacity/agent", capacityAgentRoutes(r, c));
  router.get("/demo/channels", async (_req, res, next) => {
    try {
      if (!c.DEMO_ENABLED)
        throw new PlatformError(404, "NOT_FOUND", "Demo is disabled.");
      const rows = (
        await r.db.query(
          "SELECT slot,stream_id FROM demo_channels ORDER BY slot",
        )
      ).rows;
      const channels = await Promise.all(
        rows.map(async (row) => {
          const stream = await catalog.get(row.stream_id);
          let viewers: number | null = null;
          try {
            viewers = await presenceCount(r, row.stream_id);
          } catch {
            /* Unknown during Redis outage. */
          }
          return {
            slot: row.slot,
            ...stream,
            viewers,
            viewerLabel:
              "Approximate active guest/player identities; excludes synthetic agents",
          };
        }),
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({ channels });
    } catch (e) {
      next(e);
    }
  });
  router.get("/demo/channels/:slug/history", async (req, res, next) => {
    try {
      if (!c.DEMO_ENABLED)
        throw new PlatformError(404, "NOT_FOUND", "Demo is disabled.");
      const slot = Number(
        String(req.params.slug).match(/^streamer-([123])$/)?.[1],
      );
      if (!slot)
        throw new PlatformError(404, "NOT_FOUND", "Channel not found.");
      res.json({
        history: (
          await r.db.query(
            "SELECT h.status,h.observed_at FROM demo_broadcast_history h JOIN demo_channels d ON d.stream_id=h.stream_id WHERE d.slot=$1 ORDER BY h.id DESC LIMIT 30",
            [slot],
          )
        ).rows,
      });
    } catch (e) {
      next(e);
    }
  });
  router.post("/demo/local-access", async (req, res, next) => {
    try {
      checkCsrf(
        req.headers.origin,
        req.headers["x-csrf-token"],
        req.headers.cookie,
        media.CORS_ORIGINS,
        c,
      );
      const { ticket } = z
        .object({ ticket: z.string().regex(/^[\w-]{43}$/) })
        .strict()
        .parse(req.body);
      await consumeLocalTicket(r, c, req, res, ticket);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  return router;
}
export function capacityAdminRoutes(r: Resources) {
  const router = express.Router();
  router.get("/capacity", async (_req, res, next) => {
    try {
      res.json({ runs: await capacitySummaries(r) });
    } catch (e) {
      next(e);
    }
  });
  return router;
}
