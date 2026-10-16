import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  testMatch:
    process.env.STREAMING_E2E === "1"
      ? "**/media.spec.ts"
      : "**/foundation.spec.ts",
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
