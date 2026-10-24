import { afterEach, expect, it, vi } from "vitest";
import { Circuit } from "./circuit.js";
afterEach(() => vi.useRealTimers());
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
