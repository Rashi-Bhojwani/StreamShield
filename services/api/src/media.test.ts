import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createMediaService } from "./media";
import { createApp } from "./app";
import { parseConfig } from "./config";
import { testEnv } from "./test-config";
import { streamSchema } from "@streamshield/shared";
const config = parseConfig(testEnv);
const path = {
  name: "live",
  online: true,
  available: true,
  tracks: ["H264", "MPEG-4 Audio"],
};
function replies(...responses: Array<Response | Error>) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetcher.mockRejectedValueOnce(response);
    else fetcher.mockResolvedValueOnce(response);
  }
  return fetcher;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
describe("media observations", () => {
  it("follows only one same-origin, same-path HLS cookie-check redirect", async () => {
    const fetcher = replies(
      json(path),
      new Response(null, {
        status: 302,
        headers: { location: "/live/index.m3u8?cookieCheck=1" },
      }),
      new Response("#EXTM3U\n#EXTINF:2\nseg.mp4"),
    );
    expect((await createMediaService(config, fetcher).getStream()).status).toBe(
      "live",
    );
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "http://origin.test:8888/live/index.m3u8?cookieCheck=1",
    );
    const external = replies(
      json(path),
      new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example/live/index.m3u8" },
      }),
    );
    expect(
      (await createMediaService(config, external).getStream()).status,
    ).toBe("starting");
    expect(external).toHaveBeenCalledTimes(2);
  });
  it("classifies malformed JSON as invalid evidence rather than an absent source", async () => {
    expect(
      (await createMediaService(config, replies(new Response("{"))).getStream())
        .reason,
    ).toBe("invalid_origin_response");
  });

  it("reports live only after authenticated path and real HLS manifest validation", async () => {
    const fetcher = replies(
      json(path),
      new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nstream.m3u8"),
    );
    const result = await createMediaService(config, fetcher).getStream();
    expect(streamSchema.parse(result).status).toBe("live");
    expect(result.publisher).toBe("online");
    expect(result.hls).toBe("available");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://origin.test:9997/v3/paths/get/live",
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).toHaveProperty("Authorization");
    expect(JSON.stringify(result)).not.toContain(config.MEDIA_API_PASSWORD);
  });
  it("distinguishes publisher absence from unavailable origin", async () => {
    for (const response of [json({}, 404), json({ ...path, online: false })]) {
      const result = await createMediaService(
        config,
        replies(response),
      ).getStream();
      expect(result.status).toBe("offline");
      expect(result.publisher).toBe("offline");
      expect(result.hls).toBe("not_checked");
    }
    const missing = await createMediaService(
      config,
      replies(new Error("timeout")),
    ).getStream();
    expect(missing.status).toBe("unavailable");
    expect(missing.publisher).toBe("unknown");
  });
  it.each([401, 403, 500])(
    "does not treat origin HTTP %i as offline",
    async (status) => {
      const result = await createMediaService(
        config,
        replies(json({}, status)),
      ).getStream();
      expect(result.reason).toBe("origin_rejected");
    },
  );
  it("rejects malformed or mismatched path data", async () => {
    for (const payload of [{ ready: true }, { ...path, name: "other" }]) {
      expect(
        (await createMediaService(config, replies(json(payload))).getStream())
          .reason,
      ).toBe("invalid_origin_response");
    }
  });
  it.each([
    new Response("not a playlist"),
    new Response("#EXTM3U\nno segments"),
    new Response("x".repeat(70000)),
    new Response("", { status: 503 }),
  ])(
    "does not invent playback availability from invalid HLS",
    async (response) => {
      const result = await createMediaService(
        config,
        replies(json(path), response),
      ).getStream();
      expect(result.status).toBe("starting");
      expect(result.publisher).toBe("online");
      expect(result.hls).toBe("unavailable");
    },
  );
  it("coalesces concurrent observations and retains the checked timestamp in a bounded cache", async () => {
    const fetcher = replies(json({}, 404));
    const service = createMediaService(
      { ...config, MEDIA_STATUS_CACHE_MS: 1000 },
      fetcher,
    );
    const results = await Promise.all([
      service.getStream(),
      service.getStream(),
      service.getStream(),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await service.getStream()).toEqual(results[0]);
  });
  it("exposes only the configured channel, never arbitrary media/admin URLs", async () => {
    const service = createMediaService(config, replies(json({}, 404)));
    const app = createApp(config, { ready: true }, undefined, service);
    expect(
      (await request(app).get("/api/v1/streams").expect(200)).body.streams[0]
        .status,
    ).toBe("offline");
    await request(app).get("/api/v1/streams/unconfigured").expect(404);
    await request(app).post("/api/v1/streams/live").expect(404);
    await request(app).get("/v3/config/global/get").expect(404);
  });
});
describe("media configuration", () => {
  it.each([
    { MEDIA_STREAM_PATH: "../escape" },
    { MEDIA_PUBLIC_HLS_BASE_URL: "//evil.example" },
    { MEDIA_API_BASE_URL: "file:///etc/passwd" },
    { MEDIA_API_PASSWORD: "" },
    { MEDIA_PROBE_TIMEOUT_MS: "0" },
  ])("rejects unsafe/missing values %o", (bad) =>
    expect(() => parseConfig({ ...testEnv, ...bad })).toThrow(
      "Invalid API configuration",
    ),
  );
});
