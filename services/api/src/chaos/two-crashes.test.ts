import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { HealingSnapshot, RecoveryAttempt } from "@streamshield/shared";
import { ChaosEngine } from "./engine.js";
import { ChaosJournal } from "./journal.js";
import { chaosConfig } from "./config.js";
import type { ChaosStore } from "./store.js";
import type { Verifier } from "../healing/verification.js";
const journals: ChaosJournal[] = [];
afterEach(() => {
  journals.forEach((j) => j.db.close());
  journals.length = 0;
  vi.useRealTimers();
});
function fixture() {
  const journal = new ChaosJournal(":memory:");
  journals.push(journal);
  const store = {
    available: true,
    get: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    incident: vi.fn(),
  };
  const verifier = {
    verify: vi.fn().mockResolvedValue({
      ok: true,
      evidence: { applicationReadVerified: true },
    }),
    unavailable: vi.fn(async () => ({
      unavailable: true,
      code: "probe_unreachable",
      observedAt: new Date().toISOString(),
    })),
    crashBaseline: vi.fn().mockResolvedValue({
      api: true,
      gateway: true,
      sourceCount: 1,
      progressingPaths: 1,
    }),
  };
  const engine = new ChaosEngine(
    chaosConfig({
      CHAOS_SECRET: "a".repeat(43),
      CHAOS_CONTROL_SECRET: "b".repeat(43),
      CHAOS_ENABLED: "true",
      CHAOS_ENVIRONMENT: "local-development",
      CHAOS_OBSERVATION_WINDOW_MS: "5000",
      CHAOS_ALLOWED_SCENARIOS: "crash-api,crash-video-gateway",
    }),
    journal,
    store as unknown as ChaosStore,
    verifier as unknown as Verifier,
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
    ].map((id) => ({
      id,
      state: "HEALTHY",
      code: "probe_ok",
      observedAt: new Date().toISOString(),
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
    enabled: true,
    available: true,
    databaseAvailable: true,
    leader: true,
    observedAt: new Date().toISOString(),
    attempts: [],
    circuit: { state: "CLOSED" },
    budgets: {
      "api-1": { used: 0, max: 2, availableAt: null },
      "video-gateway": { used: 0, max: 2, availableAt: null },
    },
  } as unknown as HealingSnapshot;
  engine.controlAvailable = true;
  const fresh = () => {
    engine.frame!.lastCompleted = Date.now();
    engine.frame!.components.forEach(
      (c) => (c.observedAt = new Date().toISOString()),
    );
    engine.frame!.media.forEach(
      (m) => (m.checkedAt = new Date().toISOString()),
    );
    engine.healer!.observedAt = new Date().toISOString();
    engine.crashBaseline = {
      observedAt: new Date().toISOString(),
      api: true,
      gateway: true,
      sourceCount: 1,
      progressingPaths: 1,
      reason: null,
    };
  };
  fresh();
  vi.spyOn(engine, "control").mockResolvedValue({ cleanup: "NOT_REQUIRED" });
  return { engine, journal, store, verifier, fresh };
}
const cases = [
  ["crash-api", "api-1", "api-start"],
  ["crash-video-gateway", "video-gateway", "gateway-start"],
] as const;
async function injected(scenario: (typeof cases)[number][0], target: string) {
  const f = fixture();
  const e = await f.engine.submit(randomUUID(), randomUUID(), scenario, target);
  e.state = "INJECTING";
  f.journal.save(e);
  await f.engine["receipt"](e, {
    state: "CONFIRMED",
    injectedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    expiresAt: Date.now() + 180000,
    cleanup: "NOT_REQUIRED",
    evidence: { killAccepted: true, stoppedObserved: true },
  });
  await f.engine["advance"](e);
  return { ...f, e };
}
function repair(target: string, playbook: string, start: number) {
  return {
    id: randomUUID(),
    incidentId: randomUUID(),
    component: target,
    playbook,
    action: "start_stopped_service",
    state: "VERIFIED",
    createdAt: new Date(start + 100).toISOString(),
    actionStartedAt: new Date(start + 500).toISOString(),
    actionFinishedAt: new Date(start + 1000).toISOString(),
    verificationStartedAt: new Date(start + 1000).toISOString(),
    finishedAt: new Date(start + 1500).toISOString(),
    diagnosis: "availability loss",
    evidence: { controlReceipt: "docker_start_accepted" },
    events: [],
  } as unknown as RecoveryAttempt;
}
it.each(cases)(
  "requires a fresh measured API/HLS baseline before %s",
  async (scenario, target) => {
    const f = fixture();
    f.engine.crashBaseline = undefined;
    await expect(
      f.engine.submit(randomUUID(), randomUUID(), scenario, target),
    ).rejects.toMatchObject({
      reason: expect.stringContaining("functional baseline"),
    });
    expect(f.engine.control).not.toHaveBeenCalled();
  },
);
it("does not turn an accepted kill or an answering target into confirmed impact", async () => {
  const f = fixture(),
    e = await f.engine.submit(randomUUID(), randomUUID(), "crash-api", "api-1");
  e.state = "INJECTING";
  f.journal.save(e);
  f.verifier.unavailable.mockResolvedValue({
    unavailable: false,
    code: "http_200",
    observedAt: new Date().toISOString(),
  });
  await f.engine["receipt"](e, {
    state: "CONFIRMED",
    injectedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    expiresAt: Date.now() + 180000,
    cleanup: "NOT_REQUIRED",
    evidence: { killAccepted: true, stoppedObserved: true },
  });
  expect(e.faultConfirmedAt).toBeNull();
  expect(e.state).toBe("INJECTING");
  expect(e.evidence.observationWindowMs).toBe(5000);
  expect(e.evidence.unavailableProbe).toBe("http_200");
});
it.each(cases)(
  "completes %s only after real detection, correct independent action and functional checks",
  async (scenario, target, playbook) => {
    vi.useFakeTimers();
    const start = Date.now(),
      f = await injected(scenario, target),
      a = repair(target, playbook, start);
    f.engine.healer!.attempts = [a];
    f.store.incident.mockResolvedValue({ detected_at: new Date(start + 200) });
    for (const elapsed of [2000, 4500]) {
      vi.setSystemTime(start + elapsed);
      f.fresh();
      await f.engine["advance"](f.e);
    }
    expect(f.e.verifiedAt).toBeTruthy();
    expect(f.e.state).toBe("VERIFYING");
    expect(f.e.measurements.restorationMs).toBe(4500);
    vi.setSystemTime(start + 6000);
    f.fresh();
    await f.engine["advance"](f.e);
    expect(f.e).toMatchObject({
      state: "COMPLETED",
      evidence: {
        healerReceipt: "docker_start_accepted",
        independentBehaviorVerified: true,
      },
      measurements: { restorationMs: 4500, demonstrationMs: 6000 },
    });
    expect(f.e.incidentDetectedAt).toBeTruthy();
    expect(f.e.evidence.unavailableProbe).toBe("probe_unreachable");
    expect(f.verifier.verify).toHaveBeenCalled();
  },
);
it.each(cases)(
  "does not complete %s without Observer detection even if a receipt says verified",
  async (scenario, target, playbook) => {
    vi.useFakeTimers();
    const start = Date.now(),
      f = await injected(scenario, target);
    f.engine.healer!.attempts = [repair(target, playbook, start)];
    f.store.incident.mockResolvedValue(undefined);
    vi.setSystemTime(start + 6000);
    f.fresh();
    await f.engine["advance"](f.e);
    expect(f.e.verifiedAt).toBeNull();
    expect(f.e.state).not.toBe("COMPLETED");
  },
);
it.each(cases)(
  "times out %s without claiming recovery when behavioral verification fails",
  async (scenario, target, playbook) => {
    vi.useFakeTimers();
    const start = Date.now(),
      f = await injected(scenario, target);
    f.engine.healer!.attempts = [repair(target, playbook, start)];
    f.store.incident.mockResolvedValue({ detected_at: new Date(start + 200) });
    f.verifier.verify.mockResolvedValue({
      ok: false,
      evidence: { applicationReadVerified: false },
    });
    vi.setSystemTime(start + 6000);
    f.fresh();
    await f.engine["advance"](f.e);
    expect(f.e.verifiedAt).toBeNull();
    f.e.deadline = Date.now() - 1;
    await f.engine["advance"](f.e);
    expect(f.e.state).toBe("TIMED_OUT");
    expect(f.e.verifiedAt).toBeNull();
  },
);
it("rejects a second scenario and reconciles duplicate UUIDs without an additional injection", async () => {
  const f = fixture(),
    e = await f.engine.submit(randomUUID(), randomUUID(), "crash-api", "api-1");
  await expect(
    f.engine.submit(e.id, e.actor, e.scenario, "api-1"),
  ).resolves.toMatchObject({ id: e.id });
  await expect(
    f.engine.submit(
      randomUUID(),
      randomUUID(),
      "crash-video-gateway",
      "video-gateway",
    ),
  ).rejects.toMatchObject({ reason: expect.stringContaining("active") });
  expect(f.journal.all()).toHaveLength(1);
  expect(f.engine.control).not.toHaveBeenCalled();
});
it("refreshes functional baseline without any fault or recovery side effect", async () => {
  const f = fixture();
  f.engine.crashBaseline = undefined;
  await f.engine.refreshCrashBaseline();
  expect(f.engine.crashBaseline).toMatchObject({
    api: true,
    gateway: true,
    sourceCount: 1,
  });
  expect(f.journal.all()).toHaveLength(0);
  expect(f.engine.control).not.toHaveBeenCalled();
});
it.each(cases)(
  "keeps %s failed when its actual Healer action escalates",
  async (scenario, target, playbook) => {
    vi.useFakeTimers();
    const start = Date.now(),
      f = await injected(scenario, target),
      a = repair(target, playbook, start);
    a.state = "ESCALATED";
    a.reason = "control_action_failed";
    f.engine.healer!.attempts = [a];
    f.store.incident.mockResolvedValue({ detected_at: new Date(start + 200) });
    vi.setSystemTime(start + 2000);
    f.fresh();
    await f.engine["advance"](f.e);
    expect(f.e.state).toBe("FAILED");
    expect(f.e.verifiedAt).toBeNull();
    expect(f.e.reason).toContain("control_action_failed");
  },
);
it.each(cases)(
  "does not accept the wrong recovery receipt for %s",
  async (scenario, target, playbook) => {
    vi.useFakeTimers();
    const start = Date.now(),
      f = await injected(scenario, target),
      a = repair(target, playbook, start);
    a.evidence.controlReceipt = "docker_restart_accepted";
    f.engine.healer!.attempts = [a];
    f.store.incident.mockResolvedValue({ detected_at: new Date(start + 200) });
    vi.setSystemTime(start + 2000);
    f.fresh();
    await f.engine["advance"](f.e);
    expect(f.e.state).toBe("FAILED");
    expect(f.e.verifiedAt).toBeNull();
    expect(f.e.reason).toContain("docker_start_accepted");
  },
);
