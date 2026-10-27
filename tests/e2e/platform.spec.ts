import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { cleanup, account, capture } from "./platform-helpers";
test.use({ trace: "off" }); // Authentication and one-time publishing secrets must never enter traces.
test("real accounts, Studio/channel/stream, session restoration, chat and responsive product screens", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  const ids: string[] = [],
    suffix = randomUUID().slice(0, 8),
    username = "e2e_" + suffix,
    password = "Browser-test-only-password-42";
  const viewerContext = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
  });
  try {
    await page.goto("/studio");
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await page.goto("/signup");
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(
        page.getByRole("heading", { name: "Create your account" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await capture(page, "test-results/phase3/signup-" + width + ".png");
    }
    await page.getByLabel("Username", { exact: true }).fill(username);
    await page.getByLabel("Email address").fill(username + "@example.test");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "A channel to call your own." }),
    ).toBeVisible();
    const me = await (await page.request.get("/api/v1/auth/me")).json();
    ids.push(me.user.id);
    await page
      .getByLabel("Channel name", { exact: true })
      .fill("Live with Maya");
    await page.getByLabel("Channel address").fill("maya-" + suffix);
    await page
      .getByLabel("About your channel")
      .fill("Creative conversations and real live moments.");
    await page
      .getByRole("button", { name: "Create channel", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Live with Maya", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Create livestream", exact: true })
      .click();
    await page
      .getByLabel("Stream title", { exact: true })
      .fill("An evening in the studio");
    await page
      .getByLabel("Stream description")
      .fill("A real test-created broadcast, ready for a publisher.");
    await page
      .getByRole("button", { name: "Create stream", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "An evening in the studio",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Create publishing key", exact: true })
      .click();
    await expect(page.getByLabel("Private stream key")).toHaveAttribute(
      "type",
      "password",
    );
    await page.getByRole("button", { name: "Dismiss key" }).click();
    const watchHref = await page
      .getByRole("link", { name: /Open watch page/ })
      .getAttribute("href");
    expect(watchHref).toMatch(/^\/watch\//);
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await capture(page, "test-results/phase3/studio-" + width + ".png");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.reload();
    await expect(
      page.getByRole("heading", {
        name: "An evening in the studio",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Private stream key")).toHaveCount(0);
    await page.goto("/profile");
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Maya on StreamShield");
    await page
      .getByRole("button", { name: "Save profile", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText("Profile updated.");
    await page.reload();
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Maya on StreamShield",
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await capture(page, "test-results/phase3/profile-1440.png");
    await page.goto("/studio");
    await page.getByRole("link", { name: /View channel/ }).click();
    await expect(
      page.getByRole("heading", { name: "Live with Maya", exact: true }),
    ).toBeVisible();
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await capture(page, "test-results/phase3/channel-" + width + ".png");
    }
    const viewer = await account(
      viewerContext.request,
      "e2e_view_" + suffix,
      password,
    );
    ids.push(viewer.user.id);
    await page.goto("/studio");
    await expect(
      page.getByRole("complementary", { name: "Broadcast live comments" }),
    ).toBeVisible();
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(watchHref!);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(
      viewerPage.getByText("Connected", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Your message").fill("Hello from the broadcaster.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      viewerPage.getByRole("log", { name: "Chat messages" }),
    ).toContainText("Hello from the broadcaster.");
    await viewerPage
      .getByLabel("Your message")
      .fill("Hello from another viewer.");
    await viewerPage.getByLabel("Your message").press("Enter");
    await expect(
      page.getByRole("log", { name: "Chat messages" }),
    ).toContainText("Hello from another viewer.");
    await expect(page.getByLabel("Your message")).toHaveValue("");
    await page.getByLabel("Your message").fill("Replying live from Studio.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      viewerPage.getByRole("log", { name: "Chat messages" }),
    ).toContainText("Replying live from Studio.");
    await page.goto(watchHref!);
    await viewerPage.reload();
    await expect(
      viewerPage.getByRole("log", { name: "Chat messages" }),
    ).toContainText("Hello from the broadcaster.");
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await capture(page, "test-results/phase3/watch-chat-" + width + ".png");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.locator(".account-menu summary").click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Sign in", exact: true }).first(),
    ).toBeVisible();
    await page.goto("/login");
    await page.getByLabel("Email or username").fill(username);
    await page
      .getByLabel("Password", { exact: true })
      .fill("incorrect-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Invalid account or password.",
    );
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Your next live moment starts here." }),
    ).toBeVisible();
  } finally {
    await viewerContext.close();
    cleanup(ids);
  }
});
