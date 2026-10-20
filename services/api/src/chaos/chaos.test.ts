import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealingSnapshot, RecoveryAttempt } from "@streamshield/shared";
import { chaosConfig, scenarios } from "./config.js";
import { ChaosJournal } from "./journal.js";
import { ChaosEngine } from "./engine.js";
import type { ChaosStore } from "./store.js";
import type { Verifier } from "../healing/verification.js";
const env = {
  CHAOS_SECRET: "a".repeat(43),
  CHAOS_CONTROL_SECRET: "b".repeat(43),
  CHAOS_ENABLED: "true",
  CHAOS_ENVIRONMENT: "local-development",
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
  const verifier = {} as Verifier;
  const engine = new ChaosEngine(
    chaosConfig(env),
    j,
    store as unknown as ChaosStore,
    verifier,
  );
  engine.frame = {
    components: [],
    media: [],
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
  } as unknown as HealingSnapshot;
  engine.controlAvailable = true;
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
    expect(scenarios.filter((s) => s.supported)).toHaveLength(6);
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
    expect(engine.reason("crash-api")).toContain("Fresh");
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
});
