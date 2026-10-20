import { describe, it, expect, vi } from "vitest";
import type {
  ComponentObservation,
  RecoveryAttempt,
} from "@streamshield/shared";
import { randomUUID } from "node:crypto";
import { healingConfig, managed } from "./config.js";
import { eligibility, selectPlaybook, playbooks, backoff } from "./policy.js";
import { Circuit } from "./circuit.js";
import { ControlJournal } from "./control.js";
import { database, Journal } from "./journal.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Healer } from "./controller.js";
import { RecoveryStore } from "./store.js";
import { Verifier, type Frame } from "./verification.js";
const config = () =>
  healingConfig({
    HEALER_SECRET: "a".repeat(43),
    CONTROL_SECRET: "b".repeat(43),
    HEALER_ENABLED: "true",
  });
const component = (
  id: string,
  overrides: Partial<ComponentObservation> = {},
): ComponentObservation => ({
  id,
  name: id,
  role: "test",
  group: "test",
  dependencies: [],
  state: "UNHEALTHY",
  code: "probe_unreachable",
  observedAt: new Date().toISOString(),
  lastSuccessAt: null,
  latencyMs: null,
  failures: 2,
  successes: 0,
  firstFailureAt: new Date().toISOString(),
  confirmedAt: new Date().toISOString(),
  detectionMs: 2000,
  ...overrides,
});
const deps = () => [
  component("postgres", { state: "HEALTHY" }),
  component("redis", { state: "HEALTHY" }),
];
describe("recovery policy", () => {
  it("defaults privileged operations off", () => {
    expect(
      healingConfig({
        HEALER_SECRET: "a".repeat(43),
        CONTROL_SECRET: "b".repeat(43),
      }).enabled,
    ).toBe(false);
  });
  it("rejects arbitrary service identities and shared authority", () => {
    expect(() =>
      healingConfig({
        ...config(),
        HEALER_ALLOWED_SERVICES: "postgres",
      } as unknown as Record<string, string>),
    ).toThrow();
    expect(() =>
      healingConfig({
        HEALER_SECRET: "a".repeat(43),
        CONTROL_SECRET: "a".repeat(43),
      }),
    ).toThrow();
  });
  it("has one versioned explicit playbook per managed identity", () => {
    for (const id of managed)
      expect(playbooks.filter((p) => p.services.includes(id))).toHaveLength(1);
    expect(selectPlaybook("arbitrary")).toBeUndefined();
  });
  it("permits independently failed APIs with healthy dependencies", () => {
    expect(eligibility(component("api-1"), deps(), config()).allowed).toBe(
      true,
    );
  });
  it.each(["postgres", "redis"])(
    "suppresses API repair when %s fails",
    (id) => {
      expect(
        eligibility(
          component("api-1"),
          deps().map((d) => (d.id === id ? { ...d, state: "UNHEALTHY" } : d)),
          config(),
        ),
      ).toMatchObject({ allowed: false, reason: "dependency_unhealthy:" + id });
    },
  );
  it("does not restart an API for readiness/dependency symptoms", () => {
    expect(
      eligibility(component("api-1", { state: "DEGRADED" }), deps(), config())
        .allowed,
    ).toBe(false);
  });
  it.each(["UNKNOWN", "RECOVERING", "HEALTHY"] as const)(
    "rejects %s as an actionable outage",
    (state) => {
      expect(
        eligibility(component("api-1", { state }), deps(), config()).allowed,
      ).toBe(false);
    },
  );
  it("rejects stale evidence and unconfirmed failure", () => {
    expect(
      eligibility(
        component("api-1", {
          observedAt: new Date(Date.now() - 20000).toISOString(),
        }),
        deps(),
        config(),
      ).allowed,
    ).toBe(false);
    expect(
      eligibility(component("api-1", { confirmedAt: null }), deps(), config())
        .allowed,
    ).toBe(false);
  });
  it("requires standby/relay authority before primary restoration", () => {
    expect(eligibility(component("origin-primary"), [], config()).allowed).toBe(
      false,
    );
  });
  it("supports operator-disabled playbooks", () => {
    const c = config();
    c.HEALER_DISABLED_PLAYBOOKS = "api-start";
    expect(eligibility(component("api-1"), deps(), c)).toMatchObject({
      reason: "policy_disabled",
    });
  });
  it("database and missing-source mechanisms cannot restart services", () => {
    expect(selectPlaybook("postgres")!.action).toBe("operator_review");
    expect(selectPlaybook("publisher-source")!.action).toBe("observe_source");
  });
  it("bounds exponential backoff and jitter", () => {
    expect(backoff(1, 1000, 0)).toBe(1000);
    expect(backoff(3, 1000, 0.5)).toBe(4125);
    expect(backoff(30, 1000, 0)).toBe(10000);
  });
});
describe("independent durable control coordination", () => {
  it("leases one leader and fences expired epochs", () => {
    const db = database(":memory:"),
      j = new ControlJournal(db),
      a = randomUUID(),
      b = randomUUID();
    const lease = j.lease(a, 20000, 1000)!;
    expect(j.lease(b, 20000, 2000)).toBeNull();
    expect(j.valid(a, lease.epoch, 2000)).toBe(true);
    const next = j.lease(b, 20000, 22000)!;
    expect(next.epoch).toBeGreaterThan(lease.epoch);
    expect(j.valid(a, lease.epoch, 22000)).toBe(false);
    db.close();
  });
  it("renews the same epoch only before expiry", () => {
    const db = database(":memory:"),
      j = new ControlJournal(db),
      owner = randomUUID();
    const a = j.lease(owner, 100, 0)!;
    expect(j.lease(owner, 100, 50)!.epoch).toBe(a.epoch);
    expect(j.lease(owner, 100, 200)!.epoch).toBe(a.epoch + 1);
    db.close();
  });
  it("deduplicates accepted operation IDs across service cooldowns", () => {
    const db = database(":memory:"),
      j = new ControlJournal(db),
      id = randomUUID();
    expect(j.claim(id, "api-1", 5000, 2, 60000, 0)).toBe("accepted");
    expect(j.claim(id, "api-1", 5000, 2, 60000, 10)).toBe("duplicate");
    expect(j.claim(randomUUID(), "api-1", 5000, 2, 60000, 100)).toBe(
      "cooldown",
    );
    expect(j.claim(randomUUID(), "api-2", 5000, 2, 60000, 100)).toBe(
      "accepted",
    );
    db.close();
  });
  it("enforces rolling budgets across distinct incidents", () => {
    const db = database(":memory:"),
      j = new ControlJournal(db);
    j.claim(randomUUID(), "edge-1", 5000, 2, 60000, 0);
    j.claim(randomUUID(), "edge-1", 5000, 2, 60000, 6000);
    expect(j.claim(randomUUID(), "edge-1", 5000, 2, 60000, 12000)).toBe(
      "budget_exhausted",
    );
    expect(j.claim(randomUUID(), "edge-1", 5000, 2, 60000, 70000)).toBe(
      "accepted",
    );
    db.close();
  });
  it("marks interrupted Docker requests ambiguous rather than replaying", () => {
    const db = database(":memory:"),
      j = new ControlJournal(db),
      id = randomUUID();
    j.claim(id, "api-1", 5000, 2, 60000);
    new ControlJournal(db);
    expect(j.get(id)!.state).toBe("AMBIGUOUS");
    expect(j.claim(id, "api-1", 5000, 2, 60000)).toBe("duplicate");
    db.close();
  });
  it("deduplicates episodes and rejects old-leader attempt writes", () => {
    const j = new Journal(":memory:");
    const a = {
      id: randomUUID(),
      episode: "api-1:first",
      epoch: 1,
      state: "SCHEDULED",
      databasePersisted: false,
    } as RecoveryAttempt;
    expect(j.insert(a)).toBe(true);
    expect(j.insert({ ...a, id: randomUUID() })).toBe(false);
    expect(j.adopt(a, 2)).toBe(true);
    expect(j.save({ ...a, state: "VERIFIED" }, 1)).toBe(false);
    expect(j.get(a.id)!.state).toBe("SCHEDULED");
    j.db.close();
  });
});
describe("real safe-read circuit policy", () => {
  it("opens after failures, rejects calls, half-opens and requires two successes", async () => {
    const c = new Circuit(2, 1000),
      bad = vi.fn(async () => {
        throw Error("failure");
      }),
      good = vi.fn(async () => "ok");
    await expect(c.execute(bad, 0)).rejects.toThrow();
    await expect(c.execute(bad, 1)).rejects.toThrow();
    expect(c.state).toBe("OPEN");
    await expect(c.execute(good, 100)).rejects.toThrow();
    expect(good).not.toHaveBeenCalled();
    await expect(c.execute(good, 1002)).resolves.toBe("ok");
    expect(c.state).toBe("HALF_OPEN");
    await c.execute(good, 1003);
    expect(c.state).toBe("CLOSED");
    expect(c.rejected).toBe(1);
  });
  it("reopens after a failed half-open probe", async () => {
    const c = new Circuit(2, 10);
    const bad = async () => {
      throw Error("failed");
    };
    await c.execute(bad, 0).catch(() => {});
    await c.execute(bad, 1).catch(() => {});
    await c.execute(bad, 20).catch(() => {});
    expect(c.state).toBe("OPEN");
  });
  it("serializes simultaneous recovery probes", async () => {
    const c = new Circuit(2, 1000);
    let release!: (n: number) => void;
    const promise = c.execute(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    await expect(c.execute(async () => 2)).rejects.toThrow();
    release(1);
    expect(await promise).toBe(1);
    expect(c.requests).toBe(1);
  });
});
it("verifies a component that returned before execution without inventing an action", async () => {
  const directory = mkdtempSync(join(tmpdir(), "streamshield-healing-unit-")),
    file = join(directory, "targets.json");
  writeFileSync(file, "[]");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
  const c = config(),
    journal = new Journal(":memory:"),
    store = new RecoveryStore(),
    verifier = new Verifier(c, file),
    h = new Healer(c, journal, store, verifier, pino({ level: "silent" }));
  try {
    vi.spyOn(store, "check").mockResolvedValue();
    vi.spyOn(store, "sync").mockResolvedValue(true);
    const control = vi.spyOn(h, "control").mockImplementation(async (path) => {
      if (path !== "/v1/lease") throw new Error("Unexpected action");
      return {
        ok: true,
        status: 200,
        body: { owner: h.owner, epoch: 1, expires: Date.now() + 30000 },
      };
    });
    vi.spyOn(h, "dependency").mockResolvedValue({
      status: "available",
      simulated: true,
      feature: "recommendation-demo",
      recommendations: [],
    });
    vi.spyOn(verifier, "frame").mockImplementation(
      async () =>
        ({
          components: [component("api-1", { state: "HEALTHY" }), ...deps()],
          media: [],
          mediaAvailable: true,
          lastCompleted: Date.now(),
          persistence: true,
        }) as Frame,
    );
    vi.spyOn(verifier, "verify").mockResolvedValue({
      ok: true,
      evidence: { applicationReadVerified: true },
    });
    const a = h.create(component("api-1"), 1, "confirmed_failure")!;
    await h.tick();
    expect(journal.get(a.id)!.state).toBe("VERIFYING");
    vi.setSystemTime(Date.now() + 1000);
    await h.tick();
    vi.setSystemTime(Date.now() + 4000);
    await h.tick();
    const result = journal.get(a.id)!;
    expect(result.state).toBe("VERIFIED");
    expect(result.actionStartedAt).toBeNull();
    expect(result.actionFinishedAt).toBeNull();
    expect(result.evidence.actionPerformed).toBe(false);
    expect(result.evidence.actionOrigin).toBe(
      "external_return_without_healer_action",
    );
    expect(control.mock.calls.every(([path]) => path === "/v1/lease")).toBe(
      true,
    );
  } finally {
    await store.db.end();
    journal.db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("backs off repeated half-open failures with bounded jitter", async () => {
  const c = new Circuit(1, 1000, () => 0.5);
  const bad = async () => {
    throw Error("offline");
  };
  await c.execute(bad, 0).catch(() => {});
  await c.execute(bad, 1000).catch(() => {});
  const good = vi.fn(async () => true);
  await expect(c.execute(good, 2000)).rejects.toThrow("circuit_open");
  expect(good).not.toHaveBeenCalled();
  await c.execute(good, 3126);
  await c.execute(good, 3127);
  expect(c.state).toBe("CLOSED");
});

it("keeps active and unsynchronized work visible beyond the latest-100 UI", () => {
  const j = new Journal(":memory:");
  try {
    const active = {
      id: randomUUID(),
      episode: "old-active",
      epoch: 1,
      state: "VERIFYING",
      databasePersisted: true,
    } as RecoveryAttempt;
    j.insert(active);
    for (let i = 0; i < 105; i++)
      j.insert({
        ...active,
        id: randomUUID(),
        episode: String(i),
        state: "VERIFIED",
      });
    expect(j.all().some((a) => a.id === active.id)).toBe(false);
    expect(j.work().some((a) => a.id === active.id)).toBe(true);
  } finally {
    j.db.close();
  }
});
