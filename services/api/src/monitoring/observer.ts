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
import { evaluate, failedProbe, tierOverloaded, type Probe } from "./policy.js";
import {
  observationFreshness,
  type MonitoringSnapshot,
} from "@streamshield/shared";
import { persist, durableSnapshot } from "./store.js";
import {
  CoalescingWriter,
  unrecordedFailures,
  acknowledgeFailures,
} from "./writer.js";
import { promValue } from "./prom-value.js";
import { liveSnapshot } from "./snapshot.js";
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
    OBS_OVERLOAD_P95_MS: number(100, 60000, 1500),
    OBS_OVERLOAD_ERROR_PCT: number(1, 100, 5),
    OBS_OVERLOAD_SAMPLES: number(2, 20, 3),
    OBS_OVERLOAD_MIN_RPS: number(1, 100000, 20),
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
      kind: z.enum(["http", "api", "media", "postgres", "redis", "tier"]),
      /** A pre-provisioned spare: stopped is its normal standby, not a failure. */
      spare: z.boolean().optional(),
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
// Overload must persist for N consecutive samples before it is confirmed.
const tierPolicy = {
  failures: c.OBS_OVERLOAD_SAMPLES,
  successes: c.OBS_SUCCESSES,
};
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
let lastPersistedAt = 0;
let cachedHistory: MonitoringSnapshot | undefined;
let historyReadable = false;
const persistenceFresh = () =>
  persistence &&
  observationFreshness(lastPersistedAt, Date.now(), c.OBS_STALE_MS) === "fresh";
const failureClocks = new Map<string, number>();
// Append-only history of thresholded state transitions, buffered across DB loss.
const lastRecorded = new Map<string, string>();
let pendingTransitions: {
  component: string;
  state: string;
  previous: string | null;
  code: string;
  at: string;
}[] = [];
async function flushTransitions() {
  if (!pendingTransitions.length) return;
  const batch = pendingTransitions.slice(0, 200);
  await db.query(
    "INSERT INTO monitoring_state_changes(component,state,previous,code,at) SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(component text,state text,previous text,code text,at timestamptz)",
    [JSON.stringify(batch)],
  );
  pendingTransitions = pendingTransitions.slice(batch.length);
}
let chaosRevision = "";
let recoveryRevision = "";
const pendingEvidence = new Map<string, ComponentObservation>();
const recordedFailures = new Map<string, string>();
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
async function promScalar(query: string) {
  const url = new URL("/api/v1/query", process.env.PROMETHEUS_URL);
  url.searchParams.set("query", query);
  const r = await request(url.href);
  if (!r.ok) throw new Error("metrics");
  return promValue(await r.json());
}
/**
 * Logical API-tier load from real metrics already scraped from every API.
 * Overloaded = p95 above threshold or 5xx ratio above threshold. Individual
 * APIs are never marked unhealthy merely for being slow.
 */
async function tierProbe(started: number): Promise<Probe> {
  if (!process.env.PROMETHEUS_URL)
    return { state: "UNKNOWN", code: "metrics_unavailable", latencyMs: null };
  try {
    const rps = await promScalar(
      'sum(rate(streamshield_http_requests_total{job="api"}[20s]))',
    );
    if (rps === 0)
      return {
        state: "UNKNOWN",
        code: "metrics_no_requests",
        latencyMs: Math.round(performance.now() - started),
      };
    const [p95, errors, limited] = await Promise.all([
      promScalar(
        'histogram_quantile(0.95,sum by(le)(rate(streamshield_http_request_duration_seconds_bucket{job="api"}[20s])))*1000',
      ),
      promScalar(
        '100*(sum(rate(streamshield_http_requests_total{job="api",category="5xx"}[20s])) or vector(0))/clamp_min(sum(rate(streamshield_http_requests_total{job="api"}[20s])),0.000001)',
      ),
      promScalar(
        'sum(rate(streamshield_http_limited_total{job="api"}[20s])) or vector(0)',
      ),
    ]);
    const overloaded = tierOverloaded(
      { p95Ms: p95, errorPct: errors, rps },
      {
        p95Ms: c.OBS_OVERLOAD_P95_MS,
        errorPct: c.OBS_OVERLOAD_ERROR_PCT,
        minRps: c.OBS_OVERLOAD_MIN_RPS,
      },
    );
    return {
      state: overloaded ? "DEGRADED" : "HEALTHY",
      code: overloaded ? "overloaded" : "probe_ok",
      latencyMs: Math.round(performance.now() - started),
      metrics: {
        p95Ms: Math.round(p95),
        errorPct: Math.round(errors * 100) / 100,
        rps: Math.round(rps * 10) / 10,
        limitedRps: Math.round(limited * 10) / 10,
      },
    };
  } catch {
    return {
      state: "UNKNOWN",
      code: "metrics_unavailable",
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
async function probe(t: (typeof targets)[number]): Promise<Probe> {
  const started = performance.now();
  if (t.kind === "tier") return tierProbe(started);
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
    const failed = failedProbe(error, Math.round(performance.now() - started));
    // A stopped spare is in standby, which is neither healthy nor a failure.
    return t.spare && failed.code === "probe_unreachable"
      ? { state: "UNKNOWN", code: "spare_standby", latencyMs: null }
      : failed;
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
    this.set(persistenceFresh() ? 1 : 0);
  },
});
const app = express();
app.disable("x-powered-by");
app.get("/health", (_req, res) =>
  res
    .status(
      lastCompleted &&
        observationFreshness(lastCompleted, Date.now(), c.OBS_STALE_MS) ===
          "fresh"
        ? 200
        : 503,
    )
    .json({ alive: true, persistence: persistenceFresh() }),
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
  res.json({
    components,
    persistence: persistenceFresh(),
    lastCompleted,
    mediaAvailable,
    media,
  }),
);
app.get("/snapshot", (_req, res) => {
  res.json(
    liveSnapshot(
      {
        components,
        media,
        mediaAvailable,
        lastCompleted,
        persistence: persistenceFresh(),
        staleAfterMs: c.OBS_STALE_MS,
      },
      cachedHistory,
      Date.now(),
      historyReadable,
    ),
  );
});
const server = app.listen(c.OBS_PORT, "0.0.0.0");
let lastMaintenance = Date.now();
const writer = new CoalescingWriter<{
  components: ComponentObservation[];
  media: MediaObservation[];
  mediaAvailable: boolean;
  evidence: Map<string, ComponentObservation>;
  observedAt: string;
}>(
  async (value) => {
    const failureEvidence = unrecordedFailures(
      value.evidence,
      recordedFailures,
    );
    const sequence = await persist(
      db,
      value.components,
      value.media,
      value.mediaAvailable,
      policy,
      c.OBS_STALE_MS,
      c.OBS_RETENTION_DAYS,
      failureEvidence,
      value.observedAt,
    );
    persistence = true;
    lastPersistedAt = Date.parse(value.observedAt);
    try {
      cachedHistory = await durableSnapshot(db);
      historyReadable = true;
    } catch {
      historyReadable = false;
      log.warn(
        { code: "history_read_unavailable" },
        "Durable write succeeded; incident-history refresh unavailable",
      );
    }
    acknowledgeFailures(pendingEvidence, failureEvidence, recordedFailures);
    await flushTransitions().catch(() =>
      log.warn(
        { code: "state_history_unavailable" },
        "State transitions buffered for a later cycle",
      ),
    );
    let kind = "snapshot_changed";
    try {
      const revision =
        (
          await db.query(
            "SELECT max(updated_at)::text AS revision FROM healing_attempts",
          )
        ).rows[0]?.revision || "";
      if (revision && revision !== recoveryRevision) kind = "recovery_changed";
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
    if (Date.now() - lastMaintenance > 60000) {
      lastMaintenance = Date.now();
      await db
        .query(
          "DELETE FROM monitoring_incidents WHERE id IN (SELECT id FROM monitoring_incidents WHERE resolved_at<now()-($1*interval '1 day') LIMIT 100)",
          [c.OBS_RETENTION_DAYS],
        )
        .catch(() =>
          log.warn(
            { code: "retention_unavailable" },
            "Optional monitoring retention deferred",
          ),
        );
    }
  },
  () => {
    persistence = false;
    log.warn(
      { code: "persistence_unavailable" },
      "Monitoring persistence failed; independent health probes continue",
    );
  },
);
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
          components[i] = evaluate(
            previous,
            p,
            t.kind === "tier" ? tierPolicy : policy,
            now,
            elapsed,
          );
        }
      }),
    );
    for (const current of components) {
      if (lastRecorded.get(current.id) !== current.state) {
        pendingTransitions.push({
          component: current.id,
          state: current.state,
          previous: lastRecorded.get(current.id) ?? null,
          code: current.code,
          at: current.observedAt,
        });
        lastRecorded.set(current.id, current.state);
      }
    }
    if (pendingTransitions.length > 2000)
      pendingTransitions = pendingTransitions.slice(-2000);
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
    lastCompleted = Date.now();
    writer.offer({
      components: structuredClone(components),
      media: structuredClone(media),
      mediaAvailable,
      evidence: new Map(pendingEvidence),
      observedAt: new Date(lastCompleted).toISOString(),
    });
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
  writer.stop();
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
