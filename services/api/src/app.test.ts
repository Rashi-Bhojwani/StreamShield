import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app";
import { parseConfig } from "./config";
import { healthSchema, systemInfoSchema } from "@streamshield/shared";
const env = {
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "4000",
  CORS_ORIGINS: "http://localhost:5173",
  REQUEST_TIMEOUT_MS: "10000",
  SHUTDOWN_TIMEOUT_MS: "10000",
  LOG_LEVEL: "silent",
};
const config = parseConfig(env);
describe("API foundation", () => {
  it("distinguishes liveness from readiness across lifecycle transitions", async () => {
    const lifecycle = { ready: false };
    const app = createApp(config, lifecycle);
    expect(
      healthSchema.parse(
        (await request(app).get("/api/v1/health/live").expect(200)).body,
      ).status,
    ).toBe("alive");
    expect(
      (await request(app).get("/api/v1/health/ready").expect(503)).body.status,
    ).toBe("not_ready");
    lifecycle.ready = true;
    expect(
      healthSchema.parse(
        (await request(app).get("/api/v1/health/ready").expect(200)).body,
      ).status,
    ).toBe("ready");
    lifecycle.ready = false;
    await request(app).get("/api/v1/health/ready").expect(503);
  });
  it("returns shared metadata and security headers with server-generated IDs", async () => {
    const response = await request(createApp(config, { ready: true }))
      .get("/api/v1/system/info")
      .set("X-Request-ID", "untrusted")
      .expect(200);
    expect(systemInfoSchema.parse(response.body).phase).toBe(1);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
  it("allows only configured browser origins", async () => {
    const app = createApp(config, { ready: true });
    expect(
      (
        await request(app)
          .get("/api/v1/system/info")
          .set("Origin", "http://localhost:5173")
      ).headers["access-control-allow-origin"],
    ).toBe("http://localhost:5173");
    expect(
      (
        await request(app)
          .get("/api/v1/system/info")
          .set("Origin", "https://untrusted.example")
      ).headers["access-control-allow-origin"],
    ).toBeUndefined();
  });
  it("uses a consistent 404 and rejects malformed or oversized JSON", async () => {
    const app = createApp(config, { ready: true });
    const missing = await request(app).get("/not-found").expect(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
    expect(missing.body.error.requestId).toBe(missing.headers["x-request-id"]);
    await request(app)
      .post("/api/v1/system/info")
      .set("Content-Type", "application/json")
      .send("{")
      .expect(400);
    await request(app)
      .post("/api/v1/system/info")
      .send({ value: "x".repeat(17000) })
      .expect(413);
  });
});
describe("configuration", () => {
  it.each([
    "API_PORT",
    "API_HOST",
    "CORS_ORIGINS",
    "REQUEST_TIMEOUT_MS",
    "SHUTDOWN_TIMEOUT_MS",
    "LOG_LEVEL",
    "NODE_ENV",
  ])("rejects missing %s without printing secrets", (key) => {
    const invalid: Record<string, unknown> = { ...env };
    delete invalid[key];
    expect(() => parseConfig(invalid)).toThrow(key);
  });
  it.each([
    { API_PORT: "0" },
    { API_PORT: "65536" },
    { CORS_ORIGINS: "*" },
    { CORS_ORIGINS: "https://example.com/path" },
    { REQUEST_TIMEOUT_MS: "-1" },
    { API_HOST: "bad host" },
  ])("rejects invalid settings %o", (invalid) => {
    expect(() => parseConfig({ ...env, ...invalid })).toThrow(
      "Invalid API configuration",
    );
  });
});
