import { describe, expect, it } from "vitest";
import type {
  ChaosExperiment,
  ComponentObservation,
  RecoveryAttempt,
} from "@streamshield/shared";
import { componentTone, experimentOverlay, stages } from "./evidence";

const at = (s: number) =>
  new Date(Date.UTC(2026, 9, 22, 12, 4, s)).toISOString();
const base = {
  id: "e",
  scenario: "crash-redis",
  target: "redis",
  state: "AWAITING_DETECTION",
  createdAt: at(0),
  injectedAt: at(10),
  faultConfirmedAt: at(10),
  incidentDetectedAt: null,
  actionStartedAt: null,
  actionFinishedAt: null,
  verifiedAt: null,
  finishedAt: null,
  recoveryIds: [],
  events: [],
} as unknown as ChaosExperiment;
const attempt = {
  id: "a",
  component: "redis",
  action: "start_stopped_service",
  state: "VERIFIED",
  createdAt: at(13),
  actionStartedAt: at(14),
  finishedAt: at(23),
} as RecoveryAttempt;
describe("recovery stage derivation", () => {
  it("lights no stage without its stored timestamp", () => {
    const s = stages(base, []);
    expect(s.filter((x) => x.at).map((x) => x.id)).toEqual([
      "healthy",
      "fault",
    ]);
    expect(s.find((x) => x.id === "detected")).toMatchObject({
      at: null,
      elapsedMs: null,
    });
  });
  it("derives elapsed times from the injection timestamp only", () => {
    const done = {
      ...base,
      state: "COMPLETED",
      incidentDetectedAt: at(13),
      actionStartedAt: at(14),
      actionFinishedAt: at(14),
      verifiedAt: at(25),
      finishedAt: at(25),
      recoveryIds: ["a"],
    } as ChaosExperiment;
    const s = stages(done, [attempt]);
    expect(s.map((x) => x.label)).toEqual([
      "HEALTHY",
      "FAULT CONFIRMED",
      "INCIDENT DETECTED",
      "DIAGNOSED",
      "HEALING STARTED",
      "SERVICE STARTING",
      "READINESS VERIFIED",
      "CHAT VERIFIED",
      "RECOVERED",
    ]);
    expect(s.find((x) => x.id === "detected")?.elapsedMs).toBe(3000);
    expect(s.find((x) => x.id === "readiness")?.elapsedMs).toBe(13000);
    expect(s.at(-1)?.elapsedMs).toBe(15000);
  });
  it("labels a restart and ends an escalated run honestly", () => {
    const failed = {
      ...base,
      target: "api-2",
      state: "FAILED",
      finishedAt: at(30),
      recoveryIds: ["a"],
    } as ChaosExperiment;
    const s = stages(failed, [
      {
        ...attempt,
        component: "api-2",
        action: "restart_unresponsive_service",
        state: "ESCALATED",
      },
    ]);
    expect(s.find((x) => x.id === "action")?.label).toBe("SERVICE RESTARTING");
    expect(s.find((x) => x.id === "recovered")?.at).toBeNull();
    expect(s.at(-1)).toMatchObject({ label: "ESCALATED", tone: "escalated" });
  });
});
describe("component tone", () => {
  const c = (o: Partial<ComponentObservation>) =>
    ({
      id: "redis",
      state: "HEALTHY",
      firstFailureAt: null,
      ...o,
    }) as ComponentObservation;
  it("never shows stale or missing evidence as green", () => {
    expect(componentTone(c({}), [], true)).toBe("unknown");
    expect(componentTone(undefined, [], false)).toBe("unknown");
  });
  it("shows healing while a Healer action executes or verifies, then recovered", () => {
    expect(
      componentTone(
        c({ state: "UNHEALTHY" }),
        [{ ...attempt, state: "VERIFYING" }],
        false,
      ),
    ).toBe("healing");
    expect(componentTone(c({}), [attempt], false, Date.parse(at(30)))).toBe(
      "recovered",
    );
    expect(componentTone(c({}), [attempt], false, Date.parse(at(90)))).toBe(
      "healthy",
    );
  });
  it("overlays the Healer step on every experiment target", () => {
    const tier = {
      ...base,
      target: "api-tier",
      state: "HEALING_OBSERVED",
      recoveryIds: ["x", "y"],
    } as ChaosExperiment;
    expect(
      experimentOverlay(tier, [
        { ...attempt, id: "x", component: "api-1", state: "VERIFYING" },
        { ...attempt, id: "y", component: "api-2", state: "EXECUTING" },
      ]),
    ).toEqual({ "api-1": "Healer verifying", "api-2": "Healer starting" });
  });
});
