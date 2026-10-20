import type { ComponentObservation, HealthState } from "@streamshield/shared";
export interface Probe {
  state: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
  code: string;
  latencyMs: number | null;
}
export interface Policy {
  failures: number;
  successes: number;
}
export function evaluate(
  previous: ComponentObservation,
  probe: Probe,
  policy: Policy,
  now: string,
  elapsedMs: number | null,
): ComponentObservation {
  const next = {
    ...previous,
    observedAt: now,
    code: probe.code,
    latencyMs: probe.latencyMs,
  };
  if (probe.state === "UNKNOWN")
    return { ...next, state: "UNKNOWN", failures: 0, successes: 0 };
  if (probe.state === "HEALTHY") {
    if (previous.successes === 0) next.firstSuccessAt = now;
    next.lastSuccessAt = now;
    next.successes++;
    next.failures = 0;
    next.state =
      next.successes >= policy.successes
        ? "HEALTHY"
        : previous.firstFailureAt
          ? "RECOVERING"
          : "UNKNOWN";
    if (next.state === "HEALTHY") {
      next.firstFailureAt = null;
      next.detectionMs = null;
      next.confirmedAt = null;
      next.failureCode = null;
      next.failureState = null;
    }
  } else {
    next.successes = 0;
    next.firstSuccessAt = null;
    next.failures++;
    next.firstFailureAt ||= now;
    next.state =
      next.failures >= policy.failures
        ? probe.state
        : previous.state === "HEALTHY"
          ? "DEGRADED"
          : "UNKNOWN";
    if (next.failures === policy.failures) {
      next.detectionMs = elapsedMs;
      next.confirmedAt ||= now;
      next.failureCode = probe.code;
      next.failureState = probe.state;
    }
  }
  return next;
}
export function overall(
  components: Pick<ComponentObservation, "id" | "state">[],
): HealthState {
  if (!components.length || components.some((c) => c.state === "UNKNOWN"))
    return "UNKNOWN";
  for (const peers of [
    ["api-1", "api-2"],
    ["edge-1", "edge-2"],
    ["origin-primary", "origin-standby"],
  ]) {
    if (
      peers.every(
        (id) => components.find((c) => c.id === id)?.state === "UNHEALTHY",
      )
    )
      return "UNHEALTHY";
  }
  if (
    components.some(
      (c) =>
        [
          "postgres",
          "redis",
          "relay",
          "api-gateway",
          "video-gateway",
          "web",
        ].includes(c.id) && c.state === "UNHEALTHY",
    )
  )
    return "UNHEALTHY";
  return components.some((c) => c.state !== "HEALTHY") ? "DEGRADED" : "HEALTHY";
}
export function duration(from: string, to: string) {
  const value = Date.parse(to) - Date.parse(from);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Rejected observer authority cannot establish that the target itself is down. */
export function failedProbe(error: unknown, latencyMs: number): Probe {
  const value = error as { code?: string; message?: string } | null;
  const denied =
    ["28P01", "28000", "42501", "3D000", "MONITOR_AUTH_DENIED"].includes(
      value?.code || "",
    ) || /^(WRONGPASS|NOAUTH|NOPERM)\b/.test(value?.message || "");
  return {
    state: denied ? "UNKNOWN" : "UNHEALTHY",
    code: denied ? "probe_denied" : "probe_unreachable",
    latencyMs,
  };
}
