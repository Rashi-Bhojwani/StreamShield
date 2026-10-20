import { expect, test } from "@playwright/test";
test("real API connectivity, failure visibility and recovery", async ({
  page,
}) => {
  await page.goto("/diagnostics");
  await expect(
    page.getByRole("heading", { name: "API connected" }),
  ).toBeVisible();
  await page.route("**/api/v1/health/ready", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"status":"not_ready","service":"streamshield-api"}',
    }),
  );
  await page.getByRole("button", { name: /Check again/ }).click();
  await expect(
    page.getByRole("heading", { name: "API unavailable" }),
  ).toBeVisible();
  await page.unroute("**/api/v1/health/ready");
  await page.getByRole("button", { name: /Check again/ }).click();
  await expect(
    page.getByRole("heading", { name: "API connected" }),
  ).toBeVisible();
});
for (const width of [375, 768, 1280, 1440, 1680, 1920]) {
  test(`consumer home and watch use the available space at ${width}px`, async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 1000 });
    const response = await request.get("/api/v1/streams");
    expect(response.ok()).toBeTruthy();
    const { streams } = await response.json();
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "A good place to tune in." }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Visit channel", exact: true }),
    ).toBeVisible();
    const assertWidth = async () =>
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
    await assertWidth();
    if (width >= 1280) {
      const bounds = await page.locator("#main").boundingBox();
      expect(bounds!.width).toBeGreaterThan(width - 260);
    }
    await page.screenshot({
      path: `test-results/ui/after-home-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole("searchbox", { name: "Search streams" })
      .fill(streams[0].title);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: `Results for “${streams[0].title}”` }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: `Watch ${streams[0].title}`, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Waiting for a broadcaster" }),
    ).toBeVisible();
    await expect(page.getByText(/Live chat isn’t available yet/)).toBeVisible();
    await expect(page.locator("details")).not.toHaveAttribute("open", "");
    await assertWidth();
    await page.screenshot({
      path: `test-results/ui/after-watch-${width}.png`,
      fullPage: true,
    });
    if (width < 1100) {
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: "Sidebar navigation" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Menu", exact: true }),
      ).toBeFocused();
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page
        .getByRole("link", { name: "Explore Categories", exact: true })
        .click();
    } else
      await page
        .getByRole("link", { name: "Explore Categories", exact: true })
        .click();
    await expect(
      page.getByRole("heading", { name: "Categories are on the way." }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("consumer search empty results and separate future Control product", async ({
  page,
}) => {
  await page.goto("/search?q=channel-that-does-not-exist");
  await expect(
    page.getByRole("heading", { name: "No matching channels." }),
  ).toBeVisible();
  await page.goto("/control");
  await expect(
    page.getByRole("heading", {
      name: "A separate space for stream reliability.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await page.getByRole("link", { name: "Return to StreamShield Live" }).click();
  await expect(
    page.getByRole("heading", { name: "A good place to tune in." }),
  ).toBeVisible();
});

test("developer context is separate from consumer discovery", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "About this build" }).click();
  await expect(
    page.getByRole("heading", { name: "The foundation behind the stream." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Planned, not operational" }),
  ).toBeVisible();
});
