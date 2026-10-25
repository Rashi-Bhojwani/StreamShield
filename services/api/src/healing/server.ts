import express from "express";
import pino from "pino";
import { equal } from "./authority.js";
import { healingConfig } from "./config.js";
import { Journal } from "./journal.js";
import { RecoveryStore } from "./store.js";
import { Verifier } from "./verification.js";
import { Healer } from "./controller.js";
const c = healingConfig(process.env),
  log = pino({ base: { service: "streamshield-healer" } }),
  journal = new Journal(
    process.env.HEALER_JOURNAL || "/data/healer/state.sqlite",
  ),
  store = new RecoveryStore();
const healer = new Healer(c, journal, store, new Verifier(c), log);
let stopped = false,
  lastCompleted = 0;
const app = express();
app.disable("x-powered-by");
app.get("/health", (_req, res) =>
  res
    .status(
      lastCompleted && Date.now() - lastCompleted < c.HEALER_LEASE_MS
        ? 200
        : 503,
    )
    .json({
      alive: !!lastCompleted,
      enabled: c.enabled,
      observerAvailable: healer.available,
      databaseAvailable: store.available,
    }),
);
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!equal(req.headers.authorization || "", "Bearer " + c.HEALER_SECRET)) {
    res.sendStatus(401);
    return;
  }
  next();
});
app.get("/state", (_req, res) => res.json(healer.snapshot()));
app.get("/metrics", async (_req, res) =>
  res
    .type(healer.metrics.registry.contentType)
    .send(await healer.metrics.registry.metrics()),
);
app.get("/dependency", async (_req, res) => {
  try {
    res.json(await healer.dependency());
  } catch {
    res.status(503).json({
      status: "degraded",
      simulated: true,
      feature: "recommendation-demo",
      recommendations: [],
      circuit: healer.circuit.state,
    });
  }
});
const server = app.listen(c.HEALER_PORT, "0.0.0.0");
async function run() {
  while (!stopped) {
    try {
      await healer.tick();
    } catch {
      log.warn(
        { code: "cycle_unavailable" },
        "Recovery cycle incomplete; no unbounded retry",
      );
    }
    lastCompleted = Date.now();
    await new Promise((r) => setTimeout(r, c.HEALER_INTERVAL_MS));
  }
}
void run();
process.on("SIGTERM", () => {
  stopped = true;
  server.close();
  void store.db.end();
  setTimeout(() => process.exit(0), 1500).unref();
});
