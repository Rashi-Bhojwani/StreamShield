import { describe, it, expect } from "vitest";
import {
  capacityConfig,
  capacityReport,
  demoSlots,
  demoIdentity,
  latencyBounds,
  type CapacityReport,
} from "@streamshield/shared";
import { percentile, summarize } from "./capacity.js";
const config = {
  profile: "api",
  clients: 100,
  duration: 30,
  ramp: 5,
  distributed: false,
  chatPerSecond: 2,
  target: "http://localhost:5173",
};
function report(patch: Partial<CapacityReport> = {}): CapacityReport {
  return capacityReport.parse({
    seq: 1,
    active: 10,
    peak: 10,
    requests: 10,
    errors: 0,
    bytes: 1000,
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
    requestHistogram: latencyBounds.map((_, i) => (i === 3 ? 10 : 0)),
    deliveryHistogram: latencyBounds.map(() => 0),
    generatorCpuPercent: 10,
    generatorRssBytes: 1000000,
    finished: false,
    stopReason: "running",
    ...patch,
  });
}
const now = Date.parse("2026-10-21T00:00:10Z");
const run = {
  id: crypto.randomUUID(),
  profile: "api" as const,
  target_clients: 100,
  target_origin: "http://localhost:5173",
  state: "RUNNING",
  created_at: new Date(now - 10000),
  expires_at: new Date(now + 60000),
  distributed: false,
  duration_seconds: 30,
  chat_per_second: 2,
};
describe("owned-target capacity boundaries", () => {
  it("uses exactly three stable independent channel and stream identities", () => {
    expect(demoSlots).toHaveLength(3);
    expect(new Set(demoSlots.map((n) => demoIdentity(n).streamId)).size).toBe(
      3,
    );
    expect(demoSlots.map((n) => demoIdentity(n).slug)).toEqual([
      "streamer-1",
      "streamer-2",
      "streamer-3",
    ]);
  });
  it("rejects 50k local clients and accepts only the explicitly distributed target", () => {
    expect(
      capacityConfig.safeParse({ ...config, clients: 50000 }).success,
    ).toBe(false);
    expect(
      capacityConfig.parse({ ...config, clients: 50000, distributed: true })
        .clients,
    ).toBe(50000);
    expect(
      capacityConfig.safeParse({ ...config, clients: 50001, distributed: true })
        .success,
    ).toBe(false);
  });
  it.each([
    "https://name:password@example.com",
    "file:///etc/passwd",
    "http://localhost:5173/private",
    "http://localhost:5173?token=value",
  ])("rejects unsafe/non-origin target %s", (target) =>
    expect(capacityConfig.safeParse({ ...config, target }).success).toBe(false),
  );
  it("caps browser sessions, run duration, ramp and chat volume", () => {
    for (const patch of [
      { profile: "browser", clients: 13 },
      { duration: 901 },
      { ramp: 0 },
      { chatPerSecond: 101 },
    ])
      expect(capacityConfig.safeParse({ ...config, ...patch }).success).toBe(
        false,
      );
  });
  it("rejects arbitrary report fields and non-finite/unbounded counts", () => {
    expect(capacityReport.safeParse({ ...report(), admin: true }).success).toBe(
      false,
    );
    expect(
      capacityReport.safeParse({ ...report(), active: 50000 }).success,
    ).toBe(false);
    expect(
      capacityReport.safeParse({ ...report(), bytes: Infinity }).success,
    ).toBe(false);
  });
});
describe("truthful distributed aggregation", () => {
  it("freezes historical rates at the actual run completion time", () => {
    const value = summarize(
      { ...run, state: "COMPLETED", stopped_at: new Date(now - 5000) },
      [
        {
          id: "a",
          clients: 100,
          updated_at: new Date(now - 5000),
          report: report({ active: 0, finished: true }),
          finished: true,
        },
      ],
      [],
      now + 10000,
    );
    expect(value.requestsPerSecond).toBe(2);
  });
  it("does not infer stopped public traffic from an expired missing generator", () => {
    const value = summarize(
      { ...run, expires_at: new Date(now - 1) },
      [
        {
          id: "a",
          clients: 100,
          updated_at: new Date(now - 30000),
          report: report(),
          finished: false,
        },
      ],
      [],
      now,
    );
    expect(value.actualActive).toBeNull();
  });
  it("merges histogram counts rather than averaging percentiles", () => {
    const a = report(),
      b = report({
        requestHistogram: latencyBounds.map((_, i) => (i === 9 ? 100 : 0)),
        requests: 100,
      });
    const value = summarize(
      run,
      [
        {
          id: "a",
          clients: 50,
          updated_at: new Date(now),
          report: a,
          finished: false,
        },
        {
          id: "b",
          clients: 50,
          updated_at: new Date(now),
          report: b,
          finished: false,
        },
      ],
      [],
      now,
    );
    expect(value.actualActive).toBe(20);
    expect(value.targetClients).toBe(100);
    expect(value.p50Ms).toBe(512);
    expect(value.p95Ms).toBe(512);
    expect(value.requests).toBe(110);
    expect(value.requestsPerSecond).toBe(11);
    expect(value.verifiedBrowsers).toBeNull();
  });
  it("never substitutes the requested target for achieved active clients", () => {
    const value = summarize(run, [], [], now);
    expect(value.actualActive).toBe(0);
    expect(value.peakReported).toBe(0);
    expect(value.p95Ms).toBeNull();
  });
  it("marks current activity unknown when any worker lease is stale", () => {
    const value = summarize(
      run,
      [
        {
          id: "a",
          clients: 100,
          updated_at: new Date(now - 11000),
          report: report(),
          finished: false,
        },
      ],
      [],
      now,
    );
    expect(value.actualActive).toBeNull();
    expect(value.staleWorkers).toBe(1);
    expect(value.requests).toBe(10);
  });
  it("does not sum unrelated worker peak concurrency", () => {
    const workers = ["a", "b"].map((id) => ({
      id,
      clients: 50,
      updated_at: new Date(now),
      report: report({ active: 2, peak: 50 }),
      finished: false,
    }));
    expect(
      summarize(
        run,
        workers,
        [
          {
            at: new Date(now - 5000).toISOString(),
            active: 30,
            rps: 2,
            errors: 0,
          },
        ],
        now,
      ).peakReported,
    ).toBe(30);
  });
  it("keeps finished evidence and zeroes active work after deadline", () => {
    const value = summarize(
      { ...run, expires_at: new Date(now - 1) },
      [
        {
          id: "a",
          clients: 100,
          updated_at: new Date(now - 30000),
          report: report({ active: 0, finished: true }),
          finished: true,
        },
      ],
      [],
      now,
    );
    expect(value.state).toBe("EXPIRED");
    expect(value.actualActive).toBe(0);
    expect(value.requests).toBe(10);
  });
  it("leaves empty latency measurements null", () =>
    expect(
      percentile(
        latencyBounds.map(() => 0),
        0.95,
      ),
    ).toBeNull());
});
