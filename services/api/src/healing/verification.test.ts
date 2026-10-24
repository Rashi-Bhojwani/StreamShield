import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RecoveryAttempt } from "@streamshield/shared";
import { Verifier, type Frame } from "./verification.js";
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
