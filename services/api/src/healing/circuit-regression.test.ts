import { afterEach, expect, it, vi } from "vitest";
import { Circuit } from "./circuit.js";
afterEach(() => vi.useRealTimers());
it("backs off failed probes exponentially, caps the delay, and needs two real successes to close", async () => {
  const c = new Circuit(1, 1000, () => 0);
  const failed = vi.fn(async () => {
    throw Error("request timeout");
  });
  let now = 0;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    await expect(c.execute(failed, now)).rejects.toThrow(
      "dependency_unavailable",
    );
    const count = failed.mock.calls.length;
    await expect(c.execute(failed, now + delay - 1)).rejects.toThrow(
      "circuit_open",
    );
    expect(failed).toHaveBeenCalledTimes(count);
    now += delay;
  }
  const healthy = vi.fn(async () => ({ status: "available" }));
  await c.execute(healthy, now);
  expect(c.state).toBe("HALF_OPEN");
  await c.execute(healthy, now);
  expect(c.state).toBe("CLOSED");
  expect(c.snapshot().requests).toBe(10);
});
it("starts the open interval after a slow failure, not before the request", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const c = new Circuit(1, 200, () => 0);
  const failed = c.execute(async () => {
    await new Promise((r) => setTimeout(r, 300));
    throw Error("timeout");
  });
  const rejection = expect(failed).rejects.toThrow("dependency_unavailable");
  await vi.advanceTimersByTimeAsync(300);
  await rejection;
  const read = vi.fn(async () => "ok");
  await expect(c.execute(read)).rejects.toThrow("circuit_open");
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(201);
  await c.execute(read);
  await c.execute(read);
  expect(c.state).toBe("CLOSED");
});
