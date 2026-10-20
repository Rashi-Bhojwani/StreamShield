import { Gauge } from "@prometheus-io/client";
import { readFileSync } from "node:fs";
import express from "express";
import pino from "pino";
import { Pool } from "pg";
import { createClient } from "redis";
import { z } from "zod";
import type {
  ComponentObservation,
  MediaObservation,
} from "@streamshield/shared";
import { evaluate, failedProbe, type Probe } from "./policy.js";
import { persist, durableSnapshot } from "./store.js";
import { equal } from "../platform/security.js";
import { createMetrics } from "./metrics.js";
const number = (min: number, max: number, value: number) =>
  z.coerce.number().int().min(min).max(max).default(value);
const c = z
  .object({
    OBS_INTERVAL_MS: number(1000, 60000, 2000),
    OBS_TIMEOUT_MS: number(200, 5000, 1000),
    OBS_FAILURES: number(2, 10, 2),
    OBS_SUCCESSES: number(2, 10, 2),
    OBS_CONCURRENCY: number(1, 8, 4),
    OBS_STALE_MS: number(6000, 120000, 12000),
    OBS_MEDIA_INTERVAL_MS: number(5000, 60000, 10000),
    OBS_RETENTION_DAYS: number(7, 365, 90),
    OBS_PORT: number(1024, 65535, 4010),
    OBS_SECRET: z.string().regex(/^[\w-]{43}$/),
  })
  .parse(process.env);
const targetSchema = z
  .array(
    z.object({
      id: z.string(),
      name: z.string(),
      group: z.string(),
      role: z.string(),
      dependencies: z.array(z.string()),
      url: z.string().url().optional(),
      kind: z.enum(["http", "api", "media", "postgres", "redis"]),
    }),
  )
  .max(20);
const targets = targetSchema.parse(
  JSON.parse(
    readFileSync(
      process.env.OBS_TARGETS_FILE || "/config/targets.json",
      "utf8",
    ),
  ),
);
const log = pino({ base: { service: "health-observer", version: 1 } });
const db = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 2,
  connectionTimeoutMillis: c.OBS_TIMEOUT_MS,
  query_timeout: c.OBS_TIMEOUT_MS,
  statement_timeout: c.OBS_TIMEOUT_MS,
  idleTimeoutMillis: 5000,
});
db.on("error", () =>
  log.warn({ dependency: "postgres" }, "Observer database connection lost"),
);
let redisAuthorityDenied = false;
const redis = createClient({
  password: process.env.REDIS_PASSWORD,
  database: Number(process.env.REDIS_DB || 0),
  disableOfflineQueue: true,
  commandsQueueMaxLength: 32,
  commandOptions: { timeout: c.OBS_TIMEOUT_MS },
  socket: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    connectTimeout: c.OBS_TIMEOUT_MS,
    reconnectStrategy: () => 1000,
  },
});
redis.on("error", (error) => {
  redisAuthorityDenied = failedProbe(error, 0).state === "UNKNOWN";
});
redis.on("ready", () => {
  redisAuthorityDenied = false;
});
void redis.connect().catch(() => {});
const policy = { failures: c.OBS_FAILURES, successes: c.OBS_SUCCESSES };
let components: ComponentObservation[] = targets.map((t) => ({
  id: t.id,
  name: t.name,
  group: t.group,
  role: t.role,
  dependencies: t.dependencies,
  state: "UNKNOWN",
  observedAt: new Date().toISOString(),
  lastSuccessAt: null,
  code: "warming_up",
  latencyMs: null,
  failures: 0,
  successes: 0,
  firstFailureAt: null,
  detectionMs: null,
}));
let media: MediaObservation[] = [],
  mediaAvailable = false,
  persistence = false,
  stopped = false,
  lastCompleted = 0,
  lastMedia = 0;
const failureClocks = new Map<string, number>();
let chaosRevision = "";
let recoveryRevision = "";
const pendingEvidence = new Map<string, ComponentObservation>();
const mediaSeen = new Map<
  string,
  { uri: string; changed: number; advanced: boolean }
>();
const basic =
  "Basic " +
  Buffer.from(
    process.env.MEDIA_API_USER + ":" + process.env.MEDIA_API_PASSWORD,
  ).toString("base64");
const request = async (url: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(c.OBS_TIMEOUT_MS),
  });
async function probe(t: (typeof targets)[number]): Promise<Probe> {
  const started = performance.now();
  try {
    let state: Probe["state"] = "HEALTHY",
      code = "probe_ok";
    if (t.kind === "postgres") await db.query("SELECT 1");
    else if (t.kind === "redis") {
      if (redisAuthorityDenied) throw { code: "MONITOR_AUTH_DENIED" };
      if (!redis.isReady || (await redis.ping()) !== "PONG")
        throw new Error("redis");
    } else {
      const r = await request(
        t.url!,
        t.kind === "media" ? { Authorization: basic } : {},
      );
      if ([401, 403].includes(r.status)) {
        state = "UNKNOWN";
        code = "probe_denied";
      } else if (!r.ok) {
        state = t.kind === "api" && r.status === 503 ? "DEGRADED" : "UNHEALTHY";
        code = "http_" + r.status;
      } else if (t.kind === "api") {
        const body = await r.json();
        if (body.status !== "ready") {
          state = "UNKNOWN";
          code = "invalid_response";
        }
      } else if (t.kind === "media") {
        const body = await r.json();
        if (!Array.isArray(body.items)) {
          state = "UNKNOWN";
          code = "invalid_response";
        }
      } else await r.body?.cancel();
    }
    return { state, code, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return failedProbe(error, Math.round(performance.now() - started));
  }
}
async function boundedText(url: string, headers: Record<string, string>) {
  const r = await request(url, headers);
  if (!r.ok) throw new Error("http");
  const reader = r.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const v = await reader.read();
      if (v.done) break;
      size += v.value.length;
      if (size > 2 * 1024 * 1024) throw new Error("size");
      chunks.push(v.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function inspectMedia() {
  try {
    const relay = targets.find((t) => t.id === "relay")!;
    const r = await request(relay.url!, { Authorization: basic });
    if (!r.ok) throw new Error("relay");
    const body = (await r.json()) as {
      items: {
        name: string;
        ready?: boolean;
        online?: boolean;
        source?: unknown;
      }[];
    };
    const active = body.items
      .filter((p) => (p.ready || p.online) && p.source)
      .slice(0, 5);
    const next: MediaObservation[] = [];
    for (const path of active) {
      if (
        !/^(live|s-[a-f0-9]{32})$/.test(path.name) &&
        path.name !== process.env.MEDIA_STREAM_PATH
      )
        continue;
      const sources: MediaObservation["sources"] = [];
      for (const id of ["primary", "standby"] as const) {
        let manifest = false,
          segment = false,
          fresh: boolean | null = null,
          code = "manifest_unavailable";
        try {
          const host = targets.find((t) => t.id === "origin-" + id)!;
          const root = new URL(host.url!);
          root.port = process.env.MEDIA_HLS_PORT!;
          root.pathname = "/" + path.name + "/";
          const headers = {
            Authorization: "Bearer " + process.env.RESILIENCE_HLS_SECRET,
          };
          const master = await boundedText(
            new URL("index.m3u8", root).href,
            headers,
          );
          if (!master.startsWith("#EXTM3U")) throw new Error("manifest");
          const line = master
            .split("\n")
            .find((l) => l.trim() && !l.startsWith("#"));
          if (!line) throw new Error("variant");
          const variant = new URL(line.trim(), root);
          if (
            variant.origin !== root.origin ||
            !variant.pathname.startsWith(root.pathname)
          )
            throw new Error("unsafe");
          const playlist = await boundedText(variant.href, headers);
          manifest = playlist.startsWith("#EXTM3U");
          const last = playlist
            .split("\n")
            .filter((l) => l.trim() && !l.startsWith("#"))
            .at(-1);
          if (!last) throw new Error("segment");
          const url = new URL(last.trim(), variant);
          if (
            url.origin !== root.origin ||
            !url.pathname.startsWith(root.pathname)
          )
            throw new Error("unsafe");
          const bytes = await boundedText(url.href, headers);
          segment = bytes.length > 0;
          const key = id + ":" + path.name,
            previous = mediaSeen.get(key),
            now = performance.now();
          if (!previous || previous.uri !== url.pathname)
            mediaSeen.set(key, {
              uri: url.pathname,
              changed: now,
              advanced: !!previous,
            });
          fresh = previous
            ? mediaSeen.get(key)!.advanced
              ? now - mediaSeen.get(key)!.changed < c.OBS_MEDIA_INTERVAL_MS * 3
              : now - mediaSeen.get(key)!.changed >= c.OBS_MEDIA_INTERVAL_MS * 3
                ? false
                : null
            : null;
          code = segment ? "media_bytes_observed" : "segment_unavailable";
        } catch {
          code = manifest ? "segment_unavailable" : "manifest_unavailable";
        }
        sources.push({ id, manifest, segment, fresh, code });
      }
      next.push({
        path: path.name,
        publisher: true,
        checkedAt: new Date().toISOString(),
        sources,
      });
    }
    media = next;
    mediaAvailable = true;
    const keys = new Set(
      next.flatMap((p) => ["primary:" + p.path, "standby:" + p.path]),
    );
    for (const key of mediaSeen.keys())
      if (!keys.has(key)) mediaSeen.delete(key);
  } catch {
    mediaAvailable = false;
    media = [];
  }
}
const metrics = createMetrics();
new Gauge({
  name: "streamshield_component_available",
  help: "Thresholded component probe state: 1 healthy, 0 failed, -1 unknown",
  labelNames: ["component"],
  registers: [metrics.registry],
  collect() {
    for (const c of components)
      this.set(
        { component: c.id },
        c.state === "HEALTHY"
          ? 1
          : ["UNHEALTHY", "DEGRADED"].includes(c.state)
            ? 0
            : -1,
      );
  },
});
new Gauge({
  name: "streamshield_observer_persistence_available",
  help: "Last observer cycle durable persistence availability",
  registers: [metrics.registry],
  collect() {
    this.set(persistence ? 1 : 0);
  },
});
const app = express();
app.disable("x-powered-by");
app.get("/health", (_req, res) =>
  res
    .status(
      lastCompleted && Date.now() - lastCompleted < c.OBS_STALE_MS ? 200 : 503,
    )
    .json({ alive: true, persistence }),
);
app.use((req, res, next) => {
  if (!equal(req.headers.authorization || "", "Bearer " + c.OBS_SECRET)) {
    res.sendStatus(401);
    return;
  }
  next();
});
app.get("/metrics", async (_req, res) =>
  res.type(metrics.registry.contentType).send(await metrics.registry.metrics()),
);
app.get("/observations", (_req, res) =>
  res.json({ components, persistence, lastCompleted, mediaAvailable, media }),
);
app.get("/snapshot", async (_req, res) => {
  try {
    const snapshot = await durableSnapshot(db);
    res.json({
      ...snapshot,
      components,
      media,
      mediaAvailable,
      persistence,
      stale: Date.now() - lastCompleted > c.OBS_STALE_MS,
    });
  } catch {
    res.status(503).json({
      error: {
        code: "PERSISTENCE_UNAVAILABLE",
        message:
          "Incident persistence unavailable; no durable snapshot can be confirmed.",
      },
    });
  }
});
const server = app.listen(c.OBS_PORT, "0.0.0.0");
async function start() {
  try {
    const rows = (
      await db.query("SELECT observation FROM monitoring_components")
    ).rows;
    components = components.map((c) => {
      const old = rows.find((r) => r.observation.id === c.id)?.observation;
      return old ? { ...old, state: "UNKNOWN", successes: 0, failures: 0 } : c;
    });
  } catch {
    log.warn(
      "No stored observation available; bounded reconciliation will retry",
    );
  }
  // One non-overlapping cycle. Parallel workers isolate slow/failing components.
  while (!stopped) {
    const started = performance.now();
    let index = 0;
    await Promise.all(
      Array.from({ length: c.OBS_CONCURRENCY }, async () => {
        while (index < targets.length) {
          const i = index++,
            t = targets[i]!,
            previous = components[i]!,
            p = await probe(t),
            now = new Date().toISOString();
          if (p.state === "HEALTHY") failureClocks.delete(t.id);
          else if (p.state !== "UNKNOWN" && !failureClocks.has(t.id))
            failureClocks.set(t.id, performance.now());
          const elapsed = failureClocks.has(t.id)
            ? performance.now() - failureClocks.get(t.id)!
            : null;
          components[i] = evaluate(previous, p, policy, now, elapsed);
        }
      }),
    );
    for (const current of components) {
      const pending = pendingEvidence.get(current.id);
      if (current.confirmedAt) pendingEvidence.set(current.id, { ...current });
      else if (pending)
        pendingEvidence.set(current.id, {
          ...current,
          firstFailureAt: pending.firstFailureAt,
          confirmedAt: pending.confirmedAt,
          detectionMs: pending.detectionMs,
          failureCode: pending.failureCode,
          failureState: pending.failureState,
        });
    }
    try {
      const sequence = await persist(
        db,
        components,
        media,
        mediaAvailable,
        policy,
        c.OBS_STALE_MS,
        c.OBS_RETENTION_DAYS,
        pendingEvidence,
      );
      persistence = true;
      pendingEvidence.clear();
      let kind = "snapshot_changed";
      try {
        const revision =
          (
            await db.query(
              "SELECT max(updated_at)::text AS revision FROM healing_attempts",
            )
          ).rows[0]?.revision || "";
        if (revision && revision !== recoveryRevision)
          kind = "recovery_changed";
        recoveryRevision = revision;
      } catch {
        /* Older deployments still reconcile ordinary snapshots. */
      }
      try {
        const revision =
          (
            await db.query(
              "SELECT max(updated_at)::text AS revision FROM chaos_experiments",
            )
          ).rows[0]?.revision || "";
        if (revision && revision !== chaosRevision) kind = "chaos_changed";
        chaosRevision = revision;
      } catch {
        /* Prior compositions remain compatible. */
      }
      if (redis.isReady)
        await redis
          .publish(
            "monitoring:" + String(process.env.REDIS_DB || 0),
            JSON.stringify({
              version: 1,
              sequence,
              at: new Date().toISOString(),
              kind,
            }),
          )
          .catch(() =>
            log.warn(
              { code: "event_delivery_unavailable" },
              "Persisted state will reconcile through REST",
            ),
          );
    } catch {
      persistence = false;
      log.warn(
        { code: "persistence_unavailable" },
        "Observation cycle not fully persisted/published",
      );
    }
    lastCompleted = Date.now();
    const remaining = Math.max(
      50,
      c.OBS_INTERVAL_MS - (performance.now() - started) + Math.random() * 200,
    );
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
// Media work has its own budget and never blocks health or persistence cycles.
async function mediaLoop() {
  while (!stopped) {
    await inspectMedia();
    lastMedia = Date.now();
    await new Promise((resolve) =>
      setTimeout(resolve, c.OBS_MEDIA_INTERVAL_MS),
    );
  }
}
void mediaLoop();
void start().catch(() => {
  log.fatal("Observer failed");
  process.exitCode = 1;
  server.close();
});
const stop = () => {
  stopped = true;
  server.close();
  void Promise.allSettled([
    db.end(),
    redis.isOpen ? redis.close() : Promise.resolve(),
  ]);
  setTimeout(() => process.exit(0), 1500).unref();
  log.info({ lastMedia }, "Observer stopping");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
