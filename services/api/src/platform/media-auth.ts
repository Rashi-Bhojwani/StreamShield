import type { ApiMetrics } from "../monitoring/metrics.js";
import express from "express";
import { z } from "zod";
import type { Resources } from "./resources.js";
import type { PlatformConfig } from "./config.js";
import type { Config } from "../config.js";
import { equal, digest } from "./security.js";
const schema = z.object({
  action: z.string(),
  path: z.string().default(""),
  user: z.string().default(""),
  password: z.string().max(256).default(""),
  ip: z.string().default(""),
  protocol: z.string().default(""),
});
export function createMediaAuth(
  r: Resources,
  c: PlatformConfig,
  media: Config,
  legacy: { user: string; password: string },
  diagnostics?: () => Promise<unknown>,
  metrics?: ApiMetrics,
) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/metrics", async (req, res) => {
    if (
      !metrics ||
      !process.env.OBS_SECRET ||
      !equal(
        req.headers.authorization || "",
        "Bearer " + process.env.OBS_SECRET,
      )
    ) {
      res.sendStatus(401);
      return;
    }
    res
      .type(metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });
  // This listener is not mounted in the public API and is never proxied/published.
  app.use((req, res, next) => {
    const expected =
      "Basic " +
      Buffer.from("mediamtx:" + c.MEDIA_AUTH_SECRET).toString("base64");
    if (!equal(req.headers.authorization || "", expected)) {
      res.sendStatus(401);
      return;
    }
    next();
  });
  app.get("/internal/instance", async (_req, res) => {
    if (!diagnostics) {
      res.sendStatus(404);
      return;
    }
    try {
      res.json(await diagnostics());
    } catch {
      res.sendStatus(503);
    }
  });
  app.use(express.json({ limit: "16kb" }));
  app.post("/internal/media/auth", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.sendStatus(401);
      return;
    }
    const a = parsed.data;
    if (a.action === "api" || a.action === "metrics") {
      const healthLocal =
        ["127.0.0.1", "::1"].includes(a.ip) && !a.user && !a.password;
      res.sendStatus(
        healthLocal ||
          (equal(a.user, media.MEDIA_API_USER) &&
            equal(a.password, media.MEDIA_API_PASSWORD))
          ? 204
          : 401,
      );
      return;
    }
    if (a.action === "read") {
      if (
        a.protocol !== "rtsp" ||
        !c.MEDIA_REPLICATION_SECRET ||
        !equal(a.user, "replica") ||
        !equal(a.password, c.MEDIA_REPLICATION_SECRET)
      ) {
        res.sendStatus(401);
        return;
      }
      if (c.ENABLE_LEGACY_STREAM && a.path === media.MEDIA_STREAM_PATH) {
        res.sendStatus(204);
        return;
      }
      if (!/^s-[a-f0-9]{32}$/.test(a.path)) {
        res.sendStatus(401);
        return;
      }
      try {
        const found = await r.db.query(
          "SELECT s.id FROM streams s JOIN channels c ON c.id=s.channel_id JOIN users u ON u.id=c.owner_id WHERE s.media_path=$1 AND s.lifecycle='ready' AND s.publish_hash IS NOT NULL AND u.role IN ('broadcaster','administrator')",
          [a.path],
        );
        res.sendStatus(found.rowCount ? 204 : 401);
      } catch {
        res.sendStatus(503);
      }
      return;
    }
    if (a.action !== "publish" || a.protocol !== "rtmp") {
      res.sendStatus(401);
      return;
    }
    if (c.ENABLE_LEGACY_STREAM && a.path === media.MEDIA_STREAM_PATH) {
      res.sendStatus(
        equal(a.user, legacy.user) && equal(a.password, legacy.password)
          ? 204
          : 401,
      );
      return;
    }
    if (
      !/^s-[a-f0-9]{32}$/.test(a.path) ||
      !z.uuid().safeParse(a.user).success ||
      !/^[a-zA-Z0-9_-]{43}$/.test(a.password)
    ) {
      res.sendStatus(401);
      return;
    }
    try {
      const row = (
        await r.db.query(
          "SELECT s.publish_hash FROM streams s JOIN channels c ON c.id=s.channel_id JOIN users u ON u.id=c.owner_id WHERE s.id=$1 AND s.media_path=$2 AND s.lifecycle='ready' AND u.role IN ('broadcaster','administrator')",
          [a.user, a.path],
        )
      ).rows[0];
      res.sendStatus(
        row?.publish_hash && equal(row.publish_hash, digest(a.password))
          ? 204
          : 401,
      );
    } catch {
      res.sendStatus(503);
    }
  });
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.sendStatus(400),
  );
  return app;
}
