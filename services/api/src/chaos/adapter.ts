import express from "express";
import pino from "pino";
import { z } from "zod";
import { database } from "../healing/journal.js";
import { equal } from "../healing/authority.js";
import { chaosConfig, supported, scenarioFor, temporary } from "./config.js";
import { FaultDocker } from "./docker.js";
import type { ChaosScenarioId } from "@streamshield/shared";
const c = chaosConfig(process.env),
  log = pino({ base: { service: "chaos-fault-adapter" } });
const db = database(process.env.CHAOS_CONTROL_JOURNAL || "/data/faults.sqlite");
db.exec(
  "CREATE TABLE IF NOT EXISTS faults(id TEXT PRIMARY KEY,active INTEGER NOT NULL,body TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_fault ON faults(active) WHERE active=1;",
);
type Fault = {
  id: string;
  scenario: ChaosScenarioId;
  state: string;
  injectedAt: string | null;
  confirmedAt: string | null;
  expiresAt: number;
  cleanup: string;
  cleanupAt: string | null;
  reason: string;
  evidence: Record<string, string | number | boolean | null>;
};
const get = (id: string) => {
  const r = db.prepare("SELECT body FROM faults WHERE id=?").get(id) as
    { body: string } | undefined;
  return r ? (JSON.parse(r.body) as Fault) : undefined;
};
const save = (f: Fault, active = true) =>
  db
    .prepare(
      "INSERT INTO faults VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,body=excluded.body",
    )
    .run(f.id, active ? 1 : 0, JSON.stringify(f));
const rows = () =>
  (
    db.prepare("SELECT body FROM faults WHERE active=1").all() as {
      body: string;
    }[]
  ).map((r) => JSON.parse(r.body) as Fault);
for (const f of rows())
  if (f.state === "INJECTING") {
    f.state = "AMBIGUOUS";
    f.reason = "adapter_interrupted_no_replay";
    save(f);
  }
const docker = new FaultDocker(
  z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,60}$/)
    .parse(process.env.HEALER_COMPOSE_PROJECT),
);
const toxicName = (id: string) => "chaos-" + id;
async function proxy(path: string, method = "GET", body?: object) {
  const r = await fetch(
    (process.env.CHAOS_TOXIPROXY_URL || "http://toxiproxy:8474") +
      "/proxies/recommendation-demo/toxics" +
      path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw Error("toxic_control_unavailable");
  return method === "DELETE" ? {} : r.json();
}
async function cleanup(f: Fault) {
  if (!temporary(f.scenario)) {
    f.cleanup = "NOT_REQUIRED";
    return true;
  }
  try {
    await proxy("/" + toxicName(f.id), "DELETE");
    if (await proxy("/" + toxicName(f.id))) throw Error("toxic_still_present");
    f.cleanup = "COMPLETED";
    f.cleanupAt = new Date().toISOString();
    save(f);
    return true;
  } catch {
    f.cleanup = "FAILED";
    f.reason = "owned_fault_cleanup_unconfirmed";
    save(f);
    return false;
  }
}
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2kb" }));
app.get("/health", (_q, r) => r.json({ alive: true, enabled: c.enabled }));
app.use((q, r, next) => {
  r.setHeader("Cache-Control", "no-store");
  if (
    !equal(q.headers.authorization || "", "Bearer " + c.CHAOS_CONTROL_SECRET)
  ) {
    r.sendStatus(401);
    return;
  }
  next();
});
app.get("/v1/status", (_q, r) =>
  r.json({ enabled: c.enabled, active: rows() }),
);
app.get("/v1/faults/:id", (q, r) => {
  if (!z.uuid().safeParse(q.params.id).success) {
    r.sendStatus(400);
    return;
  }
  const f = get(q.params.id);
  r.status(f ? 200 : 404).json(f || { code: "not_accepted" });
});
let injecting = false;
app.post("/v1/inject", async (q, r) => {
  const input = z
    .object({ id: z.uuid(), scenario: z.enum(supported) })
    .strict()
    .safeParse(q.body);
  if (!input.success) {
    r.status(400).json({ code: "unsupported_fault" });
    return;
  }
  const b = input.data;
  if (!c.enabled || !c.allowed.includes(b.scenario)) {
    r.status(403).json({ code: "chaos_disabled" });
    return;
  }
  const old = get(b.id);
  if (old) {
    r.status(old.scenario === b.scenario ? 200 : 409).json(
      old.scenario === b.scenario ? old : { code: "identity_conflict" },
    );
    return;
  }
  if (injecting || rows().length) {
    r.status(409).json({ code: "fault_already_active" });
    return;
  }
  const f: Fault = {
    id: b.id,
    scenario: b.scenario,
    state: "INJECTING",
    injectedAt: new Date().toISOString(),
    confirmedAt: null,
    expiresAt:
      Date.now() +
      (temporary(b.scenario) ? c.CHAOS_FAULT_DURATION_MS : c.CHAOS_TIMEOUT_MS),
    cleanup: temporary(b.scenario) ? "PENDING" : "NOT_REQUIRED",
    cleanupAt: null,
    reason: "durable_fault_intent",
    evidence: {},
  };
  // Intent is durable before the only permitted destructive effect.
  save(f);
  injecting = true;
  try {
    if (temporary(b.scenario)) {
      const toxic = {
        name: toxicName(b.id),
        type: b.scenario === "network-timeout" ? "latency" : "reset_peer",
        stream: "downstream",
        toxicity: 1,
        attributes:
          b.scenario === "network-timeout"
            ? { latency: 3500, jitter: 0 }
            : { timeout: 0 },
      };
      await proxy("", "POST", toxic);
      const actual = await proxy("/" + toxicName(b.id));
      if (actual?.name !== toxic.name) throw Error("toxic_unconfirmed");
      f.evidence = {
        toxicCreated: true,
        simulatedDependency: true,
        faultDurationMs: c.CHAOS_FAULT_DURATION_MS,
      };
    } else {
      f.evidence = await docker.kill(
        scenarioFor(b.scenario).target as
          "api-1" | "edge-1" | "origin-primary" | "redis",
      );
      if (!f.evidence.stoppedObserved) throw Error("stopped_state_unconfirmed");
    }
    f.state = "CONFIRMED";
    f.confirmedAt = new Date().toISOString();
    f.reason = "real_fault_confirmed";
  } catch {
    f.state = "AMBIGUOUS";
    f.reason = "injection_unconfirmed_no_replay";
  } finally {
    save(f);
    injecting = false;
  }
  log.info(
    { experimentId: f.id, scenario: f.scenario, state: f.state },
    "Restricted fault injection recorded",
  );
  r.json(f);
});
app.post("/v1/faults/:id/release", async (q, r) => {
  if (!z.uuid().safeParse(q.params.id).success) {
    r.sendStatus(400);
    return;
  }
  const f = get(q.params.id);
  if (!f) {
    r.status(404).json({ code: "not_accepted" });
    return;
  }
  if (
    f.state === "CLOSED" &&
    ["COMPLETED", "NOT_REQUIRED"].includes(f.cleanup)
  ) {
    r.json(f);
    return;
  }
  if (await cleanup(f)) {
    f.state = "CLOSED";
    save(f, false);
  }
  r.status(f.cleanup === "FAILED" ? 503 : 200).json(f);
});
app.use((_q, r) => r.sendStatus(404));
app.use(
  (
    _e: unknown,
    _q: express.Request,
    r: express.Response,
    _next: express.NextFunction,
  ) => r.status(503).json({ code: "fault_adapter_unavailable" }),
);
let busy = false;
const timer = setInterval(() => {
  if (busy || injecting) return;
  busy = true;
  void (async () => {
    for (const f of rows())
      if (Date.now() >= f.expiresAt) {
        if (await cleanup(f)) {
          f.state = "CLOSED";
          save(f, false);
        }
      }
  })()
    .catch(() =>
      log.warn("Fault expiry requires retry; no recovery action is permitted"),
    )
    .finally(() => (busy = false));
}, 500);
const server = app.listen(c.CHAOS_CONTROL_PORT, "0.0.0.0");
process.on("SIGTERM", () => {
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
