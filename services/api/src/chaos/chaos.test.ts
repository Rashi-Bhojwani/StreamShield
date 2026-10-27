import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealingSnapshot, RecoveryAttempt } from "@streamshield/shared";
import { chaosConfig, scenarios } from "./config.js";
import { killable, freezable } from "./docker.js";
import { startSurge } from "./load.js";
import { ChaosJournal } from "./journal.js";
import { ChaosEngine } from "./engine.js";
import type { ChaosStore } from "./store.js";
import type { Verifier } from "../healing/verification.js";
const env = {
  CHAOS_SECRET: "a".repeat(43),
  CHAOS_CONTROL_SECRET: "b".repeat(43),
  CHAOS_ENABLED: "true",
  CHAOS_ENVIRONMENT: "local-development",
  CHAOS_OBSERVATION_WINDOW_MS: "5000",
};
const journals: ChaosJournal[] = [];
const dirs: string[] = [];
afterEach(() => {
  journals.forEach((j) => j.db.close());
  journals.length = 0;
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  dirs.length = 0;
  vi.restoreAllMocks();
});
function journal(path = ":memory:") {
  const j = new ChaosJournal(path);
  journals.push(j);
  return j;
}
function fixture() {
  const j = journal(),
    store = {
      available: true,
      get: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      check: vi.fn().mockResolvedValue(undefined),
    };
  const verifier = {
    unavailable: vi.fn().mockResolvedValue({
      unavailable: true,
      code: "probe_unreachable",
      observedAt: new Date().toISOString(),
    }),
  } as unknown as Verifier;
  const engine = new ChaosEngine(
    chaosConfig(env),
    j,
    store as unknown as ChaosStore,
    verifier,
  );
  engine.frame = {
    components: [
      "postgres",
      "redis",
      "api-1",
      "api-2",
      "api-gateway",
      "relay",
      "origin-primary",
      "origin-standby",
      "edge-1",
      "edge-2",
      "video-gateway",
      "demo-dependency",
    ].map((id) => ({
      id,
      state: "HEALTHY",
      observedAt: new Date().toISOString(),
      code: "probe_ok",
    })) as never,
    media: [
      {
        path: "live",
        publisher: true,
        checkedAt: new Date().toISOString(),
        sources: ["primary", "standby"].map((id) => ({
          id,
          manifest: true,
          segment: true,
          fresh: true,
          code: "verified",
        })),
      },
    ] as never,
    mediaAvailable: true,
    lastCompleted: Date.now(),
    persistence: true,
  };
  engine.healer = {
    available: true,
    databaseAvailable: true,
    enabled: true,
    leader: true,
    observedAt: new Date().toISOString(),
    attempts: [],
    circuit: { state: "CLOSED" },
    budgets: Object.fromEntries(
      [
        "api-1",
        "api-2",
        "edge-1",
        "edge-2",
        "origin-primary",
        "redis",
        "video-gateway",
        "relay",
        "api-3",
      ].map((s) => [s, { used: 0, max: 2, availableAt: null }]),
    ),
  } as unknown as HealingSnapshot;
  engine.controlAvailable = true;
  engine.crashBaseline = {
    observedAt: new Date().toISOString(),
    api: true,
    gateway: true,
    sourceCount: 1,
    progressingPaths: 1,
    reason: null,
  };
  return { engine, j, store };
}
async function submitted() {
  const f = fixture();
  const e = await f.engine.submit(
    randomUUID(),
    randomUUID(),
    "crash-api",
    "api-1",
  );
  return { ...f, e };
}
describe("chaos authority and admission", () => {
  it.each([
    {},
    { NODE_ENV: "production" },
    { BIND_ADDRESS: "0.0.0.0" },
    { CHAOS_ENVIRONMENT: "disabled" },
    { CHAOS_ENABLED: "false" },
  ])(
    "fails closed outside explicitly opted-in loopback development: %j",
    (overrides) => {
      const c = Object.keys(overrides).length
        ? { ...env, ...overrides }
        : {
            CHAOS_SECRET: env.CHAOS_SECRET,
            CHAOS_CONTROL_SECRET: env.CHAOS_CONTROL_SECRET,
          };
      expect(chaosConfig(c).enabled).toBe(false);
    },
  );
  it("rejects arbitrary identities, shared authority and unbounded fault duration", () => {
    for (const overrides of [
      { CHAOS_ALLOWED_SCENARIOS: "postgres" },
      { CHAOS_ALLOWED_SCENARIOS: "crash-api,crash-api" },
      { CHAOS_CONTROL_SECRET: env.CHAOS_SECRET },
      { CHAOS_FAULT_DURATION_MS: "60000" },
      { CHAOS_CONCURRENCY: "2" },
    ])
      expect(() => chaosConfig({ ...env, ...overrides })).toThrow();
  });
  it("shows unsafe/unowned scenarios as disabled with explicit reasons", () => {
    expect(scenarios.filter((s) => s.supported)).toHaveLength(12);
    expect(
      scenarios
        .filter((s) => !s.supported)
        .every((s) => !!s.reason && !s.available),
    ).toBe(true);
  });
  it("requires fresh enabled independent Healer and observer", () => {
    const { engine } = fixture();
    engine.healer!.enabled = false;
    expect(engine.reason("crash-api")).toContain("Fresh");
    engine.healer!.enabled = true;
    engine.frame!.lastCompleted -= 13000;
    expect(engine.reason("crash-api")).toContain("stale");
  });
  it("blocks admission while terminal fault cleanup remains owned by adapter", () => {
    const { engine } = fixture();
    engine.adapterActive = 1;
    expect(engine.reason("crash-api")).toContain("cleanup");
  });
  it("requires exact confirmation and denies unsupported scenarios before any side effect", async () => {
    const { engine } = fixture(),
      control = vi.spyOn(engine, "control");
    await expect(
      engine.submit(randomUUID(), randomUUID(), "crash-api", "api-2"),
    ).rejects.toThrow("confirmation");
    await expect(
      engine.submit(randomUUID(), randomUUID(), "database-outage", "postgres"),
    ).rejects.toThrow("unsupported");
    expect(control).not.toHaveBeenCalled();
  });
  it("records actor-bound UUID idempotency, denies conflicting retries and global concurrency", async () => {
    const { engine, e } = await submitted();
    expect((await engine.submit(e.id, e.actor, e.scenario, "api-1")).id).toBe(
      e.id,
    );
    await expect(
      engine.submit(e.id, randomUUID(), e.scenario, "api-1"),
    ).rejects.toThrow("identity_conflict");
    await expect(
      engine.submit(randomUUID(), e.actor, "crash-redis", "redis"),
    ).rejects.toThrow("prerequisites");
  });
  it("preserves actor-bound identity after local retention by checking durable PostgreSQL audit", async () => {
    const { engine, e, j, store } = await submitted();
    e.state = "COMPLETED";
    e.finishedAt = new Date(Date.now() - 100 * 86400000).toISOString();
    j.save(e);
    j.synced(e);
    j.prune(90);
    expect(j.get(e.id)).toBeUndefined();
    store.get.mockResolvedValue(e);
    expect((await engine.submit(e.id, e.actor, e.scenario, "api-1")).id).toBe(
      e.id,
    );
    await expect(
      engine.submit(e.id, randomUUID(), e.scenario, "api-1"),
    ).rejects.toThrow("identity_conflict");
  });
  it("fails before injection when audit persistence is unavailable", async () => {
    const { engine, store, j } = fixture();
    store.sync.mockRejectedValue(Error("database"));
    const control = vi.spyOn(engine, "control");
    await expect(
      engine.submit(
        randomUUID(),
        randomUUID(),
        "network-timeout",
        "demo-dependency",
      ),
    ).rejects.toThrow("audit");
    expect(control).not.toHaveBeenCalled();
    expect(j.all()[0]).toMatchObject({
      state: "FAILED",
      cleanup: "NOT_REQUIRED",
    });
  });
});
describe("durable chaos lifecycle", () => {
  it("persists active experiment across process restart without reacceptance", async () => {
    const { e } = await submitted(),
      dir = mkdtempSync(join(tmpdir(), "streamshield-chaos-"));
    dirs.push(dir);
    const j = journal(join(dir, "journal.sqlite"));
    j.create(e, 12, 600000, 30000);
    j.db.close();
    journals.splice(journals.indexOf(j), 1);
    const reopened = journal(join(dir, "journal.sqlite"));
    expect(reopened.get(e.id)?.actor).toBe(e.actor);
    expect(reopened.work()[0]!.id).toBe(e.id);
    expect(() =>
      reopened.create({ ...e, id: randomUUID() }, 12, 600000, 30000),
    ).toThrow("active");
  });
  it("enforces persisted rolling rate and target cooldown after terminal outcomes", async () => {
    const { j, e } = await submitted();
    e.state = "CANCELLED";
    j.save(e);
    expect(() =>
      j.create({ ...e, id: randomUUID() }, 12, 600000, 30000),
    ).toThrow("cooldown");
    expect(() =>
      j.create({ ...e, id: randomUUID(), target: "redis" }, 1, 600000, 0),
    ).toThrow("rate");
  });
  it("cancels before injection without calling fault adapter or any healing API", async () => {
    const { engine, e, j } = await submitted(),
      control = vi.spyOn(engine, "control");
    engine.cancel(e.id, e.actor);
    await engine["advance"](j.get(e.id)!);
    expect(control).not.toHaveBeenCalled();
    expect(j.get(e.id)).toMatchObject({
      state: "CANCELLED",
      cleanup: "NOT_REQUIRED",
    });
  });
  it("preserves cancellation received while the fault receipt is in flight", async () => {
    const { engine, e, j } = await submitted();
    e.state = "VALIDATING";
    j.save(e);
    vi.spyOn(engine, "control").mockImplementation(async (path) => {
      if (path === "/v1/inject") {
        engine.cancel(e.id, e.actor);
        return {
          state: "CONFIRMED",
          injectedAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
          expiresAt: Date.now() + 180000,
          cleanup: "NOT_REQUIRED",
          evidence: {},
        };
      }
      return { cleanup: "NOT_REQUIRED" };
    });
    await engine["advance"](e);
    const current = j.get(e.id)!;
    expect(current.cancelRequestedBy).toBe(e.actor);
    expect(
      current.events.filter((x) => x.kind === "CANCEL_REQUESTED"),
    ).toHaveLength(1);
    await engine["advance"](current);
    expect(j.get(e.id)?.state).toBe("CANCELLED");
  });
  it("does not erase a cancellation with an older PostgreSQL acknowledgement or inject afterward", async () => {
    const { engine, e, j, store } = await submitted();
    e.state = "VALIDATING";
    j.save(e);
    store.sync.mockImplementationOnce(async () => {
      engine.cancel(e.id, e.actor);
    });
    const control = vi
      .spyOn(engine, "control")
      .mockResolvedValue({ cleanup: "NOT_REQUIRED" });
    await engine["advance"](e);
    expect(control).not.toHaveBeenCalled();
    expect(j.get(e.id)).toMatchObject({
      cancelRequestedBy: e.actor,
      databasePersisted: false,
    });
    await engine["advance"](j.get(e.id)!);
    expect(j.get(e.id)?.state).toBe("CANCELLED");
  });
  it("honors disabled policy after admission but before injection", async () => {
    const { engine, e, j } = await submitted();
    e.state = "VALIDATING";
    j.save(e);
    engine.c.enabled = false;
    const control = vi.spyOn(engine, "control");
    await engine["advance"](e);
    expect(control).not.toHaveBeenCalled();
    expect(j.get(e.id)).toMatchObject({
      state: "FAILED",
      cleanup: "NOT_REQUIRED",
      injectedAt: null,
    });
  });
  it("records injection intent before POST and never repeats a lost injection response", async () => {
    const { engine, e, j } = await submitted();
    e.state = "VALIDATING";
    j.save(e);
    const control = vi
      .spyOn(engine, "control")
      .mockImplementation(async (path) => {
        if (path === "/v1/inject") {
          expect(j.get(e.id)?.state).toBe("INJECTING");
          throw Error("response lost");
        }
        throw Error("unavailable");
      });
    await engine["advance"](e);
    await engine["advance"](j.get(e.id)!);
    await engine["advance"](j.get(e.id)!);
    expect(control.mock.calls.map((c) => c[0])).toEqual([
      "/v1/inject",
      "/v1/faults/" + e.id,
      "/v1/faults/" + e.id,
    ]);
    expect(j.get(e.id)?.state).toBe("INJECTING");
  });
  it("times out honestly and retains failed cleanup for reconciliation", async () => {
    const { engine, e, j } = await submitted();
    e.state = "INJECTING";
    e.deadline = Date.now() - 1;
    j.save(e);
    const control = vi
      .spyOn(engine, "control")
      .mockRejectedValue(Error("adapter down"));
    await engine["advance"](e);
    expect(j.get(e.id)).toMatchObject({
      state: "TIMED_OUT",
      cleanup: "FAILED",
      verifiedAt: null,
    });
    expect(j.work()).toHaveLength(1);
    expect(control).toHaveBeenCalledWith("/v1/faults/" + e.id + "/release", {});
  });
  it("never claims completed restoration if cleanup failed", async () => {
    const { engine, e, j } = await submitted();
    e.state = "VERIFYING";
    e.injectedAt = new Date().toISOString();
    j.save(e);
    vi.spyOn(engine, "control").mockRejectedValue(Error("cleanup"));
    await engine.finish(e, "COMPLETED", "restored");
    expect(j.get(e.id)).toMatchObject({ state: "FAILED", cleanup: "FAILED" });
  });
  it("waits for independently progressing standby media before injecting and rejects idle paths", async () => {
    const { engine, e, j } = await submitted();
    e.scenario = "crash-edge";
    e.target = "edge-1";
    e.state = "VALIDATING";
    j.save(e);
    engine.verifier.paths = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue(["s-" + "a".repeat(32)]);
    engine.verifier.hls = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({ ok: true });
    engine.verifier.edgeRoute = vi.fn().mockResolvedValue({
      edge: "edge-1",
      observedAt: new Date().toISOString(),
    });
    const control = vi.spyOn(engine, "control").mockResolvedValue({
      state: "CONFIRMED",
      injectedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      expiresAt: Date.now() + 180000,
      cleanup: "NOT_REQUIRED",
      evidence: {},
    });
    await engine["advance"](e);
    await engine["advance"](e);
    expect(control).not.toHaveBeenCalled();
    expect(j.get(e.id)?.state).toBe("VALIDATING");
    await engine["advance"](e);
    expect(control).toHaveBeenCalledWith("/v1/inject", {
      id: e.id,
      scenario: "crash-edge",
    });
  });
  it("does not correlate a recovery attempt that predates the actual injected fault", async () => {
    const { engine, e, j } = await submitted();
    e.state = "AWAITING_DETECTION";
    e.injectedAt = new Date().toISOString();
    j.save(e);
    engine.healer!.attempts = [
      {
        id: randomUUID(),
        component: e.target,
        createdAt: new Date(Date.parse(e.injectedAt) - 1).toISOString(),
      } as RecoveryAttempt,
    ];
    vi.spyOn(engine, "control").mockResolvedValue({ cleanup: "NOT_REQUIRED" });
    await engine["advance"](e);
    expect(e.recoveryIds).toEqual([]);
  });
  it("retains actual repeated circuit transitions instead of deduplicating history", async () => {
    const { engine, e } = await submitted();
    for (const state of ["OPEN", "HALF_OPEN", "OPEN"] as const)
      engine.event(e, `CIRCUIT_${state}`, state);
    expect(
      e.events.filter((x) => x.kind.startsWith("CIRCUIT_")).map((x) => x.kind),
    ).toEqual(["CIRCUIT_OPEN", "CIRCUIT_HALF_OPEN", "CIRCUIT_OPEN"]);
  });
  it.each([false, true])(
    "records backup serving only while the failed edge is independently unavailable (%s)",
    async (unavailable) => {
      const { engine, e } = await submitted();
      e.scenario = "crash-edge";
      e.target = "edge-1";
      e.state = "FAULT_CONFIRMED";
      e.faultConfirmedAt = new Date().toISOString();
      e.evidence.edgeBefore = "edge-1";
      engine.verifier.unavailable = vi.fn().mockResolvedValue({ unavailable });
      engine.verifier.edgeRoute = vi.fn().mockResolvedValue({
        edge: "edge-2",
        observedAt: new Date().toISOString(),
      });
      await engine["advance"](e);
      expect(!!e.evidence.edgeFailoverObservedAt).toBe(unavailable);
      expect(e.events.some((x) => x.kind === "EDGE_FAILOVER_VERIFIED")).toBe(
        unavailable,
      );
    },
  );
  it("captures actual edge failover with the accepted fault receipt before a fast repair can hide it", async () => {
    const { engine, e, j } = await submitted();
    e.scenario = "crash-edge";
    e.target = "edge-1";
    e.state = "INJECTING";
    e.evidence.edgeBefore = "edge-1";
    const observedAt = new Date().toISOString();
    engine.verifier.unavailable = vi
      .fn()
      .mockResolvedValue({ unavailable: true });
    engine.verifier.edgeRoute = vi
      .fn()
      .mockResolvedValue({ edge: "edge-2", observedAt });
    await engine["receipt"](e, {
      state: "CONFIRMED",
      injectedAt: observedAt,
      confirmedAt: observedAt,
      expiresAt: Date.now() + 180000,
      cleanup: "NOT_REQUIRED",
      evidence: { killAccepted: true, stoppedObserved: true },
    });
    expect(j.get(e.id)).toMatchObject({
      state: "FAULT_CONFIRMED",
      evidence: { edgeAfter: "edge-2", edgeFailoverObservedAt: observedAt },
    });
    expect(e.recoveryIds).toHaveLength(0);
  });
});

const attempt = (
  component: string,
  overrides: Partial<RecoveryAttempt> = {},
): RecoveryAttempt =>
  ({
    id: randomUUID(),
    incidentId: null,
    component,
    playbook: component.startsWith("api") ? "api-start" : component + "-start",
    action: "start_stopped_service",
    diagnosis: "test",
    state: "VERIFIED",
    createdAt: new Date(Date.now() + 5).toISOString(),
    actionStartedAt: new Date(Date.now() + 10).toISOString(),
    actionFinishedAt: new Date(Date.now() + 20).toISOString(),
    verificationStartedAt: new Date(Date.now() + 30).toISOString(),
    finishedAt: new Date(Date.now() + 40).toISOString(),
    reason: "independent_behavior_verified",
    evidence: { controlReceipt: "docker_start_accepted" },
    events: [],
    ...overrides,
  }) as RecoveryAttempt;
async function injected(
  scenario: "hang-api" | "crash-api-tier" | "crash-relay",
  target: string,
) {
  const f = fixture();
  const e = await f.engine.submit(randomUUID(), randomUUID(), scenario, target);
  e.state = "AWAITING_DETECTION";
  e.injectedAt = new Date().toISOString();
  f.j.save(e);
  vi.spyOn(f.engine, "control").mockResolvedValue({
    cleanup: "NOT_REQUIRED",
  });
  f.engine.verifier.verify = vi
    .fn()
    .mockResolvedValue({ ok: true, evidence: {} });
  return { ...f, e };
}
async function settle(engine: ChaosEngine, id: string, j: ChaosJournal) {
  // Two observations 2 s apart satisfy the stability window.
  const now = Date.now();
  for (const at of [now, now + 6000]) {
    vi.spyOn(Date, "now").mockReturnValue(at);
    engine.frame!.lastCompleted = at;
    for (const c of engine.frame!.components)
      c.observedAt = new Date(at).toISOString();
    engine.healer!.observedAt = new Date(at).toISOString();
    if (engine.crashBaseline)
      engine.crashBaseline.observedAt = new Date(at).toISOString();
    await engine["advance"](j.get(id)!);
  }
}
describe("final self-healing scenarios", () => {
  it("lists the core five first, each with a real-world cause and expected receipt", () => {
    expect(scenarios.slice(0, 5).map((s) => s.id)).toEqual([
      "crash-redis",
      "crash-video-gateway",
      "crash-api-tier",
      "crash-relay",
      "hang-api",
    ]);
    for (const s of scenarios.filter((s) => s.kind === "healer")) {
      expect(s.realWorldCause.length).toBeGreaterThan(10);
      expect(s.audienceSees.length).toBeGreaterThan(10);
      expect(s.expectedReceipt).toMatch(/^docker_(start|restart)_accepted$/);
    }
    expect(scenarios.find((s) => s.id === "hang-api")?.expectedReceipt).toBe(
      "docker_restart_accepted",
    );
    expect(
      scenarios
        .filter((s) => s.kind === "resilience")
        .every((s) => s.expectedReceipt === null),
    ).toBe(true);
  });
  it("never allowlists postgres or unrelated targets for faults", () => {
    expect(killable).not.toContain("postgres" as never);
    expect(freezable).toEqual(["api-2"]);
    // The surge is generated load, not a Docker fault: it has no fault target.
    for (const s of scenarios.filter(
      (s) => s.kind === "healer" && s.id !== "traffic-surge",
    ))
      for (const t of s.targets)
        expect([...killable, ...freezable]).toContain(t as never);
  });
  it("requires the typed api-tier confirmation for the whole tier", async () => {
    const { engine } = fixture();
    await expect(
      engine.submit(randomUUID(), randomUUID(), "crash-api-tier", "api-1"),
    ).rejects.toThrow("confirmation");
  });
  it("refuses a hang experiment unless the Healer restart playbook is enabled", () => {
    const { engine } = fixture();
    process.env.HEALER_DISABLED_PLAYBOOKS = "api-restart-unresponsive";
    try {
      expect(engine.reason("hang-api")).toContain("playbook is disabled");
      expect(engine.reason("crash-api")).toBeNull();
    } finally {
      delete process.env.HEALER_DISABLED_PLAYBOOKS;
    }
  });
  it("confirms a hang only when the direct readiness probe times out", async () => {
    const { engine, j } = fixture();
    const e = await engine.submit(
      randomUUID(),
      randomUUID(),
      "hang-api",
      "api-2",
    );
    e.state = "INJECTING";
    j.save(e);
    const receipt = {
      state: "CONFIRMED",
      injectedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      expiresAt: Date.now() + 180000,
      cleanup: "NOT_REQUIRED",
      evidence: { runningObserved: true },
    };
    const control = vi.spyOn(engine, "control").mockResolvedValue(receipt);
    const probe = vi
      .spyOn(engine, "hangProbe")
      .mockResolvedValueOnce("answered_200")
      .mockResolvedValue("probe_timeout");
    await engine["advance"](j.get(e.id)!);
    expect(j.get(e.id)?.state).toBe("INJECTING");
    await engine["advance"](j.get(e.id)!);
    expect(j.get(e.id)).toMatchObject({ state: "FAULT_CONFIRMED" });
    expect(j.get(e.id)?.evidence.readinessProbe).toBe("probe_timeout");
    // The accepted fault is re-read, never re-injected.
    expect(control.mock.calls.every((c) => c[0] !== "/v1/inject")).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("completes a hang only with a docker_restart_accepted receipt from the restart playbook", async () => {
    const ok = await injected("hang-api", "api-2");
    ok.engine.healer!.attempts = [
      attempt("api-2", {
        playbook: "api-restart-unresponsive",
        action: "restart_unresponsive_service",
        evidence: { controlReceipt: "docker_restart_accepted" },
      }),
    ];
    await settle(ok.engine, ok.e.id, ok.j);
    expect(ok.j.get(ok.e.id)).toMatchObject({ state: "COMPLETED" });
    vi.restoreAllMocks();
    const wrong = await injected("hang-api", "api-2");
    wrong.engine.healer!.attempts = [attempt("api-2")];
    await settle(wrong.engine, wrong.e.id, wrong.j);
    expect(wrong.j.get(wrong.e.id)?.state).toBe("FAILED");
    expect(wrong.j.get(wrong.e.id)?.reason).toContain(
      "docker_restart_accepted",
    );
  });
  it("requires two accepted Healer receipts before the API tier completes", async () => {
    const { engine, e, j } = await injected("crash-api-tier", "api-tier");
    const one = attempt("api-1"),
      two = attempt("api-2", { state: "VERIFYING", finishedAt: null });
    engine.healer!.attempts = [one];
    await settle(engine, e.id, j);
    expect(j.get(e.id)?.state).not.toBe("COMPLETED");
    engine.healer!.attempts = [one, two];
    await settle(engine, e.id, j);
    expect(j.get(e.id)?.state).not.toBe("COMPLETED");
    engine.healer!.attempts = [
      one,
      { ...two, state: "VERIFIED", finishedAt: new Date().toISOString() },
    ];
    await settle(engine, e.id, j);
    expect(j.get(e.id)).toMatchObject({ state: "COMPLETED" });
    expect(j.get(e.id)?.recoveryIds).toHaveLength(2);
    expect(j.get(e.id)?.evidence.healerReceipts).toBe(2);
  });
  it("fails the API tier when either instance escalates", async () => {
    const { engine, e, j } = await injected("crash-api-tier", "api-tier");
    engine.healer!.attempts = [
      attempt("api-1"),
      attempt("api-2", { state: "ESCALATED", reason: "budget_exhausted" }),
    ];
    await engine["advance"](j.get(e.id)!);
    expect(j.get(e.id)?.state).toBe("FAILED");
    expect(j.get(e.id)?.reason).toContain("api-2");
  });
  it("records the broadcaster's own reconnection separately from the relay repair", async () => {
    const { engine, e, j } = await injected("crash-relay", "relay");
    e.evidence.livePathsAtInjection = 1;
    j.save(e);
    engine.healer!.attempts = [attempt("relay", { playbook: "relay-start" })];
    engine.frame!.media = [];
    await settle(engine, e.id, j);
    expect(j.get(e.id)?.state).not.toBe("COMPLETED");
    expect(j.get(e.id)?.verifiedAt).not.toBeNull();
    engine.frame!.media = [
      {
        path: "s-" + "a".repeat(32),
        publisher: true,
        checkedAt: new Date().toISOString(),
        sources: [],
      },
    ];
    await engine["advance"](j.get(e.id)!);
    const done = j.get(e.id)!;
    expect(done.state).toBe("COMPLETED");
    expect(done.evidence).toMatchObject({
      broadcasterClientReconnected: true,
      sourceRestoredByHealer: false,
    });
    expect(done.events.map((x) => x.kind)).toContain(
      "BROADCASTER_CLIENT_RECONNECTED",
    );
  });
});

describe("repair-budget admission", () => {
  it("never injects a fault the Healer cannot currently repair", () => {
    const { engine } = fixture();
    engine.healer!.budgets!["api-2"] = {
      used: 2,
      max: 2,
      availableAt: "2026-10-22T20:02:03.000Z",
    };
    expect(engine.reason("crash-api-tier")).toContain("api-2");
    expect(engine.reason("hang-api")).toContain("20:02:03");
    expect(engine.reason("crash-api")).toBeNull();
    expect(engine.reason("network-timeout")).toBeNull();
    delete engine.healer!.budgets;
    expect(engine.reason("crash-redis")).toContain("not reported");
  });
});

describe("traffic surge", () => {
  it("refuses non-local load targets before sending anything", () => {
    expect(() =>
      startSurge({ url: "https://example.com", users: 1, durationMs: 10 }),
    ).toThrow("surge_target_not_local");
  });
  it("runs a bounded number of viewers for a bounded time and counts outcomes", async () => {
    let calls = 0;
    const fetcher = (async (url: string) => {
      calls++;
      if (String(url).includes("/streams?"))
        return new Response(JSON.stringify({ streams: [{ id: "s1" }] }));
      return new Response("{}", { status: calls % 2 ? 429 : 200 });
    }) as typeof fetch;
    const load = startSurge({
      url: "http://api-gateway:8080",
      users: 3,
      durationMs: 150,
      rps: 1000,
      maxRequests: 100,
      thinkMs: 5,
      fetcher,
    });
    const stats = await load.done;
    expect(stats.users).toBe(3);
    expect(stats.requests).toBe(calls);
    expect(stats.ok + stats.limited + stats.errors).toBe(stats.requests);
    expect(stats.limited).toBeGreaterThan(0);
    expect(stats.endedAt).not.toBeNull();
  });
  it("needs the spare stopped and budget for API-3 before admission", () => {
    const { engine } = fixture();
    expect(engine.reason("traffic-surge")).toContain("spare API-3");
    engine.frame!.components = [
      ...engine.frame!.components,
      {
        id: "api-3",
        state: "UNKNOWN",
        code: "spare_standby",
        observedAt: new Date().toISOString(),
      },
    ] as never;
    expect(engine.reason("traffic-surge")).toBeNull();
    engine.healer!.budgets!["api-3"] = {
      used: 2,
      max: 2,
      availableAt: "2026-10-22T20:30:00.000Z",
    };
    expect(engine.reason("traffic-surge")).toContain("api-3");
  });
});

describe("monitoring denial evidence", () => {
  it.each([
    "observer-future",
    "component-future",
    "healer-future",
    "persistence",
    "adapter",
    "audit",
  ])("rejects %s evidence before any fault", (kind) => {
    const { engine, store } = fixture();
    if (kind === "observer-future")
      engine.frame!.lastCompleted = Date.now() + 60000;
    if (kind === "component-future")
      engine.frame!.components = [
        {
          id: "api-1",
          state: "HEALTHY",
          observedAt: new Date(Date.now() + 60000).toISOString(),
        },
      ] as never;
    if (kind === "healer-future")
      engine.healer!.observedAt = new Date(Date.now() + 60000).toISOString();
    if (kind === "persistence") engine.frame!.persistence = false;
    if (kind === "adapter") engine.controlAvailable = false;
    if (kind === "audit") store.available = false;
    expect(engine.reason("crash-api")).toBeTruthy();
  });
});

it("does not admit another fault on a restart receipt without completed functional verification", async () => {
  const { engine, e, j } = await submitted();
  e.state = "FAILED";
  e.injectedAt = new Date().toISOString();
  e.faultConfirmedAt = e.injectedAt;
  e.finishedAt = e.injectedAt;
  j.save(e);
  engine.healer!.attempts = [
    {
      component: "api-1",
      state: "VERIFYING",
      evidence: { controlReceipt: "docker_start_accepted" },
    },
  ] as never;
  expect(engine.reason("crash-redis")).toContain("progress");
  engine.healer!.attempts = [
    {
      component: "api-1",
      state: "ESCALATED",
      evidence: { controlReceipt: "docker_start_accepted" },
    },
  ] as never;
  expect(engine.reason("crash-redis")).toContain("unverified");
  engine.healer!.attempts = [
    {
      component: "api-1",
      state: "VERIFIED",
      finishedAt: new Date().toISOString(),
      evidence: { controlReceipt: "docker_start_accepted" },
    },
  ] as never;
  expect(engine.reason("crash-redis")).toBeNull();
});

it("rejects missing critical observations and idle media before any injection", () => {
  const { engine } = fixture();
  engine.frame!.components = engine.frame!.components.filter(
    (c) => c.id !== "api-2",
  );
  expect(engine.reason("crash-api")).toContain("api-2");
  const f = fixture();
  f.engine.frame!.media = [];
  expect(f.engine.reason("crash-video-gateway")).toContain("real live source");
  expect(f.engine.reason("crash-edge")).toContain("real live source");
});
it("keeps idle logical load UNKNOWN without blocking a healthy API crash baseline", () => {
  const { engine } = fixture();
  engine.frame!.components.push({
    id: "api-tier",
    state: "UNKNOWN",
    code: "metrics_no_requests",
    observedAt: new Date().toISOString(),
  } as never);
  expect(engine.reason("crash-api")).toBeNull();
  expect(engine.reason("traffic-surge")).toContain("baseline");
  engine.frame!.components.at(-1)!.code = "metrics_unavailable";
  expect(engine.reason("crash-api")).toContain("metrics_unavailable");
});
it("separates genuine recovery duration from the persisted minimum observation window", async () => {
  vi.useFakeTimers();
  try {
    const { engine, e, j } = await injected("hang-api", "api-2");
    engine.healer!.attempts = [
      attempt("api-2", {
        playbook: "api-restart-unresponsive",
        action: "restart_unresponsive_service",
        evidence: { controlReceipt: "docker_restart_accepted" },
      }),
    ];
    await engine["advance"](j.get(e.id)!);
    await vi.advanceTimersByTimeAsync(2500);
    await engine["advance"](j.get(e.id)!);
    const early = j.get(e.id)!;
    expect(early.state).toBe("VERIFYING");
    expect(early.verifiedAt).toBeTruthy();
    expect(early.measurements.restorationMs).toBe(2500);
    expect(early.measurements.demonstrationMs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    await engine["advance"](j.get(e.id)!);
    expect(j.get(e.id)).toMatchObject({
      state: "COMPLETED",
      measurements: { restorationMs: 2500, demonstrationMs: 5500 },
    });
  } finally {
    vi.useRealTimers();
  }
});
it("does not finish the observation window if subsequent behavioral verification fails", async () => {
  vi.useFakeTimers();
  try {
    const { engine, e, j } = await injected("hang-api", "api-2");
    engine.healer!.attempts = [
      attempt("api-2", {
        playbook: "api-restart-unresponsive",
        action: "restart_unresponsive_service",
        evidence: { controlReceipt: "docker_restart_accepted" },
      }),
    ];
    await engine["advance"](j.get(e.id)!);
    await vi.advanceTimersByTimeAsync(2500);
    await engine["advance"](j.get(e.id)!);
    expect(j.get(e.id)!.verifiedAt).toBeTruthy();
    vi.mocked(engine.verifier.verify).mockResolvedValue({
      ok: false,
      evidence: {},
    });
    await vi.advanceTimersByTimeAsync(3000);
    await engine["advance"](j.get(e.id)!);
    expect(j.get(e.id)!.state).not.toBe("COMPLETED");
    expect(j.get(e.id)!.verifiedAt).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("retains the precise admission reason when a prerequisite changes after the browser refresh", async () => {
  const { engine } = fixture();
  engine.frame!.components.find((c) => c.id === "api-2")!.state = "DEGRADED";
  await expect(
    engine.submit(randomUUID(), randomUUID(), "crash-api", "api-1"),
  ).rejects.toMatchObject({
    message: "prerequisites_unavailable",
    reason: expect.stringContaining("api-2"),
  });
});

it("expires stale recovery state and admits a new scenario only after durable independent baseline reverification", async () => {
  vi.useFakeTimers();
  try {
    const { engine, e, j } = await submitted();
    e.state = "VERIFYING";
    e.injectedAt = new Date(Date.now() - 180001).toISOString();
    e.faultConfirmedAt = e.injectedAt;
    e.deadline = Date.now() - 1;
    j.save(e);
    vi.spyOn(engine, "control").mockResolvedValue({ cleanup: "NOT_REQUIRED" });
    engine.verifier.verify = vi.fn().mockResolvedValue({
      ok: true,
      evidence: { applicationReadVerified: true },
    });
    await engine["advance"](j.get(e.id)!);
    expect(j.get(e.id)!.state).toBe("TIMED_OUT");
    expect(engine.reason("crash-video-gateway")).toContain("unverified");
    await engine.reconcileTerminalBaseline();
    expect(engine.reason("crash-video-gateway")).toContain("unverified");
    await vi.advanceTimersByTimeAsync(2500);
    await engine.reconcileTerminalBaseline();
    const closed = j.get(e.id)!;
    expect(closed).toMatchObject({
      state: "TIMED_OUT",
      verifiedAt: null,
      databasePersisted: true,
    });
    expect(closed.events.some((x) => x.kind === "BASELINE_REVERIFIED")).toBe(
      true,
    );
    expect(engine.verifier.verify).toHaveBeenCalledTimes(2);
    expect(engine.reason("crash-video-gateway")).toBeNull();
    await expect(
      engine.submit(
        randomUUID(),
        randomUUID(),
        "crash-video-gateway",
        "video-gateway",
      ),
    ).resolves.toMatchObject({ state: "CREATED" });
  } finally {
    vi.useRealTimers();
  }
});
it.each([
  "failed-probe",
  "cleanup-pending",
  "healer-busy",
  "persistence-failed",
  "stale-observation",
])("does not clear a terminal safety lock with %s", async (kind) => {
  vi.useFakeTimers();
  try {
    const { engine, e, j, store } = await submitted();
    e.state = "FAILED";
    e.injectedAt = new Date().toISOString();
    e.faultConfirmedAt = e.injectedAt;
    e.finishedAt = e.injectedAt;
    j.save(e);
    engine.verifier.verify = vi
      .fn()
      .mockResolvedValue({ ok: kind !== "failed-probe", evidence: {} });
    if (kind === "cleanup-pending") {
      e.cleanup = "PENDING";
      j.save(e);
    }
    if (kind === "healer-busy")
      engine.healer!.attempts = [{ state: "VERIFYING" }] as never;
    if (kind === "persistence-failed") store.available = false;
    if (kind === "stale-observation")
      engine.frame!.lastCompleted = Date.now() - 13000;
    await engine.reconcileTerminalBaseline();
    await vi.advanceTimersByTimeAsync(2500);
    await engine.reconcileTerminalBaseline();
    expect(j.get(e.id)!.evidence.terminalBaselineReverifiedAt).toBeUndefined();
    expect(engine.reason("crash-video-gateway")).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
it("does not treat terminal bookkeeping or a foreign stale baseline marker as verification", async () => {
  const { engine, e, j } = await submitted();
  e.state = "TIMED_OUT";
  e.injectedAt = new Date().toISOString();
  e.faultConfirmedAt = e.injectedAt;
  e.finishedAt = e.injectedAt;
  e.evidence.terminalBaselineReverifiedAt = e.injectedAt;
  e.evidence.terminalBaselineIdentity = "different-fault";
  j.save(e);
  j.synced(e);
  expect(engine.reason("crash-video-gateway")).toContain("unverified");
});
describe("operator-only media authority failure", () => {
  it("retains the missing-authority lock across a controller journal reopen", async () => {
    const { engine, store } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "ss-media-authority-"));
    dirs.push(directory);
    const path = join(directory, "experiments.sqlite");
    engine.journal = journal(path);
    engine.c.CHAOS_MEDIA_GATE_ENABLED = "true";
    const e = await engine.submit(
      randomUUID(),
      randomUUID(),
      "media-authority-loss",
      "media-authority",
    );
    e.injectedAt = new Date().toISOString();
    e.evidence.externalAuthorityUnavailable = true;
    engine.journal.save(e);
    const reopened = new ChaosEngine(
      engine.c,
      journal(path),
      store as unknown as ChaosStore,
      engine.verifier,
    );
    expect(reopened.mediaAccessBlocked()).toBe(true);
  });
  it("is unavailable unless the real disposable delivery gate is installed", () => {
    expect(fixture().engine.reason("media-authority-loss")).toContain(
      "media authorization gate",
    );
  });
  it("blocks actual delivery, waits beyond a deadline without claiming healing, and verifies explicit human restoration", async () => {
    vi.useFakeTimers();
    try {
      const { engine, j, store } = fixture();
      engine.c.CHAOS_MEDIA_GATE_ENABLED = "true";
      const control = vi.spyOn(engine, "control");
      engine.verifier.paths = vi.fn().mockResolvedValue(["live"]);
      engine.verifier.url = vi
        .fn()
        .mockReturnValue("http://gateway.test/primary/live/index.m3u8");
      engine.verifier.hls = vi.fn().mockResolvedValue({ ok: false });
      const fetch = vi.fn().mockResolvedValue(
        new Response("", {
          status: 503,
          headers: { "X-Media-Authority": "unavailable" },
        }),
      );
      vi.stubGlobal("fetch", fetch);
      const e = await engine.submit(
        randomUUID(),
        randomUUID(),
        "media-authority-loss",
        "media-authority",
      );
      const advance = () => engine["advance"](j.get(e.id)!);
      await advance();
      await advance();
      expect(engine.mediaAccessBlocked()).toBe(true);
      expect(control).not.toHaveBeenCalled();
      await advance();
      expect(j.get(e.id)).toMatchObject({
        state: "AWAITING_OPERATOR",
        evidence: { deliveryDenied: true, automaticRecoveryPossible: false },
      });
      const waiting = j.get(e.id)!;
      waiting.deadline = Date.now() - 1000;
      j.save(waiting);
      await advance();
      expect(j.get(e.id)?.state).toBe("AWAITING_OPERATOR");
      expect(engine.mediaAccessBlocked()).toBe(true);
      expect(() => engine.cancel(e.id, e.actor)).toThrow(
        "operator_restore_required",
      );
      expect(() => engine.requestOperatorReset(e.id, e.actor, "wrong")).toThrow(
        "confirmation_required",
      );
      engine.requestOperatorReset(e.id, e.actor, "media-authority");
      store.sync.mockRejectedValueOnce(Error("audit down"));
      await expect(advance()).rejects.toThrow("audit down");
      expect(engine.mediaAccessBlocked()).toBe(true);
      await advance();
      expect(engine.mediaAccessBlocked()).toBe(false);
      await advance();
      expect(j.get(e.id)?.verifiedAt).toBeNull();
      vi.mocked(engine.verifier.hls).mockResolvedValue({
        ok: true,
        paths: 1,
      } as never);
      await advance();
      await vi.advanceTimersByTimeAsync(2500);
      await advance();
      expect(j.get(e.id)).toMatchObject({
        state: "COMPLETED",
        actionStartedAt: null,
        recoveryIds: [],
        evidence: {
          automaticallyHealed: false,
          independentBehaviorVerified: true,
        },
      });
      expect(
        j.get(e.id)?.events.some((e) => e.kind === "OPERATOR_ACCESS_RESTORED"),
      ).toBe(true);
      expect(control).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it("does not confirm an unrelated network error as a media authorization fault", async () => {
    const { engine, j } = fixture();
    engine.c.CHAOS_MEDIA_GATE_ENABLED = "true";
    engine.verifier.paths = vi.fn().mockResolvedValue(["live"]);
    engine.verifier.url = vi.fn().mockReturnValue("http://gateway.test/");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 503 })),
    );
    try {
      const e = await engine.submit(
        randomUUID(),
        randomUUID(),
        "media-authority-loss",
        "media-authority",
      );
      await engine["advance"](j.get(e.id)!);
      await engine["advance"](j.get(e.id)!);
      await engine["advance"](j.get(e.id)!);
      expect(j.get(e.id)?.state).toBe("INJECTING");
      expect(j.get(e.id)?.faultConfirmedAt).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("preserves a human reset that arrives while an earlier observation is in flight", async () => {
    const { engine, j } = fixture();
    engine.c.CHAOS_MEDIA_GATE_ENABLED = "true";
    const e = await engine.submit(
      randomUUID(),
      randomUUID(),
      "media-authority-loss",
      "media-authority",
    );
    e.injectedAt = new Date().toISOString();
    e.evidence.externalAuthorityUnavailable = true;
    j.save(e);
    const stale = j.get(e.id)!;
    engine.requestOperatorReset(e.id, e.actor, "media-authority");
    j.save(stale);
    expect(j.get(e.id)?.evidence.operatorResetRequestedBy).toBe(e.actor);
    expect(
      j.get(e.id)?.events.filter((e) => e.kind === "OPERATOR_RESET_REQUESTED"),
    ).toHaveLength(1);
  });
});
