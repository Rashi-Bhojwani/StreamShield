import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
export function resourceGuard(clients, profile) {
  if (
    !Number.isInteger(clients) ||
    clients < 1 ||
    clients > 1000 ||
    (profile === "browser" && clients > 12)
  )
    throw Error(
      "Per-generator cap: 1–1000 clients; decoded browsers <=12. Use separate distributed workers, never bypass this guard.",
    );
  let available = process.availableMemory();
  try {
    const max = Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8")),
      used = Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8"));
    if (Number.isFinite(max)) available = Math.min(available, max - used);
  } catch {
    /* Non-Linux: Node's actual available-memory estimate. */
  }
  const required =
    256 * 1048576 +
    clients *
      (profile === "browser"
        ? 192 * 1048576
        : profile === "hls"
          ? 1048576
          : 262144);
  if (available < required)
    throw Error(
      `Insufficient generator memory: ${Math.round(available / 1048576)} MiB available; ${Math.ceil(required / 1048576)} MiB required`,
    );
  try {
    const soft = readFileSync("/proc/self/limits", "utf8").match(
      /^Max open files\s+(\d+)/m,
    )?.[1];
    if (soft && Number(soft) < clients * 3 + 256)
      throw Error(
        "Insufficient open-file limit; provision a suitable distributed generator",
      );
  } catch (e) {
    if (e.message.startsWith("Insufficient")) throw e;
  }
  return {
    availableMemoryBytes: available,
    estimatedRequiredBytes: required,
    cpuCount: availableParallelism(),
  };
}
