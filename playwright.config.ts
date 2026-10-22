import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  outputDir:
    process.env.DYNAMIC_E2E === "1"
      ? "test-results/dynamic-artifacts"
      : process.env.DEMO_E2E === "1"
        ? "test-results/demo-artifacts"
        : process.env.CHAOS_E2E === "1"
          ? "test-results/chaos-artifacts"
          : process.env.HEALING_E2E === "1"
            ? "test-results/healing-artifacts"
            : process.env.MONITORING_E2E === "1"
              ? "test-results/monitoring-artifacts"
              : process.env.RESILIENCE_E2E === "1"
                ? "test-results/resilience-artifacts"
                : process.env.PLATFORM_MEDIA_E2E === "1"
                  ? "test-results/platform-media-artifacts"
                  : process.env.STREAMING_E2E === "1"
                    ? "test-results/media-artifacts"
                    : "test-results/browser-artifacts",
  fullyParallel: false,
  workers: 1,
  testMatch:
    process.env.DYNAMIC_E2E === "1"
      ? "**/dynamic.spec.ts"
      : process.env.DEMO_E2E === "1"
        ? "**/demo.spec.ts"
        : process.env.CHAOS_E2E === "1"
          ? "**/chaos.spec.ts"
          : process.env.HEALING_E2E === "1"
            ? "**/healing.spec.ts"
            : process.env.MONITORING_E2E === "1"
              ? "**/monitoring.spec.ts"
              : process.env.RESILIENCE_E2E === "1"
                ? "**/resilience.spec.ts"
                : process.env.STREAMING_E2E === "1"
                  ? "**/media.spec.ts"
                  : process.env.PLATFORM_MEDIA_E2E === "1"
                    ? "**/platform-media.spec.ts"
                    : ["**/foundation.spec.ts", "**/platform.spec.ts"],
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      args:
        process.env.DYNAMIC_E2E === "1"
          ? [
              "--use-fake-device-for-media-stream",
              "--use-fake-ui-for-media-stream",
              "--autoplay-policy=no-user-gesture-required",
            ]
          : [],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
