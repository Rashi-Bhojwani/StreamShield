import { expect, it, vi } from "vitest";
import {
  CoalescingWriter,
  unrecordedFailures,
  acknowledgeFailures,
} from "./writer.js";
import { liveSnapshot } from "./snapshot.js";
import type { ComponentObservation } from "@streamshield/shared";
it("coalesces backlog without overlapping writes or blocking probes", async () => {
  let release!: () => void;
  const blocker = new Promise<void>((r) => (release = r)),
    values: number[] = [];
  let active = 0,
    max = 0;
  const writer = new CoalescingWriter<number>(
    async (value) => {
      active++;
      max = Math.max(max, active);
      values.push(value);
      if (value === 1) await blocker;
      active--;
    },
    () => {},
  );
  writer.offer(1);
  writer.offer(2);
  writer.offer(3);
  expect(values).toEqual([1]);
  release();
  await writer.idle();
  expect(values).toEqual([1, 3]);
  expect(max).toBe(1);
});
it("reports failed persistence, retries a later snapshot, and stops queued work", async () => {
  const failed = vi.fn(),
    write = vi
      .fn()
      .mockRejectedValueOnce(Error("SQL timeout"))
      .mockResolvedValue(undefined);
  const writer = new CoalescingWriter<number>(write, failed);
  writer.offer(1);
  await writer.idle();
  expect(failed).toHaveBeenCalledOnce();
  writer.offer(2);
  await writer.idle();
  expect(write).toHaveBeenCalledTimes(2);
  writer.stop();
  writer.offer(3);
  await writer.idle();
  expect(write).toHaveBeenCalledTimes(2);
});
it("drains an offer arriving between drain completion and its finalizer", async () => {
  const values: number[] = [];
  const writer = new CoalescingWriter<number>(
    async (value) => {
      values.push(value);
    },
    () => {},
  );
  writer.offer(1);
  await Promise.resolve();
  writer.offer(2);
  await writer.idle();
  expect(values).toEqual([1, 2]);
});
const now = Date.now(),
  c = {
    id: "api-1",
    name: "API",
    role: "api",
    group: "app",
    dependencies: [],
    state: "HEALTHY",
    observedAt: new Date(now).toISOString(),
    lastSuccessAt: new Date(now).toISOString(),
    code: "probe_ok",
    latencyMs: 1,
    failures: 0,
    successes: 2,
    firstFailureAt: null,
    detectionMs: null,
  } satisfies ComponentObservation;
const frame = {
  components: [c],
  media: [],
  mediaAvailable: false,
  lastCompleted: now,
  persistence: false,
  staleAfterMs: 12000,
};
it("preserves fresh real component health during a persistence outage with unknown incident history", () => {
  const s = liveSnapshot(frame, undefined, now);
  expect(s.components[0]!.state).toBe("HEALTHY");
  expect(s.stale).toBe(false);
  expect(s.persistence).toBe(false);
  expect(s.incidentHistoryAvailable).toBe(false);
  expect(s.observedAt).toBe(c.observedAt);
});
it.each([
  undefined,
  "bad",
  new Date(now + 1).toISOString(),
  new Date(now - 12000).toISOString(),
])("rejects missing/invalid/future/stale component observations: %s", (at) => {
  const s = liveSnapshot(
    { ...frame, components: [{ ...c, observedAt: at! }] },
    undefined,
    now,
  );
  expect(s.stale).toBe(true);
});
it("never turns a failed actual probe into a green component", () => {
  const s = liveSnapshot(
    {
      ...frame,
      components: [{ ...c, state: "UNHEALTHY", code: "probe_unreachable" }],
    },
    undefined,
    now,
  );
  expect(s.components[0]!.state).toBe("UNHEALTHY");
});

it("acknowledges a persisted episode despite newer healthy probe objects without losing a different episode", () => {
  const episode = { ...c, confirmedAt: new Date(now - 1000).toISOString() },
    pending = new Map([[c.id, { ...episode }]]),
    captured = new Map([[c.id, episode]]),
    recorded = new Map<string, string>();
  acknowledgeFailures(pending, captured, recorded);
  expect(pending.size).toBe(0);
  expect(unrecordedFailures(captured, recorded).size).toBe(0);
  const newer = { ...c, confirmedAt: new Date(now).toISOString() };
  pending.set(c.id, newer);
  acknowledgeFailures(pending, captured, recorded);
  expect(pending.get(c.id)).toBe(newer);
  expect(unrecordedFailures(pending, recorded).size).toBe(1);
});
