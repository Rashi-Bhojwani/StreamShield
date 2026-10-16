import { z } from "zod";
import type { Stream } from "@streamshield/shared";
import type { Config } from "./config.js";

// v1.21 uses online/available. Do not infer availability from HTTP success alone.
const pathSchema = z.object({
  name: z.string(),
  online: z.boolean(),
  available: z.boolean(),
  tracks: z.array(z.string()),
});
export function createMediaService(
  config: Config,
  fetcher: typeof fetch = fetch,
) {
  let cached: Stream | undefined;
  let expires = 0;
  let inflight: Promise<Stream> | undefined;
  const observe = async (): Promise<Stream> => {
    const result: Stream = {
      id: config.MEDIA_STREAM_PATH,
      title: config.MEDIA_STREAM_TITLE,
      status: "unavailable",
      publisher: "unknown",
      hls: "not_checked",
      reason: "origin_unreachable",
      checkedAt: new Date().toISOString(),
      playbackUrl: `${config.MEDIA_PUBLIC_HLS_BASE_URL.replace(/\/$/, "")}/${config.MEDIA_STREAM_PATH}/index.m3u8`,
      tracks: [],
    };
    const signal = AbortSignal.timeout(config.MEDIA_PROBE_TIMEOUT_MS);
    try {
      const response = await fetcher(
        `${config.MEDIA_API_BASE_URL.replace(/\/$/, "")}/v3/paths/get/${config.MEDIA_STREAM_PATH}`,
        {
          signal,
          redirect: "error",
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(
                config.MEDIA_API_USER + ":" + config.MEDIA_API_PASSWORD,
              ).toString("base64"),
          },
        },
      );
      if (response.status === 404) {
        await response.body?.cancel();
        return {
          ...result,
          status: "offline",
          publisher: "offline",
          reason: "publisher_absent",
        };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { ...result, reason: "origin_rejected" };
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return { ...result, reason: "invalid_origin_response" };
      }
      const parsed = pathSchema.safeParse(data);
      if (!parsed.success || parsed.data.name !== config.MEDIA_STREAM_PATH)
        return { ...result, reason: "invalid_origin_response" };
      const path = parsed.data;
      if (!path.online)
        return {
          ...result,
          status: "offline",
          publisher: "offline",
          reason: "publisher_absent",
        };
      Object.assign(result, {
        publisher: "online",
        tracks: path.tracks,
        hls: "unavailable",
        status: "starting",
        reason: "hls_pending",
      });
      if (!path.available) return result;
      try {
        let hls = await fetcher(
          `${config.MEDIA_HLS_BASE_URL.replace(/\/$/, "")}/${config.MEDIA_STREAM_PATH}/index.m3u8`,
          { signal, redirect: "manual" },
        );
        // MediaMTX checks cookie support using one same-path redirect. Never follow
        // arbitrary hosts/paths or forward control API authentication to media.
        if ([301, 302, 307, 308].includes(hls.status)) {
          const initial = new URL(
            `${config.MEDIA_HLS_BASE_URL.replace(/\/$/, "")}/${config.MEDIA_STREAM_PATH}/index.m3u8`,
          );
          const location = hls.headers.get("location");
          await hls.body?.cancel();
          if (!location) return result;
          const redirected = new URL(location, initial);
          if (
            redirected.origin !== initial.origin ||
            redirected.pathname !== initial.pathname ||
            redirected.username ||
            redirected.password
          )
            return result;
          hls = await fetcher(redirected.toString(), {
            signal,
            redirect: "error",
          });
        }
        if (hls.ok) {
          // Bound the playlist body: this endpoint never transports media or follows playlist URLs.
          const reader = hls.body?.getReader();
          let body = "";
          let bytes = 0;
          if (reader) {
            try {
              while (bytes <= 65536) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                body += new TextDecoder().decode(chunk.value);
              }
            } finally {
              await reader.cancel();
            }
          }
          if (
            bytes <= 65536 &&
            body.trimStart().startsWith("#EXTM3U") &&
            (body.includes("#EXT-X-STREAM-INF") || body.includes("#EXTINF"))
          )
            return {
              ...result,
              status: "live",
              hls: "available",
              reason: "verified_manifest",
            };
        } else {
          await hls.body?.cancel();
        }
      } catch {
        /* Publisher exists, but HLS could not be verified. */
      }
      return result;
    } catch {
      return result;
    }
  };
  return {
    getStream(): Promise<Stream> {
      if (cached && Date.now() < expires) return Promise.resolve(cached);
      if (inflight) return inflight;
      inflight = observe()
        .then((stream) => {
          cached = { ...stream, checkedAt: new Date().toISOString() };
          expires = Date.now() + config.MEDIA_STATUS_CACHE_MS;
          return cached;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}
export type MediaService = ReturnType<typeof createMediaService>;
