import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtureRuntime } from "./fixture-runtime.mjs";
import {
  compiledFixtureService,
  idleBaselineAssessment,
  idleBaselineGate,
} from "./fixture-runtime.mjs";

const snapshot = () => ({
  chaos: {
    available: true,
    scenarios: [{ id: "crash-api", available: true }],
    experiments: [],
  },
  healer: {
    available: true,
    databaseAvailable: true,
    leader: true,
    attempts: [],
  },
  health: {
    stale: false,
    persistence: true,
    incidentHistoryAvailable: true,
    openCount: 0,
    components: [{ id: "api-1", state: "HEALTHY", code: "probe_ok" }],
    incidents: [],
  },
});

const recoveredSnapshot = () => {
  const s = snapshot();
  s.healer.attempts.push({
    id: "startup-repair",
    component: "api-1",
    state: "VERIFIED",
    reason: "independent_behavior_verified",
    finishedAt: "2026-10-26T21:13:00.000Z",
    databasePersisted: true,
  });
  s.health.incidents.push({
    id: "startup-incident",
    component: "api-1",
    state: "RESOLVED",
    verified_at: "2026-10-26T21:13:01.000Z",
    resolved_at: "2026-10-26T21:13:01.000Z",
  });
  return s;
};

it("admits the reported healthy baseline after verified startup recovery without deleting history", () => {
  let time = 0;
  const s = recoveredSnapshot();
  const original = structuredClone(s);
  const gate = idleBaselineGate({ now: () => time });
  expect(gate.observe(s)).toEqual({
    pending: true,
    evidence: { stableForMs: 0, requiredStableMs: 30000 },
  });
  time = 29999;
  expect(gate.observe(s).pending).toBe(true);
  time = 30000;
  expect(gate.observe(s)).toBe(true);
  expect(s).toEqual(original);
});

it.each(["SCHEDULED", "EXECUTING", "VERIFYING", "RETRY_WAIT", "ESCALATED"])(
  "keeps an unresolved %s startup repair blocked even if probes are healthy",
  (state) => {
    const s = recoveredSnapshot();
    s.healer.attempts[0].state = state;
    const pending = idleBaselineGate().observe(s);
    expect(pending.evidence.recoveryAttempts).toEqual([
      expect.objectContaining({ id: "startup-repair", state }),
    ]);
  },
);

it.each(["finishedAt", "databasePersisted"])(
  "rejects VERIFIED history without %s proof",
  (field) => {
    const s = recoveredSnapshot();
    delete s.healer.attempts[0][field];
    expect(idleBaselineAssessment(s).ready).toBe(false);
  },
);

it.each(["state", "verified_at", "resolved_at"])(
  "does not infer incident closure without %s",
  (field) => {
    const s = recoveredSnapshot();
    delete s.health.incidents[0][field];
    expect(idleBaselineAssessment(s).ready).toBe(false);
  },
);

it.each(["stale", "persistence", "incidentHistoryAvailable", "openCount"])(
  "blocks unavailable or open monitoring evidence: %s",
  (field) => {
    const s = snapshot();
    s.health[field] = field === "openCount" ? 1 : field === "stale";
    expect(idleBaselineAssessment(s).ready).toBe(false);
  },
);

it("starts a new quiet window when a completed recovery appears between healthy samples", () => {
  let time = 0;
  const gate = idleBaselineGate({ now: () => time });
  gate.observe(snapshot());
  time = 29999;
  const s = recoveredSnapshot();
  expect(gate.observe(s).evidence.stableForMs).toBe(0);
  time = 59998;
  expect(gate.observe(s).pending).toBe(true);
  time = 59999;
  expect(gate.observe(s)).toBe(true);
});

it("ignores history ordering while retaining every completed record", () => {
  const s = recoveredSnapshot();
  s.healer.attempts.push({ ...s.healer.attempts[0], id: "other-repair" });
  s.health.incidents.push({ ...s.health.incidents[0], id: "other-incident" });
  const first = idleBaselineAssessment(s);
  s.healer.attempts.reverse();
  s.health.incidents.reverse();
  expect(idleBaselineAssessment(s).historyIdentity).toBe(first.historyIdentity);
  expect(first.history.recoveryAttempts).toHaveLength(2);
  expect(first.history.incidents).toHaveLength(2);
});

it("requires continuous healthy observations and restarts after a transient failure", () => {
  let time = 0;
  const gate = idleBaselineGate({
    now: () => time,
    scenarioIds: ["crash-api"],
  });
  expect(gate.observe(snapshot()).pending).toBe(true);
  time = 29000;
  const bad = snapshot();
  bad.health.components[0].state = "RECOVERING";
  expect(gate.observe(bad).pending).toBe(true);
  time = 30000;
  expect(gate.observe(snapshot()).pending).toBe(true);
  time = 59000;
  expect(gate.observe(snapshot()).pending).toBe(true);
  time = 60000;
  expect(gate.observe(snapshot())).toBe(true);
});

it.each(["incident", "repair", "experiment", "database", "missing-scenario"])(
  "does not hide %s during the idle baseline",
  (mode) => {
    const gate = idleBaselineGate({
      now: () => 100000,
      scenarioIds: ["crash-api"],
    });
    const s = snapshot();
    if (mode === "incident") s.health.incidents.push({ id: "actual-incident" });
    if (mode === "repair") s.healer.attempts.push({ id: "actual-repair" });
    if (mode === "experiment") s.chaos.experiments.push({ id: "actual-fault" });
    if (mode === "database") s.healer.databaseAvailable = false;
    if (mode === "missing-scenario") s.chaos.scenarios = [];
    expect(gate.observe(s).pending).toBe(true);
  },
);

it("does not count time across a failed request", () => {
  let time = 0;
  const gate = idleBaselineGate({ now: () => time });
  gate.observe(snapshot());
  time = 29999;
  gate.reset();
  time = 30000;
  expect(gate.observe(snapshot()).pending).toBe(true);
  time = 60000;
  expect(gate.observe(snapshot())).toBe(true);
});

it("replaces only supported TypeScript service commands and keeps pinned dependencies", () => {
  const s = {
    command: ["node", "--import", "tsx", "services/api/src/healing/server.ts"],
    volumes: [{ target: "/config" }],
  };
  const mapped = compiledFixtureService(s, "/fixture/.compiled");
  expect(mapped.command).toEqual([
    "node",
    "/app/.fixture-runtime/healing/server.js",
  ]);
  expect(mapped.volumes).toContainEqual({
    type: "bind",
    source: "/fixture/.compiled",
    target: "/app/.fixture-runtime",
    read_only: true,
  });
  expect(s.command).toHaveLength(4);
  for (const command of [
    ["node", "scripts/migrate.mjs"],
    ["ffmpeg"],
    ["node", "--import", "tsx", "unknown.ts"],
  ]) {
    const service = { command };
    expect(compiledFixtureService(service, "/fixture/.compiled")).toBe(service);
  }
});

it("compiles host-independent runtime code without bundling host native modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-compiled-runtime-"));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const out = await buildFixtureRuntime(root, dir);
    const server = readFileSync(join(out, "server.js"), "utf8");
    expect(server).toContain("@node-rs/argon2");
    expect(server).not.toContain("argon2.linux-x64");
    const chunks = readdirSync(out)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(out, f), "utf8"))
      .join("\n");
    expect(chunks).toContain('from "node:sqlite"');
    expect(chunks).not.toContain('from "sqlite"');
    for (const entry of [
      "monitoring/observer",
      "healing/server",
      "healing/adapter-server",
      "healing/dependency-demo",
      "chaos/server",
      "chaos/adapter",
    ])
      expect(
        readFileSync(join(out, entry + ".js"), "utf8").length,
      ).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
