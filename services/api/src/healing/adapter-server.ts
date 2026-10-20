import express from "express";
import pino from "pino";
import { z } from "zod";
import { equal } from "./authority.js";
import { healingConfig, managed } from "./config.js";
import { database } from "./journal.js";
import { ControlJournal } from "./control.js";
import { DockerControl } from "./docker.js";
const c = healingConfig(process.env),
  log = pino({ base: { service: "healing-control-adapter" } });
const db = database(process.env.CONTROL_JOURNAL || "/data/control.sqlite"),
  journal = new ControlJournal(db);
const project = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,60}$/)
  .parse(process.env.HEALER_COMPOSE_PROJECT);
const docker = new DockerControl(
  project,
  process.env.HEALER_DOCKER_SOCKET || "/var/run/docker.sock",
  c.HEALER_ACTION_TIMEOUT_MS,
);
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2kb" }));
app.get("/health", (_req, res) =>
  res.json({ alive: true, enabled: c.enabled }),
);
app.use((req, res, next) => {
  if (!equal(req.headers.authorization || "", "Bearer " + c.CONTROL_SECRET)) {
    res.sendStatus(401);
    return;
  }
  next();
});
app.post("/v1/lease", (req, res) => {
  const body = z.object({ owner: z.uuid() }).strict().safeParse(req.body);
  if (!body.success) {
    res.sendStatus(400);
    return;
  }
  const lease = journal.lease(body.data.owner, c.HEALER_LEASE_MS);
  res.status(lease ? 200 : 409).json(lease || { code: "leader_held" });
});
app.get("/v1/actions/:id", (req, res) => {
  if (!z.uuid().safeParse(req.params.id).success) {
    res.sendStatus(400);
    return;
  }
  const row = journal.get(req.params.id);
  res.status(row ? 200 : 404).json(row || { code: "not_accepted" });
});
let busy = false;
app.post("/v1/start", async (req, res) => {
  const parsed = z
    .object({
      service: z.enum(managed),
      attemptId: z.uuid(),
      owner: z.uuid(),
      epoch: z.number().int().positive(),
    })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: "unsupported_operation" });
    return;
  }
  const b = parsed.data;
  if (!c.enabled || !c.allowed.includes(b.service)) {
    res.status(403).json({ code: "policy_disabled" });
    return;
  }
  if (!journal.valid(b.owner, b.epoch)) {
    res.status(409).json({ code: "stale_leader" });
    return;
  }
  const previous = journal.get(b.attemptId);
  if (previous) {
    res
      .status(previous.service === b.service ? 200 : 409)
      .json(
        previous.service === b.service
          ? previous
          : { code: "identity_conflict" },
      );
    return;
  }
  if (busy) {
    res.status(409).json({ code: "action_busy" });
    return;
  }
  busy = true;
  try {
    const status = journal.claim(
      b.attemptId,
      b.service,
      c.HEALER_COOLDOWN_MS,
      c.HEALER_MAX_STARTS,
      c.HEALER_BUDGET_WINDOW_MS,
    );
    if (status !== "accepted") {
      res.status(429).json({ code: status });
      return;
    }
    if (!journal.valid(b.owner, b.epoch)) {
      journal.finish(b.attemptId, "REJECTED", "stale_leader");
      res.status(409).json({ code: "stale_leader" });
      return;
    }
    try {
      const code = await docker.start(b.service);
      journal.finish(b.attemptId, "ACCEPTED", code);
      log.info(
        { attemptId: b.attemptId, component: b.service, code },
        "Allowlisted operation completed",
      );
    } catch {
      journal.finish(b.attemptId, "AMBIGUOUS", "start_unconfirmed_or_unsafe");
      log.warn(
        { attemptId: b.attemptId, component: b.service },
        "No confirmed safe start outcome; inspection required",
      );
    }
    res.json(journal.get(b.attemptId));
  } finally {
    busy = false;
  }
});
app.use((_req, res) => res.sendStatus(404));
app.use(
  (
    _error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    log.error("Control request failed; no unconfirmed action will be replayed");
    res.status(500).json({ code: "control_request_failed" });
  },
);
const server = app.listen(c.CONTROL_PORT, "0.0.0.0");
process.on("SIGTERM", () =>
  server.close(() => {
    db.close();
    process.exit(0);
  }),
);
