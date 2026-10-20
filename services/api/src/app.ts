import type { Platform } from "./platform/routes.js";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import pino, { type Logger } from "pino";
import type { Health, SystemInfo, ApiError } from "@streamshield/shared";
import { createMediaService, type MediaService } from "./media.js";
import type { Config } from "./config.js";

export interface Lifecycle {
  ready: boolean;
}
export function createApp(
  config: Config,
  lifecycle: Lifecycle,
  logger: Logger = pino({ level: config.LOG_LEVEL }),
  media: MediaService = createMediaService(config),
  platform?: Platform,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    // Generate our own IDs; untrusted incoming IDs are never reflected or logged.
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    const started = performance.now();
    res.on("finish", () =>
      logger.info(
        {
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        },
        "request completed",
      ),
    );
    next();
  });
  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGINS,
      methods: ["GET", "POST", "PATCH"],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "16kb" }));
  app.get("/api/v1/health/live", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "alive", service: "streamshield-api" } satisfies Health);
  });
  app.get("/api/v1/health/ready", async (_req, res) => {
    const ready = lifecycle.ready && (!platform || (await platform.ready()));
    res.setHeader("Cache-Control", "no-store");
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      service: "streamshield-api",
    } satisfies Health);
  });
  app.get("/api/v1/system/info", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      name: "StreamShield",
      version: platform ? "0.3.0" : "0.2.0",
      phase: platform ? 3 : 2,
      capabilities: [
        "API health probes",
        "System metadata",
        "RTMP ingest",
        "HLS playback",
        "Media availability observations",
      ],
    } satisfies SystemInfo);
  });
  if (platform) {
    app.use("/api/v1", platform.router);
    app.use(platform.errors);
  }
  app.get("/api/v1/streams", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ streams: [await media.getStream()] });
  });
  app.get("/api/v1/streams/:id", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.params.id !== config.MEDIA_STREAM_PATH) {
      res.status(404).json({
        error: {
          code: "STREAM_NOT_FOUND",
          message: "Stream not configured",
          requestId: res.locals.requestId as string,
        },
      } satisfies ApiError);
      return;
    }
    res.json(await media.getStream());
  });
  app.use((_req, res) =>
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        requestId: res.locals.requestId as string,
      },
    } satisfies ApiError),
  );
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : 500;
    const clientError = status === 400 || status === 413;
    logger.error(
      {
        requestId: res.locals.requestId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      },
      "request failed",
    );
    res.status(clientError ? status : 500).json({
      error: {
        code: clientError ? "INVALID_REQUEST" : "INTERNAL_ERROR",
        message: clientError
          ? "Invalid request body"
          : "An unexpected error occurred",
        requestId: res.locals.requestId as string,
      },
    } satisfies ApiError);
  };
  app.use(errors);
  return app;
}
