/**
 * Bounded traffic surge: N simulated viewers doing realistic catalogue reads
 * against the local API gateway only, for a bounded duration. The load is the
 * fault; ending it is "load ended", never a repair.
 */
export interface SurgeStats {
  users: number;
  durationMs: number;
  requests: number;
  ok: number;
  errors: number;
  limited: number;
  p95Ms: number | null;
  startedAt: string;
  endedAt: string | null;
}
const allowedHosts = ["api-gateway", "127.0.0.1", "localhost"];
export function startSurge(options: {
  url: string;
  users: number;
  durationMs: number;
  thinkMs?: number;
  fetcher?: typeof fetch;
}) {
  const target = new URL(options.url);
  if (!allowedHosts.includes(target.hostname))
    throw Error("surge_target_not_local");
  const fetcher = options.fetcher || fetch;
  const controller = new AbortController();
  const latencies: number[] = [];
  const stats: SurgeStats = {
    users: options.users,
    durationMs: options.durationMs,
    requests: 0,
    ok: 0,
    errors: 0,
    limited: 0,
    p95Ms: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  const deadline = Date.now() + options.durationMs;
  const one = async (path: string) => {
    const started = performance.now();
    stats.requests++;
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
      if (r.status === 429) stats.limited++;
      else if (r.ok) stats.ok++;
      else stats.errors++;
      return body as { streams?: { id: string }[] } | null;
    } catch {
      if (!controller.signal.aborted) stats.errors++;
      return null;
    } finally {
      if (latencies.length < 200000)
        latencies.push(performance.now() - started);
    }
  };
  const viewer = async () => {
    while (!controller.signal.aborted && Date.now() < deadline) {
      const list = await one("/api/v1/streams?limit=24");
      const id = list?.streams?.[0]?.id;
      if (id && !controller.signal.aborted)
        await one("/api/v1/streams/" + encodeURIComponent(id));
      if (options.thinkMs)
        await new Promise((r) => setTimeout(r, options.thinkMs));
    }
  };
  const done = Promise.all(
    Array.from({ length: options.users }, () => viewer()),
  ).then(() => {
    const sorted = latencies.sort((a, b) => a - b);
    stats.p95Ms = sorted.length
      ? Math.round(sorted[Math.floor(sorted.length * 0.95)]!)
      : null;
    stats.endedAt = new Date().toISOString();
    return stats;
  });
  return {
    stats,
    done,
    stop() {
      controller.abort();
      return done;
    },
  };
}
