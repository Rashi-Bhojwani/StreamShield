import { latencyBounds } from "../../packages/shared/src/demo.ts";
export function initialMetrics() {
  return {
    seq: 0,
    active: 0,
    peak: 0,
    requests: 0,
    errors: 0,
    bytes: 0,
    connections: 0,
    connectionFailures: 0,
    joinFailures: 0,
    disconnects: 0,
    reconnects: 0,
    messages: 0,
    delivered: 0,
    deliveryFailures: 0,
    verifiedBrowsers: 0,
    stalls: 0,
    startupMs: null,
    requestHistogram: latencyBounds.map(() => 0),
    deliveryHistogram: latencyBounds.map(() => 0),
    generatorCpuPercent: 0,
    generatorRssBytes: 0,
    finished: false,
    stopReason: "running",
  };
}
export function observe(histogram, ms) {
  const i = latencyBounds.findIndex((b) => ms <= b);
  histogram[i < 0 ? histogram.length - 1 : i]++;
}
export function validateOwnedTarget(value, authorized) {
  const u = new URL(value);
  if (
    !authorized ||
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error(
      "Explicitly authorize an owned HTTP(S) origin without credentials/path/query",
    );
  return u.origin;
}
