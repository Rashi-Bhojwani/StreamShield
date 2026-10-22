import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerControl } from "./docker.js";

/** A fake Docker Engine API on a unix socket: only what DockerControl may call. */
function fakeDocker(initial: { state: string; oom?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "docker-"));
  const socket = join(dir, "docker.sock");
  const id = "a".repeat(64);
  const container = {
    state: initial.state,
    oom: initial.oom ?? false,
    startedAt: "2026-01-01T00:00:00Z",
  };
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    calls.push(req.method + " " + req.url);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === null ? "" : JSON.stringify(body));
    };
    if (req.url?.startsWith("/v1.45/containers/json"))
      return json(200, [{ Id: id }]);
    if (req.url === `/v1.45/containers/${id}/json`)
      return json(200, {
        State: {
          Status: container.state,
          OOMKilled: container.oom,
          ExitCode: 0,
          StartedAt: container.startedAt,
        },
        Config: {
          Labels: {
            "io.streamshield.healer.service": "api-2",
            "com.docker.compose.project": "streamshield",
          },
        },
      });
    if (req.url === `/v1.45/containers/${id}/restart?t=3`) {
      container.state = "running";
      container.startedAt = "2026-01-01T00:01:00Z";
      res.writeHead(204);
      return res.end();
    }
    if (req.url === `/v1.45/containers/${id}/start`) {
      container.state = "running";
      res.writeHead(204);
      return res.end();
    }
    json(404, { message: "not allowed" });
  });
  return new Promise<{
    docker: DockerControl;
    calls: string[];
    close: () => void;
  }>((resolve) =>
    server.listen(socket, () =>
      resolve({
        docker: new DockerControl("streamshield", socket, 2000),
        calls,
        close: () => {
          server.close();
          rmSync(dir, { recursive: true, force: true });
        },
      }),
    ),
  );
}

describe("healing-control Docker adapter", () => {
  let close = () => {};
  afterEach(() => close());
  it("restarts only a running, non-OOM container and proves a new start", async () => {
    const f = await fakeDocker({ state: "running" });
    close = f.close;
    await expect(f.docker.restart("api-2", 3)).resolves.toBe(
      "docker_restart_accepted",
    );
    expect(f.calls.filter((c) => c.includes("/restart"))).toHaveLength(1);
  });
  it.each(["exited", "paused", "created", "restarting", "dead"])(
    "rejects a restart from state %s without any mutation",
    async (state) => {
      const f = await fakeDocker({ state });
      close = f.close;
      await expect(f.docker.restart("api-2", 3)).rejects.toThrow(
        "unsafe_container_state",
      );
      expect(f.calls.every((c) => c.startsWith("GET"))).toBe(true);
    },
  );
  it("escalates an OOM-killed container instead of restarting it", async () => {
    const f = await fakeDocker({ state: "running", oom: true });
    close = f.close;
    await expect(f.docker.restart("api-2", 3)).rejects.toThrow(
      "resource_exhaustion_requires_review",
    );
    expect(f.calls.every((c) => c.startsWith("GET"))).toBe(true);
  });
  it("keeps start limited to exited containers", async () => {
    const f = await fakeDocker({ state: "running" });
    close = f.close;
    await expect(f.docker.start("api-2")).resolves.toBe(
      "already_running_no_action",
    );
    expect(f.calls.some((c) => c.includes("/start"))).toBe(false);
  });
});
