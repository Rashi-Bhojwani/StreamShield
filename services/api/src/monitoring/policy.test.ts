import { localAdmission } from "./admission";
import { describe, it, expect } from "vitest";
import { evaluate, overall, duration, failedProbe } from "./policy";
import { finitePoints } from "./queries";
import type { ComponentObservation } from "@streamshield/shared";
const initial: ComponentObservation = {
  id: "api-1",
  name: "API1",
  role: "API",
  group: "Application",
  dependencies: [],
  state: "UNKNOWN",
  observedAt: "2026-01-01T00:00:00Z",
  lastSuccessAt: null,
  code: "warming_up",
  latencyMs: null,
  failures: 0,
  successes: 0,
  firstFailureAt: null,
  detectionMs: null,
};
const now = "2026-01-01T00:00:02Z",
  policy = { failures: 2, successes: 2 };
const ok = { state: "HEALTHY", code: "probe_ok", latencyMs: 1 } as const;
const bad = {
  state: "UNHEALTHY",
  code: "probe_unreachable",
  latencyMs: 1000,
} as const;
describe("health evidence policy", () => {
  it("requires two successes at startup", () => {
    const first = evaluate(initial, ok, policy, now, null);
    expect(first.state).toBe("UNKNOWN");
    expect(evaluate(first, ok, policy, now, null).state).toBe("HEALTHY");
  });
  it("confirms outage at threshold and retains first observation", () => {
    const first = evaluate(initial, bad, policy, now, 0),
      next = evaluate(first, bad, policy, "2026-01-01T00:00:04Z", 2000);
    expect(first.state).toBe("UNKNOWN");
    expect(next.state).toBe("UNHEALTHY");
    expect(next.firstFailureAt).toBe(now);
    expect(next.detectionMs).toBe(2000);
  });
  it("degrades healthy service on suspicion without confirming unhealthy", () =>
    expect(
      evaluate({ ...initial, state: "HEALTHY" }, bad, policy, now, 0).state,
    ).toBe("DEGRADED"));
  it("uses recovering until success threshold and clears failure after verification", () => {
    const first = evaluate(
      { ...initial, state: "UNHEALTHY", firstFailureAt: initial.observedAt },
      ok,
      policy,
      now,
      null,
    );
    expect(first.state).toBe("RECOVERING");
    const verified = evaluate(first, ok, policy, now, null);
    expect(verified.state).toBe("HEALTHY");
    expect(verified.firstFailureAt).toBeNull();
  });
  it("unknown is neither healthy nor verification", () => {
    const unknown = evaluate(
      { ...initial, state: "UNHEALTHY", firstFailureAt: now },
      { state: "UNKNOWN", code: "probe_denied", latencyMs: 2 },
      policy,
      now,
      null,
    );
    expect(unknown.state).toBe("UNKNOWN");
    expect(unknown.successes).toBe(0);
    expect(unknown.firstFailureAt).toBe(now);
  });
  it("dependency failure can be degraded rather than unreachable", () => {
    let c = evaluate(initial, { ...bad, state: "DEGRADED" }, policy, now, 0);
    c = evaluate(c, { ...bad, state: "DEGRADED" }, policy, now, 2000);
    expect(c.state).toBe("DEGRADED");
  });
  it("failure interrupts verification hysteresis", () => {
    const c = evaluate(
      { ...initial, successes: 1, firstFailureAt: now },
      bad,
      policy,
      now,
      0,
    );
    expect(c.successes).toBe(0);
    expect(c.state).not.toBe("HEALTHY");
  });
  it("surviving peer means degraded platform, both down means unavailable", () => {
    const peers = [
      { id: "api-1", state: "UNHEALTHY" },
      { id: "api-2", state: "HEALTHY" },
    ] as const;
    expect(overall([...peers])).toBe("DEGRADED");
    expect(overall(peers.map((c) => ({ ...c, state: "UNHEALTHY" })))).toBe(
      "UNHEALTHY",
    );
  });
  it("unknown evidence is not fabricated operational status", () =>
    expect(overall([{ id: "api-1", state: "UNKNOWN" }])).toBe("UNKNOWN"));
  it("shared dependency failure renders platform unhealthy", () =>
    expect(overall([{ id: "redis", state: "UNHEALTHY" }])).toBe("UNHEALTHY"));
  it("calculates UTC duration without negative clock artifacts", () => {
    expect(duration(initial.observedAt, now)).toBe(2000);
    expect(duration(now, initial.observedAt)).toBeNull();
  });
  it("filters NaN and infinity without converting absence to zero", () =>
    expect(
      finitePoints([
        [1, "NaN"],
        [2, "+Inf"],
        [3, "1.25"],
      ]),
    ).toEqual([[3, 1.25]]));
  it("bounds returned metric samples", () =>
    expect(
      finitePoints(Array.from({ length: 200 }, (_, i) => [i, String(i)]))
        .length,
    ).toBe(121));
});

it("bounds Redis-outage monitoring admission without denying authorized reads immediately", () => {
  const allow = localAdmission(2, 100, 2);
  expect(allow("a", 0)).toBe(true);
  expect(allow("a", 1)).toBe(true);
  expect(allow("a", 2)).toBe(false);
  expect(allow("b", 2)).toBe(true);
  expect(allow("c", 3)).toBe(false);
  expect(allow("c", 101)).toBe(true);
});

it("reports rejected DB/Redis observer authority as unknown without declaring a service outage", () => {
  expect(failedProbe({ code: "28P01" }, 2).state).toBe("UNKNOWN");
  expect(failedProbe(new Error("WRONGPASS invalid credentials"), 2).code).toBe(
    "probe_denied",
  );
  expect(failedProbe({ code: "ECONNREFUSED" }, 1000).state).toBe("UNHEALTHY");
});

it("distinguishes a hung target (timeout) from an absent one (unreachable)", () => {
  expect(failedProbe(new DOMException("t", "TimeoutError"), 1000)).toEqual({
    state: "UNHEALTHY",
    code: "probe_timeout",
    latencyMs: 1000,
  });
  expect(failedProbe(new DOMException("a", "AbortError"), 999).code).toBe(
    "probe_timeout",
  );
  expect(failedProbe(new Error("Query read timeout"), 1000).code).toBe(
    "probe_timeout",
  );
  expect(failedProbe({ code: "57014" }, 1000).code).toBe("probe_timeout");
  class TimeoutError extends Error {}
  expect(failedProbe(new TimeoutError(), 1000).code).toBe("probe_timeout");
  const refused = new TypeError("fetch failed", {
    cause: { code: "ECONNREFUSED" },
  });
  expect(failedProbe(refused, 3).code).toBe("probe_unreachable");
  const dns = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  expect(failedProbe(dns, 3).code).toBe("probe_unreachable");
  const connect = new TypeError("fetch failed", {
    cause: { code: "UND_ERR_CONNECT_TIMEOUT", name: "ConnectTimeoutError" },
  });
  expect(failedProbe(connect, 1000).code).toBe("probe_unreachable");
  expect(failedProbe(new Error("redis"), 0).code).toBe("probe_unreachable");
  expect(failedProbe({ code: "28P01" }, 2).code).toBe("probe_denied");
});
