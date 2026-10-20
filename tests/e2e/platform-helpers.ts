import { execFileSync } from "node:child_process";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
export function cleanup(ids: string[]) {
  if (!ids.length) return;
  execFileSync(
    "docker",
    [
      "compose",
      "run",
      "--rm",
      "-T",
      "--no-deps",
      "api",
      "node",
      "scripts/cleanup-test-fixtures.mjs",
    ],
    {
      input: JSON.stringify(ids),
      stdio: ["pipe", "ignore", "pipe"],
      timeout: Number(process.env.MEDIA_TEST_TIMEOUT_MS),
    },
  );
}
export async function account(
  request: APIRequestContext,
  username: string,
  password: string,
) {
  let response = await request.get("/api/v1/auth/me");
  const csrf = (await response.json()).csrf;
  response = await request.post("/api/v1/auth/register", {
    headers: {
      Origin: new URL(process.env.E2E_BASE_URL!).origin,
      "X-CSRF-Token": csrf,
    },
    data: { username, email: username + "@example.test", password },
  });
  expect(response.status()).toBe(200);
  return (await (await request.get("/api/v1/auth/me")).json()) as {
    user: { id: string };
    csrf: string;
  };
}
export async function write(
  request: APIRequestContext,
  csrf: string,
  path: string,
  data?: unknown,
) {
  const response = await request.post("/api/v1" + path, {
    headers: {
      Origin: new URL(process.env.E2E_BASE_URL!).origin,
      "X-CSRF-Token": csrf,
    },
    data,
  });
  return response;
}
export async function capture(page: Page, path: string) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  if ((page.viewportSize()?.width || 0) < 1100)
    await expect(page.locator("#sidebar")).toBeHidden();
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}
