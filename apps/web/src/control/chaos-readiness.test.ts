import { describe, expect, it } from "vitest";
import {
  observationFreshness,
  parseChaosSnapshot,
  liveDemoIds,
  primaryDemoScenarios,
  type ChaosSnapshot,
} from "@streamshield/shared";
import { scenarios } from "../../../../services/api/src/chaos/config";
import { chaosReadiness, scenarioDenial } from "./chaos-readiness";
import { RequestError } from "../platform/request";
const now = Date.parse("2026-10-24T10:00:00Z");
const snapshot = (): ChaosSnapshot => ({
  version: 1,
  available: true,
  enabled: true,
  databaseAvailable: true,
  observedAt: new Date(now).toISOString(),
  serverTime: new Date(now).toISOString(),
  staleAfterMs: 12000,
  activeId: null,
  observationWindowMs: 15000,
  faultDurationMs: 8000,
  timeoutMs: 180000,
  scenarios: scenarios.map((s) => ({
    ...s,
    available: s.supported,
    reason: s.supported ? null : s.reason,
  })),
  experiments: [],
});
describe("authoritative freshness", () => {
  it.each([
    [null, "missing"],
    ["bad-date", "invalid"],
    [new Date(now + 1).toISOString(), "future"],
    [new Date(now - 12000).toISOString(), "stale"],
    [new Date(now).toISOString(), "fresh"],
  ] as const)("classifies %s as %s", (value, expected) =>
    expect(observationFreshness(value, now)).toBe(expected),
  );
  it("rejects NaN, infinity and invalid TTLs", () => {
    expect(observationFreshness(Infinity, now)).toBe("invalid");
    expect(observationFreshness(now, now, -1)).toBe("invalid");
  });
  it("uses server age plus elapsed receipt time instead of a skewed browser clock", () => {
    expect(chaosReadiness(snapshot(), undefined, 0, now + 86400000)).toBeNull();
    expect(
      chaosReadiness(snapshot(), undefined, 12000, now - 86400000),
    ).toContain("stale");
  });
  it("handles legacy missing/invalid/future observations explicitly", () => {
    for (const [value, text] of [
      [null, "missing"],
      ["bad", "invalid"],
      [new Date(now + 100).toISOString(), "future-dated"],
    ] as const)
      expect(
        chaosReadiness({ ...snapshot(), observedAt: value }, undefined, 0, now),
      ).toContain(text);
  });
});
describe("primary demo and admission", () => {
  it("selects exactly the five existing IDs without deleting the backend catalog", () => {
    expect(primaryDemoScenarios(scenarios).map((s) => s.id)).toEqual(
      liveDemoIds,
    );
    expect(scenarios.length).toBeGreaterThan(5);
  });
  it("rejects malformed JSON contracts, dates, missing/duplicate primary scenarios", () => {
    expect(parseChaosSnapshot(snapshot()).scenarios).toHaveLength(
      scenarios.length,
    );
    for (const patch of [
      { observedAt: "bad" },
      { available: "true" },
      { scenarios: [] },
      { scenarios: [...scenarios, scenarios[0]] },
    ])
      expect(() => parseChaosSnapshot({ ...snapshot(), ...patch })).toThrow();
  });
  it.each([
    [401, "Authentication"],
    [403, "Administrator"],
    [429, "limit"],
    [503, "request failed"],
  ])("distinguishes HTTP %i", (status, text) =>
    expect(
      chaosReadiness(
        snapshot(),
        new RequestError(status, "server detail"),
        0,
        now,
      ),
    ).toContain(text),
  );
  it("does not trust cached success after a failed request", () =>
    expect(chaosReadiness(snapshot(), new Error("network"), 0, now)).toContain(
      "request failed",
    ));
  it("disables unknown/controller/audit/active states with reasons", () => {
    expect(chaosReadiness(undefined)).toContain("unknown");
    expect(
      chaosReadiness(
        {
          ...snapshot(),
          available: false,
          unavailableReason: "Fault adapter unavailable",
        },
        undefined,
        0,
        now,
      ),
    ).toBe("Fault adapter unavailable");
    expect(
      chaosReadiness(
        { ...snapshot(), databaseAvailable: false },
        undefined,
        0,
        now,
      ),
    ).toContain("persistence");
    expect(
      chaosReadiness(
        { ...snapshot(), activeId: crypto.randomUUID() },
        undefined,
        0,
        now,
      ),
    ).toContain("active");
  });
  it("honors scenario-specific prerequisites even if global transport is healthy", () =>
    expect(
      scenarioDenial(
        {
          ...scenarios[0]!,
          available: false,
          reason: "Previous recovery not verified",
        },
        null,
      ),
    ).toBe("Previous recovery not verified"));
});
it("does not admit a new demo against an older backend without observation-window capability", () => {
  const old = { ...snapshot(), observationWindowMs: undefined };
  expect(chaosReadiness(old, undefined, 0, now)).toContain("Backend version");
});
