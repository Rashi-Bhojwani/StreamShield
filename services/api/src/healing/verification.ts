import { readFileSync } from "node:fs";
import { z } from "zod";
import type {
  ComponentObservation,
  MediaObservation,
  RecoveryAttempt,
} from "@streamshield/shared";
import type { HealingConfig } from "./config.js";
export interface Frame {
  components: ComponentObservation[];
  media: MediaObservation[];
  mediaAvailable: boolean;
  lastCompleted: number;
  persistence: boolean;
}
const frameSchema = z.object({
  components: z
    .array(
      z
        .object({
          id: z.string().max(40),
          state: z.enum([
            "HEALTHY",
            "DEGRADED",
            "UNHEALTHY",
            "UNKNOWN",
            "RECOVERING",
          ]),
          observedAt: z.iso.datetime(),
          code: z.string(),
          confirmedAt: z.iso.datetime().nullable().optional(),
          firstFailureAt: z.iso.datetime().nullable(),
          failures: z.number(),
          successes: z.number(),
        })
        .passthrough(),
    )
    .max(20),
  media: z
    .array(
      z.object({
        path: z.string().max(100),
        publisher: z.boolean(),
        checkedAt: z.iso.datetime(),
        sources: z
          .array(
            z.object({
              id: z.enum(["primary", "standby"]),
              manifest: z.boolean(),
              segment: z.boolean(),
              fresh: z.boolean().nullable(),
              code: z.string(),
            }),
          )
          .max(2),
      }),
    )
    .max(5),
  mediaAvailable: z.boolean(),
  lastCompleted: z.number(),
  persistence: z.boolean(),
});
export class Verifier {
  targets: { id: string; url?: string }[];
  private segments = new Map<
    string,
    { uri: string; at: number; advanced: boolean }
  >();
  constructor(
    private c: HealingConfig,
    file = process.env.OBS_TARGETS_FILE || "/config/targets.json",
  ) {
    this.targets = z
      .array(z.object({ id: z.string(), url: z.string().url().optional() }))
      .max(20)
      .parse(JSON.parse(readFileSync(file, "utf8")));
  }
  url(id: string, path?: string) {
    const target = this.targets.find((x) => x.id === id)?.url;
    if (!target) throw new Error("target_unavailable");
    return path ? new URL(path, target).href : target;
  }
  async response(url: string, headers: Record<string, string> = {}) {
    const r = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(this.c.HEALER_PROBE_TIMEOUT_MS),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error("verification_http");
    }
    return r;
  }
  async text(url: string, headers: Record<string, string> = {}) {
    const r = await this.response(url, headers);
    const reader = r.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2 * 1024 * 1024) throw new Error("verification_size");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  async frame(): Promise<Frame> {
    const raw = JSON.parse(
      await this.text(process.env.OBS_URL + "/observations", {
        Authorization: "Bearer " + process.env.OBS_SECRET,
      }),
    );
    const f = frameSchema.parse(raw) as unknown as Frame;
    if (
      Date.now() - f.lastCompleted >
      Number(process.env.OBS_STALE_MS || 12000)
    )
      throw new Error("observer_stale");
    return f;
  }
  private mediaHeaders() {
    return {
      Authorization:
        "Basic " +
        Buffer.from(
          process.env.MEDIA_API_USER + ":" + process.env.MEDIA_API_PASSWORD,
        ).toString("base64"),
    };
  }
  async paths() {
    const body = JSON.parse(
      await this.text(this.url("relay"), this.mediaHeaders()),
    );
    const parsed = z
      .object({
        items: z
          .array(
            z.object({
              name: z.string(),
              online: z.boolean().optional(),
              ready: z.boolean().optional(),
              source: z.unknown().optional(),
            }),
          )
          .max(1000),
      })
      .parse(body);
    const paths = parsed.items
      .filter((p) => (p.online || p.ready) && p.source)
      .map((p) => p.name)
      .filter(
        (p) =>
          /^(live|s-[a-f0-9]{32})$/.test(p) ||
          p === process.env.MEDIA_STREAM_PATH,
      );
    if (paths.length > 5)
      throw new Error("media_verification_capacity_exceeded");
    return paths;
  }
  async hls(component: string, paths: string[], source = "primary") {
    let good = 0;
    for (const path of paths) {
      const root = new URL(this.url(component));
      root.pathname = component.startsWith("edge-")
        ? "/" + source + "/" + path + "/"
        : "/" + path + "/";
      if (!component.startsWith("edge-"))
        root.port = process.env.MEDIA_HLS_PORT!;
      const headers: Record<string, string> = component.startsWith("edge-")
        ? {}
        : { Authorization: "Bearer " + process.env.RESILIENCE_HLS_SECRET };
      const master = await this.text(new URL("index.m3u8", root).href, headers);
      if (!master.startsWith("#EXTM3U")) throw new Error("master_invalid");
      const next = master
        .split("\n")
        .find((l) => l.trim() && !l.startsWith("#"));
      if (!next) throw new Error("variant_missing");
      const variant = new URL(next.trim(), root);
      this.safe(variant, root);
      const playlist = await this.text(variant.href, headers);
      if (!playlist.startsWith("#EXTM3U")) throw new Error("playlist_invalid");
      const last = playlist
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"))
        .at(-1);
      if (!last) throw new Error("segment_missing");
      const segment = new URL(last.trim(), variant);
      this.safe(segment, root);
      if (!(await this.text(segment.href, headers)).length)
        throw new Error("segment_empty");
      const key = component + ":" + source + ":" + path,
        old = this.segments.get(key),
        now = Date.now();
      const value =
        !old || old.uri !== segment.pathname
          ? { uri: segment.pathname, at: now, advanced: !!old }
          : old;
      this.segments.set(key, value);
      if (value.advanced && now - value.at < 15000) good++;
    }
    if (this.segments.size > 100) this.segments.clear();
    return {
      ok: good === paths.length,
      paths: paths.length,
      progressing: good,
    };
  }
  private safe(value: URL, root: URL) {
    if (
      value.origin !== root.origin ||
      !value.pathname.startsWith(root.pathname)
    )
      throw new Error("unsafe_media_reference");
  }
  async standbySafe() {
    const paths = await this.paths();
    return (await this.hls("origin-standby", paths, "standby")).ok;
  }
  async verify(a: RecoveryAttempt, frame: Frame) {
    const evidence: RecoveryAttempt["evidence"] = {
      browserPlaybackVerified: false,
    };
    if (a.component.startsWith("api-")) {
      const ready = JSON.parse(await this.text(this.url(a.component)));
      if (ready.status !== "ready") return { ok: false, evidence };
      const streams = JSON.parse(
        await this.text(this.url(a.component, "/api/v1/streams")),
      );
      if (!Array.isArray(streams.streams)) return { ok: false, evidence };
      const counts = async () =>
        Promise.all(
          ["api-1", "api-2"].map(async (id) => {
            const u = new URL(this.url(id));
            u.port = process.env.API_INTERNAL_PORT!;
            u.pathname = "/metrics";
            return (
              await this.text(u.href, {
                Authorization: "Bearer " + process.env.OBS_SECRET,
              })
            )
              .split("\n")
              .filter(
                (l) =>
                  l.startsWith("streamshield_http_requests_total{") &&
                  l.includes('route="/streams"') &&
                  l.includes('category="2xx"'),
              )
              .reduce(
                (sum, l) => sum + Number(l.slice(l.lastIndexOf(" ") + 1)),
                0,
              );
          }),
        );
      const before = await counts();
      for (let i = 0; i < 8; i++) {
        const b = JSON.parse(
          await this.text(this.url("api-gateway", "/api/v1/streams")),
        );
        if (!Array.isArray(b.streams)) return { ok: false, evidence };
      }
      const after = await counts();
      evidence.gatewayBothAPIs = after.every((n, i) => n > before[i]!);
      evidence.applicationReadVerified = true;
      return { ok: evidence.gatewayBothAPIs === true, evidence };
    }
    if (a.component.startsWith("edge-") || a.component === "origin-primary") {
      const r = await this.response(
        this.url(a.component),
        a.component.startsWith("origin") ? this.mediaHeaders() : {},
      );
      await r.body?.cancel();
      const paths = await this.paths();
      const result = await this.hls(a.component, paths);
      evidence.livePaths = paths.length;
      evidence.progressingPaths = result.progressing;
      evidence.mediaVerification = paths.length
        ? "authorized_segment_progression"
        : "idle_no_playback_claim";
      return { ok: result.ok, evidence };
    }
    if (a.component === "redis") {
      const good = ["redis", "api-1", "api-2"].every(
        (id) => frame.components.find((x) => x.id === id)?.state === "HEALTHY",
      );
      return {
        ok: good,
        evidence: { ...evidence, authenticatedPingAndAPIs: good },
      };
    }
    return { ok: false, evidence };
  }
}
