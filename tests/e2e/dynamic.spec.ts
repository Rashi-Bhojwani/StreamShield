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
        "dynamic" + i + "_" + suffix,
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
          { action: "ban", username: "dynamic1_" + suffix },
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
          { action: "unban", username: "dynamic1_" + suffix },
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
    // A fourth independently registered account proves there is no fixed three-user platform limit.
    const cameraContext = await browser.newContext({
      permissions: ["camera", "microphone"],
    });
    contexts.push(cameraContext);
    const studio = await cameraContext.newPage();
    await studio.goto("/signup");
    await studio
      .getByLabel("Username", { exact: true })
      .fill("camera_" + suffix);
    await studio
      .getByLabel("Email address")
      .fill("camera_" + suffix + "@example.test");
    await studio
      .getByLabel("Password", { exact: true })
      .fill("Dynamic-camera-password-42");
    await studio
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(studio).toHaveURL(/\/studio/, { timeout });
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
      .fill("Browser camera live " + suffix);
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
    await studio
      .getByRole("button", { name: "Start Live", exact: true })
      .click();
    await expect(
      studio.getByText("Verified LIVE", { exact: true }),
    ).toBeVisible({ timeout });
    const browserStreams = await (
      await cameraContext.request.get("/api/v1/studio/streams")
    ).json();
    const browserId = browserStreams.streams[0].id;
    const cameraViewer = await contexts[2]!.newPage();
    await cameraViewer.goto("/watch/" + browserId);
    await advances(cameraViewer);
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
    await studio.setViewportSize({ width: 1440, height: 1000 });
    await studio.screenshot({
      path: "test-results/dynamic/studio-1440.png",
      fullPage: true,
    });
    await studio.setViewportSize({ width: 375, height: 1000 });
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
