import type {
  ChaosExperiment,
  ChaosScenario,
  ComponentObservation,
  RecoveryAttempt,
} from "@streamshield/shared";
import type { HealthTone } from "../proof/health";

/** One recovery stage; lit only when its backing timestamp exists. */
export interface Stage {
  id: string;
  label: string;
  at: string | null;
  /** ms since fault injection, from stored timestamps only. */
  elapsedMs: number | null;
  tone: HealthTone;
}
const t = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
export const terminalExperiment = (s: string) =>
  ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(s);
export function attemptsFor(
  e: ChaosExperiment,
  attempts: RecoveryAttempt[],
): RecoveryAttempt[] {
  return attempts.filter((a) => e.recoveryIds.includes(a.id));
}
const eventAt = (e: ChaosExperiment, kind: string) =>
  e.events.filter((x) => x.kind === kind).at(-1)?.at ?? null;
/**
 * HEALTHY → FAULT CONFIRMED → INCIDENT DETECTED → DIAGNOSED → HEALING STARTED →
 * SERVICE STARTING/RESTARTING → READINESS VERIFIED → MEDIA/API/CHAT VERIFIED →
 * RECOVERED. A failed or escalated experiment ends honestly instead.
 */
export function stages(
  e: ChaosExperiment,
  attempts: RecoveryAttempt[],
): Stage[] {
  const own = attemptsFor(e, attempts);
  const restart = own.some((a) => a.action === "restart_unresponsive_service");
  const diagnosed = own
    .map((a) => a.createdAt)
    .filter(Boolean)
    .sort()[0];
  const readiness = own.length
    ? own.every((a) => a.state === "VERIFIED")
      ? own
          .map((a) => a.finishedAt || "")
          .sort()
          .at(-1) || null
      : null
    : null;
  const what =
    e.target === "redis"
      ? "CHAT"
      : ["video-gateway", "edge-1", "origin-primary", "relay"].includes(
            e.target,
          )
        ? "MEDIA"
        : "API";
  const rows: [string, string, string | null, HealthTone][] = [
    ["healthy", "HEALTHY", e.createdAt, "healthy"],
    ["fault", "FAULT CONFIRMED", e.faultConfirmedAt, "injected"],
    ["detected", "INCIDENT DETECTED", e.incidentDetectedAt, "failed"],
    ["diagnosed", "DIAGNOSED", diagnosed ?? null, "failed"],
    ["healing", "HEALING STARTED", e.actionStartedAt, "healing"],
    [
      "action",
      restart ? "SERVICE RESTARTING" : "SERVICE STARTING",
      e.actionFinishedAt,
      "healing",
    ],
    ["readiness", "READINESS VERIFIED", readiness, "healing"],
    [
      "verified",
      what + " VERIFIED",
      e.verifiedAt ?? eventAt(e, "SERVICE_VERIFIED"),
      "recovered",
    ],
    [
      "recovered",
      "RECOVERED",
      e.state === "COMPLETED" ? e.finishedAt : null,
      "recovered",
    ],
  ];
  const injected = t(e.injectedAt);
  const out: Stage[] = rows.map(([id, label, at, tone]) => ({
    id,
    label,
    at,
    tone,
    elapsedMs:
      at && Number.isFinite(injected) && Number.isFinite(t(at))
        ? t(at) - injected
        : null,
  }));
  if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(e.state)) {
    const escalated = own.some((a) => a.state === "ESCALATED");
    out.push({
      id: "end",
      label: escalated ? "ESCALATED" : e.state.replace("_", " "),
      at: e.finishedAt,
      tone: escalated ? "escalated" : "failed",
      elapsedMs:
        e.finishedAt && Number.isFinite(injected)
          ? t(e.finishedAt) - injected
          : null,
    });
  }
  return out;
}
export const fmt = (ms: number | null | undefined) =>
  ms == null || !Number.isFinite(ms)
    ? "Not measured"
    : ms < 1000
      ? Math.round(ms) + " ms"
      : (ms / 1000).toFixed(1) + " s";
const RECOVERED_MS = 30000;
/** Tone of a component right now, from real state and real Healer attempts. */
export function componentTone(
  c: ComponentObservation | undefined,
  attempts: RecoveryAttempt[],
  stale: boolean,
  now = Date.now(),
): HealthTone {
  if (!c || stale) return "unknown";
  const own = attempts.filter((a) => a.component === c.id);
  if (
    own.some(
      (a) =>
        a.actionStartedAt &&
        ["EXECUTING", "VERIFYING", "RETRY_WAIT"].includes(a.state),
    )
  )
    return "healing";
  const escalated = own.find((a) => a.state === "ESCALATED");
  if (
    escalated &&
    c.state !== "HEALTHY" &&
    t(escalated.finishedAt) >= t(c.firstFailureAt || escalated.createdAt)
  )
    return "escalated";
  if (c.state === "UNHEALTHY") return "failed";
  if (c.state === "DEGRADED" || c.state === "RECOVERING") return "degraded";
  if (c.state === "UNKNOWN") return "unknown";
  if (
    own.some(
      (a) =>
        a.state === "VERIFIED" &&
        a.actionStartedAt &&
        now - t(a.finishedAt) < RECOVERED_MS,
    )
  )
    return "recovered";
  return "healthy";
}
/** What the topology overlays on the target node, from experiment state. */
export function experimentOverlay(
  e: ChaosExperiment | undefined,
  attempts: RecoveryAttempt[],
): Record<string, string> {
  if (!e || terminalExperiment(e.state)) return {};
  const own = attemptsFor(e, attempts);
  const label = (target: string) => {
    const a = own.find((x) => x.component === target);
    if (a?.state === "EXECUTING")
      return a.action === "restart_unresponsive_service"
        ? "Healer restarting"
        : "Healer starting";
    if (a?.state === "VERIFYING") return "Healer verifying";
    if (a?.state === "VERIFIED") return "Verified";
    if (a?.state === "SCHEDULED") return "Diagnosed";
    if (["FAULT_CONFIRMED", "AWAITING_DETECTION"].includes(e.state))
      return "Fault injected";
    return e.state.replaceAll("_", " ").toLowerCase();
  };
  const targets = e.target === "api-tier" ? ["api-1", "api-2"] : [e.target];
  return Object.fromEntries(targets.map((x) => [x, label(x)]));
}
export const scenarioTargets = (
  s: Pick<ChaosScenario, "target" | "targets">,
) => (s.targets?.length ? s.targets : [s.target]);
