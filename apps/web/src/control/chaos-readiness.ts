import {
  DEFAULT_OBSERVATION_STALE_MS,
  observationFreshness,
  type ChaosSnapshot,
  type ChaosScenario,
} from "@streamshield/shared";
import { RequestError } from "../platform/request";
export function chaosReadiness(
  data: ChaosSnapshot | undefined,
  error?: unknown,
  elapsedMs = 0,
  now = Date.now(),
): string | null {
  if (error instanceof RequestError) {
    if (error.status === 401)
      return "Authentication has expired. Sign in again.";
    if (error.status === 403) return "Administrator authorization is required.";
    if (error.status === 429)
      return "Monitoring request limit reached. Wait for the next refresh.";
  }
  if (error instanceof Error && error.name === "InvalidChaosResponse")
    return error.message;
  if (error)
    return "The authenticated monitoring request failed. Controller health is unknown.";
  if (!data)
    return "Controller status is unknown; waiting for an authenticated observation.";
  const serverNow = data.serverTime
    ? Date.parse(data.serverTime) + Math.max(0, elapsedMs)
    : now;
  const fresh = observationFreshness(
    data.observedAt,
    serverNow,
    data.staleAfterMs ?? DEFAULT_OBSERVATION_STALE_MS,
  );
  if (fresh === "missing")
    return (
      data.unavailableReason || "Controller observation timestamp is missing."
    );
  if (fresh === "invalid")
    return "Controller observation timestamp is invalid.";
  if (fresh === "future")
    return "Controller observation is future-dated. Check the server clocks.";
  if (fresh === "stale")
    return "Monitoring data is stale; wait for fresh observer/controller evidence.";
  if (!data.available)
    return (
      data.unavailableReason ||
      "Controller prerequisites are unavailable; inspect observer, persistence, Healer and fault adapter health."
    );
  if (!data.databaseAvailable)
    return "Experiment audit persistence is unavailable; injection is disabled.";
  if (!data.enabled)
    return "Local chaos injection is not enabled by deployment policy.";
  if (
    data.activeId ||
    data.experiments.some(
      (e) =>
        !["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(e.state),
    )
  )
    return "Another scenario is active; wait for verified recovery.";
  if (
    data.experiments.some(
      (e) => e.cleanup === "PENDING" || e.cleanup === "FAILED",
    )
  )
    return "A previous fault still awaits verified cleanup.";
  if (data.observationWindowMs === undefined)
    return "Backend version does not support the verified observation window. Rebuild the frontend and restart API/controller services from the same branch.";
  return null;
}
export function scenarioDenial(
  s: ChaosScenario | undefined,
  globalReason: string | null,
): string | null {
  if (globalReason) return globalReason;
  if (!s) return "Scenario is not present in the controller contract.";
  if (!s.supported) return s.reason || "Scenario is unsupported.";
  if (!s.available)
    return s.reason || "Scenario prerequisites are not satisfied.";
  return null;
}
