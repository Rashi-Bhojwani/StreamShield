import { request } from "node:http";
import { DockerControl } from "../healing/docker.js";
/** Components a crash fault may SIGKILL. postgres and every volume are absent. */
export const killable = [
  "api-1",
  "api-2",
  "edge-1",
  "origin-primary",
  "redis",
  "video-gateway",
  "relay",
] as const;
/** Components a hang fault may freeze. Only an API with a serving peer. */
export const freezable = ["api-2"] as const;
type Killable = (typeof killable)[number];
/**
 * Fault side only. There is deliberately no start, restart, unpause or SIGCONT
 * here: once injected, only the independent Healer can repair the target.
 */
export class FaultDocker {
  inspector: DockerControl;
  constructor(
    project: string,
    private socket = "/var/run/docker.sock",
  ) {
    this.inspector = new DockerControl(project, socket);
  }
  private signal(id: string, signal: "SIGKILL" | "SIGTSTP") {
    return new Promise<void>((resolve, reject) => {
      const r = request(
        {
          socketPath: this.socket,
          path: "/v1.45/containers/" + id + "/kill?signal=" + signal,
          method: "POST",
          signal: AbortSignal.timeout(5000),
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            res.statusCode === 204
              ? resolve()
              : reject(Error("signal_unconfirmed")),
          );
        },
      );
      r.on("error", reject);
      r.end();
    });
  }
  async kill(target: Killable) {
    if (!(killable as readonly string[]).includes(target))
      throw Error("target_not_allowlisted");
    const before = await this.inspector.inspect(target);
    if (before.state !== "running" || before.oom)
      throw Error("target_not_safely_running");
    await this.signal(before.id, "SIGKILL");
    const after = await this.inspector.inspect(target);
    return {
      signal: "SIGKILL",
      killAccepted: true,
      stoppedObserved: after.state === "exited",
      exitCode: after.exitCode,
    };
  }
  /**
   * tini is PID 1 and ignores SIGSTOP for its child; SIGTSTP is forwarded to Node,
   * whose default action stops the process. The container keeps reporting
   * `running` while the API no longer answers (verified empirically).
   */
  async freeze(target: (typeof freezable)[number]) {
    if (!(freezable as readonly string[]).includes(target))
      throw Error("target_not_allowlisted");
    const before = await this.inspector.inspect(target);
    if (before.state !== "running" || before.oom)
      throw Error("target_not_safely_running");
    await this.signal(before.id, "SIGTSTP");
    const after = await this.inspector.inspect(target);
    return {
      signal: "SIGTSTP",
      freezeAccepted: true,
      runningObserved: after.state === "running",
      startedAtUnchanged: after.startedAt === before.startedAt,
    };
  }
}
