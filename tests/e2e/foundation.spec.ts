import { expect, test } from "@playwright/test";
test("real API connectivity, failure visibility, navigation and responsive layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "API connected" }),
  ).toBeVisible();
  await expect(page.getByText(/No streams yet/)).toBeVisible();
  await page.screenshot({
    path: "test-results/overview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Explore the foundation" }).click();
  await expect(
    page.getByRole("heading", { name: /A foundation you can verify/ }),
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /Menu/ }).click();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Every stream/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/overview-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
