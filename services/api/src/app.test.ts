import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app";
import { parseConfig } from "./config";
import { healthSchema, systemInfoSchema } from "@streamshield/shared";
import { testEnv as env } from "./test-config";
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
    expect(systemInfoSchema.parse(response.body).phase).toBe(2);
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

it("supports blank monitoring defaults and a standalone protected scrape credential", () => {
  expect(
    parseConfig({ ...env, OBS_SECRET: "", OBS_URL: "", PROMETHEUS_URL: "" })
      .OBS_URL,
  ).toBeUndefined();
  expect(
    parseConfig({ ...env, OBS_SECRET: "x".repeat(43) }).OBS_SECRET,
  ).toBeDefined();
  expect(() =>
    parseConfig({ ...env, OBS_URL: "http://observer:4010" }),
  ).toThrow();
  expect(() =>
    parseConfig({
      ...env,
      OBS_URL: "http://user:password@observer:4010",
      OBS_SECRET: "x".repeat(43),
      PROMETHEUS_URL: "http://prometheus:9090",
    }),
  ).toThrow();
});
it("reports Phase 5 metadata only when the monitoring deployment is configured", async () => {
  const app = createApp(
    parseConfig({
      ...env,
      OBS_URL: "http://observer:4010",
      OBS_SECRET: "x".repeat(43),
      PROMETHEUS_URL: "http://prometheus:9090",
    }),
    { ready: true },
  );
  const info = systemInfoSchema.parse(
    (await request(app).get("/api/v1/system/info").expect(200)).body,
  );
  expect(info.phase).toBe(5);
  expect(info.version).toBe("0.5.0");
});

it("names the serving instance outside production and never in production", async () => {
  const dev = parseConfig({ ...env, API_INSTANCE_ID: "api-2" });
  const served = await request(createApp(dev, { ready: true }))
    .get("/api/v1/health/live")
    .expect(200);
  expect(served.headers["x-served-by"]).toBe("api-2");
  const prod = parseConfig({
    ...env,
    API_INSTANCE_ID: "api-2",
    EXPOSE_SERVING_INSTANCE: "false",
  });
  const hidden = await request(createApp(prod, { ready: true }))
    .get("/api/v1/health/live")
    .expect(200);
  expect(hidden.headers["x-served-by"]).toBeUndefined();
  const anonymous = await request(createApp(config, { ready: true }))
    .get("/api/v1/health/live")
    .expect(200);
  expect(anonymous.headers["x-served-by"]).toBeUndefined();
});
