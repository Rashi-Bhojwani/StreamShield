import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { mediaEnv } from "./media-env.mjs";
const fixture = {
  ...parseEnv(
    readFileSync(new URL("../.env.example", import.meta.url), "utf8"),
  ),
  MEDIA_PUBLISH_PASSWORD: "test-only-publishing-password-not-a-key",
  MEDIA_API_PASSWORD: "test-only-control-password-not-a-key",
};
describe("media bootstrap security", () => {
  it("accepts the documented local defaults with explicit test credentials", () =>
    expect(mediaEnv(fixture).MEDIA_STREAM_PATH).toBe("live"));
  it.each([
    { NODE_ENV: "production" },
    { MEDIA_PUBLISH_USER: "any" },
    { MEDIA_API_USER: "any" },
    { MEDIA_STREAM_PATH: "../outside" },
    { MEDIA_PUBLISH_PASSWORD: "" },
    { MEDIA_API_PORT: "1935" },
    { TEST_PUBLISH_DURATION_SECONDS: "0" },
    { TEST_PUBLISH_DURATION_SECONDS: "601" },
    { MEDIA_API_USER: "broadcaster" },
    { MEDIA_READ_TIMEOUT: "0s" },
  ])("rejects insecure or unbounded bootstrap settings %o", (bad) =>
    expect(() => mediaEnv({ ...fixture, ...bad })).toThrow(),
  );
});
