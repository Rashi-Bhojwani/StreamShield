import { request } from "node:http";
import { DockerControl } from "../healing/docker.js";
export class FaultDocker {
  inspector: DockerControl;
  constructor(
    project: string,
    private socket = "/var/run/docker.sock",
  ) {
    this.inspector = new DockerControl(project, socket);
  }
  async kill(target: "api-1" | "edge-1" | "origin-primary" | "redis") {
    const before = await this.inspector.inspect(target);
    if (before.state !== "running" || before.oom)
      throw Error("target_not_safely_running");
    await new Promise<void>((resolve, reject) => {
      const r = request(
        {
          socketPath: this.socket,
          path: "/v1.45/containers/" + before.id + "/kill?signal=SIGKILL",
          method: "POST",
          signal: AbortSignal.timeout(5000),
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            res.statusCode === 204
              ? resolve()
              : reject(Error("kill_unconfirmed")),
          );
        },
      );
      r.on("error", reject);
      r.end();
    });
    const after = await this.inspector.inspect(target);
    return {
      containerId: before.id,
      signal: "SIGKILL",
      killAccepted: true,
      stoppedObserved: after.state === "exited",
    };
  }
}
