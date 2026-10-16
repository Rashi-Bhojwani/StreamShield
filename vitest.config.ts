import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "api",
          include: ["services/api/src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "web",
          include: ["apps/web/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./tests/web-setup.ts"],
          env: {
            VITE_API_BASE_URL: "/api/v1",
            VITE_API_TIMEOUT_MS: "5000",
            VITE_STATUS_POLL_MS: "15000",
          },
        },
      },
    ],
  },
});
