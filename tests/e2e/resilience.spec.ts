import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { io, type Socket } from "socket.io-client";
import type { Publishing } from "@streamshield/shared";
import { account, write, cleanup, capture } from "./platform-helpers";
test.use({ trace: "off" });
const timeout = Number(process.env.RESILIENCE_TEST_TIMEOUT_MS);
const mediaBase = process.env.MEDIA_PUBLIC_HLS_BASE_URL!.replace(/\/$/, "");
const composeArgs = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  ".local/resilience/compose.yml",
  ...(process.env.STREAMSHIELD_COMPOSE_MODE === "monitoring"
    ? ["-f", ".local/monitoring/compose.yml"]
    : []),
];
function compose(...args: string[]) {
  return execFileSync("docker", [...composeArgs, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
  });
}
function privateFetch(
  host: string,
  path: string,
  port = process.env.API_INTERNAL_PORT!,
  method = "GET",
  body?: unknown,
) {
  const code =
    "const payload=(await import('node:fs')).readFileSync(0,'utf8'); const r=await fetch('http://'+process.argv[1]+':'+process.argv[2]+process.argv[3],{method:process.argv[4],headers:{Origin:process.env.CORS_ORIGINS.split(',')[0],Authorization:'Basic '+Buffer.from(process.argv[3].startsWith('/v3/') ? process.env.MEDIA_API_USER+':'+process.env.MEDIA_API_PASSWORD : 'mediamtx:'+process.env.MEDIA_AUTH_SECRET).toString('base64'),'Content-Type':'application/json'},body:payload || undefined});const b=await r.arrayBuffer(); const v=/json|mpegurl|text/.test(r.headers.get('content-type')||'') ? new TextDecoder().decode(b) : '';console.log(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),body:v,bytes:b.byteLength}));";
  return JSON.parse(
    execFileSync(
      "docker",
      [
        ...composeArgs,
        "exec",
        "-T",
        "api-2",
        "node",
        "--input-type=module",
        "-e",
        code,
        host,
        port,
        path,
        method,
      ],
      {
        encoding: "utf8",
        input: body ? JSON.stringify(body) : "",
        stdio: ["pipe", "pipe", "pipe"],
        timeout,
      },
    ),
  ) as {
    status: number;
    headers: Record<string, string>;
    body: string;
    bytes: number;
  };
}
function diag(host: string) {
  const r = privateFetch(host, "/internal/instance");
  expect(r.status).toBe(200);
  return JSON.parse(r.body) as {
    instanceId: string;
    ready: boolean;
    socketIds: string[];
  };
}
function publish(p: Publishing, size: string) {
  return spawn(process.execPath, ["scripts/test-publisher.mjs"], {
    env: {
      ...process.env,
      MEDIA_STREAM_PATH: p.path,
      MEDIA_PUBLISH_USER: p.user,
      MEDIA_PUBLISH_PASSWORD: p.key,
      TEST_PUBLISH_SIZE: size,
      TEST_PUBLISH_DURATION_SECONDS: "600",
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}
async function stop(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  if (p.connected) p.send("stop");
  else p.kill("SIGTERM");
  await expect
    .poll(() => p.exitCode !== null || p.signalCode !== null, { timeout })
    .toBe(true);
}
async function sample(page: Page) {
  return page.getByLabel("Live stream video").evaluate((n) => {
    const v = n as HTMLVideoElement;
    return {
      time: v.currentTime,
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
      width: v.videoWidth,
      source: v.closest(".player")?.getAttribute("data-delivery-source"),
    };
  });
}
async function advances(page: Page, width: number) {
  const before = await sample(page);
  await expect
    .poll(
      async () => {
        const now = await sample(page);
        return (
          now.frames > before.frames + 10 &&
          now.time > before.time &&
          now.width === width
        );
      },
      { timeout },
    )
    .toBe(true);
}
async function emit(socket: Socket, event: string, body: unknown) {
  return await new Promise<{
    ok: boolean;
    data?: { messages?: { id: string; content: string }[]; id?: string };
    error?: unknown;
  }>((resolve, reject) =>
    socket
      .timeout(timeout)
      .emit(event, body, (error: Error | null, result: never) =>
        error ? reject(error) : resolve(result),
      ),
  );
}
const logJson = (service: string) =>
  compose("logs", "--no-log-prefix", "--tail=500", service)
    .split("\n")
    .flatMap((line) => {
      try {
        return [
          JSON.parse(line) as {
            requestId?: string;
            instanceId?: string;
            status?: number;
          },
        ];
      } catch {
        return [];
      }
    });
test("real redundant API/chat, edge routing and independent-origin browser failover", async ({
  browser,
  request,
}) => {
  test.setTimeout(timeout * 12);
  const first = await request.get("/api/v1/streams?limit=100");
  expect(first.ok()).toBe(true);
  expect(
    (await first.json()).streams.every(
      (s: { publisher: string }) => s.publisher !== "online",
    ),
    "Refuse to interrupt an existing broadcaster",
  ).toBe(true);
  const ids: string[] = [],
    children: ChildProcess[] = [],
    sockets: Socket[] = [],
    stopped = new Set<string>();
  const contexts = await Promise.all([
    browser.newContext({ baseURL: process.env.E2E_BASE_URL }),
    browser.newContext({ baseURL: process.env.E2E_BASE_URL }),
  ]);
  const records: Record<string, unknown>[] = [];
  const samples: { at: number; frames: number; time: number }[][] = [[], []];
  const events: { at: number; kind: string }[][] = [[], []];
  const interval = Number(process.env.RESILIENCE_SAMPLE_INTERVAL_MS),
    stallThreshold = Number(process.env.RESILIENCE_STALL_THRESHOLD_MS);
  function measuredPlayback(from: number, to: number) {
    const all = samples.map((rows) =>
      rows.filter((r) => r.at >= from && r.at <= to),
    );
    let maxGap = 0,
      interruptions = 0,
      stallCount = 0;
    for (const rows of all) {
      let previous = rows[0],
        lastProgressAt = previous?.at;
      for (const row of rows.slice(1)) {
        if (
          previous &&
          lastProgressAt !== undefined &&
          row.frames > 0 &&
          (row.frames > previous.frames || row.time > previous.time)
        ) {
          const gap = row.at - lastProgressAt;
          maxGap = Math.max(maxGap, gap);
          if (gap >= stallThreshold) {
            interruptions += gap;
            stallCount++;
          }
          lastProgressAt = row.at;
        }
        previous = row;
      }
    }
    return {
      sampleIntervalMs: interval,
      stallThresholdMs: stallThreshold,
      playbackStallCount: stallCount,
      playbackInterruptionMs: interruptions,
      maxDecodedProgressGapMs: maxGap,
      waitingEventCount: events
        .flat()
        .filter((e) => e.at >= from && e.at <= to && e.kind === "waiting")
        .length,
    };
  }

  const suffix = randomUUID().slice(0, 8),
    api1 = process.env.RESILIENCE_API1_HOST!,
    api2 = process.env.RESILIENCE_API2_HOST!,
    httpPort = process.env.RESILIENCE_HTTP_PORT!;
  const hosts = [
    process.env.RESILIENCE_PRIMARY_HOST!,
    process.env.RESILIENCE_STANDBY_HOST!,
  ];
  const edge = process.env.RESILIENCE_EDGE1_HOST!;
  let outcome = "FAIL";
  try {
    expect(diag(api1)).toMatchObject({ instanceId: "api-1", ready: true });
    expect(diag(api2)).toMatchObject({ instanceId: "api-2", ready: true });
    const users = await Promise.all(
      contexts.map((ctx, i) =>
        account(
          ctx.request,
          "e2e_resilience" + i + "_" + suffix,
          "Resilience-test-password-42",
        ),
      ),
    );
    ids.push(...users.map((u) => u.user.id));
    const streams: string[] = [],
      keys: Publishing[] = [];
    for (let i = 0; i < 2; i++) {
      const ctx = contexts[i]!,
        csrf = users[i]!.csrf;
      expect(
        (
          await write(ctx.request, csrf, "/channels", {
            slug: "resilience-" + i + "-" + suffix,
            displayName: i ? "Independent Signal" : "Resilient Live",
            description: "Real multi-origin verification",
          })
        ).status(),
      ).toBe(201);
      const channel = (
        await (await ctx.request.get("/api/v1/studio/channel")).json()
      ).channel;
      const created = await write(ctx.request, csrf, "/studio/streams", {
        channelId: channel.id,
        title: i ? "A separate live signal" : "Live through the interruption",
        description: "Actual replicated FFmpeg video.",
      });
      expect(created.status()).toBe(201);
      streams.push((await created.json()).id);
      const key = await write(
        ctx.request,
        csrf,
        "/studio/streams/" + streams[i] + "/publishing",
      );
      expect(key.ok()).toBe(true);
      keys.push(await key.json());
    }
    // Private callback rejects missing/incorrect replication credentials and unknown paths.
    expect(
      privateFetch(
        api1,
        "/internal/media/auth",
        process.env.API_INTERNAL_PORT,
        "POST",
        {
          action: "read",
          protocol: "rtsp",
          path: keys[0]!.path,
          user: "replica",
          password: "incorrect",
        },
      ).status,
    ).toBe(401);
    expect(
      privateFetch(
        api1,
        "/internal/media/auth",
        process.env.API_INTERNAL_PORT,
        "POST",
        {
          action: "read",
          protocol: "rtsp",
          path: "s-" + "0".repeat(32),
          user: "replica",
          password: process.env.RESILIENCE_REPLICATION_SECRET,
        },
      ).status,
    ).toBe(401);
    expect((await request.get("/api/v1/internal/instance")).status()).toBe(404);
    const cross = publish({ ...keys[0]!, path: keys[1]!.path }, "320x180");
    children.push(cross);
    await expect.poll(() => cross.exitCode, { timeout }).not.toBeNull();
    expect(cross.exitCode).not.toBe(0);
    for (let i = 0; i < 2; i++) {
      const p = publish(keys[i]!, i ? "320x180" : "640x360");
      children.push(p);
    }
    for (const host of hosts)
      for (const key of keys)
        await expect
          .poll(
            () => {
              const r = privateFetch(
                host,
                "/v3/paths/get/" + key.path,
                process.env.MEDIA_API_PORT,
              );
              if (r.status !== 200) return false;
              const body = JSON.parse(r.body);
              return body.online && body.available;
            },
            { timeout },
          )
          .toBe(true);
    console.log("Verified genuine media on both origins for two paths");
    // Prove HTTP round-robin using private correlated instance logs, not public identity headers.
    const requestIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await contexts[0]!.request.get("/api/v1/auth/me");
      expect(r.status()).toBe(200);
      expect((await r.json()).user.id).toBe(users[0]!.user.id);
      requestIds.push(r.headers()["x-request-id"]!);
    }
    const seen = new Set(
      [...logJson("api"), ...logJson("api-2")]
        .filter((l) => requestIds.includes(l.requestId || ""))
        .map((l) => l.instanceId),
    );
    expect([...seen].sort()).toEqual(["api-1", "api-2"]);
    async function socketFor(index: number, wanted: string) {
      const cookies = (await contexts[index]!.cookies())
        .map((c) => c.name + "=" + c.value)
        .join("; ");
      for (let attempt = 0; attempt < 8; attempt++) {
        const s = io(process.env.E2E_BASE_URL!, {
          transports: ["websocket"],
          extraHeaders: {
            Origin: new URL(process.env.E2E_BASE_URL!).origin,
            Cookie: cookies,
          },
          auth: { csrf: users[index]!.csrf },
          autoConnect: false,
          reconnectionAttempts: 5,
          reconnectionDelay: 1000,
          timeout,
        });
        sockets.push(s);
        await new Promise<void>((resolve, reject) => {
          s.once("connect", () => resolve());
          s.once("connect_error", reject);
          s.connect();
        });
        if (diag(wanted).socketIds.includes(s.id!)) {
          s.on("connect", () => void emit(s, "join", { streamId: streams[0] }));
          expect((await emit(s, "join", { streamId: streams[0] })).ok).toBe(
            true,
          );
          return s;
        }
        s.disconnect();
      }
      throw new Error(
        "Could not establish the required independent gateway-routed socket",
      );
    }
    console.log("Verified HTTP load balancing and publisher boundaries");
    const a = await socketFor(0, api1),
      b = await socketFor(1, api2);
    const beforeMessage = "Cross-instance delivery " + suffix;
    const delivered = new Promise<unknown>((resolve) =>
      a.once("message", resolve),
    );
    expect(
      (
        await emit(b, "message", {
          streamId: streams[0],
          content: beforeMessage,
        })
      ).ok,
    ).toBe(true);
    await delivered;
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    const network: { at: number; status: number; source: string }[] = [];
    for (let i = 0; i < 2; i++) {
      pages[i]!.on("response", (r) => {
        if (r.url().includes(mediaBase + "/"))
          network.push({
            at: performance.now(),
            status: r.status(),
            source: r.url().includes("/standby/") ? "standby" : "primary",
          });
      });
      pages[i]!.on("requestfailed", (r) => {
        if (r.url().includes(mediaBase + "/"))
          network.push({
            at: performance.now(),
            status: 0,
            source: r.url().includes("/standby/") ? "standby" : "primary",
          });
      });
      await pages[i]!.goto("/watch/" + streams[i]);
      await expect(pages[i]!.getByTestId("playback-state")).toHaveText(
        "playing",
        { timeout },
      );
      await advances(pages[i]!, i ? 320 : 640);
    }
    for (let i = 0; i < 2; i++) {
      const hostClock = performance.now(),
        browserClock = await pages[i]!.evaluate(() => performance.now()),
        clockOffset = hostClock - browserClock;
      await pages[i]!.exposeFunction(
        "phase4Sample",
        (frames: number, time: number, at: number) =>
          samples[i]!.push({ at: at + clockOffset, frames, time }),
      );
      await pages[i]!.exposeFunction(
        "phase4Event",
        (kind: string, at: number) =>
          events[i]!.push({ at: at + clockOffset, kind }),
      );
      await pages[i]!.evaluate((ms) => {
        const v = document.querySelector("video")!;
        const w = window as unknown as {
          phase4Sample: (frames: number, time: number, at: number) => void;
          phase4Event: (kind: string, at: number) => void;
        };
        setInterval(
          () =>
            w.phase4Sample(
              v.getVideoPlaybackQuality().totalVideoFrames,
              v.currentTime,
              performance.now(),
            ),
          ms,
        );
        for (const kind of ["waiting", "stalled", "playing"])
          v.addEventListener(kind, () =>
            w.phase4Event(kind, performance.now()),
          );
      }, interval);
    }
    // API-1 crash: no routing edits; durable sessions and Redis chat recover through API-2.
    const injected = performance.now(),
      utc = new Date().toISOString();
    let disconnected: number | undefined;
    a.once("disconnect", () => {
      disconnected = performance.now();
    });
    compose("kill", "-s", "SIGKILL", "api");
    stopped.add("api");
    const missed = "Persisted while peer reconnects " + suffix;
    expect(
      (await emit(b, "message", { streamId: streams[0], content: missed })).ok,
    ).toBe(true);
    let readErrors = 0;
    async function recoveredRead<T>(path: string): Promise<T> {
      let value: T | undefined;
      await expect
        .poll(
          async () => {
            const r = await contexts[0]!.request.get(path);
            if (!r.ok()) {
              readErrors++;
              return false;
            }
            value = await r.json();
            return true;
          },
          { timeout },
        )
        .toBe(true);
      return value!;
    }
    const restoredSession = await recoveredRead<{ user: { id: string } }>(
      "/api/v1/auth/me",
    );
    expect(restoredSession.user).toMatchObject({ id: users[0]!.user.id });
    const traffic = performance.now();
    const createdDuringFailure = await write(
      contexts[0]!.request,
      users[0]!.csrf,
      "/studio/streams",
      {
        channelId: (
          await recoveredRead<{ channel: { id: string } }>(
            "/api/v1/studio/channel",
          )
        ).channel.id,
        title: "Single write during failover " + suffix,
        description: "One acknowledged creation",
      },
    );
    const writeStatus = createdDuringFailure.status();
    expect([201, 502, 503, 504]).toContain(writeStatus);
    let ownedAfter = (
      await recoveredRead<{ streams: { title: string }[] }>(
        "/api/v1/studio/streams",
      )
    ).streams as unknown as { title: string }[];
    const matching = () =>
      ownedAfter.filter(
        (s: { title: string }) =>
          s.title === "Single write during failover " + suffix,
      );
    expect(matching()).toHaveLength(writeStatus === 201 ? 1 : 0);
    // A failed unsafe write is never replayed by the gateway. Only the operator/client,
    // after verifying absence in durable state, explicitly submits a new operation.
    if (writeStatus !== 201) {
      const channel = (
        await (await contexts[0]!.request.get("/api/v1/studio/channel")).json()
      ).channel;
      expect(
        (
          await write(contexts[0]!.request, users[0]!.csrf, "/studio/streams", {
            channelId: channel.id,
            title: "Single write during failover " + suffix,
            description: "One acknowledged creation",
          })
        ).status(),
      ).toBe(201);
      ownedAfter = (
        await (await contexts[0]!.request.get("/api/v1/studio/streams")).json()
      ).streams;
      expect(matching()).toHaveLength(1);
    }
    const response = await contexts[0]!.request.get("/api/v1/auth/me");
    expect(response.status()).toBe(200);
    expect((await response.json()).user.id).toBe(users[0]!.user.id);

    await expect
      .poll(() => a.connected && diag(api2).socketIds.includes(a.id!), {
        timeout,
      })
      .toBe(true);
    const chatRecovered = performance.now();
    expect(
      (await emit(a, "join", { streamId: streams[0] })).data?.messages?.some(
        (m) => m.content === missed,
      ),
    ).toBe(true);
    const after = "After reconnection " + suffix,
      deliveredAfter = new Promise<unknown>((resolve) =>
        b.once("message", resolve),
      );
    expect(
      (await emit(a, "message", { streamId: streams[0], content: after })).ok,
    ).toBe(true);
    await deliveredAfter;
    const history = await (
      await contexts[0]!.request.get("/api/v1/streams/" + streams[0] + "/chat")
    ).json();
    expect(
      history.messages.filter((m: { content: string }) => m.content === after),
    ).toHaveLength(1);
    expect(
      (
        await emit(a, "message", {
          streamId: streams[1],
          content: "Must not cross rooms",
        })
      ).ok,
    ).toBe(false);
    await advances(pages[0]!, 640);
    await advances(pages[1]!, 320);
    compose("up", "-d", "--no-deps", "api");
    stopped.delete("api");
    await expect
      .poll(
        () => {
          try {
            return diag(api1).ready;
          } catch {
            return false;
          }
        },
        { timeout },
      )
      .toBe(true);
    const restored = performance.now();
    await expect
      .poll(
        async () => {
          const ids: string[] = [];
          for (let i = 0; i < 4; i++) {
            const r = await contexts[0]!.request.get("/api/v1/auth/me");
            ids.push(r.headers()["x-request-id"]!);
          }
          return logJson("api").some((l) => ids.includes(l.requestId || ""));
        },
        { timeout },
      )
      .toBe(true);
    records.push({
      ...measuredPlayback(injected, restored),
      experiment: "api-and-socket",
      injectedAt: utc,
      firstDetectionMs: disconnected ? disconnected - injected : null,
      trafficRecoveredMs: traffic - injected,
      chatRecoveredMs: chatRecovered - injected,
      infrastructureRestoredMs: restored - injected,
      playbackRecoveredMs: null,
      playback: "continued on both independent streams",
      acknowledgedMessageDuplicateCount: 0,
      unsafeWriteStatus: writeStatus,
      unsafeWriteDuplicateCount: 0,
      requestErrors: readErrors + (writeStatus === 201 ? 0 : 1),
      durableCatchupVerified: true,
      transientDelivery:
        "No exactly-once Pub/Sub guarantee; disconnected peer recovered the acknowledged message from durable history",
      outcome: "PASS",
    });
    console.log(
      "Verified API crash, session continuity and cross-instance chat recovery",
    );
    // Edge cache: playlists bypass, immutable segments MISS then HIT on the same real edge.
    const sourcePath = "/primary/" + keys[0]!.path + "/";
    let master = privateFetch(edge, sourcePath + "index.m3u8", httpPort);
    if (master.status >= 300 && master.status < 400)
      master = privateFetch(edge, master.headers.location!, httpPort);
    expect(master.status).toBe(200);
    expect(master.headers["cache-control"]).toBe("no-store");
    expect(master.headers["x-cache"]).toBe("BYPASS");
    expect(master.headers["access-control-allow-origin"]).toBe(
      process.env.CORS_ORIGINS!.split(",")[0],
    );
    let playlistPath =
      sourcePath +
      master.body.split("\n").find((l) => l && !l.startsWith("#"))!;
    let playlist = privateFetch(edge, playlistPath, httpPort);
    if (playlist.status >= 300 && playlist.status < 400) {
      playlistPath = playlist.headers.location!;
      playlist = privateFetch(edge, playlistPath, httpPort);
    }
    expect(playlist.status).toBe(200);
    expect(playlist.body).toContain("#EXTINF");
    const segment = playlist.body
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .at(-1)!;
    const segmentPath = sourcePath + segment;
    const media1 = privateFetch(edge, segmentPath, httpPort),
      media2 = privateFetch(edge, segmentPath, httpPort);
    expect(media1.status).toBe(200);
    expect(media1.bytes).toBeGreaterThan(100);
    expect(media2.status).toBe(200);
    expect(media2.headers["x-cache"]).toBe("HIT");
    const startedEdge = performance.now(),
      edgeUtc = new Date().toISOString();
    compose("kill", "-s", "SIGKILL", "edge-1");
    stopped.add("edge-1");
    const mark = network.length;
    await expect
      .poll(() => network.slice(mark).some((r) => r.status === 200), {
        timeout,
      })
      .toBe(true);
    const routed = performance.now();
    await advances(pages[0]!, 640);
    await advances(pages[1]!, 320);
    const played = performance.now();
    await expect
      .poll(
        () => {
          const edgeLogs = compose("logs", "--since", edgeUtc, "edge-2");
          return (
            edgeLogs.includes(keys[0]!.path) && edgeLogs.includes(keys[1]!.path)
          );
        },
        { timeout },
      )
      .toBe(true);
    compose("up", "-d", "--no-deps", "edge-1");
    stopped.delete("edge-1");
    await expect
      .poll(
        () => {
          try {
            return privateFetch(edge, "/health", httpPort).status === 200;
          } catch {
            return false;
          }
        },
        { timeout },
      )
      .toBe(true);
    records.push({
      ...measuredPlayback(startedEdge, played),
      experiment: "edge-1",
      firstDetectionMs: network
        .slice(mark)
        .find((r) => r.status === 0 || r.status >= 400)?.at
        ? network.slice(mark).find((r) => r.status === 0 || r.status >= 400)!
            .at - startedEdge
        : null,
      injectedAt: edgeUtc,
      trafficRecoveredMs: routed - startedEdge,
      playbackRecoveredMs: played - startedEdge,
      infrastructureRestoredMs: performance.now() - startedEdge,
      requestErrors: network
        .slice(mark)
        .filter((r) => r.status === 0 || r.status >= 400).length,
      outcome: "PASS",
    });
    console.log("Verified edge crash routing and advancing decoded playback");
    // Primary origin crash: both already-warm standby paths must provide actual fresh decoded video.
    const originStart = performance.now(),
      originUtc = new Date().toISOString(),
      originMark = network.length;
    compose("kill", "-s", "SIGKILL", "origin-primary");
    stopped.add("origin-primary");
    for (let i = 0; i < 2; i++) {
      await expect(pages[i]!.locator(".player")).toHaveAttribute(
        "data-delivery-source",
        "standby",
        { timeout },
      );
      await advances(pages[i]!, i ? 320 : 640);
    }
    const playbackRecovered = performance.now(),
      standbyTraffic = network
        .slice(originMark)
        .find((r) => r.source === "standby" && r.status === 200)?.at;
    expect(standbyTraffic).toBeDefined();
    for (const key of keys) {
      const r = privateFetch(
        hosts[1]!,
        "/v3/paths/get/" + key.path,
        process.env.MEDIA_API_PORT,
      );
      expect(JSON.parse(r.body).available).toBe(true);
    }
    records.push({
      ...measuredPlayback(originStart, playbackRecovered),
      experiment: "primary-origin",
      injectedAt: originUtc,
      firstDetectionMs: network
        .slice(originMark)
        .find((r) => r.status === 0 || r.status >= 400)?.at
        ? network
            .slice(originMark)
            .find((r) => r.status === 0 || r.status >= 400)!.at - originStart
        : null,
      trafficRecoveredMs: standbyTraffic! - originStart,
      playbackRecoveredMs: playbackRecovered - originStart,
      requestErrors: network
        .slice(originMark)
        .filter((r) => r.status === 0 || r.status >= 400).length,
      twoIndependentDecodedStreams: true,
      outcome: "PASS",
    });
    const newcomer = await contexts[1]!.newPage();
    await newcomer.goto("/watch/" + streams[0]);
    await expect(newcomer.getByTestId("playback-state")).toHaveText("playing", {
      timeout,
    });
    await advances(newcomer, 640);
    records[records.length - 1]!.newViewerVerifiedMs =
      performance.now() - originStart;
    await newcomer.close();
    // Rendered desktop/mobile continuity evidence, without keys or private topology.
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await pages[0]!.setViewportSize({ width, height: 1000 });
      await capture(pages[0]!, "test-results/phase4/watch-" + width + ".png");
    }
    compose("up", "-d", "--no-deps", "origin-primary");
    stopped.delete("origin-primary");
    for (const key of keys)
      await expect
        .poll(
          () => {
            try {
              return (
                JSON.parse(
                  privateFetch(
                    hosts[0]!,
                    "/v3/paths/get/" + key.path,
                    process.env.MEDIA_API_PORT,
                  ).body,
                ).available === true
              );
            } catch {
              return false;
            }
          },
          { timeout },
        )
        .toBe(true);
    records[records.length - 1]!.infrastructureRestoredMs =
      performance.now() - originStart;
    // Restoration means fresh media through the actual route, not only a source-ready flag.
    await expect
      .poll(
        async () => {
          try {
            for (let attempt = 0; attempt < 2; attempt++) {
              const base = new URL(
                mediaBase + "/primary/" + keys[0]!.path + "/",
                process.env.E2E_BASE_URL,
              );
              const master = await request.get(
                new URL("index.m3u8", base).toString(),
              );
              if (!master.ok()) return false;
              const variant = (await master.text())
                .split("\n")
                .find((l) => l && !l.startsWith("#"));
              if (!variant) return false;
              const playlist = await request.get(
                new URL(variant, base).toString(),
              );
              if (!playlist.ok()) return false;
              const segments = (await playlist.text())
                .split("\n")
                .filter((l) => l && !l.startsWith("#"));
              const last = segments.at(-1);
              if (!last) return false;
              const segment = await request.get(new URL(last, base).toString());
              if (!segment.ok() || (await segment.body()).byteLength < 100)
                return false;
            }
            return true;
          } catch {
            return false;
          }
        },
        { timeout },
      )
      .toBe(true);
    // Stable standby does not flap; explicit preferred-source retry verifies primary rejoin.
    expect((await sample(pages[0]!)).source).toBe("standby");
    await pages[0]!
      .getByRole("button", { name: "Retry preferred playback source" })
      .click();
    await expect(pages[0]!.locator(".player")).toHaveAttribute(
      "data-delivery-source",
      "primary",
      { timeout },
    );
    await advances(pages[0]!, 640);
    // Rotation revokes the old relay credential and supplies fresh timelines to both origins.
    const replacement = await write(
      contexts[0]!.request,
      users[0]!.csrf,
      "/studio/streams/" + streams[0] + "/publishing",
    );
    expect(replacement.status()).toBe(200);
    const renewed: Publishing = await replacement.json();
    await stop(children[1]!);
    const oldKey = publish(keys[0]!, "640x360");
    children.push(oldKey);
    await expect.poll(() => oldKey.exitCode, { timeout }).not.toBeNull();
    expect(oldKey.exitCode).not.toBe(0);
    const newPublisher = publish(renewed, "640x360");
    children.push(newPublisher);
    keys[0] = renewed;
    for (const host of hosts)
      await expect
        .poll(
          () => {
            const r = privateFetch(
              host,
              "/v3/paths/get/" + renewed.path,
              process.env.MEDIA_API_PORT,
            );
            return r.status === 200 && JSON.parse(r.body).available === true;
          },
          { timeout },
        )
        .toBe(true);
    await expect
      .poll(
        async () => {
          const r = await request.get("/api/v1/streams/" + streams[0]);
          return r.ok() && (await r.json()).status === "live";
        },
        { timeout },
      )
      .toBe(true);
    await pages[0]!.goto("/watch/" + streams[0]);
    await expect(pages[0]!.getByTestId("playback-state")).toHaveText(
      "playing",
      { timeout },
    );
    await advances(pages[0]!, 640);
    const freshMaster = privateFetch(edge, sourcePath + "index.m3u8", httpPort);
    expect(freshMaster.status).toBe(200);
    const freshVariant = freshMaster.body
      .split("\n")
      .find((l) => l && !l.startsWith("#"))!;
    const freshPlaylist = privateFetch(
      edge,
      sourcePath + freshVariant,
      httpPort,
    );
    expect(freshPlaylist.body).toContain("#EXTINF");
    expect(freshPlaylist.body).not.toContain(segment);
    await advances(pages[1]!, 320);
    // End/revocation propagates through relay supply, and the independent stream keeps playing.
    expect(
      (
        await write(
          contexts[0]!.request,
          users[0]!.csrf,
          "/studio/streams/" + streams[0] + "/end",
        )
      ).status(),
    ).toBe(200);
    for (const host of hosts)
      await expect
        .poll(
          () => {
            const r = privateFetch(
              host,
              "/v3/paths/get/" + keys[0]!.path,
              process.env.MEDIA_API_PORT,
            );
            return r.status !== 200 || !JSON.parse(r.body).available;
          },
          { timeout },
        )
        .toBe(true);
    const revoked = publish(keys[0]!, "640x360");
    children.push(revoked);
    await expect.poll(() => revoked.exitCode, { timeout }).not.toBeNull();
    expect(revoked.exitCode).not.toBe(0);
    await advances(pages[1]!, 320);
    outcome = "PASS";
  } finally {
    for (const s of sockets) s.disconnect();
    for (const service of stopped)
      try {
        compose("up", "-d", "--no-deps", service);
      } catch {
        /* reported by final readiness verification */
      }
    await Promise.all(children.map(stop));
    await Promise.all(contexts.map((c) => c.close()));
    cleanup(ids);
    mkdirSync("test-results/phase4", { recursive: true });
    writeFileSync(
      "test-results/phase4/measurements.json",
      JSON.stringify(
        {
          outcome,
          measuredAt: new Date().toISOString(),
          clock:
            "performance.now monotonic milliseconds; UTC injection timestamps",
          experiments: records,
        },
        null,
        2,
      ),
    );
    console.log(
      "Resilience experiments: " +
        JSON.stringify({ outcome, experiments: records }),
    );
  }
});
