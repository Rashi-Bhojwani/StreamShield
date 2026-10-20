import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { parsePlatformConfig } from "./config.js";
import { registerSchema, messageInput } from "@streamshield/shared";
import { checkCsrf, csrfToken, cookies } from "./security.js";
const input = {
  ...parseEnv(readFileSync(".env.example", "utf8")),
  POSTGRES_PASSWORD: "test-only-postgres-password-123456",
  REDIS_PASSWORD: "test-only-redis-password-123456789",
  CSRF_SECRET: "test-only-csrf-secret-not-real-123456789",
  MEDIA_AUTH_SECRET: "test_only_service_secret_not_real_123456789",
};
describe("platform security configuration", () => {
  it("rejects insecure production/session and presence settings without echoing secrets", () => {
    expect(() =>
      parsePlatformConfig({ ...input, NODE_ENV: "production" }),
    ).toThrow("Production requires secure cookies");
    expect(() =>
      parsePlatformConfig({ ...input, POSTGRES_PASSWORD: "x" }),
    ).toThrow("POSTGRES_PASSWORD");
    expect(() => parsePlatformConfig({ ...input, DB_POOL_MAX: "0" })).toThrow(
      "DB_POOL_MAX",
    );
    expect(() =>
      parsePlatformConfig({ ...input, PRESENCE_HEARTBEAT_MS: "60000" }),
    ).toThrow("Presence TTL");
    expect(() =>
      parsePlatformConfig({
        ...input,
        MEDIA_AUTH_BASE_URL: "http://name:private-value@internal:4001",
      }),
    ).toThrow("MEDIA_AUTH_BASE_URL");
    const c = parsePlatformConfig({
      ...input,
      NODE_ENV: "production",
      COOKIE_SECURE: "true",
      ENABLE_LEGACY_STREAM: "false",
    });
    expect(c.COOKIE_SECURE).toBe(true);
    expect(c.ENABLE_LEGACY_STREAM).toBe(false);
  });
  it("requires matching Origin, nonce cookie and CSRF token for mutations", () => {
    const c = parsePlatformConfig(input),
      nonce = "test-only-browser-nonce";
    const token = csrfToken(nonce, c),
      cookie = "ss_csrf=" + nonce;
    expect(() =>
      checkCsrf(
        "http://localhost:5173",
        token,
        cookie,
        ["http://localhost:5173"],
        c,
      ),
    ).not.toThrow();
    expect(() =>
      checkCsrf(
        "http://untrusted.invalid",
        token,
        cookie,
        ["http://localhost:5173"],
        c,
      ),
    ).toThrow("Refresh this page");
    expect(() =>
      checkCsrf(undefined, token, cookie, ["http://localhost:5173"], c),
    ).toThrow();
    expect(() =>
      checkCsrf(
        "http://localhost:5173",
        "forged",
        cookie,
        ["http://localhost:5173"],
        c,
      ),
    ).toThrow();
    expect(() =>
      checkCsrf(
        "http://localhost:5173",
        token,
        "",
        ["http://localhost:5173"],
        c,
      ),
    ).toThrow();
    expect(cookies("invalid=%zz; ss_csrf=valid").ss_csrf).toBe("valid");
  });
  it("rejects role mass assignment, weak accounts and invalid chat while preserving literal text", () => {
    expect(
      registerSchema.safeParse({
        username: "valid_user",
        email: "valid@example.test",
        password: "long-enough-password",
        role: "administrator",
      }).success,
    ).toBe(false);
    expect(
      registerSchema.safeParse({
        username: "ok",
        email: "invalid",
        password: "short",
      }).success,
    ).toBe(false);
    const streamId = "8c46380b-8f23-4f6a-819c-61adb5b4d190";
    expect(
      messageInput.safeParse({ streamId, content: "x".repeat(1001) }).success,
    ).toBe(false);
    expect(
      messageInput.safeParse({ streamId, content: String.fromCharCode(0) })
        .success,
    ).toBe(false);
    expect(
      messageInput.parse({
        streamId,
        content: "<script>literal plain text</script>",
      }).content,
    ).toBe("<script>literal plain text</script>");
  });
});
