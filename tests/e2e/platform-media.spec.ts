import { test, expect } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cleanup, account, write, capture } from "./platform-helpers";
import type { Publishing } from "@streamshield/shared";
test.use({ trace: "off" });
const timeout = Number(process.env.MEDIA_TEST_TIMEOUT_MS);
function publish(p: Publishing, size: string) {
  return spawn(process.execPath, ["scripts/test-publisher.mjs"], {
    env: {
      ...process.env,
      MEDIA_STREAM_PATH: p.path,
      MEDIA_PUBLISH_USER: p.user,
      MEDIA_PUBLISH_PASSWORD: p.key,
      TEST_PUBLISH_SIZE: size,
      TEST_PUBLISH_DURATION_SECONDS: "180",
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  if (child.connected) child.send("stop");
  else child.kill("SIGTERM");
  await expect
    .poll(() => child.exitCode !== null || child.signalCode !== null, {
      timeout,
    })
    .toBe(true);
}
const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", ...args], { stdio: "ignore", timeout });
test("two owned RTMP streams, decoded viewers, rotation, presence, chat and dependency degradation", async ({
  browser,
  request,
}) => {
  test.setTimeout(timeout * 8);
  const initial = await (await request.get("/api/v1/streams?limit=100")).json();
  expect(
    initial.streams.every(
      (s: { publisher: string }) => s.publisher !== "online",
    ),
    "Run media tests only on an idle development stack",
  ).toBe(true);
  const contexts = await Promise.all([
    browser.newContext({ baseURL: process.env.E2E_BASE_URL }),
    browser.newContext({ baseURL: process.env.E2E_BASE_URL }),
  ]);
  const ids: string[] = [],
    children: ChildProcess[] = [];
  let redisStopped = false,
    dbStopped = false;
  const suffix = randomUUID().slice(0, 8);
  try {
    const users = await Promise.all(
      contexts.map((context, i) =>
        account(
          context.request,
          "e2e_stream" + i + "_" + suffix,
          "Media-test-only-password-42",
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
            slug: "signal-" + i + "-" + suffix,
            displayName: i ? "Signal Two" : "Signal One",
            description: "Independent real media test channel.",
          })
        ).status(),
      ).toBe(201);
      const channel = (
        await (await ctx.request.get("/api/v1/studio/channel")).json()
      ).channel;
      const created = await write(ctx.request, csrf, "/studio/streams", {
        channelId: channel.id,
        title: i ? "A second live signal" : "Inside the live studio",
        description: "Actual FFmpeg test video with durable channel data.",
      });
      expect(created.status()).toBe(201);
      streams.push((await created.json()).id);
      const publishing = await write(
        ctx.request,
        csrf,
        "/studio/streams/" + streams[i] + "/publishing",
      );
      expect(publishing.status()).toBe(200);
      keys.push(await publishing.json());
    }
    expect(keys[0]!.path).not.toBe(keys[1]!.path);
    // A correct key for A is invalid on B even before B has a publisher.
    const cross = publish({ ...keys[0]!, path: keys[1]!.path }, "320x180");
    children.push(cross);
    await expect.poll(() => cross.exitCode, { timeout }).not.toBeNull();
    expect(cross.exitCode).not.toBe(0);
    let first = publish(keys[0]!, "640x360");
    const second = publish(keys[1]!, "320x180");
    children.push(first, second);
    for (let i = 0; i < 2; i++)
      await expect
        .poll(
          async () =>
            (await (await request.get("/api/v1/streams/" + streams[i])).json())
              .status,
          { timeout },
        )
        .toBe("live");
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    for (let i = 0; i < 2; i++) {
      await pages[i]!.goto("/watch/" + streams[i]);
      await expect(pages[i]!.getByTestId("playback-state")).toHaveText(
        "playing",
        { timeout },
      );
      await expect
        .poll(
          () =>
            pages[i]!.getByLabel("Live stream video").evaluate(
              (node) => (node as HTMLVideoElement).videoWidth,
            ),
          { timeout },
        )
        .toBe(i ? 320 : 640);
      await expect
        .poll(
          () =>
            pages[i]!.getByLabel("Live stream video").evaluate(
              (node) =>
                (node as HTMLVideoElement).getVideoPlaybackQuality()
                  .totalVideoFrames,
            ),
          { timeout },
        )
        .toBeGreaterThan(0);
    }
    const viewer = await contexts[1]!.newPage();
    await viewer.goto("/watch/" + streams[0]);
    await expect(viewer.getByTestId("playback-state")).toHaveText("playing", {
      timeout,
    });
    await expect(
      pages[0]!.getByText("Connected", { exact: true }),
    ).toBeVisible();
    await expect(viewer.getByText("Connected", { exact: true })).toBeVisible();
    await pages[0]!
      .getByLabel("Your message")
      .fill("Two independent signals. One conversation here.");
    await pages[0]!.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      viewer.getByRole("log", { name: "Chat messages" }),
    ).toContainText("One conversation here.");
    await expect(
      pages[1]!.getByRole("log", { name: "Chat messages" }),
    ).not.toContainText("One conversation here.");
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get("/api/v1/streams/" + streams[0] + "/presence")
            ).json()
          ).count,
        { timeout },
      )
      .toBe(2);
    const duplicate = await contexts[0]!.newPage();
    await duplicate.goto("/watch/" + streams[0]);
    await expect(duplicate.getByTestId("playback-state")).toHaveText(
      "playing",
      { timeout },
    );
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get("/api/v1/streams/" + streams[0] + "/presence")
            ).json()
          ).count,
        { timeout },
      )
      .toBe(2);
    await duplicate.close();
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await pages[0]!.setViewportSize({ width, height: 1000 });
      expect(
        await pages[0]!.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await capture(
        pages[0]!,
        "test-results/phase3-live/watch-" + width + ".png",
      );
    }
    await pages[0]!.goto("/");
    await expect(pages[0]!.getByTestId("playback-state")).toHaveText(
      "playing",
      { timeout },
    );
    await capture(pages[0]!, "test-results/phase3-live/home-1920.png");
    await pages[0]!.goto("/watch/" + streams[0]);
    await expect(pages[0]!.getByTestId("playback-state")).toHaveText(
      "playing",
      { timeout },
    );
    const rotated = await write(
      contexts[0]!.request,
      users[0]!.csrf,
      "/studio/streams/" + streams[0] + "/publishing",
    );
    expect(rotated.status()).toBe(200);
    const newKey = (await rotated.json()) as Publishing;
    await expect.poll(() => first.exitCode, { timeout }).not.toBeNull();
    const old = publish(keys[0]!, "640x360");
    children.push(old);
    await expect.poll(() => old.exitCode, { timeout }).not.toBeNull();
    expect(old.exitCode).not.toBe(0);
    first = publish(newKey, "640x360");
    children.push(first);
    await expect(pages[0]!.getByTestId("playback-state")).toHaveText(
      "playing",
      { timeout },
    );
    await expect(pages[1]!.getByTestId("playback-state")).toHaveText("playing");
    const progress = async () =>
      pages[0]!
        .getByLabel("Live stream video")
        .evaluate((node) => (node as HTMLVideoElement).currentTime);
    compose("stop", "redis");
    redisStopped = true;
    const beforeRedis = await progress();
    await expect.poll(progress, { timeout }).toBeGreaterThan(beforeRedis + 2);
    await expect(
      pages[0]!.getByText("Viewer estimate unavailable", { exact: true }),
    ).toBeVisible({ timeout });
    compose("up", "-d", "--no-build", "--wait", "redis");
    redisStopped = false;
    compose("stop", "postgres");
    dbStopped = true;
    const beforeDb = await progress();
    await expect.poll(progress, { timeout }).toBeGreaterThan(beforeDb + 2);
    compose("up", "-d", "--no-build", "--wait", "postgres");
    dbStopped = false;
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/streams/" + streams[1])).json())
            .title,
        { timeout },
      )
      .toBe("A second live signal");
    await expect
      .poll(
        async () =>
          (
            await (
              await contexts[1]!.request.get(
                "/api/v1/streams/" + streams[0] + "/chat",
              )
            ).json()
          ).messages?.length,
        { timeout },
      )
      .toBeGreaterThan(0);
    await expect(pages[0]!.getByText("Connected", { exact: true })).toBeVisible(
      { timeout },
    );
    await expect(viewer.getByText("Connected", { exact: true })).toBeVisible({
      timeout,
    });
    await viewer
      .getByLabel("Your message")
      .fill("Chat returned after the dependency restart.");
    await viewer.getByLabel("Your message").press("Enter");
    await expect(
      pages[0]!.getByRole("log", { name: "Chat messages" }),
    ).toContainText("Chat returned after the dependency restart.", { timeout });
    // Ending revokes and kicks the correct stream while the other remains independent.
    expect(
      (
        await write(
          contexts[0]!.request,
          users[0]!.csrf,
          "/studio/streams/" + streams[0] + "/end",
        )
      ).status(),
    ).toBe(200);
    await expect.poll(() => first.exitCode, { timeout }).not.toBeNull();
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/streams/" + streams[0])).json())
            .status,
        { timeout },
      )
      .toBe("offline");
    await expect(pages[1]!.getByTestId("playback-state")).toHaveText("playing");
    console.log(
      "Verified two independent RTMP/HLS sources (640x360 and 320x180), decoded viewers, Redis chat/presence, active key rotation, publisher termination, durable database restart and uninterrupted HLS through Redis/PostgreSQL outages.",
    );
  } finally {
    for (const child of children) await stop(child);
    if (redisStopped) compose("up", "-d", "--no-build", "--wait", "redis");
    if (dbStopped) compose("up", "-d", "--no-build", "--wait", "postgres");
    for (const context of contexts) await context.close();
    cleanup(ids);
  }
});
