import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { startSurge } from "./load.js";
it.each([
  { users: 0 },
  { users: 1001 },
  { users: Infinity },
  { rps: 0 },
  { rps: 1001 },
  { maxRequests: 0 },
  { maxRequests: 100001 },
  { durationMs: 120001 },
  { thinkMs: -1 },
])("rejects unsafe input before any requests: %j", (patch) => {
  const fetcher = vi.fn();
  expect(() =>
    startSurge({
      url: "http://127.0.0.1:9999",
      users: 2,
      durationMs: 100,
      ...patch,
      fetcher,
    }),
  ).toThrow("limits");
  expect(fetcher).not.toHaveBeenCalled();
});
it("enforces global rate and total count against a real local HTTP server", async () => {
  const times: number[] = [];
  const server = createServer((_q, r) => {
    times.push(performance.now());
    r.setHeader("content-type", "application/json");
    r.end('{"streams":[]}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const result = await startSurge({
      url: `http://127.0.0.1:${port}`,
      users: 8,
      durationMs: 2000,
      rps: 10,
      maxRequests: 5,
    }).done;
    expect(result.requests).toBe(5);
    expect(times.length).toBe(5);
    expect(times.at(-1)! - times[0]!).toBeGreaterThan(300);
    expect(result.ok).toBe(5);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});
it("aborts active requests and scheduled work on explicit stop", async () => {
  let seen!: () => void;
  const dispatched = new Promise<void>((r) => (seen = r));
  const fetcher = vi.fn(
    (_url, options) =>
      new Promise<Response>((_r, reject) => {
        seen();
        options!.signal!.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
  ) as unknown as typeof fetch;
  const load = startSurge({
    url: "http://localhost:9000",
    users: 8,
    durationMs: 1000,
    rps: 10,
    fetcher,
  });
  await dispatched;
  await load.stop();
  expect(load.stats.requests).toBe(1);
  expect(load.stats.endedAt).not.toBeNull();
});

it("confirms load only after a request is actually dispatched", async () => {
  const fetcher = vi.fn(async () => new Response('{"streams":[]}'));
  const load = startSurge({
    url: "http://localhost:9000",
    users: 1,
    durationMs: 1000,
    fetcher,
  });
  expect(load.stats.requests).toBe(0);
  const first = await load.started;
  expect(first).toBe(load.stats.firstRequestAt);
  expect(load.stats.requests).toBeGreaterThan(0);
  expect(fetcher).toHaveBeenCalled();
  await load.stop();
});
