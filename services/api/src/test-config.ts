// Explicit test fixture. No production credentials.
export const testEnv = {
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "4000",
  CORS_ORIGINS: "http://localhost:5173",
  REQUEST_TIMEOUT_MS: "10000",
  SHUTDOWN_TIMEOUT_MS: "10000",
  LOG_LEVEL: "silent",
  MEDIA_STREAM_PATH: "live",
  MEDIA_STREAM_TITLE: "Test channel",
  MEDIA_API_BASE_URL: "http://origin.test:9997",
  MEDIA_HLS_BASE_URL: "http://origin.test:8888",
  MEDIA_PUBLIC_HLS_BASE_URL: "/media",
  MEDIA_API_USER: "test",
  MEDIA_API_PASSWORD: "test-only-control-password-not-a-secret",
  MEDIA_PROBE_TIMEOUT_MS: "100",
  MEDIA_STATUS_CACHE_MS: "0",
};
