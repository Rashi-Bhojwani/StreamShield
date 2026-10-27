import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { publisherConnections } from "./media-control.js";
import { kickPublisher } from "./catalog.js";

const config = {
  MEDIA_API_BASE_URL: "http://media.private:9997",
  MEDIA_API_USER: "private-api-user",
  MEDIA_API_PASSWORD: "private-media-password-never-return",
  MEDIA_PROBE_TIMEOUT_MS: 5000,
  MEDIA_CONTROL_TIMEOUT_MS: 5000,
} as Config;
afterEach(() => vi.unstubAllGlobals());
it("keeps publishing control independent from a shorter health-probe deadline", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (_url, options) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      options.signal.throwIfAborted();
      return Response.json({ items: [] });
    }),
  );
  await expect(
    kickPublisher(
      { ...config, MEDIA_PROBE_TIMEOUT_MS: 1, MEDIA_CONTROL_TIMEOUT_MS: 1000 },
      "s-owned",
      true,
    ),
  ).resolves.toBeUndefined();
});

it("starts both independent inventory reads together under one bounded deadline", async () => {
  const replies: ((value: Response) => void)[] = [];
  const fetch = vi
    .fn()
    .mockImplementation(
      () => new Promise<Response>((resolve) => replies.push(resolve)),
    );
  vi.stubGlobal("fetch", fetch);
  const result = publisherConnections(config, true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]![1].signal).toBe(fetch.mock.calls[1]![1].signal);
  replies.forEach((reply) => reply(Response.json({ items: [], pageCount: 0 })));
  expect(await result).toEqual([
    { protocol: "rtmpconns", items: [] },
    { protocol: "webrtcsessions", items: [] },
  ]);
});
it.each([
  [401, "media_control_auth_denied"],
  [403, "media_control_auth_denied"],
  [503, "media_control_http_error"],
] as const)(
  "reports safe diagnostics for HTTP %s without exposing response details",
  async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(config.MEDIA_API_PASSWORD, { status })),
    );
    await expect(publisherConnections(config, true)).rejects.toMatchObject({
      code,
      message: code,
    });
  },
);
it("fails closed on invalid or incomplete connection inventories", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ items: [{ id: "bad" }] }))
    .mockResolvedValueOnce(Response.json({ items: [], pageCount: 2 }));
  vi.stubGlobal("fetch", fetch);
  await expect(publisherConnections(config)).rejects.toMatchObject({
    code: "media_control_invalid_response",
  });
  await expect(publisherConnections(config)).rejects.toMatchObject({
    code: "media_control_inventory_incomplete",
  });
});
it("identifies a timed-out media connection without serializing its URL or credentials", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    ),
  );
  await expect(
    publisherConnections({ ...config, MEDIA_CONTROL_TIMEOUT_MS: 20 }, true),
  ).rejects.toMatchObject({ code: "media_control_timeout" });
});
it("still disconnects only this stream's RTMP and WebRTC publishers, preserving readers and other streams", async () => {
  const rtmp = randomUUID(),
    browser = randomUUID(),
    reader = randomUUID(),
    other = randomUUID();
  const fetch = vi
    .fn()
    .mockImplementation(async (url: string, options: RequestInit) => {
      if (options.method === "POST") return new Response(null, { status: 200 });
      return Response.json({
        items: [
          {
            id: url.includes("rtmpconns") ? rtmp : browser,
            path: "s-owned",
            state: "publish",
          },
          { id: reader, path: "s-owned", state: "read" },
          { id: other, path: "s-other", state: "publish" },
        ],
      });
    });
  vi.stubGlobal("fetch", fetch);
  await kickPublisher(config, "s-owned", true);
  expect(
    fetch.mock.calls
      .filter(([, options]) => options.method === "POST")
      .map(([url]) => url),
  ).toEqual([
    config.MEDIA_API_BASE_URL + "/v3/rtmpconns/kick/" + rtmp,
    config.MEDIA_API_BASE_URL + "/v3/webrtcsessions/kick/" + browser,
  ]);
});
it("does not kick any publisher when either protocol inventory is unavailable", async () => {
  const fetch = vi.fn().mockImplementation(async (url: string) =>
    url.includes("webrtcsessions")
      ? new Response("private upstream failure", { status: 503 })
      : Response.json({
          items: [{ id: randomUUID(), path: "s-owned", state: "publish" }],
        }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(kickPublisher(config, "s-owned", true)).rejects.toMatchObject({
    code: "PUBLISHER_STOP_UNCONFIRMED",
    status: 503,
  });
  expect(fetch.mock.calls).toHaveLength(2);
  expect(
    fetch.mock.calls.every(([, options]) => options.method !== "POST"),
  ).toBe(true);
});
