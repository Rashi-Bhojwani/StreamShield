import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { account } from "./platform-helpers";

test.use({ trace: "off", permissions: ["camera", "microphone"] });
test("broadcaster keeps publishing while reading and replying to real viewer comments", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(240000);
  const baseURL = process.env.E2E_BASE_URL!;
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL).hostname);
  const suffix = randomUUID().slice(0, 8);
  const password = "Studio-test-only-password-42";
  await account(context.request, "e2e_studio_" + suffix, password);
  const availability = await context.request.get(
    "/api/v1/monitoring/experience",
  );
  expect(availability.ok()).toBeTruthy();
  expect((await availability.json()).enabled).toBe(true);
  const viewer = await browser.newContext({ baseURL });
  try {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto("/studio");
    await page
      .getByLabel("Channel name", { exact: true })
      .fill("Live with Studio");
    await page
      .getByLabel("Channel address", { exact: true })
      .fill("studio-" + suffix);
    await page
      .getByRole("button", { name: "Create channel", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create livestream", exact: true })
      .click();
    await page
      .getByLabel("Stream title", { exact: true })
      .fill("Behind the stream · camera and community");
    await page
      .getByRole("button", { name: "Create stream", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Preview camera", exact: true })
      .click();
    await expect(
      page.getByText("Camera and microphone preview ready", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Start Live", exact: true }).click();
    await expect(page.getByTestId("studio-publish-state")).toHaveText(
      "Live · your broadcast is available to viewers.",
      { timeout: 70000 },
    );
    const comments = page.getByRole("complementary", {
      name: "Broadcast live comments",
    });
    await expect(comments.getByTestId("chat-status")).toHaveAttribute(
      "data-status",
      "Connected",
    );
    const watch = await page
      .getByRole("link", { name: /Open watch page/ })
      .getAttribute("href");
    await account(viewer.request, "e2e_audience_" + suffix, password);
    const audience = await viewer.newPage();
    await audience.goto(watch!);
    await expect(audience.getByTestId("chat-status")).toHaveAttribute(
      "data-status",
      "Connected",
    );
    await audience
      .getByLabel("Your message")
      .fill("Your camera is live. Hello from the audience!");
    await audience.getByRole("button", { name: "Send", exact: true }).click();
    await expect(comments.getByRole("log")).toContainText(
      "Hello from the audience!",
    );
    await comments
      .getByLabel("Your message")
      .fill("Thanks for joining! Replying without leaving Studio.");
    await comments.getByRole("button", { name: "Send", exact: true }).click();
    await expect(audience.getByRole("log")).toContainText(
      "Replying without leaving Studio.",
    );
    await expect
      .poll(
        () =>
          audience
            .locator("video")
            .evaluate(
              (v: HTMLVideoElement) =>
                v.getVideoPlaybackQuality().totalVideoFrames,
            ),
        { timeout: 45000 },
      )
      .toBeGreaterThan(10);
    await expect(page.getByTestId("studio-publish-state")).toHaveText(
      "Live · your broadcast is available to viewers.",
    );
    const streamId = watch!.split("/").at(-1);
    await expect
      .poll(
        async () =>
          (
            await (
              await context.request.get(
                "/api/v1/streams/" + streamId + "/presence",
              )
            ).json()
          ).count,
        { timeout: 30000 },
      )
      .toBe(1);
    await expect(
      comments.getByText("1 approximate active player", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: "test-results/studio/desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(comments.getByRole("log")).toContainText(
      "Hello from the audience!",
    );
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: "test-results/studio/mobile.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "End Live", exact: true }).click();
    await expect(page.getByTestId("studio-publish-state")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await (
              await context.request.get("/api/v1/streams/" + streamId)
            ).json()
          ).lifecycle,
      )
      .toBe("ended");
  } finally {
    await viewer.close();
  }
});
