import { beforeEach, describe, expect, it } from "vitest";
import {
  getTelemetry,
  recordFailure,
  recordResponse,
  recordTimeout,
  resetTelemetry,
} from "./telemetry";
describe("browser request telemetry", () => {
  beforeEach(() => resetTelemetry());
  it("records the real serving instance and latency", () => {
    recordResponse(200, "api-1", 41.6, 1000);
    recordResponse(200, "api-2", 12, 2000);
    expect(getTelemetry()).toMatchObject({
      servedBy: "api-2",
      latencyMs: 12,
      failures: 0,
      outageSince: null,
    });
    expect(getTelemetry().recent.map((r) => r.instance)).toEqual([
      "api-1",
      "api-2",
    ]);
  });
  it("treats an HTTP answer as reachable and 502/503/504 or a network error as an outage", () => {
    recordResponse(404, "api-1", 5, 1000);
    expect(getTelemetry().outageSince).toBeNull();
    recordResponse(502, null, 5, 2000);
    expect(getTelemetry()).toMatchObject({ failures: 1, outageSince: 2000 });
    recordFailure(3000);
    expect(getTelemetry()).toMatchObject({ failures: 2, outageSince: 2000 });
    recordResponse(200, "api-1", 20, 4000);
    expect(getTelemetry()).toMatchObject({ failures: 0, outageSince: null });
  });
  it("shows a hang as slowness first and an outage only after repeated timeouts", () => {
    recordTimeout(12000, 1000);
    recordTimeout(12000, 2000);
    expect(getTelemetry()).toMatchObject({
      latencyMs: 12000,
      slow: 2,
      outageSince: null,
    });
    recordTimeout(12000, 3000);
    expect(getTelemetry().outageSince).toBe(3000);
  });
  it("forgets instances that have not answered for 30 s", () => {
    recordResponse(200, "api-1", 5, 1000);
    recordResponse(200, "api-2", 5, 40000);
    expect(getTelemetry().recent.map((r) => r.instance)).toEqual(["api-2"]);
  });
});
