import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { ChaosSnapshot, Stream } from "@streamshield/shared";
import { account, write } from "./platform-helpers";

test.use({ trace: "off", actionTimeout: 15000, navigationTimeout: 20000 });
test("real media authorization loss requires human restoration and produces understandable logs", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(240000);
  const project = process.env.SYSTEM_E2E_PROJECT || "";
  expect(project).toMatch(/^ss-light-[a-f0-9]{8}$/);
  const base = process.env.E2E_BASE_URL!;
  await page.setViewportSize({ width: 1600, height: 1100 });
  expect(["127.0.0.1", "localhost"]).toContain(new URL(base).hostname);
  const container = project + "-api-1";
  const labels = JSON.parse(
    execFileSync(
      "docker",
      ["inspect", "--format", "{{json .Config.Labels}}", container],
      { encoding: "utf8" },
    ),
  );
  expect(labels["com.docker.compose.project"]).toBe(project);
  expect(labels["streamshield.light-run"]).toBe(
    project.slice("ss-light-".length),
  );
  const suffix = randomUUID().slice(0, 8);
  const username = "e2e_system_" + suffix;
  const password = "System-test-only-password-42";
  await account(context.request, username, password);
  const changed = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "node",
      "--input-type=module",
      "-e",
      `
    import {readFileSync} from 'node:fs'; import {Pool} from 'pg';
    const username=JSON.parse(readFileSync(0,'utf8')).username;
    if(!/^e2e_system_[a-f0-9]{8}$/.test(username)) throw Error('test account required');
    const db=new Pool({host:process.env.POSTGRES_HOST,port:Number(process.env.POSTGRES_PORT),database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD});
    try { const r=await db.query("UPDATE users SET role='administrator' WHERE username=$1",[username]); console.log(r.rowCount); } finally { await db.end(); }
  `,
    ],
    {
      input: JSON.stringify({ username }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  expect(changed.trim()).toBe("1");
  const auth = await (await context.request.get("/api/v1/auth/me")).json();
  const csrf = auth.csrf;
  const state = async () =>
    (await (
      await context.request.get("/api/v1/monitoring/chaos", { timeout: 8000 })
    ).json()) as ChaosSnapshot;
  await expect
    .poll(
      async () =>
        (await state()).scenarios.find((s) => s.id === "media-authority-loss")
          ?.available,
      { timeout: 60000 },
    )
    .toBe(true);
  const streams = await (await context.request.get("/api/v1/streams")).json();
  const stream = streams.streams.find(
    (s: Stream) => s.status === "live",
  ) as Stream;
  expect(stream).toBeTruthy();
  const sources = stream.playbackSources!;
  expect(sources).toHaveLength(2);
  const viewer = await browser.newContext({ baseURL: base });
  const report: Record<string, unknown> = {
    project,
    simulatedExternalAuthority: true,
  };
  let experimentId: string | undefined;
  try {
    const viewerAuth = await account(
      viewer.request,
      "e2e_sysview_" + suffix,
      password,
    );
    expect((await viewer.request.get("/api/v1/monitoring/logs")).status()).toBe(
      403,
    );
    const audience = await viewer.newPage();
    await audience.goto("/watch/" + stream.id);
    await expect(audience.getByTestId("playback-state")).toHaveText("playing", {
      timeout: 30000,
    });
    const frames = () =>
      audience
        .locator("video")
        .evaluate(
          (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames,
        );
    const before = await frames();
    await expect.poll(frames, { timeout: 15000 }).toBeGreaterThan(before + 5);
    await page.goto("/control/chaos");
    await expect(page.locator("[data-scenario]")).toHaveCount(5);
    await page.locator('[data-scenario="media-authority-loss"]').click();
    await page
      .getByRole("button", { name: "Run failure demonstration", exact: true })
      .click();
    await page.getByRole("checkbox").check();
    await page
      .getByLabel("Confirm target", { exact: true })
      .fill("media-authority");
    await page
      .getByRole("button", { name: "Inject controlled failure", exact: true })
      .click();
    await expect(page.getByTestId("manual-recovery")).toBeVisible({
      timeout: 30000,
    });
    await expect
      .poll(async () => (await state()).experiments[0]?.state, {
        timeout: 30000,
      })
      .toBe("AWAITING_OPERATOR");
    const experiment = (await state()).experiments[0]!;
    experimentId = experiment.id;
    expect(experiment.actionStartedAt).toBeNull();
    expect(experiment.recoveryIds).toHaveLength(0);
    expect(
      (
        await write(
          viewer.request,
          viewerAuth.csrf,
          "/monitoring/chaos/experiments/" +
            experimentId +
            "/restore-media-authority",
          { confirmation: "media-authority" },
        )
      ).status(),
    ).toBe(403);
    for (const source of sources) {
      const r = await viewer.request.get(source.url);
      expect(r.status()).toBe(503);
      expect(r.headers()["x-media-authority"]).toBe("unavailable");
    }
    report.bothVideoRoutesDenied = true;
    console.log("Verified: both video routes reject actual media reads.");
    await expect(audience.getByTestId("live-service-impact")).toHaveAttribute(
      "data-state",
      "human_required",
      { timeout: 15000 },
    );
    // Buffered video is allowed to drain naturally; no UI code pauses the player.
    let last = await frames();
    let sameSince = Date.now();
    await expect
      .poll(
        async () => {
          const current = await frames();
          if (current !== last) {
            sameSince = Date.now();
            last = current;
          }
          return Date.now() - sameSince >= 4000;
        },
        { timeout: 70000, intervals: [1000] },
      )
      .toBe(true);
    report.decodedPlaybackActuallyStopped = true;
    console.log("Verified: decoded video stopped after the buffer drained.");
    await expect
      .poll(async () => (await state()).experiments[0]?.state)
      .toBe("AWAITING_OPERATOR");
    await page.screenshot({
      path: "test-results/system/manual-recovery.png",
      fullPage: true,
    });
    await page
      .getByLabel("Confirm manual media restoration")
      .fill("media-authority");
    await expect(
      page.getByRole("button", {
        name: "Restore demo media authorization",
        exact: true,
      }),
    ).toBeEnabled();
    await page
      .getByRole("button", {
        name: "Restore demo media authorization",
        exact: true,
      })
      .click();
    await expect
      .poll(async () => (await state()).experiments[0]?.state, {
        timeout: 60000,
      })
      .toBe("COMPLETED");
    const restored = (await state()).experiments[0]!;
    expect(restored.evidence).toMatchObject({
      automaticallyHealed: false,
      independentBehaviorVerified: true,
      externalAuthorityUnavailable: false,
    });
    expect(restored.actionStartedAt).toBeNull();
    expect(restored.recoveryIds).toHaveLength(0);
    report.operatorRestoration = {
      state: restored.state,
      automaticallyHealed: false,
      advancingVideoVerified: true,
    };
    console.log(
      "Verified: operator restoration recorded and advancing video independently checked.",
    );
    for (const source of sources)
      expect(
        (await viewer.request.get(source.url, { timeout: 8000 })).ok(),
      ).toBe(true);
    if (
      await audience
        .getByRole("button", { name: "Retry playback", exact: true })
        .isVisible()
    )
      await audience
        .getByRole("button", { name: "Retry playback", exact: true })
        .click();
    const after = await frames();
    await expect.poll(frames, { timeout: 40000 }).toBeGreaterThan(after + 5);
    report.decodedPlaybackResumed = true;
    console.log("Verified: decoded video resumed.");
    const logs = await (
      await context.request.get("/api/v1/monitoring/logs?hours=1", {
        timeout: 8000,
      })
    ).json();
    expect(logs.partial).toBe(false);
    expect(
      logs.entries.some((e: { message: string }) =>
        e.message.includes("not automatically healed"),
      ),
    ).toBe(true);
    await page
      .getByRole("link", { name: /System logs/, exact: false })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Logs you can understand." }),
    ).toBeVisible();
    await expect(page.locator(".log-entry")).not.toHaveCount(0);
    await page.getByLabel("Search logs").fill("signing");
    await expect(page.locator(".log-entry")).not.toHaveCount(0);
    await expect(page.locator(".log-body").first()).toContainText(/signing/i);
    await page.getByLabel("Search logs").fill("");
    await page
      .getByRole("combobox", { name: "Source", exact: true })
      .selectOption("experiment");
    await page
      .getByRole("button", { name: "Pause updates", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Resume updates", exact: true }),
    ).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download filtered logs", exact: true })
      .click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("streamshield-system-logs.json");
    const exported = JSON.parse(readFileSync((await download.path())!, "utf8"));
    expect(exported.entries.length).toBeGreaterThan(0);
    expect(
      exported.entries.every(
        (entry: { source: string }) => entry.source === "experiment",
      ),
    ).toBe(true);
    expect(JSON.stringify(exported)).not.toContain(password);
    await page.screenshot({
      path: "test-results/system/system-logs.png",
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("heading", { name: "Logs you can understand." })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("heading", { name: "Logs you can understand." }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/system/system-logs-mobile.png",
      fullPage: false,
    });
    report.logsReadableAndFilterable = true;
    report.viewerCannotReadLogsOrRestore = true;
    report.status = "PASS";
    mkdirSync("test-results/system", { recursive: true });
    writeFileSync(
      "test-results/system/verification.json",
      JSON.stringify(report, null, 2),
    );
  } finally {
    if (experimentId) {
      const e = (await state().catch(() => null))?.experiments.find(
        (e) => e.id === experimentId,
      );
      if (e?.evidence.externalAuthorityUnavailable === true)
        await write(
          context.request,
          csrf,
          "/monitoring/chaos/experiments/" +
            experimentId +
            "/restore-media-authority",
          { confirmation: "media-authority" },
        );
    }
    await viewer.close();
  }
});
