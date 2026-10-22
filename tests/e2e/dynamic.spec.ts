import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import type {
  Publishing,
  ChaosSnapshot,
  ChaosExperiment,
} from "@streamshield/shared";
import { account, write } from "./platform-helpers";
import { dynamicComposeArgs } from "../../infrastructure/dynamic/compose.mjs";
test.use({ trace: "off", actionTimeout: 15000, navigationTimeout: 30000 });
const timeout = 90000,
  origin = new URL(process.env.E2E_BASE_URL!).origin;
const compose = (...args: string[]) =>
  execFileSync("docker", [...dynamicComposeArgs, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 90000,
  });
const publish = (p: Publishing, size: string, tone: number) =>
  spawn(process.execPath, ["scripts/test-publisher.mjs"], {
    env: {
      ...process.env,
      MEDIA_RTMP_BASE_URL: p.server,
      MEDIA_STREAM_PATH: p.path,
      MEDIA_PUBLISH_USER: p.user,
      MEDIA_PUBLISH_PASSWORD: p.key,
      TEST_PUBLISH_SIZE: size,
      TEST_PUBLISH_TONE_HZ: String(tone),
      TEST_PUBLISH_DURATION_SECONDS: "600",
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
async function stop(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  if (p.connected) p.send("stop");
  else p.kill("SIGTERM");
  await expect
    .poll(() => p.exitCode !== null || p.signalCode !== null, {
      timeout: 20000,
    })
    .toBe(true);
}
async function advances(page: Page, width?: number) {
  let last = 0;
  await expect
    .poll(
      async () => {
        const current = await page
          .getByLabel("Live stream video")
          .first()
          .evaluate((n) => {
            const v = n as HTMLVideoElement;
            return {
              width: v.videoWidth,
              time: v.currentTime,
              frames: v.getVideoPlaybackQuality().totalVideoFrames,
              playing: !v.paused && v.readyState >= 2,
            };
          })
          .catch(() => null);
        if (!current) return false;
        const ok =
          current.playing &&
          (!width || current.width === width) &&
          current.frames > last &&
          last > 0;
        last = current.frames;
        return ok;
      },
      { timeout, intervals: [500] },
    )
    .toBe(true);
}
async function socketFor(context: BrowserContext, csrf: string) {
  const s = io(origin, {
    transports: ["websocket"],
    extraHeaders: {
      Origin: origin,
      Cookie: (await context.cookies())
        .map((c) => c.name + "=" + c.value)
        .join("; "),
    },
    auth: { csrf },
    autoConnect: false,
    reconnectionDelay: 500,
  });
  await new Promise<void>((resolve, reject) => {
    s.once("connect", resolve);
    s.once("connect_error", reject);
    s.connect();
  });
  return s;
}
const emit = (s: Socket, event: string, body: object) =>
  new Promise<{ ok: boolean; data?: { id: string }; error?: { code: string } }>(
    (resolve, reject) =>
      s
        .timeout(10000)
        .emit(event, body, (e: Error | null, r: never) =>
          e ? reject(e) : resolve(r),
        ),
  );
async function crossReplicaChat(
  a: BrowserContext,
  b: BrowserContext,
  csrfA: string,
  csrfB: string,
  streamId: string,
  content: string,
) {
  const cookie = async (context: BrowserContext) =>
    (await context.cookies()).map((c) => c.name + "=" + c.value).join("; ");
  // Trusted test terminal only: pass session material via stdin, never command arguments or evidence.
  const program = `
    import WebSocket from "ws";
    let input = ""; for await (const chunk of process.stdin) input += chunk;
    const p = JSON.parse(input), clients = [];
    const timer = setTimeout(() => process.exit(2), 30000);
    const connect = (host, index) => new Promise((resolve, reject) => {
      const ws = new WebSocket("ws://" + host + ":" + p.port + "/socket.io/?EIO=4&transport=websocket", { headers: { Origin: p.origin, Cookie: p.cookies[index] } });
      const pending = new Map(); let seq = 0;
      const client = { disconnect: () => ws.close(), onMessage: () => {}, emit: (event, data) => new Promise((done, fail) => {
        const id = ++seq;
        const timeout = setTimeout(() => { pending.delete(id); fail(Error("Acknowledgement timeout")); }, 10000);
        pending.set(id, reply => { clearTimeout(timeout); done(reply); });
        ws.send("42" + id + JSON.stringify([event, data]));
      }) };
      clients.push(client);
      ws.on("error", reject);
      ws.on("message", raw => {
        const packet = raw.toString();
        if (packet.startsWith("0")) ws.send("40" + JSON.stringify({ csrf: p.csrf[index] }));
        else if (packet === "2") ws.send("3");
        else if (packet.startsWith("40")) resolve(client);
        else if (packet.startsWith("44")) reject(Error("Socket authorization rejected"));
        else if (packet.startsWith("42")) { const [event, value] = JSON.parse(packet.slice(2)); if (event === "message") client.onMessage(value); }
        else if (packet.startsWith("43")) { const match = /^43(\\d+)(\\[.*)$/.exec(packet); if (match) { pending.get(Number(match[1]))?.(JSON.parse(match[2])[0]); pending.delete(Number(match[1])); } }
      });
    });
    try {
      const a = await connect("api", 0), b = await connect("api-2", 1);
      for (const s of [a, b]) if (!(await s.emit("join", { streamId: p.streamId })).ok) throw Error("Join denied");
      let deliveries = 0;
      a.onMessage = m => { if (m.content === p.content && m.streamId === p.streamId) deliveries++; };
      const ack = await b.emit("message", { streamId: p.streamId, content: p.content });
      for (let i=0; i<50 && !deliveries; i++) await new Promise(r => setTimeout(r, 100));
      await new Promise(r => setTimeout(r, 500));
      if (!ack.ok || deliveries !== 1) throw Error("Cross-replica delivery failed");
      console.log(JSON.stringify({ sender: "api-2", receiver: "api-1", acknowledged: true, deliveries }));
    } finally { clearTimeout(timer); for (const s of clients) s.disconnect(); }
  `;
  return JSON.parse(
    execFileSync(
      "docker",
      [
        ...dynamicComposeArgs,
        "exec",
        "-T",
        "api-2",
        "node",
        "--input-type=module",
        "-e",
        program,
      ],
      {
        input: JSON.stringify({
          origin,
          port: Number(process.env.API_PORT),
          cookies: [await cookie(a), await cookie(b)],
          csrf: [csrfA, csrfB],
          streamId,
          content,
        }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 40000,
      },
    ),
  );
}
async function sample(page: Page) {
  await page.evaluate(() => {
    let previous: {
        video: HTMLVideoElement;
        time: number;
        frames: number;
      } | null = null,
      last = performance.now(),
      gap = 0,
      count = 0;
    const start = last;
    const timer = setInterval(() => {
      const v = document.querySelector("video");
      if (v && !v.paused && v.readyState >= 2) {
        const frames = v.getVideoPlaybackQuality().totalVideoFrames;
        if (
          previous &&
          previous.video === v &&
          v.currentTime > previous.time &&
          frames > previous.frames
        ) {
          gap = Math.max(gap, performance.now() - last);
          last = performance.now();
        }
        // Compare adjacent samples: a new origin may reset media time/counters.
        // Keep the last actual progress clock so a real interruption is retained.
        previous = { video: v, time: v.currentTime, frames };
      } else previous = null;
      count++;
    }, 250);
    (
      window as unknown as { stopDynamicSample: () => unknown }
    ).stopDynamicSample = () => {
      clearInterval(timer);
      return {
        samples: count,
        windowMs: performance.now() - start,
        maxProgressGapMs: Math.max(gap, performance.now() - last),
        thresholdMs: 2000,
      };
    };
  });
}
async function finishSample(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as { stopDynamicSample: () => unknown }
    ).stopDynamicSample(),
  );
}

test("real dynamic accounts, discovery, isolated media/chat, WHIP publishing and independent healing", async ({
  browser,
  request,
}) => {
  test.setTimeout(900000);
  const suffix = randomUUID().slice(0, 8),
    contexts: BrowserContext[] = [],
    publishers: ChildProcess[] = [],
    sockets: Socket[] = [],
    ids: string[] = [],
    keys: Publishing[] = [],
    viewers: Page[] = [],
    faults: unknown[] = [];
  const checks: Record<string, unknown> = {};
  let outcome = "FAIL";
  mkdirSync("test-results/dynamic", { recursive: true });
  try {
    expect((await request.get("/api/v1/auth/me")).status()).toBe(200);
    expect((await request.get("/api/v1/monitoring/chaos")).status()).toBe(401);
    const users = [];
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext();
      contexts.push(context);
      const user = await account(
        context.request,
        (i === 1 ? "lakshita_" : "dynamic" + i + "_") + suffix,
        "Dynamic-test-password-42",
      );
      users.push(user);
      const response = await write(context.request, user.csrf, "/channels", {
        slug: "dynamic-" + i + "-" + suffix,
        displayName: ["Alex · Technology", "Maya · Music", "Jordan · Learning"][
          i
        ],
        description: "Independent live broadcast test",
      });
      expect(response.status()).toBe(201);
      const channel = (
        await (await context.request.get("/api/v1/studio/channel")).json()
      ).channel;
      const created = await write(
        context.request,
        user.csrf,
        "/studio/streams",
        {
          channelId: channel.id,
          title:
            [
              "Build something live",
              "An independent live session",
              "Learn together, live",
            ][i] +
            " " +
            suffix,
          description: "Real media, separate channel",
          category: ["Technology", "Music", "Education"][i],
        },
      );
      expect(created.status()).toBe(201);
      const id = (await created.json()).id;
      ids.push(id);
      const key = await write(
        context.request,
        user.csrf,
        "/studio/streams/" + id + "/publishing",
      );
      expect(key.status()).toBe(200);
      keys.push(await key.json());
    }
    expect(new Set(keys.map((k) => k.path)).size).toBe(3);
    expect(new Set(keys.map((k) => k.key)).size).toBe(3);
    expect(
      (await (await request.get("/api/v1/live")).json()).streams.some(
        (s: { id: string }) => ids.includes(s.id),
      ),
    ).toBe(false);
    expect(
      (
        await write(
          contexts[1]!.request,
          users[1]!.csrf,
          "/studio/streams/" + ids[0] + "/publishing",
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await write(
          contexts[1]!.request,
          users[1]!.csrf,
          "/streams/" + ids[0] + "/moderation",
          { action: "ban", username: "dynamic2_" + suffix },
        )
      ).status(),
    ).toBe(403);
    checks.falseLiveAndOwnership = true;
    const feed = await contexts[1]!.newPage();
    await feed.goto("/live");
    await expect(
      feed.getByRole("heading", { name: "Live, right now." }),
    ).toBeVisible();
    let navigations = 0;
    const discoverySocket = await socketFor(contexts[1]!, users[1]!.csrf);
    sockets.push(discoverySocket);
    const liveHints = new Set<string>();
    discoverySocket.on(
      "discovery:v1",
      (event: { version: number; streamId: string; state: string }) => {
        if (event.version === 1 && event.state === "LIVE")
          liveHints.add(event.streamId);
      },
    );
    feed.on("framenavigated", (frame) => {
      if (frame === feed.mainFrame()) navigations++;
    });
    const widths = [640, 480, 320];
    for (let i = 0; i < 3; i++)
      publishers.push(
        publish(
          keys[i]!,
          widths[i] + "x" + Math.round(widths[i]! * 0.75),
          440 + i * 220,
        ),
      );
    for (const id of ids)
      await expect(feed.locator('[data-stream-id="' + id + '"]')).toBeVisible({
        timeout,
      });
    expect(navigations).toBe(0);
    await expect
      .poll(() => ids.every((id) => liveHints.has(id)), { timeout })
      .toBe(true);
    checks.automaticFeedWithoutReload = true;
    checks.typedLiveDiscoveryEvents = true;
    for (let i = 0; i < 3; i++) {
      const page = await contexts[(i + 1) % 3]!.newPage();
      viewers.push(page);
      await page.goto("/watch/" + ids[i]);
      await advances(page, widths[i]);
    }
    checks.threeIndependentDecodedWidths = widths;
    const filtered = await (
      await request.get("/api/v1/live?category=Music&q=" + suffix)
    ).json();
    expect(filtered.streams.map((s: { id: string }) => s.id)).toEqual([ids[1]]);
    checks.categoryFilter = true;
    const a = await socketFor(contexts[0]!, users[0]!.csrf),
      b = await socketFor(contexts[1]!, users[1]!.csrf),
      c = await socketFor(contexts[2]!, users[2]!.csrf);
    sockets.push(a, b, c);
    expect((await emit(a, "join", { streamId: ids[0] })).ok).toBe(true);
    expect((await emit(b, "join", { streamId: ids[0] })).ok).toBe(true);
    expect((await emit(c, "join", { streamId: ids[2] })).ok).toBe(true);
    const content = "Authenticated conversation " + suffix;
    let delivered = 0,
      leaked = 0;
    a.on("message", (m) => {
      if (m.content === content) delivered++;
    });
    c.on("message", (m) => {
      if (m.content === content) leaked++;
    });
    const sent = await emit(b, "message", { streamId: ids[0], content });
    expect(sent.ok).toBe(true);
    await expect.poll(() => delivered).toBe(1);
    expect(leaked).toBe(0);
    expect(
      (
        await (await request.get("/api/v1/streams/" + ids[0] + "/chat")).json()
      ).messages.some((m: { content: string }) => m.content === content),
    ).toBe(true);
    expect(
      (
        await write(
          contexts[0]!.request,
          users[0]!.csrf,
          "/streams/" + ids[0] + "/moderation",
          { action: "delete", messageId: sent.data!.id },
        )
      ).status(),
    ).toBe(200);
    expect(
      (
        await (await request.get("/api/v1/streams/" + ids[0] + "/chat")).json()
      ).messages.some((m: { id: string }) => m.id === sent.data!.id),
    ).toBe(false);
    expect(
      (
        await write(
          contexts[0]!.request,
          users[0]!.csrf,
          "/streams/" + ids[0] + "/moderation",
          { action: "ban", username: "lakshita_" + suffix },
        )
      ).status(),
    ).toBe(200);
    expect(
      (await emit(b, "message", { streamId: ids[0], content: "blocked" })).error
        ?.code,
    ).toBe("CHAT_BLOCKED");
    expect(
      (
        await write(
          contexts[0]!.request,
          users[0]!.csrf,
          "/streams/" + ids[0] + "/moderation",
          { action: "unban", username: "lakshita_" + suffix },
        )
      ).status(),
    ).toBe(200);
    expect(
      (
        await emit(b, "message", {
          streamId: ids[0],
          content: "Chat restored " + suffix,
        })
      ).ok,
    ).toBe(true);
    checks.authenticatedChatHistoryIsolationModeration = true;
    // Promote this newly registered test account only through the trusted local terminal.
    compose(
      "exec",
      "-T",
      "api-2",
      "node",
      "scripts/set-role.mjs",
      "dynamic0_" + suffix,
      "administrator",
    );
    const state = async () => {
      const response = await contexts[0]!.request.get(
        "/api/v1/monitoring/chaos",
      );
      return response.ok() ? ((await response.json()) as ChaosSnapshot) : null;
    };
    for (const [scenario, target] of [
      ["crash-api", "api-1"],
      ["crash-edge", "edge-1"],
      ["crash-primary", "origin-primary"],
    ]) {
      await expect
        .poll(
          async () =>
            (await state())?.scenarios.find((s) => s.id === scenario)
              ?.available,
          { timeout: 120000, intervals: [1000] },
        )
        .toBe(true);
      for (const page of viewers) await sample(page);
      const id = randomUUID(),
        response = await write(
          contexts[0]!.request,
          users[0]!.csrf,
          "/monitoring/chaos/experiments",
          { id, scenario, confirmation: target },
        );
      expect(response.status()).toBe(201);
      await expect
        .poll(
          async () =>
            (await state())?.experiments.find((e) => e.id === id)?.state,
          { timeout: 150000, intervals: [1000] },
        )
        .toBe("COMPLETED");
      const experiment = (await state())!.experiments.find(
        (e) => e.id === id,
      ) as ChaosExperiment;
      const playback = [];
      for (let i = 0; i < 3; i++) {
        playback.push(await finishSample(viewers[i]!));
        await advances(viewers[i]!, widths[i]);
      }
      expect(experiment.evidence.independentBehaviorVerified).toBe(true);
      faults.push({ experiment, playback });
    }
    checks.independentFaultRecovery = true;
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await feed.setViewportSize({ width, height: 1000 });
      await feed.goto("/");
      await expect(feed.locator("[data-stream-id]")).toHaveCount(3, {
        timeout,
      });
      await expect
        .poll(() =>
          feed.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
        )
        .toBe(true);
      await advances(feed, widths[2]);
      await feed.screenshot({
        path: "test-results/dynamic/home-" + width + ".png",
        fullPage: true,
        animations: "disabled",
      });
    }
    for (const width of [375, 1440]) {
      await viewers[0]!.setViewportSize({ width, height: 1000 });
      await advances(viewers[0]!, 640);
      await viewers[0]!.screenshot({
        path: "test-results/dynamic/watch-" + width + ".png",
        fullPage: true,
      });
    }
    await stop(publishers[1]!);
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/streams/" + ids[1])).json())
            .broadcastState,
        { timeout: 45000 },
      )
      .toBe("ENDED");
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/live")).json()).streams
            .filter((s: { id: string }) => ids.includes(s.id))
            .map((s: { id: string }) => s.id)
            .sort(),
        { timeout },
      )
      .toEqual([ids[0], ids[2]].sort());
    await advances(viewers[0]!, 640);
    await advances(viewers[2]!, 320);
    checks.independentSourceStop = true;
    const cameraEvidence: {
      network: unknown[];
      consoleErrors: number;
      pageErrors: number;
    } = { network: [], consoleErrors: 0, pageErrors: 0 };
    checks.exactCameraScenario = cameraEvidence;
    // A fourth independently registered account proves there is no fixed three-user platform limit.
    const cameraContext = await browser.newContext({
      permissions: ["camera", "microphone"],
    });
    contexts.push(cameraContext);
    await cameraContext.addInitScript(() => {
      const Original = window.RTCPeerConnection;
      const states: string[] = [];
      (window as unknown as { publishStates: string[] }).publishStates = states;
      window.RTCPeerConnection = class extends Original {
        constructor(config?: RTCConfiguration) {
          super(config);
          this.addEventListener("connectionstatechange", () =>
            states.push(this.connectionState),
          );
        }
      };
    });
    const studio = await cameraContext.newPage();
    studio.on("console", (m) => {
      if (m.type() === "error") cameraEvidence.consoleErrors++;
    });
    studio.on("pageerror", () => cameraEvidence.pageErrors++);
    studio.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith("/ingest/"))
        cameraEvidence.network.push({
          method: response.request().method(),
          path,
          status: response.status(),
        });
    });
    await studio.goto("/signup");
    await studio
      .getByLabel("Username", { exact: true })
      .fill("rashi_" + suffix);
    await studio
      .getByLabel("Email address")
      .fill("rashi_" + suffix + "@example.test");
    await studio
      .getByLabel("Password", { exact: true })
      .fill("Dynamic-camera-password-42");
    await studio
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(studio).toHaveURL(/\/studio/, { timeout });
    const registered = await (
      await cameraContext.request.get("/api/v1/auth/me")
    ).json();
    expect(
      (
        await write(cameraContext.request, registered.csrf, "/auth/logout")
      ).status(),
    ).toBe(200);
    const signedOut = await (
      await cameraContext.request.get("/api/v1/auth/me")
    ).json();
    expect(
      (
        await write(cameraContext.request, signedOut.csrf, "/auth/login", {
          identifier: "rashi_" + suffix,
          password: "Dynamic-camera-password-42",
        })
      ).status(),
    ).toBe(200);
    await studio.goto("/studio");
    await studio
      .getByLabel("Channel name", { exact: true })
      .fill("Camera Studio");
    await studio.getByLabel("Channel address").fill("camera-" + suffix);
    await studio
      .getByRole("button", { name: "Create channel", exact: true })
      .click();
    await studio
      .getByRole("button", { name: "Create livestream", exact: true })
      .click();
    await studio
      .getByLabel("Stream title", { exact: true })
      .fill("Rejected browser attempt " + suffix);
    await studio
      .getByRole("button", { name: "Create stream", exact: true })
      .click();
    await expect(
      studio.getByRole("button", { name: "Preview camera", exact: true }),
    ).toBeVisible();
    await studio
      .getByRole("button", { name: "Preview camera", exact: true })
      .click();
    await expect(
      studio.getByRole("button", { name: "Start Live", exact: true }),
    ).toBeEnabled({ timeout: 30000 });
    // Reproduce a rejected publish request: preview must not become LIVE and the owned key must be revoked.
    const rejectedId = (
      await (await cameraContext.request.get("/api/v1/studio/streams")).json()
    ).streams[0].id;
    await studio.route("**/ingest/**", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 401 })
        : route.continue(),
    );
    await studio
      .getByRole("button", { name: "Start Live", exact: true })
      .click();
    await expect(
      studio.getByText(/Publishing authorization rejected/),
    ).toBeVisible({ timeout: 30000 });
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/streams/" + rejectedId)).json())
            .lifecycle,
      )
      .toBe("ended");
    expect(
      (await (await request.get("/api/v1/live")).json()).streams.some(
        (s: { id: string }) => s.id === rejectedId,
      ),
    ).toBe(false);
    await studio.unroute("**/ingest/**");
    // A real accepted WHIP session with unreachable test-only ICE candidates must fail visibly and be deleted.
    await studio
      .getByRole("button", { name: "Create livestream", exact: true })
      .click();
    await studio
      .getByLabel("Stream title", { exact: true })
      .first()
      .fill("Blocked ICE attempt " + suffix);
    await studio
      .getByRole("button", { name: "Create stream", exact: true })
      .click();
    await studio
      .getByRole("button", { name: "Preview camera", exact: true })
      .click();
    await expect(
      studio.getByRole("button", { name: "Start Live", exact: true }),
    ).toBeEnabled({ timeout: 30000 });
    const blockedIceId = (
      await (await cameraContext.request.get("/api/v1/studio/streams")).json()
    ).streams[0].id;
    await studio.route("**/ingest/**", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      const answer = await response.text();
      expect(answer).toContain("a=candidate:");
      await route.fulfill({
        response,
        body: answer
          .replace(/^a=ice-ufrag:.*$/gm, "a=ice-ufrag:unreachabletest")
          .replace(/(a=candidate:\S+ \d+ \S+ \d+) \S+ \d+/g, "$1 192.0.2.1 9"),
      });
    });
    await studio
      .getByRole("button", { name: "Start Live", exact: true })
      .click();
    await expect(
      studio.getByText(/Media connection (timed out|failed)/),
    ).toBeVisible({ timeout: 40000 });
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/streams/" + blockedIceId)).json())
            .lifecycle,
      )
      .toBe("ended");
    expect(
      (await (await request.get("/api/v1/live")).json()).streams.some(
        (s: { id: string }) => s.id === blockedIceId,
      ),
    ).toBe(false);
    await studio.unroute("**/ingest/**");
    await studio
      .getByRole("button", { name: "Create livestream", exact: true })
      .click();
    await studio
      .getByLabel("Stream title", { exact: true })
      .first()
      .fill("learn c++ in 2 hour");
    await studio
      .getByRole("button", { name: "Create stream", exact: true })
      .click();
    const currentStudio = studio.locator(".studio-stream").filter({
      has: studio.getByRole("heading", {
        name: "learn c++ in 2 hour",
        exact: true,
      }),
    });
    await currentStudio
      .getByRole("button", { name: "Preview camera", exact: true })
      .click();
    await expect(
      currentStudio.getByRole("button", { name: "Start Live", exact: true }),
    ).toBeEnabled({ timeout: 30000 });
    await feed.goto("/live");
    let cameraFeedNavigations = 0;
    feed.on("framenavigated", (frame) => {
      if (frame === feed.mainFrame()) cameraFeedNavigations++;
    });
    await currentStudio
      .getByRole("button", { name: "Start Live", exact: true })
      .click();
    await expect(
      studio.getByText("Verified LIVE", { exact: true }),
    ).toBeVisible({ timeout });
    const browserStreams = await (
      await cameraContext.request.get("/api/v1/studio/streams")
    ).json();
    const browserId = browserStreams.streams[0].id;
    await expect(
      feed.locator('[data-stream-id="' + browserId + '"]'),
    ).toBeVisible({ timeout });
    expect(cameraFeedNavigations).toBe(0);
    await expect.poll(() => liveHints.has(browserId), { timeout }).toBe(true);
    const cameraViewer = feed;
    await feed
      .locator('[data-stream-id="' + browserId + '"] a')
      .first()
      .click();
    await expect(cameraViewer).toHaveURL(new RegExp("/watch/" + browserId));
    await advances(cameraViewer);
    const popupPromise = studio.waitForEvent("popup");
    await currentStudio.getByRole("link", { name: "Open watch page" }).click();
    const rashiWatch = await popupPromise;
    await expect(studio).toHaveURL(/\/studio/);
    await advances(rashiWatch);
    const thirdViewer = await contexts[2]!.newPage();
    await thirdViewer.goto("/live");
    await expect(
      thirdViewer.locator('[data-stream-id="' + browserId + '"]'),
    ).toBeVisible({ timeout });
    await thirdViewer.goto("/watch/" + browserId);
    await advances(thirdViewer);
    const cameraAuth = await (
      await cameraContext.request.get("/api/v1/auth/me")
    ).json();
    checks.crossReplicaCameraChat = await crossReplicaChat(
      cameraContext,
      contexts[1]!,
      cameraAuth.csrf,
      users[1]!.csrf,
      browserId,
      "Cross-replica camera " + suffix,
    );
    checks.mediaServerSnapshots = JSON.parse(
      compose(
        "exec",
        "-T",
        "api-2",
        "node",
        "--input-type=module",
        "-e",
        `
      const evidence = {};
      for (const [name, key] of [["relay", "MEDIA_API_BASE_URL"], ["primary", "MEDIA_DELIVERY_API_BASE_URL"], ["standby", "MEDIA_STANDBY_API_BASE_URL"]]) {
        const response = await fetch(process.env[key] + "/v3/paths/list", { headers: { Authorization: "Basic " + Buffer.from(process.env.MEDIA_API_USER + ":" + process.env.MEDIA_API_PASSWORD).toString("base64") }, signal: AbortSignal.timeout(5000) });
        const body = await response.json();
        evidence[name] = { status: response.status, paths: (body.items || []).map(p => ({ name: p.name, ready: p.ready, source: p.source?.type, tracks: p.tracks, bytes: p.inboundBytes ?? p.bytesReceived })) };
      }
      console.log(JSON.stringify(evidence));
    `,
      ),
    );
    const conversation = "Lakshita to Rashi " + suffix;
    await cameraViewer
      .getByLabel("Your message", { exact: true })
      .fill(conversation);
    await cameraViewer
      .getByRole("button", { name: "Send", exact: true })
      .click();
    await expect(
      cameraViewer.getByLabel("Your message", { exact: true }),
    ).toHaveValue("");
    for (const page of [rashiWatch, thirdViewer])
      await expect(
        page.getByRole("log").getByText(conversation, { exact: true }),
      ).toHaveCount(1);
    expect(
      (
        await (await request.get("/api/v1/streams/" + ids[2] + "/chat")).json()
      ).messages.some((m: { content: string }) => m.content === conversation),
    ).toBe(false);
    await cameraViewer.context().setOffline(true);
    await cameraViewer.context().setOffline(false);
    await expect(
      cameraViewer.getByLabel("Your message", { exact: true }),
    ).toBeEnabled({ timeout: 30000 });
    await advances(cameraViewer);
    await cameraViewer.screenshot({
      path: "test-results/dynamic/exact-lakshita-watch.png",
      fullPage: true,
    });
    await advances(viewers[0]!, 640);
    await advances(viewers[2]!, 320);
    const browserMedia = await cameraViewer
      .getByLabel("Live stream video")
      .evaluate((n) => {
        const v = n as HTMLVideoElement & {
          webkitAudioDecodedByteCount?: number;
        };
        return {
          width: v.videoWidth,
          height: v.videoHeight,
          audioDecodedBytes: v.webkitAudioDecodedByteCount ?? null,
        };
      });
    const meta = await (
      await request.get("/api/v1/streams/" + browserId)
    ).json();
    expect(meta.tracks.some((track: string) => /opus/i.test(track))).toBe(true);
    const audioRms = await cameraViewer
      .getByLabel("Live stream video")
      .evaluate(async (n) => {
        const video = n as HTMLVideoElement;
        video.muted = false;
        video.volume = 1;
        await video.play();
        const context = new AudioContext();
        await context.resume();
        const source = context.createMediaElementSource(video),
          analyser = context.createAnalyser();
        source.connect(analyser);
        analyser.connect(context.destination);
        analyser.fftSize = 512;
        const data = new Float32Array(analyser.fftSize);
        let maximum = 0;
        for (let i = 0; i < 50; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          analyser.getFloatTimeDomainData(data);
          maximum = Math.max(
            maximum,
            Math.sqrt(
              data.reduce((sum, value) => sum + value * value, 0) / data.length,
            ),
          );
        }
        source.disconnect();
        analyser.disconnect();
        await context.close();
        video.muted = true;
        return maximum;
      });
    expect(audioRms).toBeGreaterThan(0.001);
    checks.browserWhip = {
      status: "PASS",
      remoteDecoded: browserMedia,
      tracks: meta.tracks,
      remoteAudioRms: audioRms,
    };
    for (const [scenario, target] of [
      ["crash-api", "api-1"],
      ["crash-edge", "edge-1"],
    ]) {
      await expect
        .poll(
          async () =>
            (await state())?.scenarios.find((s) => s.id === scenario)
              ?.available,
          { timeout: 150000, intervals: [1000] },
        )
        .toBe(true);
      await sample(cameraViewer);
      const id = randomUUID();
      expect(
        (
          await write(
            contexts[0]!.request,
            users[0]!.csrf,
            "/monitoring/chaos/experiments",
            { id, scenario, confirmation: target },
          )
        ).status(),
      ).toBe(201);
      await expect
        .poll(
          async () =>
            (await state())?.experiments.find((e) => e.id === id)?.state,
          { timeout: 150000, intervals: [1000] },
        )
        .toBe("COMPLETED");
      const experiment = (await state())!.experiments.find((e) => e.id === id)!;
      expect(experiment.evidence.independentBehaviorVerified).toBe(true);
      await advances(cameraViewer);
      await advances(viewers[2]!, 320);
      const message = "Camera chat after " + scenario + " " + suffix;
      await expect(
        cameraViewer.getByLabel("Your message", { exact: true }),
      ).toBeEnabled({ timeout: 30000 });
      await cameraViewer
        .getByLabel("Your message", { exact: true })
        .fill(message);
      await cameraViewer
        .getByRole("button", { name: "Send", exact: true })
        .click();
      await expect(
        cameraViewer.getByLabel("Your message", { exact: true }),
      ).toHaveValue("");
      await expect(
        rashiWatch.getByRole("log").getByText(message, { exact: true }),
      ).toHaveCount(1, { timeout: 30000 });
      faults.push({
        scope: "exact-browser-camera",
        experiment,
        playback: await finishSample(cameraViewer),
        chat: "acknowledged and received",
      });
    }
    checks.exactCameraScenario = {
      ...cameraEvidence,
      status: "PASS",
      title: "learn c++ in 2 hour",
      separateAccounts: 3,
      automaticFeed: true,
      watchPopupPreservesPublishing: true,
      chatAcknowledgedAndReceivedOnce: true,
      isolatedOtherSource: true,
      iceStates: await studio.evaluate(
        () => (window as unknown as { publishStates: string[] }).publishStates,
      ),
    };
    await studio.setViewportSize({ width: 1440, height: 1000 });
    await studio.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    await studio.screenshot({
      path: "test-results/dynamic/studio-1440.png",
      fullPage: true,
    });
    await studio.setViewportSize({ width: 375, height: 1000 });
    await studio.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    await studio.screenshot({
      path: "test-results/dynamic/studio-375.png",
      fullPage: true,
    });
    await studio.getByRole("button", { name: "End Live", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/streams/" + browserId)).json())
            .status,
        { timeout: 30000 },
      )
      .toBe("offline");
    await expect(
      cameraViewer.getByRole("heading", { name: "Waiting for a broadcaster" }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      rashiWatch.getByRole("heading", { name: "Waiting for a broadcaster" }),
    ).toBeVisible({ timeout: 30000 });
    const afterEndFeed = await contexts[1]!.newPage();
    await afterEndFeed.goto("/live");
    await expect(
      afterEndFeed.locator('[data-stream-id="' + browserId + '"]'),
    ).toHaveCount(0);
    await advances(viewers[0]!, 640);
    await advances(viewers[2]!, 320);
    checks.fourthAccountAndBrowserEnd = true;
    expect(
      (
        await write(contexts[1]!.request, users[1]!.csrf, "/auth/logout")
      ).status(),
    ).toBe(200);
    expect(
      (await contexts[1]!.request.get("/api/v1/studio/channel")).status(),
    ).toBe(401);
    checks.logout = true;
    outcome = "PASS";
  } finally {
    writeFileSync(
      "test-results/dynamic/measurements.json",
      JSON.stringify(
        {
          status: outcome,
          measuredAt: new Date().toISOString(),
          checks,
          faults,
          streamIds: ids,
          limitations: [
            "Synthetic browser devices verify the real WHIP/media pipeline; no physical Windows camera, screen-share chooser or three LAN laptops were available.",
            "50K capacity is a separate unverified milestone.",
          ],
        },
        null,
        2,
      ),
    );
    for (const s of sockets) s.disconnect();
    for (const p of publishers) await stop(p);
    for (const c of contexts) await c.close();
  }
});
