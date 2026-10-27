import { expect, it } from "vitest";
import type { ChaosExperiment } from "@streamshield/shared";
import {
  demoProgress,
  blockedNextStep,
  scenarioPresentationState,
  systemPresentationState,
  definitelyNoFaultInjected,
} from "./demo-model";
const now = Date.now();
const experiment = {
  state: "VERIFYING",
  scenario: "crash-api",
  injectedAt: new Date(now - 16000).toISOString(),
  faultConfirmedAt: new Date(now - 15900).toISOString(),
  incidentDetectedAt: new Date(now - 14000).toISOString(),
  actionStartedAt: new Date(now - 13000).toISOString(),
  verifiedAt: null,
  finishedAt: null,
  evidence: { observationWindowMs: 15000 },
  events: [],
} as unknown as ChaosExperiment;
it("requires actual verification and current fresh health after a confirmed fault", () => {
  expect(scenarioPresentationState(undefined, true, true)).toBe("HEALTHY");
  expect(scenarioPresentationState(experiment, false, true)).toBe("RECOVERING");
  const healed = {
    ...experiment,
    state: "COMPLETED" as const,
    verifiedAt: new Date(now).toISOString(),
    evidence: { independentBehaviorVerified: true },
  };
  expect(scenarioPresentationState(healed, true, true)).toBe("HEALTHY");
  expect(
    scenarioPresentationState({ ...healed, verifiedAt: null }, true, true),
  ).toBe("RECOVERY UNVERIFIED");
  expect(scenarioPresentationState(healed, true, false)).toBe("UNKNOWN");
  expect(
    scenarioPresentationState({ ...healed, state: "TIMED_OUT" }, true, true),
  ).toBe("RECOVERY UNVERIFIED");
});
it("shows a genuine Healthy to Failed to Recovering to Healthy cycle", () => {
  expect(scenarioPresentationState(undefined, true, true)).toBe("HEALTHY");
  expect(
    scenarioPresentationState(
      { ...experiment, state: "FAULT_CONFIRMED", actionStartedAt: null },
      false,
      true,
    ),
  ).toBe("FAILED");
  expect(scenarioPresentationState(experiment, false, true)).toBe("RECOVERING");
  expect(
    scenarioPresentationState(
      {
        ...experiment,
        state: "COMPLETED",
        verifiedAt: new Date(now).toISOString(),
        evidence: { independentBehaviorVerified: true },
      },
      true,
      true,
    ),
  ).toBe("HEALTHY");
});
it("does not retain a false outage from a request rejected before injection", () => {
  const denied = {
    ...experiment,
    state: "FAILED",
    injectedAt: null,
    faultConfirmedAt: null,
  } as ChaosExperiment;
  expect(scenarioPresentationState(denied, true, true)).toBe("HEALTHY");
  expect(scenarioPresentationState(denied, false, true)).toBe("DEGRADED");
});
it("does not declare no fault or healthy recovery when injection acceptance is ambiguous", () => {
  const e = {
    ...experiment,
    state: "FAILED",
    injectedAt: null,
    faultConfirmedAt: null,
    events: [
      {
        kind: "INJECTING",
        at: new Date(now).toISOString(),
        detail: "intent recorded",
      },
    ],
  } as ChaosExperiment;
  expect(definitelyNoFaultInjected(e)).toBe(false);
  expect(scenarioPresentationState(e, true, true)).toBe("RECOVERY UNVERIFIED");
  e.events.push({
    kind: "NO_ACCEPTED_FAULT",
    at: new Date(now).toISOString(),
    detail: "adapter confirmed absent",
  });
  expect(definitelyNoFaultInjected(e)).toBe(true);
  expect(scenarioPresentationState(e, true, true)).toBe("HEALTHY");
});
it("uses independent baseline re-verification without rewriting failed history", () => {
  const e = {
    ...experiment,
    state: "TIMED_OUT",
    evidence: { terminalBaselineReverifiedAt: new Date(now).toISOString() },
    events: [
      {
        kind: "BASELINE_REVERIFIED",
        at: new Date(now).toISOString(),
        detail: "actual functional checks",
      },
    ],
  } as ChaosExperiment;
  expect(scenarioPresentationState(e, true, true)).toBe("HEALTHY");
  expect(scenarioPresentationState(e, false, true)).toBe("DEGRADED");
  expect(e.state).toBe("TIMED_OUT");
});
it("does not show a healthy header when a card has an unresolved recovery", () => {
  expect(
    systemPresentationState(["HEALTHY", "RECOVERY UNVERIFIED"], true, true),
  ).toBe("Recovery unverified");
  expect(systemPresentationState(["HEALTHY", "FAILED"], false, true)).toBe(
    "Failure detected",
  );
  expect(systemPresentationState(["HEALTHY", "RECOVERING"], false, true)).toBe(
    "Recovering",
  );
  expect(systemPresentationState(["HEALTHY"], true, true)).toBe("Healthy");
  expect(systemPresentationState(["HEALTHY", "DEGRADED"], true, true)).toBe(
    "Degraded",
  );
});
it("does not turn elapsed observation time into verified recovery", () => {
  const p = demoProgress(experiment, now);
  expect(p.observationRemainingMs).toBe(0);
  expect(p.active).toBe(true);
  expect(p.stages.find((s) => s.label === "Recovery verified")?.at).toBeNull();
  expect(p.stages.find((s) => s.label === "Demo complete")?.at).toBeNull();
});
it("shows fast real verification while continuing observation, without synthesizing completion", () => {
  const e = {
    ...experiment,
    injectedAt: new Date(now - 5000).toISOString(),
    verifiedAt: new Date(now - 1000).toISOString(),
  };
  const p = demoProgress(e, now);
  expect(p.observationRemainingMs).toBe(10000);
  expect(p.stages[5]!.at).toBe(e.verifiedAt);
  expect(p.stages[6]!.at).toBeNull();
});
it("only renders complete from real final state and valid verification/finish timestamps", () => {
  expect(
    demoProgress(
      {
        ...experiment,
        state: "COMPLETED",
        verifiedAt: new Date(now - 3000).toISOString(),
        finishedAt: new Date(now - 1000).toISOString(),
      },
      now,
    ).stages[6]!.at,
  ).toBeTruthy();
  expect(
    demoProgress(
      {
        ...experiment,
        state: "FAILED",
        finishedAt: new Date(now).toISOString(),
      },
      now,
    ).stages[6]!.at,
  ).toBeNull();
  expect(
    demoProgress(
      { ...experiment, verifiedAt: new Date(now + 1).toISOString() },
      now,
    ).stages[5]!.at,
  ).toBeNull();
});
it("uses actual network circuit and cleanup events without inventing a Healer restart", () => {
  const e = {
    ...experiment,
    scenario: "network-timeout",
    events: [
      {
        kind: "CIRCUIT_OPEN",
        at: new Date(now - 6000).toISOString(),
        detail: "real",
      },
      {
        kind: "CLEANUP_COMPLETED",
        at: new Date(now - 2000).toISOString(),
        detail: "owned toxic removed",
      },
    ],
  } as ChaosExperiment;
  const p = demoProgress(e, now);
  expect(p.stages[3]!.at).toBe(e.events[0]!.at);
  expect(p.stages[4]!.at).toBe(e.events[1]!.at);
});
it.each([
  ["Authentication has expired", "Sign in"],
  ["audit persistence failed", "PostgreSQL"],
  ["Start a real live source", "OBS"],
  ["Previous recovery not verified", "Wait"],
])("explains a useful next step for %s", (reason, step) =>
  expect(blockedNextStep(reason)).toContain(step),
);

it("lights Ready only from a genuine fresh admission timestamp", () => {
  const at = new Date(now - 1000).toISOString();
  expect(demoProgress(undefined, now, at).stages[0]!.at).toBe(at);
  expect(demoProgress(undefined, now).stages[0]!.at).toBeNull();
  expect(
    demoProgress(undefined, now, new Date(now + 1).toISOString()).stages[0]!.at,
  ).toBeNull();
});
