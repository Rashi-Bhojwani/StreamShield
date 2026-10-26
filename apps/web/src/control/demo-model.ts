import type { ChaosExperiment } from "@streamshield/shared";
export const demoNames = {
  "crash-api": [
    "API Server Crash",
    "One API stops; the other keeps serving while the Healer repairs it.",
  ],
  "crash-video-gateway": [
    "Video Gateway Crash",
    "The video entry point stops; recovery must restore actual live segments.",
  ],
  "crash-edge": [
    "Edge Node Failure",
    "One delivery node stops; its healthy peer should keep video available.",
  ],
  "network-timeout": [
    "Network Disruption",
    "A temporary delay causes real timeouts; safe probes verify reconnection.",
  ],
  "media-authority-loss": [
    "Media Authorization Loss",
    "Both video routes are blocked. Missing external signing authority requires human intervention.",
  ],
} as const;
const completed = (e: ChaosExperiment) =>
  ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(e.state);
export const demoTerminal = completed;
export function scenarioPresentationState(
  e: ChaosExperiment | undefined,
  healthy: boolean,
  fresh: boolean,
) {
  if (!fresh) return "DEGRADED";
  if (e?.state === "AWAITING_OPERATOR") return "HUMAN ACTION REQUIRED";
  if (e?.scenario === "media-authority-loss" && e.state === "COMPLETED")
    return e.verifiedAt && e.evidence.independentBehaviorVerified === true
      ? "RESTORED BY OPERATOR"
      : "DEGRADED";
  if (e && !completed(e))
    return e.actionStartedAt || e.state === "VERIFYING" || !e.faultConfirmedAt
      ? "RECOVERING"
      : "FAILED";
  if (e && ["FAILED", "TIMED_OUT", "CANCELLED"].includes(e.state))
    return "DEGRADED";
  if (!healthy) return "DEGRADED";
  if (e?.state === "COMPLETED")
    return e.verifiedAt && e.evidence.independentBehaviorVerified === true
      ? "HEALED"
      : "DEGRADED";
  return "HEALTHY";
}
export function demoProgress(
  e: ChaosExperiment | undefined,
  now: number,
  baselineAt?: string | null,
) {
  const windowMs = Number(e?.evidence.observationWindowMs ?? 15000);
  const injected = e?.injectedAt ? Date.parse(e.injectedAt) : NaN;
  const elapsedMs =
    Number.isFinite(injected) && Number.isFinite(now)
      ? Math.max(0, now - injected)
      : null;
  const event = (kind: string) =>
    e?.events.find((x) => x.kind === kind)?.at ?? null;
  const network = e?.scenario === "network-timeout";
  const manual = e?.scenario === "media-authority-loss";
  const valid = (at: string | null | undefined) =>
    at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= now ? at : null;
  const verified = valid(e?.verifiedAt);
  const stages = [
    {
      label: "Ready",
      at:
        valid(event("INJECTING")) ||
        valid(
          typeof e?.evidence.baselineObservedAt === "string"
            ? e.evidence.baselineObservedAt
            : !e
              ? baselineAt
              : null,
        ),
    },
    { label: "Failure injected", at: valid(e?.faultConfirmedAt) },
    { label: "Failure detected", at: valid(e?.incidentDetectedAt) },
    {
      label: manual ? "Human action required" : "Recovery started",
      at: valid(
        manual
          ? event("HUMAN_ACTION_REQUIRED")
          : network
            ? event("CIRCUIT_OPEN") || e?.actionStartedAt
            : e?.actionStartedAt,
      ),
    },
    {
      label: manual ? "Operator restored access" : "Recovery in progress",
      at: valid(
        manual
          ? event("OPERATOR_ACCESS_RESTORED")
          : network
            ? event("CLEANUP_COMPLETED")
            : event("VERIFYING"),
      ),
    },
    {
      label: manual ? "Human restoration verified" : "Recovery verified",
      at: verified,
    },
    {
      label: "Demo complete",
      at: e?.state === "COMPLETED" && verified ? valid(e.finishedAt) : null,
    },
  ];
  return {
    stages,
    windowMs,
    elapsedMs,
    active: !!e && !completed(e),
    observationRemainingMs:
      elapsedMs === null ? windowMs : Math.max(0, windowMs - elapsedMs),
  };
}
export function blockedNextStep(reason: string) {
  if (/human action|external media authorization/i.test(reason))
    return "Use Restore demo media authorization below, or stop this disposable demo. Automatic recovery cannot supply the missing external authority.";
  if (/auth|sign in/i.test(reason))
    return "Sign in again with an administrator account.";
  if (/live|media|standby|source/i.test(reason))
    return "Start an OBS/Studio source and wait for advancing media on both origins.";
  if (/persistence|audit|storage/i.test(reason))
    return "Inspect observer and PostgreSQL logs; wait for a fresh durable checkpoint. Do not reset storage.";
  if (/active|recovery|cleanup|cooldown|budget/i.test(reason))
    return "Wait for the current recovery and cooldown; inspect its result before trying again.";
  return "Check service status and the observer, Healer and fault-adapter logs in Advanced diagnostics.";
}
