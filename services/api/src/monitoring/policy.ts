import type { ComponentObservation, HealthState } from "@streamshield/shared";
export interface Probe {
  state: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
  code: string;
  latencyMs: number | null;
  metrics?: ComponentObservation["metrics"];
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
    ...(probe.metrics ? { metrics: probe.metrics } : {}),
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
/** A stopped spare is standby capacity: excluded from health baselines. */
export const standby = (c: { code?: string }) => c.code === "spare_standby";
export function overall(
  components: (Pick<ComponentObservation, "id" | "state"> & {
    code?: string;
  })[],
): HealthState {
  components = components.filter((c) => !standby(c));
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

const CONNECT_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
/**
 * Classifies why a probe failed without guessing beyond the evidence:
 * - probe_denied: the observer's own authority was rejected (target state unknown).
 * - probe_unreachable: no connection/answer path exists (refused, DNS gone, reset).
 *   A connect-phase timeout is also unreachable: a hung process still has its
 *   socket accepted by the kernel, so only a dead/absent endpoint fails to connect.
 * - probe_timeout: the request/command was accepted but no answer arrived in time
 *   (process alive but unresponsive).
 */
export function probeFailureCode(
  error: unknown,
): "probe_denied" | "probe_unreachable" | "probe_timeout" {
  const value = error as {
    code?: string;
    name?: string;
    message?: string;
    cause?: unknown;
  } | null;
  if (
    ["28P01", "28000", "42501", "3D000", "MONITOR_AUTH_DENIED"].includes(
      value?.code || "",
    ) ||
    /^(WRONGPASS|NOAUTH|NOPERM)\b/.test(value?.message || "")
  )
    return "probe_denied";
  const chain: { code?: string; name?: string; message?: string }[] = [];
  for (
    let e = value as typeof value | undefined, depth = 0;
    e && typeof e === "object" && depth < 4;
    e = e.cause as typeof value | undefined, depth++
  )
    chain.push(e);
  if (chain.some((e) => CONNECT_ERRORS.has(e.code || "")))
    return "probe_unreachable";
  if (
    chain.some(
      (e) =>
        e.name === "TimeoutError" ||
        e.name === "AbortError" ||
        // node-redis command timeouts are TimeoutError subclasses without a name.
        ["TimeoutError", "SocketTimeoutError"].includes(
          (e as { constructor?: { name?: string } }).constructor?.name || "",
        ) ||
        e.code === "ABORT_ERR" ||
        e.code === "UND_ERR_HEADERS_TIMEOUT" ||
        e.code === "UND_ERR_BODY_TIMEOUT" ||
        e.code === "57014" ||
        /^(Query read timeout|Timeout|Command timed out)/i.test(
          e.message || "",
        ),
    )
  )
    return "probe_timeout";
  return "probe_unreachable";
}
/** Rejected observer authority cannot establish that the target itself is down. */
export function failedProbe(error: unknown, latencyMs: number): Probe {
  const code = probeFailureCode(error);
  return {
    state: code === "probe_denied" ? "UNKNOWN" : "UNHEALTHY",
    code,
    latencyMs,
  };
}

/**
 * API-tier overload needs real traffic: with only a few requests, a couple of
 * slow ones dominate p95 and would trigger a false scale-out.
 */
export function tierOverloaded(
  m: { p95Ms: number; errorPct: number; rps: number },
  c: { p95Ms: number; errorPct: number; minRps: number },
) {
  return m.rps >= c.minRps && (m.p95Ms > c.p95Ms || m.errorPct > c.errorPct);
}
