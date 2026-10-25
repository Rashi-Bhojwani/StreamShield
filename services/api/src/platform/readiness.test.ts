import { afterEach, expect, it, vi } from "vitest";
import type { Resources } from "./resources.js";
import { createReadiness } from "./readiness.js";
afterEach(() => vi.useRealTimers());
function fixture() {
  return {
    db: { query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }) },
    redis: { isReady: true, ping: vi.fn().mockResolvedValue("PONG") },
    pub: { isReady: true },
    sub: { isReady: true },
  };
}
it("requires real SQL and Redis PING without widening HTTP deadlines", async () => {
  const r = fixture(),
    ready = createReadiness(r as unknown as Resources);
  expect(await ready()).toBe(true);
  expect(r.db.query).toHaveBeenCalledWith("SELECT 1");
  expect(r.redis.ping).toHaveBeenCalledOnce();
});
it.each(["redis", "pub", "sub"] as const)(
  "does not report readiness when %s is disconnected",
  async (name) => {
    const r = fixture();
    r[name].isReady = false;
    expect(await createReadiness(r as unknown as Resources)()).toBe(false);
    expect(r.db.query).not.toHaveBeenCalled();
  },
);
it("fails closed on SQL and PING errors", async () => {
  for (const kind of ["sql", "redis"]) {
    const r = fixture();
    if (kind === "sql") r.db.query.mockRejectedValue(Error("timeout"));
    else r.redis.ping.mockResolvedValue("not PONG");
    expect(await createReadiness(r as unknown as Resources)()).toBe(false);
  }
});
it("coalesces concurrent probes, returns within budget, and never queues more SQL while a timed-out probe is pending", async () => {
  vi.useFakeTimers();
  let release!: (value: unknown) => void;
  const r = fixture();
  r.db.query.mockReturnValue(new Promise((resolve) => (release = resolve)));
  const ready = createReadiness(r as unknown as Resources, 750, 250),
    responses = Promise.all([ready(), ready(), ready()]);
  await vi.advanceTimersByTimeAsync(751);
  expect(await responses).toEqual([false, false, false]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await ready()).toBe(false);
  expect(r.db.query).toHaveBeenCalledOnce();
  release({ rows: [{}] });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await ready()).toBe(true);
  expect(r.db.query).toHaveBeenCalledTimes(2);
});
it("does not report healthy if a required connection closes while SQL is in flight", async () => {
  let release!: (value: unknown) => void;
  const r = fixture();
  r.db.query.mockReturnValue(new Promise((resolve) => (release = resolve)));
  const pending = createReadiness(r as unknown as Resources)();
  r.sub.isReady = false;
  release({ rows: [{}] });
  expect(await pending).toBe(false);
});
