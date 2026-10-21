import express from "express";
import { z } from "zod";
import {
  capacityReport,
  latencyBounds,
  type CapacityReport,
  type CapacitySummary,
} from "@streamshield/shared";
import type { Resources } from "../platform/resources.js";
import type { PlatformConfig } from "../platform/config.js";
import { digest, PlatformError, rate } from "../platform/security.js";
type Run = {
  id: string;
  profile: CapacitySummary["profile"];
  target_clients: number;
  target_origin: string;
  state: string;
  created_at: Date;
  expires_at: Date;
  distributed: boolean;
  stopped_at?: Date | null;
  duration_seconds: number;
  chat_per_second: number;
};
type Worker = {
  id: string;
  clients: number;
  updated_at: Date;
  report: CapacityReport | null;
  finished: boolean;
};
export function percentile(histogram: number[], q: number) {
  const total = histogram.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let n = 0;
  for (let i = 0; i < histogram.length; i++) {
    n += histogram[i]!;
    if (n >= Math.ceil(total * q)) return latencyBounds[i]!;
  }
  return null;
}
export function summarize(
  run: Run,
  workers: Worker[],
  samples: CapacitySummary["samples"],
  now = Date.now(),
): CapacitySummary {
  const rows = workers.filter((w) => w.report),
    fresh = workers.filter(
      (w) => w.finished || now - w.updated_at.getTime() <= 10000,
    ),
    stale = workers.length - fresh.length;
  const sum = (key: keyof CapacityReport) =>
    rows.reduce((v, w) => v + Number(w.report?.[key] || 0), 0);
  const hist = (key: "requestHistogram" | "deliveryHistogram") =>
    latencyBounds.map((_, i) =>
      rows.reduce((a, w) => a + (w.report?.[key][i] || 0), 0),
    );
  const active = stale
    ? null
    : fresh.reduce((a, w) => a + (w.finished ? 0 : w.report?.active || 0), 0);
  const expired = run.expires_at.getTime() <= now;
  const elapsed = Math.max(
    0.001,
    (Math.min(run.stopped_at?.getTime() ?? now, run.expires_at.getTime()) -
      run.created_at.getTime()) /
      1000,
  );
  return {
    id: run.id,
    profile: run.profile,
    targetClients: run.target_clients,
    targetOrigin: run.target_origin,
    state:
      expired && !["STOPPED", "COMPLETED"].includes(run.state)
        ? "EXPIRED"
        : run.state,
    createdAt: run.created_at.toISOString(),
    expiresAt: run.expires_at.toISOString(),
    distributed: run.distributed,
    allocatedClients: workers.reduce((a, w) => a + w.clients, 0),
    freshWorkers: fresh.length,
    staleWorkers: stale,
    actualActive: expired
      ? workers.every((w) => w.finished)
        ? 0
        : null
      : active,
    peakReported: Math.max(
      ...(workers.length === 1 ? [workers[0]?.report?.peak || 0] : []),
      0,
      ...samples.map((s) => s.active || 0),
      active || 0,
    ),
    requests: sum("requests"),
    errors: sum("errors"),
    bytes: sum("bytes"),
    requestsPerSecond: rows.length ? sum("requests") / elapsed : null,
    messagesPerSecond: rows.length ? sum("messages") / elapsed : null,
    connections: sum("connections"),
    connectionFailures: sum("connectionFailures"),
    joinFailures: sum("joinFailures"),
    connectionsPerSecond: rows.length ? sum("connections") / elapsed : null,
    disconnectsPerSecond: rows.length ? sum("disconnects") / elapsed : null,
    disconnects: sum("disconnects"),
    reconnects: sum("reconnects"),
    messages: sum("messages"),
    delivered: sum("delivered"),
    deliveryFailures: sum("deliveryFailures"),
    verifiedBrowsers:
      run.profile === "browser"
        ? stale
          ? null
          : sum("verifiedBrowsers")
        : null,
    stalls: sum("stalls"),
    startupMs: rows.some((w) => w.report?.startupMs != null)
      ? Math.max(...rows.map((w) => w.report?.startupMs || 0))
      : null,
    p50Ms: percentile(hist("requestHistogram"), 0.5),
    p95Ms: percentile(hist("requestHistogram"), 0.95),
    p99Ms: percentile(hist("requestHistogram"), 0.99),
    deliveryP95Ms: percentile(hist("deliveryHistogram"), 0.95),
    generatorCpuPercent: rows.length ? sum("generatorCpuPercent") : null,
    generatorRssBytes: rows.length ? sum("generatorRssBytes") : null,
    sampledAt: new Date(now).toISOString(),
    samples,
  };
}
export async function capacitySummaries(r: Resources) {
  const runs = (
    await r.db.query(
      "SELECT * FROM capacity_runs ORDER BY created_at DESC LIMIT 20",
    )
  ).rows as Run[];
  return Promise.all(
    runs.map(async (run) => {
      const workers = (
        await r.db.query("SELECT * FROM capacity_workers WHERE run_id=$1", [
          run.id,
        ])
      ).rows as Worker[];
      const samples = (
        await r.db.query(
          "SELECT sample,max((sample->>'active')::integer) OVER() AS run_peak FROM capacity_samples WHERE run_id=$1 ORDER BY second DESC LIMIT 120",
          [run.id],
        )
      ).rows;
      const result = summarize(
        run,
        workers,
        samples
          .map((row) => row.sample)
          .reverse() as CapacitySummary["samples"],
      );
      result.peakReported = Math.max(
        result.peakReported,
        Number(samples[0]?.run_peak || 0),
      );
      return result;
    }),
  );
}
export async function capacityCredential(
  r: Resources,
  token: unknown,
  origin: unknown,
  workerId?: unknown,
) {
  if (typeof token !== "string" || !/^[\w-]{43}$/.test(token))
    throw new PlatformError(
      403,
      "LOAD_GRANT_REQUIRED",
      "A current owned-target generator grant is required.",
    );
  const run = (
    await r.db.query(
      "SELECT * FROM capacity_runs WHERE token_hash=$1 AND state IN ('CREATED','RUNNING') AND expires_at>now()",
      [digest(token)],
    )
  ).rows[0] as Run | undefined;
  if (!run || run.target_origin !== origin)
    throw new PlatformError(
      403,
      "LOAD_GRANT_INVALID",
      "Generator grant is expired, stopped or bound to another origin.",
    );
  if (workerId !== undefined) {
    if (!z.uuid().safeParse(workerId).success)
      throw new PlatformError(
        400,
        "WORKER_INVALID",
        "Invalid worker identity.",
      );
    const worker = (
      await r.db.query(
        "SELECT * FROM capacity_workers WHERE id=$1 AND run_id=$2 AND finished=false AND updated_at>now()-interval '30 seconds'",
        [workerId, run.id],
      )
    ).rows[0] as Worker | undefined;
    if (!worker)
      throw new PlatformError(
        403,
        "WORKER_EXPIRED",
        "Register a current generator worker.",
      );
    return { run, worker };
  }
  return { run, worker: undefined };
}
export function capacityAgentRoutes(r: Resources, c: PlatformConfig) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (!c.DEMO_ENABLED)
        throw new PlatformError(404, "NOT_FOUND", "Demo capacity is disabled.");
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const auth = await capacityCredential(r, token, req.headers.origin);
      await rate(r, "capacity-report:" + auth.run.id, 10000, 60000);
      res.locals.run = auth.run;
      next();
    } catch (e) {
      next(e);
    }
  });
  router.post("/register", async (req, res, next) => {
    const client = await r.db.connect();
    try {
      const body = z
          .object({ id: z.uuid(), clients: z.number().int().min(1).max(1000) })
          .strict()
          .parse(req.body),
        run = res.locals.run as Run;
      await client.query("BEGIN");
      const locked = await client.query(
        "SELECT id FROM capacity_runs WHERE id=$1 AND state IN ('CREATED','RUNNING') AND expires_at>now() FOR UPDATE",
        [run.id],
      );
      if (!locked.rowCount)
        throw new PlatformError(
          403,
          "LOAD_GRANT_EXPIRED",
          "This run is no longer active.",
        );
      const workerCount = Number(
        (
          await client.query(
            "SELECT count(*) AS n FROM capacity_workers WHERE run_id=$1",
            [run.id],
          )
        ).rows[0].n,
      );
      const existing = (
        await client.query(
          "SELECT clients FROM capacity_workers WHERE id=$1 AND run_id=$2",
          [body.id, run.id],
        )
      ).rows[0];
      if (existing) {
        if (existing.clients !== body.clients)
          throw new PlatformError(
            409,
            "ALLOCATION_CONFLICT",
            "Worker allocation is immutable.",
          );
      } else {
        if (workerCount >= 100)
          throw new PlatformError(
            409,
            "WORKER_LIMIT",
            "At most 100 generator workers per run.",
          );
        const allocated = Number(
          (
            await client.query(
              "SELECT COALESCE(sum(clients),0) AS n FROM capacity_workers WHERE run_id=$1",
              [run.id],
            )
          ).rows[0].n,
        );
        if (allocated + body.clients > run.target_clients)
          throw new PlatformError(
            409,
            "ALLOCATION_LIMIT",
            "Distributed workers exceed the run target.",
          );
        await client.query(
          "INSERT INTO capacity_workers(id,run_id,clients) VALUES($1,$2,$3)",
          [body.id, run.id, body.clients],
        );
      }
      await client.query(
        "UPDATE capacity_runs SET state='RUNNING' WHERE id=$1",
        [run.id],
      );
      await client.query("COMMIT");
      res.json({
        ok: true,
        runId: run.id,
        expiresAt: run.expires_at.toISOString(),
        profile: run.profile,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      next(e);
    } finally {
      client.release();
    }
  });
  router.post("/:id/report", async (req, res, next) => {
    try {
      const id = z.uuid().parse(req.params.id),
        body = capacityReport.parse(req.body),
        run = res.locals.run as Run;
      const worker = (
        await r.db.query(
          "SELECT * FROM capacity_workers WHERE id=$1 AND run_id=$2",
          [id, run.id],
        )
      ).rows[0];
      if (
        !worker ||
        body.active > worker.clients ||
        body.peak > worker.clients ||
        body.peak < body.active ||
        body.errors > body.requests ||
        (run.profile !== "browser" && body.verifiedBrowsers !== 0)
      )
        throw new PlatformError(
          400,
          "REPORT_INVALID",
          "Report exceeds its allocation/profile.",
        );
      const previous = worker.report as CapacityReport | null;
      if (
        previous &&
        (
          [
            "requests",
            "errors",
            "bytes",
            "connections",
            "connectionFailures",
            "joinFailures",
            "disconnects",
            "reconnects",
            "messages",
            "delivered",
            "deliveryFailures",
            "stalls",
          ] as const
        ).some((k) => body[k] < previous[k])
      )
        throw new PlatformError(
          409,
          "COUNTER_REGRESSION",
          "Cumulative counters cannot decrease.",
        );
      const updated = await r.db.query(
        "UPDATE capacity_workers SET report_seq=$1,report=$2,updated_at=now(),finished=$3 WHERE id=$4 AND run_id=$5 AND report_seq<$1 AND finished=false AND (report IS NULL OR (" +
          [
            "requests",
            "errors",
            "bytes",
            "connections",
            "connectionFailures",
            "joinFailures",
            "disconnects",
            "reconnects",
            "messages",
            "delivered",
            "deliveryFailures",
            "stalls",
          ]
            .map(
              (k) => `(report->>'${k}')::bigint<=($2::jsonb->>'${k}')::bigint`,
            )
            .join(" AND ") +
          ")) RETURNING id",
        [body.seq, body, body.finished, id, run.id],
      );
      if (!updated.rowCount) {
        const same = await r.db.query(
          "SELECT id FROM capacity_workers WHERE id=$1 AND report_seq=$2 AND report=$3::jsonb",
          [id, body.seq, body],
        );
        if (!same.rowCount)
          throw new PlatformError(
            409,
            "REPORT_SEQUENCE",
            "Stale or conflicting report.",
          );
      }
      const workers = (
        await r.db.query("SELECT * FROM capacity_workers WHERE run_id=$1", [
          run.id,
        ])
      ).rows as Worker[];
      const summary = summarize(run, workers, []);
      await r.db.query(
        "INSERT INTO capacity_samples(run_id,second,sample) VALUES($1,floor(extract(epoch from now())),$2) ON CONFLICT DO NOTHING",
        [
          run.id,
          {
            at: summary.sampledAt,
            active: summary.actualActive,
            rps: summary.requestsPerSecond,
            errors: summary.errors,
          },
        ],
      );
      if (
        workers.reduce((a, w) => a + w.clients, 0) === run.target_clients &&
        workers.every((w) => w.finished)
      )
        await r.db.query(
          "UPDATE capacity_runs SET state=$2,stopped_at=now() WHERE id=$1",
          [
            run.id,
            workers.every((w) => w.report?.stopReason === "deadline")
              ? "COMPLETED"
              : "STOPPED",
          ],
        );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  return router;
}
