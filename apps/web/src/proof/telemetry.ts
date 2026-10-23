import { useSyncExternalStore } from "react";

/**
 * Browser-observed request evidence: which API instance answered (X-Served-By),
 * how long it took, and whether the application tier is reachable at all.
 * Everything here comes from real responses; nothing is inferred from timers.
 */
export interface RequestTelemetry {
  servedBy: string | null;
  latencyMs: number | null;
  lastOkAt: number | null;
  /** Consecutive requests that could not reach any API (network/502/503/504). */
  failures: number;
  outageSince: number | null;
  /** Instances seen answering in the last 30 s, newest last. */
  recent: { instance: string; at: number }[];
  requests: number;
  failed: number;
  /** Consecutive client-side timeouts: an API answered too slowly (e.g. hung). */
  slow: number;
}
const initial: RequestTelemetry = {
  servedBy: null,
  latencyMs: null,
  lastOkAt: null,
  failures: 0,
  outageSince: null,
  recent: [],
  requests: 0,
  failed: 0,
  slow: 0,
};
let state = initial;
const listeners = new Set<() => void>();
const emit = (next: RequestTelemetry) => {
  state = next;
  for (const l of listeners) l();
};
const WINDOW_MS = 30000;
/** Unreachable means no API answered; an HTTP 4xx is an answer, not an outage. */
export const unreachableStatus = (status: number) =>
  status === 502 || status === 503 || status === 504;
export function recordResponse(
  status: number,
  servedBy: string | null,
  latencyMs: number,
  now = Date.now(),
) {
  if (unreachableStatus(status)) {
    recordFailure(now);
    return;
  }
  const recent = servedBy
    ? [
        ...state.recent.filter((r) => now - r.at < WINDOW_MS),
        { instance: servedBy, at: now },
      ].slice(-50)
    : state.recent.filter((r) => now - r.at < WINDOW_MS);
  emit({
    ...state,
    servedBy: servedBy ?? state.servedBy,
    latencyMs: Math.round(latencyMs),
    lastOkAt: now,
    failures: 0,
    slow: 0,
    outageSince: null,
    recent,
    requests: state.requests + 1,
  });
}
export function recordFailure(now = Date.now()) {
  emit({
    ...state,
    failures: state.failures + 1,
    outageSince: state.outageSince ?? now,
    requests: state.requests + 1,
    failed: state.failed + 1,
  });
}
/** A timeout is slowness, not absence; repeated timeouts count as an outage. */
export function recordTimeout(elapsedMs: number, now = Date.now()) {
  const slow = state.slow + 1;
  emit({
    ...state,
    latencyMs: Math.round(elapsedMs),
    slow,
    failures: slow >= 3 ? state.failures + 1 : state.failures,
    outageSince: slow >= 3 ? (state.outageSince ?? now) : state.outageSince,
    requests: state.requests + 1,
    failed: state.failed + 1,
  });
}
export function resetTelemetry() {
  emit(initial);
}
export function getTelemetry() {
  return state;
}
export function useTelemetry() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
/** fetch() that records serving instance, latency and reachability. */
export async function trackedFetch(input: string, init?: RequestInit) {
  const started = performance.now();
  try {
    const response = await fetch(input, init);
    recordResponse(
      response.status,
      response.headers.get("X-Served-By"),
      performance.now() - started,
    );
    return response;
  } catch (error) {
    // A caller's own abort (navigation) is not evidence of an outage.
    const name = error instanceof DOMException ? error.name : "";
    if (name === "TimeoutError") recordTimeout(performance.now() - started);
    else if (name !== "AbortError") recordFailure();
    throw error;
  }
}
export const instanceLabel = (id: string | null) =>
  id ? id.toUpperCase().replace(/^API-/, "API-") : "—";
