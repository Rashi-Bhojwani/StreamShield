/** Real local read traffic with one global rate budget, request cap and deadline. */
import { setMaxListeners } from "node:events";
export interface SurgeStats {
  users: number;
  durationMs: number;
  requests: number;
  ok: number;
  errors: number;
  limited: number;
  outcomes: Record<string, number>;
  p95Ms: number | null;
  startedAt: string;
  endedAt: string | null;
  firstRequestAt: string | null;
  rpsLimit: number;
  maxRequests: number;
}
export function startSurge(options: {
  url: string;
  users: number;
  durationMs: number;
  thinkMs?: number;
  rps?: number;
  maxRequests?: number;
  fetcher?: typeof fetch;
}) {
  const target = new URL(options.url);
  if (
    !["api-gateway", "127.0.0.1", "localhost"].includes(target.hostname) ||
    target.protocol !== "http:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== "/"
  )
    throw Error("surge_target_not_local");
  const rps = options.rps ?? 50,
    maxRequests = options.maxRequests ?? 3000,
    thinkMs = options.thinkMs ?? 0;
  for (const [value, min, max] of [
    [options.users, 1, 1000],
    [options.durationMs, 1, 120000],
    [rps, 1, 1000],
    [maxRequests, 1, 100000],
    [thinkMs, 0, 5000],
  ])
    if (!Number.isInteger(value) || value! < min! || value! > max!)
      throw Error("surge_limits_invalid");
  const fetcher = options.fetcher || fetch,
    controller = new AbortController();
  setMaxListeners(options.users + 5, controller.signal);
  const latencies: number[] = [];
  const stats: SurgeStats = {
    users: options.users,
    durationMs: options.durationMs,
    requests: 0,
    ok: 0,
    errors: 0,
    limited: 0,
    outcomes: {},
    p95Ms: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    firstRequestAt: null,
    rpsLimit: rps,
    maxRequests,
  };
  let confirmStarted!: (at: string | null) => void;
  const started = new Promise<string | null>((resolve) => {
    confirmStarted = resolve;
  });
  const deadline = performance.now() + options.durationMs;
  let reserved = 0,
    nextSlot = performance.now();
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      controller.signal.addEventListener("abort", done, { once: true });
      if (controller.signal.aborted) done();
    });
  const timer = setTimeout(() => controller.abort(), options.durationMs);
  const one = async (path: string) => {
    if (controller.signal.aborted || reserved >= maxRequests) return null;
    const slot = Math.max(nextSlot, performance.now());
    if (slot >= deadline) return null;
    reserved++;
    nextSlot = slot + 1000 / rps;
    await pause(slot - performance.now());
    if (controller.signal.aborted || performance.now() >= deadline) return null;
    const started = performance.now();
    stats.requests++;
    if (!stats.firstRequestAt) {
      stats.firstRequestAt = new Date().toISOString();
      confirmStarted(stats.firstRequestAt);
    }
    try {
      const r = await fetcher(new URL(path, target).href, {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
        redirect: "error",
      });
      const body = r.ok
        ? await r.json().catch(() => null)
        : await r.body?.cancel();
      stats.outcomes[r.status] = (stats.outcomes[r.status] || 0) + 1;
      if (r.status === 429) stats.limited++;
      else if (r.ok) stats.ok++;
      else stats.errors++;
      return r.ok ? (body as { streams?: { id: string }[] } | null) : null;
    } catch (error) {
      if (!controller.signal.aborted) {
        stats.errors++;
        const kind =
          error instanceof DOMException && error.name === "TimeoutError"
            ? "timeout"
            : "network";
        stats.outcomes[kind] = (stats.outcomes[kind] || 0) + 1;
      }
      return null;
    } finally {
      if (latencies.length < maxRequests)
        latencies.push(performance.now() - started);
    }
  };
  const viewer = async () => {
    while (
      !controller.signal.aborted &&
      performance.now() < deadline &&
      reserved < maxRequests
    ) {
      const list = await one("/api/v1/streams?limit=24"),
        id = list?.streams?.[0]?.id;
      if (id && !controller.signal.aborted)
        await one("/api/v1/streams/" + encodeURIComponent(id));
      else if (!list) await pause(250);
      if (thinkMs) await pause(thinkMs);
    }
  };
  const done = Promise.all(
    Array.from({ length: options.users }, () => viewer()),
  )
    .then(() => {
      const sorted = latencies.sort((a, b) => a - b);
      stats.p95Ms = sorted.length
        ? Math.round(
            sorted[
              Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
            ]!,
          )
        : null;
      stats.endedAt = new Date().toISOString();
      return stats;
    })
    .finally(() => {
      clearTimeout(timer);
      if (!stats.firstRequestAt) confirmStarted(null);
    });
  return {
    stats,
    started,
    done,
    stop() {
      controller.abort();
      return done;
    },
  };
}
