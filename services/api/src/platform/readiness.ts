import type { Resources } from "./resources.js";
/** One real dependency probe at a time. A slow SQL operation cannot hold HTTP
 * readiness beyond its budget or spawn a queue of replacement health queries. */
export function createReadiness(
  r: Pick<Resources, "db" | "redis" | "pub" | "sub">,
  timeoutMs = 750,
  cacheMs = 250,
) {
  let work: Promise<boolean> | null = null;
  let response: Promise<boolean> | null = null;
  let cached = false,
    expires = 0;
  return async () => {
    if (performance.now() < expires) return cached;
    if (response) return response;
    if (work) return false;
    if (![r.redis, r.pub, r.sub].every((c) => c.isReady)) return false;
    work = Promise.all([r.db.query("SELECT 1"), r.redis.ping()])
      .then(
        ([, ping]) =>
          ping === "PONG" && [r.redis, r.pub, r.sub].every((c) => c.isReady),
      )
      .catch(() => false);
    void work.finally(() => {
      work = null;
    });
    let timer: ReturnType<typeof setTimeout>;
    response = Promise.race([
      work,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ])
      .then((ok) => {
        cached = ok;
        expires = performance.now() + cacheMs;
        return ok;
      })
      .finally(() => {
        clearTimeout(timer);
        response = null;
      });
    return response;
  };
}
