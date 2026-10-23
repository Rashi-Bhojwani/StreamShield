import { describe, expect, it } from "vitest";
import type { ChaosExperiment, RecoveryAttempt } from "@streamshield/shared";
import { availability, buildTimeline, overallTone } from "./timeline";

const at = (s: number) =>
  new Date(Date.UTC(2026, 9, 22, 12, 0, s)).toISOString();
const attempt = (o: Partial<RecoveryAttempt>) =>
  ({
    id: "a1",
    component: "redis",
    playbook: "redis-start",
    state: "VERIFIED",
    reason: "independent_behavior_verified",
    actionStartedAt: at(14),
    finishedAt: at(23),
    ...o,
  }) as RecoveryAttempt;
const experiment = {
  id: "e1",
  scenario: "crash-redis",
  target: "redis",
  state: "COMPLETED",
  injectedAt: at(10),
  incidentDetectedAt: at(13),
  actionStartedAt: at(14),
  verifiedAt: at(25),
  finishedAt: at(25),
} as ChaosExperiment;
describe("health timeline from persisted evidence", () => {
  const timeline = buildTimeline({
    from: at(0),
    to: at(120),
    changes: [
      { component: "redis", state: "HEALTHY", code: "probe_ok", at: at(-30) },
      {
        component: "redis",
        state: "DEGRADED",
        code: "probe_unreachable",
        at: at(11),
      },
      {
        component: "redis",
        state: "UNHEALTHY",
        code: "probe_unreachable",
        at: at(13),
      },
      { component: "redis", state: "HEALTHY", code: "probe_ok", at: at(20) },
      { component: "postgres", state: "HEALTHY", code: "probe_ok", at: at(5) },
    ],
    attempts: [attempt({})],
    experiments: [experiment],
  });
  const redis = timeline.components.find((c) => c.id === "redis")!.segments;
  it("orders green, amber, red, blue, verified, green with exact boundaries", () => {
    expect(redis.map((s) => s.tone)).toEqual([
      "healthy",
      "degraded",
      "failed",
      "healing",
      "recovered",
      "healthy",
    ]);
    expect(redis.map((s) => s.from)).toEqual([
      at(0),
      at(11),
      at(13),
      at(14),
      at(23),
      at(53),
    ]);
    expect(redis.find((s) => s.tone === "failed")?.code).toBe(
      "probe_unreachable",
    );
  });
  it("reports durations that equal the stored timestamps", () => {
    for (const s of [...redis, ...timeline.overall])
      expect(s.durationMs).toBe(Date.parse(s.to) - Date.parse(s.from));
    expect(redis.find((s) => s.tone === "healing")?.durationMs).toBe(9000);
    const total = redis.reduce((n, s) => n + s.durationMs, 0);
    expect(total).toBe(120000);
  });
  it("shows time without evidence as unknown, never green", () => {
    const pg = timeline.components.find((c) => c.id === "postgres")!.segments;
    expect(pg[0]).toMatchObject({ tone: "unknown", from: at(0), to: at(5) });
  });
  it("emits injection, detection, action and verification markers from the experiment", () => {
    expect(timeline.events.map((e) => [e.kind, e.at])).toEqual([
      ["injected", at(10)],
      ["detected", at(13)],
      ["action", at(14)],
      ["verified", at(25)],
    ]);
  });
  it("marks an escalated attempt purple until the component is next healthy", () => {
    const t2 = buildTimeline({
      from: at(0),
      to: at(60),
      changes: [
        { component: "api-2", state: "HEALTHY", code: "probe_ok", at: at(0) },
        {
          component: "api-2",
          state: "UNHEALTHY",
          code: "probe_unreachable",
          at: at(10),
        },
        { component: "api-2", state: "HEALTHY", code: "probe_ok", at: at(40) },
      ],
      attempts: [
        attempt({
          component: "api-2",
          state: "ESCALATED",
          reason: "budget_exhausted",
          actionStartedAt: null,
          finishedAt: at(12),
        }),
      ],
      experiments: [],
    });
    expect(t2.components[0]!.segments.map((s) => s.tone)).toEqual([
      "healthy",
      "failed",
      "escalated",
      "healthy",
    ]);
    expect(t2.events[0]).toMatchObject({ kind: "escalated", at: at(12) });
  });
  it("treats one failed redundant peer as degraded overall, both as failed", () => {
    expect(overallTone({ "api-1": "failed", "api-2": "healthy" })).toBe(
      "degraded",
    );
    expect(overallTone({ "api-1": "failed", "api-2": "failed" })).toBe(
      "failed",
    );
    expect(overallTone({ redis: "failed", "api-1": "healthy" })).toBe("failed");
    expect(overallTone({ redis: "healing", "api-1": "healthy" })).toBe(
      "healing",
    );
  });
  it("computes availability over observed time only", () => {
    expect(
      availability([
        {
          tone: "unknown",
          from: at(0),
          to: at(10),
          durationMs: 10000,
          code: null,
        },
        {
          tone: "healthy",
          from: at(10),
          to: at(40),
          durationMs: 30000,
          code: null,
        },
        {
          tone: "failed",
          from: at(40),
          to: at(50),
          durationMs: 10000,
          code: null,
        },
      ]),
    ).toBe(0.75);
  });
});
