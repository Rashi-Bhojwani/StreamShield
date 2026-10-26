import { afterEach, describe, it, expect, vi } from "vitest";
import type {
  ComponentObservation,
  RecoveryAttempt,
} from "@streamshield/shared";
import { randomUUID } from "node:crypto";
import { healingConfig, managed, spares } from "./config.js";
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
  // Failing long enough to pass the hang confirmation window.
  firstFailureAt: new Date(Date.now() - 30000).toISOString(),
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
  it("has exactly one default playbook per managed identity and no overlapping symptom playbooks", () => {
    for (const id of managed.filter((m) => !spares.includes(m))) {
      const own = playbooks.filter((p) => p.services.includes(id));
      expect(own.filter((p) => !p.symptoms)).toHaveLength(1);
      const symptoms = own.flatMap((p) => p.symptoms || []);
      expect(new Set(symptoms).size).toBe(symptoms.length);
    }
    expect(selectPlaybook("arbitrary")).toBeUndefined();
    // Spare capacity is only ever acted on by the tier scale playbooks.
    for (const id of spares)
      expect(playbooks.some((p) => p.services.includes(id))).toBe(false);
    expect(selectPlaybook("api-tier", "overloaded")?.action).toBe(
      "start_spare_capacity",
    );
    expect(selectPlaybook("api-tier", "scale_in")?.action).toBe(
      "stop_spare_capacity",
    );
    expect(selectPlaybook("api-tier", "probe_timeout")).toBeUndefined();
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
    // Only read-only control paths: no start/restart was ever requested.
    expect(
      control.mock.calls.every(([path]) =>
        ["/v1/lease", "/v1/budgets"].includes(path),
      ),
    ).toBe(true);
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

describe("symptom-aware diagnosis", () => {
  const healthyPeer = (id: string) => component(id, { state: "HEALTHY" });
  it("selects restart for a timeout and start for an unreachable API", () => {
    expect(selectPlaybook("api-2", "probe_timeout")?.id).toBe(
      "api-restart-unresponsive",
    );
    expect(selectPlaybook("api-2", "probe_timeout")?.action).toBe(
      "restart_unresponsive_service",
    );
    expect(selectPlaybook("api-2", "probe_unreachable")?.id).toBe("api-start");
    expect(selectPlaybook("api-2", "http_502")?.id).toBe("api-start");
    expect(selectPlaybook("api-2")?.id).toBe("api-start");
  });
  it("selects gateway and relay start playbooks for the new managed services", () => {
    expect(selectPlaybook("video-gateway", "probe_unreachable")?.id).toBe(
      "gateway-start",
    );
    expect(selectPlaybook("relay", "probe_unreachable")?.id).toBe(
      "relay-start",
    );
  });
  it("allows a restart only while the peer API is serving", () => {
    const hung = component("api-2", {
      code: "probe_timeout",
      failureCode: "probe_timeout",
    });
    const ok = eligibility(hung, [...deps(), healthyPeer("api-1")], config());
    expect(ok).toMatchObject({ allowed: true });
    expect(ok.playbook?.id).toBe("api-restart-unresponsive");
    const peerDown = eligibility(
      hung,
      [...deps(), component("api-1", { state: "UNHEALTHY" })],
      config(),
    );
    expect(peerDown).toEqual({
      allowed: false,
      reason: "peer_not_healthy:api-1",
    });
    expect(eligibility(hung, deps(), config()).reason).toBe(
      "peer_not_healthy:api-1",
    );
  });
  it("never restarts an API whose timeout is load congestion", () => {
    const hung = component("api-2", {
      code: "probe_timeout",
      failureCode: "probe_timeout",
    });
    const metrics = (rps: number) => ({
      p95Ms: 2000,
      errorPct: 0,
      rps,
      limitedRps: 0,
    });
    const busy = component("api-tier", {
      state: "HEALTHY",
      metrics: metrics(400),
    });
    expect(
      eligibility(hung, [...deps(), healthyPeer("api-1"), busy], config()),
    ).toEqual({ allowed: false, reason: "tier_under_load_timeout_not_a_hang" });
    const overloaded = component("api-tier", {
      state: "DEGRADED",
      code: "overloaded",
      failureCode: "overloaded",
      metrics: metrics(10),
    });
    expect(
      eligibility(hung, [...deps(), healthyPeer("api-1"), overloaded], config())
        .reason,
    ).toBe("tier_under_load_timeout_not_a_hang");
    const quiet = component("api-tier", {
      state: "HEALTHY",
      metrics: metrics(3),
    });
    expect(
      eligibility(hung, [...deps(), healthyPeer("api-1"), quiet], config()),
    ).toMatchObject({ allowed: true });
  });
  it("waits for a timeout to persist before treating it as a hang", () => {
    const hung = component("api-2", {
      code: "probe_timeout",
      failureCode: "probe_timeout",
      firstFailureAt: new Date(Date.now() - 4000).toISOString(),
    });
    const peers = [...deps(), healthyPeer("api-1")];
    expect(eligibility(hung, peers, config()).reason).toBe(
      "hang_unconfirmed_wait",
    );
    expect(eligibility(hung, peers, config(), Date.now() + 7000)).toMatchObject(
      { allowed: true },
    );
  });
  it("refuses dependency-unhealthy and stale restarts", () => {
    const hung = component("api-2", { failureCode: "probe_timeout" });
    expect(
      eligibility(
        hung,
        [
          component("postgres", { state: "HEALTHY" }),
          component("redis", { state: "UNHEALTHY" }),
          healthyPeer("api-1"),
        ],
        config(),
      ).reason,
    ).toBe("dependency_unhealthy:redis");
    const stale = component("api-2", {
      failureCode: "probe_timeout",
      observedAt: new Date(Date.now() - 60000).toISOString(),
    });
    expect(
      eligibility(stale, [...deps(), healthyPeer("api-1")], config()).reason,
    ).toBe("unconfirmed_or_stale");
  });
  it("never answers a timeout with a start of a running container", () => {
    const frozenRedis = component("redis", { failureCode: "probe_timeout" });
    expect(
      eligibility(
        frozenRedis,
        [component("postgres", { state: "HEALTHY" })],
        config(),
      ),
    ).toEqual({
      allowed: false,
      reason: "unresponsive_without_restart_playbook",
    });
  });
  it("honours a revised playbook kept on the attempt", () => {
    const hung = component("api-2", { failureCode: "probe_timeout" });
    expect(
      eligibility(hung, deps(), config(), Date.now(), "api-start").playbook?.id,
    ).toBe("api-start");
  });
});
describe("control adapter journal shares one budget across starts and restarts", () => {
  it("applies cooldown and the rolling budget per service regardless of operation", () => {
    const j = new ControlJournal(database(":memory:"));
    const t = 1_000_000;
    expect(j.claim(randomUUID(), "api-2", 30000, 2, 600000, t)).toBe(
      "accepted",
    );
    // A restart 10 s after a start hits the shared cooldown.
    expect(j.claim(randomUUID(), "api-2", 30000, 2, 600000, t + 10000)).toBe(
      "cooldown",
    );
    expect(j.claim(randomUUID(), "api-2", 30000, 2, 600000, t + 40000)).toBe(
      "accepted",
    );
    // A third operation inside the window is refused: no endless restarts.
    expect(j.claim(randomUUID(), "api-2", 30000, 2, 600000, t + 90000)).toBe(
      "budget_exhausted",
    );
    // Other services keep their own budget.
    expect(j.claim(randomUUID(), "api-1", 30000, 2, 600000, t + 90000)).toBe(
      "accepted",
    );
  });
  it("never replays an attempt identity, including an ambiguous restart", () => {
    const j = new ControlJournal(database(":memory:"));
    const id = randomUUID();
    expect(j.claim(id, "api-2", 30000, 2, 600000, 1)).toBe("accepted");
    j.finish(id, "AMBIGUOUS", "restart_unconfirmed_or_unsafe");
    expect(j.claim(id, "api-2", 30000, 2, 600000, 999999)).toBe("duplicate");
    expect(j.get(id)?.state).toBe("AMBIGUOUS");
  });
});

describe("healer scheduling and corroboration", () => {
  async function harness(components: () => ComponentObservation[]) {
    const directory = mkdtempSync(join(tmpdir(), "streamshield-healing-unit-")),
      file = join(directory, "targets.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "api-1", url: "http://api:4000/api/v1/health/ready" },
        { id: "api-2", url: "http://api-2:4000/api/v1/health/ready" },
      ]),
    );
    const c = config(),
      journal = new Journal(":memory:"),
      store = new RecoveryStore(),
      verifier = new Verifier(c, file),
      h = new Healer(c, journal, store, verifier, pino({ level: "silent" }));
    vi.spyOn(store, "check").mockResolvedValue();
    vi.spyOn(store, "sync").mockResolvedValue(true);
    vi.spyOn(h, "dependency").mockResolvedValue({
      status: "available",
      simulated: true,
      feature: "recommendation-demo",
      recommendations: [],
    });
    vi.spyOn(verifier, "frame").mockImplementation(
      async () =>
        ({
          components: components(),
          media: [],
          mediaAvailable: true,
          lastCompleted: Date.now(),
          persistence: true,
        }) as Frame,
    );
    const actions: string[] = [];
    const control = vi
      .spyOn(h, "control")
      .mockImplementation(async (path, body) => {
        if (path === "/v1/lease")
          return {
            ok: true,
            status: 200,
            body: { owner: h.owner, epoch: 1, expires: Date.now() + 30000 },
          };
        if (path.startsWith("/v1/inspect/"))
          return {
            ok: true,
            status: 200,
            body: { state: "running", exitCode: 0, startedAt: "t0" },
          };
        if (path === "/v1/start" || path === "/v1/restart") {
          actions.push(path + ":" + (body as { service: string }).service);
          return {
            ok: true,
            status: 200,
            body: {
              state: "ACCEPTED",
              code:
                path === "/v1/start"
                  ? "docker_start_accepted"
                  : "docker_restart_accepted",
            },
          };
        }
        throw new Error("Unexpected " + path);
      });
    const close = async () => {
      await store.db.end();
      journal.db.close();
      rmSync(directory, { recursive: true, force: true });
    };
    return { h, journal, verifier, control, actions, close };
  }
  afterEach(() => vi.restoreAllMocks());
  it("repairs every failed API without one verification starving the other", async () => {
    const t = await harness(() => [
      component("api-1"),
      component("api-2"),
      ...deps(),
    ]);
    try {
      vi.spyOn(t.verifier, "verify").mockResolvedValue({
        ok: false,
        evidence: {},
      });
      await t.h.tick();
      expect(t.actions).toEqual(["/v1/start:api-1"]);
      await t.h.tick();
      // Still one side effect per cycle, but the second repair is not starved.
      expect(t.actions).toEqual(["/v1/start:api-1", "/v1/start:api-2"]);
    } finally {
      await t.close();
    }
  });
  it("restarts a hung API only after its own direct probe also times out", async () => {
    const t = await harness(() => [
      component("api-1", { state: "HEALTHY" }),
      component("api-2", {
        code: "probe_timeout",
        failureCode: "probe_timeout",
      }),
      ...deps(),
    ]);
    try {
      // The hung API times out; its healthy peer answers at once.
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
        !String(url).includes("api-2")
          ? new Response('{"status":"ready"}')
          : Promise.reject(new DOMException("timeout", "TimeoutError")),
      );
      vi.spyOn(t.verifier, "verify").mockResolvedValue({
        ok: false,
        evidence: {},
      });
      await t.h.tick();
      expect(t.actions).toEqual(["/v1/restart:api-2"]);
      const a = t.journal.all()[0]!;
      expect(a).toMatchObject({
        playbook: "api-restart-unresponsive",
        action: "restart_unresponsive_service",
        state: "VERIFYING",
      });
      expect(a.evidence).toMatchObject({
        failureCode: "probe_timeout",
        corroboration: "probe_timeout",
        containerState: "running",
        controlReceipt: "docker_restart_accepted",
        actionPerformed: true,
      });
    } finally {
      await t.close();
    }
  });
  it("does not restart when the peer is slow too (congestion, not a hang)", async () => {
    const t = await harness(() => [
      component("api-1", { state: "HEALTHY" }),
      component("api-2", {
        code: "probe_timeout",
        failureCode: "probe_timeout",
      }),
      ...deps(),
    ]);
    try {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new DOMException("timeout", "TimeoutError"),
      );
      vi.spyOn(t.verifier, "verify").mockResolvedValue({
        ok: false,
        evidence: {},
      });
      await t.h.tick();
      expect(t.actions).toEqual([]);
      const a = t.journal.all()[0]!;
      expect(a).toMatchObject({
        state: "VERIFYING",
        reason: "peer_also_slow_congestion_not_a_hang_no_restart",
      });
      expect(a.evidence).toMatchObject({
        corroboration: "probe_timeout",
        peerProbe: "probe_timeout",
        actionPerformed: false,
      });
    } finally {
      await t.close();
    }
  });
  it("does not restart when the corroborating probe answers", async () => {
    const t = await harness(() => [
      component("api-1", { state: "HEALTHY" }),
      component("api-2", { failureCode: "probe_timeout" }),
      ...deps(),
    ]);
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response('{"status":"ready"}'),
      );
      vi.spyOn(t.verifier, "verify").mockResolvedValue({
        ok: false,
        evidence: {},
      });
      await t.h.tick();
      expect(t.actions).toEqual([]);
      expect(t.journal.all()[0]).toMatchObject({
        state: "VERIFYING",
        reason: "corroborating_probe_answered_no_restart",
      });
    } finally {
      await t.close();
    }
  });
  it.each([false, true])(
    "uses Docker-confirmed exit despite a timeout; start disabled=%s",
    async (disabled) => {
      const t = await harness(() => [
        component("api-1", { state: "HEALTHY" }),
        component("api-2", {
          code: "probe_timeout",
          failureCode: "probe_timeout",
        }),
        ...deps(),
      ]);
      try {
        if (disabled) t.h.c.HEALER_DISABLED_PLAYBOOKS = "api-start";
        const control = t.control.getMockImplementation()!;
        t.control.mockImplementation(async (path, body) =>
          path.startsWith("/v1/inspect/")
            ? {
                ok: true,
                status: 200,
                body: { state: "exited", exitCode: 137, startedAt: "t0" },
              }
            : control(path, body),
        );
        // A refused connection may look like a timeout on the Docker host.
        const fetch = vi
          .spyOn(globalThis, "fetch")
          .mockRejectedValue(new DOMException("timeout", "TimeoutError"));
        await t.h.tick();
        expect(t.actions).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
        expect(t.journal.all()[0]).toMatchObject({
          playbook: "api-start",
          action: "start_stopped_service",
          state: "SCHEDULED",
          reason: "diagnosis_revised_to_start_after_container_exit",
          evidence: { diagnosisRevised: true, containerState: "exited" },
        });
        await t.h.tick();
        expect(t.actions).toEqual(disabled ? [] : ["/v1/start:api-2"]);
        if (!disabled)
          expect(t.journal.all()[0]).toMatchObject({
            state: "VERIFYING",
            evidence: { controlReceipt: "docker_start_accepted" },
          });
      } finally {
        await t.close();
      }
    },
  );
  it("revises a timeout diagnosis to a start when the process is actually gone", async () => {
    const t = await harness(() => [
      component("api-1", { state: "HEALTHY" }),
      component("api-2", { failureCode: "probe_timeout" }),
      ...deps(),
    ]);
    try {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
      );
      vi.spyOn(t.verifier, "verify").mockResolvedValue({
        ok: false,
        evidence: {},
      });
      await t.h.tick();
      expect(t.actions).toEqual([]);
      expect(t.journal.all()[0]).toMatchObject({
        playbook: "api-start",
        action: "start_stopped_service",
        state: "SCHEDULED",
      });
      await t.h.tick();
      expect(t.actions).toEqual(["/v1/start:api-2"]);
    } finally {
      await t.close();
    }
  });
});

it("defers a relay symptom caused by the API tier instead of escalating it", () => {
  const relay = component("relay", { failureCode: "probe_timeout" });
  expect(
    eligibility(
      relay,
      [component("api-1", { state: "HEALTHY" }), component("api-2")],
      config(),
    ).reason,
  ).toBe("dependency_unhealthy:api-2");
  expect(
    eligibility(
      component("relay"),
      [
        component("api-1", { state: "HEALTHY" }),
        component("api-2", { state: "HEALTHY" }),
      ],
      config(),
    ),
  ).toMatchObject({ allowed: true });
});

it("reports the remaining budget with the same rule claim() enforces", () => {
  const j = new ControlJournal(database(":memory:"));
  const t = 10_000_000;
  expect(j.budget("api-2", 30000, 2, 600000, t)).toEqual({
    used: 0,
    max: 2,
    availableAt: null,
  });
  j.claim(randomUUID(), "api-2", 30000, 2, 600000, t);
  expect(j.budget("api-2", 30000, 2, 600000, t + 1000).availableAt).toBe(
    new Date(t + 30000).toISOString(),
  );
  j.claim(randomUUID(), "api-2", 30000, 2, 600000, t + 40000);
  const b = j.budget("api-2", 30000, 2, 600000, t + 90000);
  expect(b).toEqual({
    used: 2,
    max: 2,
    availableAt: new Date(t + 600000).toISOString(),
  });
  expect(j.claim(randomUUID(), "api-2", 30000, 2, 600000, t + 600000 - 1)).toBe(
    "budget_exhausted",
  );
  expect(j.claim(randomUUID(), "api-2", 30000, 2, 600000, t + 600001)).toBe(
    "accepted",
  );
});

describe("traffic surge scale-out and scale-in", () => {
  const overloaded = component("api-tier", {
    state: "DEGRADED",
    code: "overloaded",
    failureCode: "overloaded",
    failures: 3,
  });
  it("answers confirmed overload with spare capacity, never a restart", () => {
    const d = eligibility(overloaded, deps(), config());
    expect(d).toMatchObject({ allowed: true });
    expect(d.playbook?.id).toBe("api-scale-out");
    expect(d.playbook?.action).toBe("start_spare_capacity");
  });
  it("still treats other degraded states as dependency symptoms", () => {
    expect(
      eligibility(
        component("api-1", { state: "DEGRADED", code: "http_503" }),
        deps(),
        config(),
      ).reason,
    ).toBe("authority_or_dependency_symptom");
  });
  it("scales in only with both permanent APIs serving and authority granted", () => {
    const tier = component("api-tier", {
      state: "HEALTHY",
      code: "scale_in",
      failureCode: "scale_in",
    });
    const both = [
      component("api-1", { state: "HEALTHY" }),
      component("api-2", { state: "HEALTHY" }),
    ];
    expect(
      eligibility(tier, both, config(), Date.now(), "api-scale-in"),
    ).toMatchObject({ allowed: true });
    expect(
      eligibility(
        tier,
        [both[0]!, component("api-2")],
        config(),
        Date.now(),
        "api-scale-in",
      ).reason,
    ).toBe("dependency_unhealthy:api-2");
    expect(
      eligibility(
        tier,
        both,
        { ...config(), allowed: ["api-1", "api-2"] },
        Date.now(),
        "api-scale-in",
      ).reason,
    ).toBe("service_not_allowed");
  });
});

it("uses the configured observer freshness window without accepting stale evidence", () => {
  const now = Date.now();
  const observation = component("api-1", {
    observedAt: new Date(now - 14000).toISOString(),
  });
  expect(eligibility(observation, deps(), config(), now).reason).toBe(
    "unconfirmed_or_stale",
  );
  const c = healingConfig({
    HEALER_SECRET: "a".repeat(43),
    CONTROL_SECRET: "b".repeat(43),
    HEALER_ENABLED: "true",
    OBS_STALE_MS: "20000",
  });
  expect(eligibility(observation, deps(), c, now).allowed).toBe(true);
  expect(
    eligibility(
      { ...observation, observedAt: new Date(now - 21000).toISOString() },
      deps(),
      c,
      now,
    ).reason,
  ).toBe("unconfirmed_or_stale");
});
