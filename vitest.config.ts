import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "api",
          include: ["services/api/src/**/*.test.ts", "scripts/*.test.mjs"],
          environment: "node",
        },
      },
      {
        test: {
          name: "web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["./tests/web-setup.ts"],
          env: {
            VITE_DYNAMIC_MODE: "false",
            VITE_DEMO_MODE: "false",
            VITE_API_BASE_URL: "/api/v1",
            VITE_API_TIMEOUT_MS: "5000",
            VITE_STATUS_POLL_MS: "15000",
            VITE_STREAM_POLL_MS: "3000",
            VITE_PLAYER_LOAD_TIMEOUT_MS: "1000",
            VITE_PLAYER_STALL_TIMEOUT_MS: "15000",
            VITE_PLAYER_RETRY_LIMIT: "2",
            VITE_PLAYER_RETRY_BASE_MS: "100",
            VITE_PLAYER_RETRY_MAX_MS: "400",
          },
        },
      },
    ],
  },
});
