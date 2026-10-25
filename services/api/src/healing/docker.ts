import { request } from "node:http";
import { serviceNames, spares, type managed } from "./config.js";
/** No shell, exec, delete, create, arbitrary path or container-name interface. */
export class DockerControl {
  constructor(
    private project: string,
    private socket = "/var/run/docker.sock",
    private timeoutMs = 5000,
  ) {}

  private call(
    method: "GET" | "POST",
    path: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          method,
          path: "/v1.45" + path,
          timeout: this.timeoutMs,
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024)
              req.destroy(new Error("response_limit"));
            else chunks.push(chunk);
          });
          res.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString();
              resolve({
                status: res.statusCode || 500,
                body: text ? JSON.parse(text) : null,
              });
            } catch {
              reject(new Error("docker_response"));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("docker_timeout")));
      req.on("error", reject);
      req.end();
    });
  }
  async inspect(service: (typeof managed)[number], signal?: AbortSignal) {
    const name = serviceNames[service];
    const filters = new URLSearchParams({
      all: "1",
      filters: JSON.stringify({
        label: [
          "com.docker.compose.project=" + this.project,
          "com.docker.compose.service=" + name,
          "io.streamshield.healer.service=" + service,
        ],
      }),
    });
    const result = await this.call(
      "GET",
      "/containers/json?" + filters,
      signal,
    );
    if (
      result.status !== 200 ||
      !Array.isArray(result.body) ||
      result.body.length !== 1
    )
      throw new Error("service_identity_unavailable");
    const id = result.body[0].Id;
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("service_identity_invalid");
    const inspected = await this.call(
      "GET",
      "/containers/" + id + "/json",
      signal,
    );
    if (inspected.status !== 200) throw new Error("inspect_failed");
    const container = inspected.body as {
      State: {
        Status: string;
        OOMKilled: boolean;
        ExitCode?: number;
        StartedAt?: string;
        FinishedAt?: string;
        Paused?: boolean;
      };
      Config: { Labels: Record<string, string> };
      RestartCount?: number;
    };
    if (
      container.Config.Labels["io.streamshield.healer.service"] !== service ||
      container.Config.Labels["com.docker.compose.project"] !== this.project
    )
      throw new Error("service_identity_changed");
    return {
      id,
      state: container.State.Status,
      oom: container.State.OOMKilled,
      exitCode: container.State.ExitCode ?? null,
      startedAt: container.State.StartedAt ?? null,
      finishedAt: container.State.FinishedAt ?? null,
    };
  }
  /**
   * Graceful stop of the spare capacity only (SIGTERM, then SIGKILL after the
   * timeout). This is the only stop the adapter permits.
   */
  async stop(service: (typeof managed)[number], timeoutSeconds = 10) {
    if (!spares.includes(service)) throw new Error("stop_not_permitted");
    const signal = AbortSignal.timeout(this.timeoutMs + timeoutSeconds * 1000);
    const value = await this.inspect(service, signal);
    if (value.state !== "running") throw new Error("unsafe_container_state");
    const r = await this.call(
      "POST",
      "/containers/" + value.id + "/stop?t=" + timeoutSeconds,
      signal,
    );
    if (r.status !== 204) throw new Error("docker_stop_rejected");
    return "docker_stop_accepted";
  }
  /**
   * Bounded restart of an alive-but-unresponsive container: Docker sends SIGTERM,
   * waits stopTimeoutSeconds, then SIGKILL, then starts it. Only a `running`, non-OOM
   * container qualifies; anything else is rejected rather than blindly restarted.
   */
  async restart(service: (typeof managed)[number], stopTimeoutSeconds = 3) {
    const signal = AbortSignal.timeout(
      this.timeoutMs + stopTimeoutSeconds * 1000,
    );
    const value = await this.inspect(service, signal);
    if (value.oom) throw new Error("resource_exhaustion_requires_review");
    if (value.state !== "running") throw new Error("unsafe_container_state");
    const r = await this.call(
      "POST",
      "/containers/" + value.id + "/restart?t=" + stopTimeoutSeconds,
      signal,
    );
    if (r.status !== 204) throw new Error("docker_restart_rejected");
    const after = await this.inspect(service, signal);
    if (after.state !== "running" || after.startedAt === value.startedAt)
      throw new Error("restart_unconfirmed");
    return "docker_restart_accepted";
  }
  async start(service: (typeof managed)[number]) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const value = await this.inspect(service, signal);
    if (value.oom) throw new Error("resource_exhaustion_requires_review");
    if (value.state === "running") return "already_running_no_action";
    // A never-started spare is "created"; every other service must be "exited".
    const startable =
      value.state === "exited" ||
      (value.state === "created" && spares.includes(service));
    if (!startable) throw new Error("unsafe_container_state");
    const r = await this.call(
      "POST",
      "/containers/" + value.id + "/start",
      signal,
    );
    if (![204, 304].includes(r.status))
      throw new Error("docker_start_rejected");
    return r.status === 204
      ? "docker_start_accepted"
      : "already_running_no_action";
  }
}
