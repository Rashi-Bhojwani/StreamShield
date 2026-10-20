import { request } from "node:http";
import { serviceNames, type managed } from "./config.js";
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
      State: { Status: string; OOMKilled: boolean };
      Config: { Labels: Record<string, string> };
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
    };
  }
  async start(service: (typeof managed)[number]) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const value = await this.inspect(service, signal);
    if (value.oom) throw new Error("resource_exhaustion_requires_review");
    if (value.state === "running") return "already_running_no_action";
    if (value.state !== "exited") throw new Error("unsafe_container_state");
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
