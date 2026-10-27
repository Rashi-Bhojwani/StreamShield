import express from "express";
import { z } from "zod";
import pino from "pino";
import { chaosConfig, scenarios } from "./config.js";
import { ChaosJournal } from "./journal.js";
import { ChaosStore } from "./store.js";
import { ChaosEngine, ChaosAdmissionError } from "./engine.js";
import { Verifier } from "../healing/verification.js";
import { equal } from "../healing/authority.js";
const c = chaosConfig(process.env),
  log = pino({ base: { service: "chaos-controller" } }),
  journal = new ChaosJournal(
    process.env.CHAOS_JOURNAL || "/data/chaos/experiments.sqlite",
  ),
  store = new ChaosStore();
const engine = new ChaosEngine(
  c,
  journal,
  store,
  new Verifier({ HEALER_PROBE_TIMEOUT_MS: c.CHAOS_PROBE_TIMEOUT_MS }),
);
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2kb" }));
app.get("/health", (_q, r) =>
  r
    .status(
      engine.lastCompleted && Date.now() - engine.lastCompleted < 15000
        ? 200
        : 503,
    )
    .json({ alive: !!engine.lastCompleted, enabled: c.enabled }),
);
// Private Nginx auth subrequest: status only, no credentials or control access.
app.get("/media-access", (_q, r) => {
  r.setHeader("Cache-Control", "no-store");
  if (c.CHAOS_MEDIA_GATE_ENABLED !== "true") {
    r.sendStatus(404);
    return;
  }
  r.sendStatus(engine.mediaAccessBlocked() ? 403 : 204);
});
app.use((q, r, next) => {
  r.setHeader("Cache-Control", "no-store");
  if (!equal(q.headers.authorization || "", "Bearer " + c.CHAOS_SECRET)) {
    r.sendStatus(401);
    return;
  }
  next();
});
app.get("/state", (_q, r) => r.json(engine.snapshot()));
app.post("/experiments", async (q, r, next) => {
  try {
    const b = z
      .object({
        id: z.uuid(),
        actor: z.uuid(),
        scenario: z.enum(scenarios.map((s) => s.id)),
        confirmation: z.string().max(40),
      })
      .strict()
      .parse(q.body);
    r.status(201).json(
      await engine.submit(b.id, b.actor, b.scenario, b.confirmation),
    );
  } catch (e) {
    next(e);
  }
});
app.post("/experiments/:id/cancel", (q, r, next) => {
  try {
    const id = z.uuid().parse(q.params.id),
      b = z.object({ actor: z.uuid() }).strict().parse(q.body);
    r.json(engine.cancel(id, b.actor));
  } catch (e) {
    next(e);
  }
});
app.post("/experiments/:id/restore-media-authority", (q, r, next) => {
  try {
    const id = z.uuid().parse(q.params.id);
    const b = z
      .object({ actor: z.uuid(), confirmation: z.literal("media-authority") })
      .strict()
      .parse(q.body);
    r.status(202).json(
      engine.requestOperatorReset(id, b.actor, b.confirmation),
    );
  } catch (e) {
    next(e);
  }
});
app.use((_q, r) => r.sendStatus(404));
app.use(
  (
    e: unknown,
    _q: express.Request,
    r: express.Response,
    _next: express.NextFunction,
  ) => {
    const code =
      e instanceof z.ZodError
        ? "invalid_experiment"
        : e instanceof Error
          ? e.message
          : "chaos_unavailable";
    const known = [
      "invalid_experiment",
      "identity_conflict",
      "experiment_active",
      "experiment_rate_limit",
      "target_cooldown",
      "chaos_disabled",
      "unsupported_scenario",
      "confirmation_required",
      "prerequisites_unavailable",
      "audit_unavailable",
      "experiment_not_found",
      "operator_restore_required",
      "fault_not_confirmed",
    ];
    r.status(
      code === "experiment_rate_limit"
        ? 429
        : code === "audit_unavailable"
          ? 503
          : code === "chaos_disabled"
            ? 403
            : code === "invalid_experiment" ||
                code === "unsupported_scenario" ||
                code === "confirmation_required"
              ? 400
              : code === "experiment_not_found"
                ? 404
                : known.includes(code)
                  ? 409
                  : 503,
    ).json({
      code: known.includes(code) ? code : "chaos_unavailable",
      ...(e instanceof ChaosAdmissionError ? { reason: e.reason } : {}),
    });
  },
);
let stopped = false;
async function loop() {
  while (!stopped) {
    try {
      await engine.tick();
    } catch {
      log.warn(
        { code: "chaos_observation_unavailable" },
        "Experiment state remains journaled; no unconfirmed destructive request is replayed",
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
void loop();
const server = app.listen(c.CHAOS_PORT, "0.0.0.0");
process.on("SIGTERM", () => {
  stopped = true;
  server.close();
  void store.db.end();
  setTimeout(() => process.exit(0), 1500).unref();
});
