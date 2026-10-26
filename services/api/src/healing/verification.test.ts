import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RecoveryAttempt } from "@streamshield/shared";
import { Verifier, type Frame } from "./verification.js";
it.each(["api", "video", "none"])(
  "keeps independent functional baseline results when %s checks fail",
  async (failure) => {
    const dir = mkdtempSync(join(tmpdir(), "ss-functional-baseline-"));
    try {
      const file = join(dir, "targets.json");
      writeFileSync(
        file,
        JSON.stringify(
          ["api-1", "api-2", "api-gateway", "video-gateway"].map((id) => ({
            id,
            url: "http://" + id + "/health",
          })),
        ),
      );
      const v = new Verifier({ HEALER_PROBE_TIMEOUT_MS: 500 }, file);
      vi.spyOn(v, "text").mockImplementation(async (url) => {
        if (failure === "api" && url.includes("api-1"))
          throw Error("probe_timeout");
        return url.endsWith("/health")
          ? JSON.stringify({ status: "ready" })
          : JSON.stringify({ streams: [] });
      });
      vi.spyOn(v, "paths").mockResolvedValue(["live"]);
      vi.spyOn(v, "hls").mockImplementation(async () => {
        if (failure === "video") throw Error("gateway_hls_segment_invalid");
        return { ok: true, paths: 1, progressing: 1 };
      });
      expect(await v.crashBaseline()).toMatchObject({
        api: failure !== "api",
        gateway: failure !== "video",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
it("requires a live manifest and matching serving identity for edge routing evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-edge-proof-"));
  try {
    const file = join(dir, "targets.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "video-gateway", url: "http://127.0.0.1:9999/health" },
      ]),
    );
    const v = new Verifier({ HEALER_PROBE_TIMEOUT_MS: 500 }, file);
    vi.spyOn(v, "paths").mockResolvedValue(["live"]);
    const response = vi.spyOn(v, "response");
    response.mockImplementation(
      async () =>
        new Response("not video", { headers: { "x-edge-id": "edge-2" } }),
    );
    expect(await v.edgeRoute("edge-2")).toBeNull();
    response.mockImplementation(
      async () =>
        new Response("#EXTM3U\nstream.m3u8", {
          headers: { "x-edge-id": "edge-1" },
        }),
    );
    expect(await v.edgeRoute("edge-2")).toBeNull();
    response.mockImplementation(
      async () =>
        new Response("#EXTM3U\nstream.m3u8", {
          headers: { "x-edge-id": "edge-2" },
        }),
    );
    expect(await v.edgeRoute("edge-2")).toMatchObject({ edge: "edge-2" });
    expect(response).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/primary/live/index.m3u8",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it.each(["edge-1", "video-gateway"])(
  "does not verify %s media recovery with zero live paths",
  async (component) => {
    const dir = mkdtempSync(join(tmpdir(), "ss-media-verify-"));
    try {
      const file = join(dir, "targets.json");
      writeFileSync(
        file,
        JSON.stringify([
          { id: component, url: "http://127.0.0.1:9999/health" },
        ]),
      );
      const v = new Verifier({ HEALER_PROBE_TIMEOUT_MS: 500 }, file);
      vi.spyOn(v, "response").mockResolvedValue(new Response("ok"));
      vi.spyOn(v, "paths").mockResolvedValue([]);
      vi.spyOn(v, "hls").mockResolvedValue({
        ok: true,
        paths: 0,
        progressing: 0,
      });
      const r = await v.verify(
        { component } as RecoveryAttempt,
        { components: [] } as unknown as Frame,
      );
      expect(r.ok).toBe(false);
      expect(r.evidence.livePaths).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
