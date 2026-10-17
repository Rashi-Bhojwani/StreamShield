import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { streamSchema } from "@streamshield/shared";

const settings = z
  .object({
    MEDIA_STREAM_PATH: z.string(),
    MEDIA_TEST_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000),
    MEDIA_TEST_POLL_MS: z.coerce.number().int().min(100).max(2000),
  })
  .parse(process.env);
const timeout = settings.MEDIA_TEST_TIMEOUT_MS;
const root = fileURLToPath(new URL("../../", import.meta.url));
function publish(extra: NodeJS.ProcessEnv = {}) {
  return spawn(process.execPath, ["scripts/test-publisher.mjs"], {
    cwd: root,
    env: { ...process.env, ...extra },
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
function compose(...args: string[]) {
  execFileSync("docker", ["compose", ...args], {
    cwd: root,
    stdio: "ignore",
    timeout,
  });
}
test("real encoded RTMP → HLS → browser, source interruption and origin outage", async ({
  page,
  request,
}) => {
  test.setTimeout(timeout * 5);
  const endpoint = "/api/v1/streams/" + settings.MEDIA_STREAM_PATH;
  const observation = async () =>
    streamSchema.parse(await (await request.get(endpoint)).json());
  // Never interrupt a pre-existing broadcaster. This test owns only the children it starts.
  expect(
    (await observation()).status,
    "Start media services and stop your broadcaster before this test",
  ).toBe("offline");
  let publisher: ChildProcess | undefined;
  let bad: ChildProcess | undefined;
  let wrongPath: ChildProcess | undefined;
  let competing: ChildProcess | undefined;
  let originStopped = false;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    bad = publish({
      MEDIA_PUBLISH_PASSWORD: "invalid-test-password-not-a-real-key",
    });
    await expect.poll(() => bad?.exitCode, { timeout }).not.toBeNull();
    expect(bad.exitCode).not.toBe(0);
    expect((await observation()).status).toBe("offline");
    wrongPath = publish({ MEDIA_STREAM_PATH: "unconfigured-test-path" });
    await expect.poll(() => wrongPath?.exitCode, { timeout }).not.toBeNull();
    expect(wrongPath.exitCode).not.toBe(0);
    publisher = publish();
    await expect
      .poll(async () => (await observation()).status, {
        timeout,
        intervals: [settings.MEDIA_TEST_POLL_MS],
      })
      .toBe("live");
    competing = publish();
    await expect.poll(() => competing?.exitCode, { timeout }).not.toBeNull();
    expect(competing.exitCode).not.toBe(0);
    expect(publisher.exitCode).toBeNull();
    const stream = await observation();
    const master = await request.get(stream.playbackUrl);
    expect(master.ok()).toBe(true);
    const masterText = await master.text();
    expect(masterText).toContain("#EXTM3U");
    const rendition = masterText
      .split(/\r?\n/)
      .find((line) => line.trim() && !line.startsWith("#"));
    expect(rendition).toBeTruthy();
    const playlistUrl = new URL(rendition!, master.url());
    expect(playlistUrl.origin).toBe(new URL(master.url()).origin);
    const media = await request.get(playlistUrl.toString());
    expect(media.ok()).toBe(true);
    const mediaText = await media.text();
    expect(mediaText).toContain("#EXTINF");
    const segment = mediaText
      .split(/\r?\n/)
      .find((line) => line.trim() && !line.startsWith("#"));
    expect(segment).toBeTruthy();
    const segmentUrl = new URL(segment!, playlistUrl);
    expect(segmentUrl.origin).toBe(playlistUrl.origin);
    const bytes = await request.get(segmentUrl.toString());
    expect(bytes.ok()).toBe(true);
    expect((await bytes.body()).byteLength).toBeGreaterThan(100);
    await page.goto("/watch/" + settings.MEDIA_STREAM_PATH);
    const video = page.getByLabel("Live stream video");
    await expect(page.getByTestId("playback-state")).toHaveText("playing", {
      timeout,
    });
    await expect
      .poll(
        () => video.evaluate((node) => (node as HTMLVideoElement).videoWidth),
        { timeout },
      )
      .toBeGreaterThan(0);
    const initial = await video.evaluate(
      (node) => (node as HTMLVideoElement).currentTime,
    );
    await expect
      .poll(
        () => video.evaluate((node) => (node as HTMLVideoElement).currentTime),
        { timeout },
      )
      .toBeGreaterThan(initial + 2);
    const frames = await video.evaluate(
      (node) =>
        (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
    );
    expect(frames).toBeGreaterThan(0);
    expect(
      await video.evaluate((node) => (node as HTMLVideoElement).muted),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/live-stream-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 375, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/live-stream-mobile.png",
      fullPage: true,
    });
    for (const width of [375, 768, 1280, 1440, 1680, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      const box = await video.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(box!.width / box!.height - 16 / 9)).toBeLessThan(0.02);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/live-watch-${width}.png`,
        fullPage: true,
      });
    }
    await page.goto("/");
    await expect(page.getByTestId("playback-state")).toHaveText("playing", {
      timeout,
    });
    await expect
      .poll(
        () =>
          page
            .getByLabel("Live stream video")
            .evaluate((node) => (node as HTMLVideoElement).currentTime),
        { timeout },
      )
      .toBeGreaterThan(1);
    await page.screenshot({
      path: "test-results/live-home-1920.png",
      fullPage: true,
    });
    await page.goto(`/watch/${encodeURIComponent(settings.MEDIA_STREAM_PATH)}`);
    await expect(page.getByTestId("playback-state")).toHaveText("playing", {
      timeout,
    });
    await stop(publisher);
    publisher = undefined;
    await expect
      .poll(async () => (await observation()).status, { timeout })
      .toBe("offline");
    await expect(
      page.getByRole("heading", { name: "Waiting for a broadcaster" }),
    ).toBeVisible({ timeout });
    publisher = publish();
    await expect(page.getByTestId("playback-state")).toHaveText("playing", {
      timeout,
    });
    await expect
      .poll(
        () =>
          page
            .getByLabel("Live stream video")
            .evaluate((node) => (node as HTMLVideoElement).currentTime),
        { timeout },
      )
      .toBeGreaterThan(1);
    await stop(publisher);
    publisher = undefined;
    compose("stop", "mediamtx");
    originStopped = true;
    await expect
      .poll(async () => (await observation()).status, { timeout })
      .toBe("unavailable");
    expect((await request.get("/api/v1/health/ready")).status()).toBe(200);
    await expect(
      page.getByText("Origin unavailable", { exact: true }),
    ).toBeVisible({ timeout });
    compose("up", "-d", "--no-build", "--wait", "mediamtx");
    originStopped = false;
    await expect
      .poll(async () => (await observation()).status, { timeout })
      .toBe("offline");
    expect(errors).toEqual([]);
    console.log(
      `Verified H264/AAC publication, HLS segment bytes, ${frames} decoded browser frames, source stop/return and origin-unavailable reporting.`,
    );
  } finally {
    await stop(publisher);
    await stop(competing);
    await stop(bad);
    await stop(wrongPath);
    if (originStopped) compose("up", "-d", "--no-build", "--wait", "mediamtx");
  }
});
