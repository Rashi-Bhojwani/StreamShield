import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  outputDir:
    process.env.PLATFORM_MEDIA_E2E === "1"
      ? "test-results/platform-media-artifacts"
      : process.env.STREAMING_E2E === "1"
        ? "test-results/media-artifacts"
        : "test-results/browser-artifacts",
  fullyParallel: false,
  workers: 1,
  testMatch:
    process.env.STREAMING_E2E === "1"
      ? "**/media.spec.ts"
      : process.env.PLATFORM_MEDIA_E2E === "1"
        ? "**/platform-media.spec.ts"
        : ["**/foundation.spec.ts", "**/platform.spec.ts"],
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
