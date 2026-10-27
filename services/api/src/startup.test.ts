import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { expect, it, vi } from "vitest";
import {
  listenReady,
  startupStep,
  startupDiagnostic,
  StartupFailure,
} from "./startup.js";

it("traces only the fixture startup stage and outcome, including failures without exposing their inputs", async () => {
  vi.stubEnv("FIXTURE_STARTUP_TRACE", "true");
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(await startupStep("resources", () => "private returned value")).toBe(
      "private returned value",
    );
    await expect(
      startupStep("postgres", () => {
        throw Error("private driver value");
      }),
    ).rejects.toBeInstanceOf(StartupFailure);
    const lines = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines.map(({ stage, state }) => [stage, state])).toEqual([
      ["resources", "STARTING"],
      ["resources", "COMPLETE"],
      ["postgres", "STARTING"],
      ["postgres", "FAILED"],
    ]);
    expect(JSON.stringify(lines)).not.toContain("private");
  } finally {
    output.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("retains the failing dependency and original driver exception", async () => {
  const cause = Object.assign(
    new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    { code: "ECONNREFUSED" },
  );
  const error = await startupStep("postgres", () => {
    throw cause;
  }).catch((e) => e);
  expect(error).toBeInstanceOf(StartupFailure);
  expect(error.cause).toBe(cause);
  expect(startupDiagnostic(error, { API_INSTANCE_ID: "api-1" })).toMatchObject({
    stage: "postgres",
    instanceId: "api-1",
    failures: expect.arrayContaining([
      expect.objectContaining({
        code: "ECONNREFUSED",
        message: expect.stringContaining("5432"),
      }),
    ]),
  });
});

it("redacts secrets and URLs without serializing SQL details or arbitrary error properties", () => {
  const password = "private/password:not-for-logs";
  const cause = Object.assign(
    new Error(
      `postgres://user:${encodeURIComponent(password)}@db/app?token=unknown-token Bearer unlisted-token ${password}`,
    ),
    {
      code: "28P01",
      detail: "NEVER SERIALIZE SQL VALUES",
      environment: { PASSWORD: password },
    },
  );
  const report = JSON.stringify(
    startupDiagnostic(new StartupFailure("postgres", cause), {
      POSTGRES_PASSWORD: password,
    }),
  );
  expect(report).toContain("28P01");
  for (const value of [
    password,
    encodeURIComponent(password),
    "unknown-token",
    "unlisted-token",
    "NEVER SERIALIZE SQL VALUES",
  ])
    expect(report).not.toContain(value);
});

it("awaits actual listener binding and reports EADDRINUSE rather than readiness", async () => {
  const occupied = createServer(),
    other = createServer();
  try {
    await listenReady(occupied, 0, "127.0.0.1");
    const address = occupied.address();
    if (!address || typeof address === "string")
      throw Error("test_bind_missing");
    await expect(
      startupStep("public_listener", () =>
        listenReady(other, address.port, "127.0.0.1"),
      ),
    ).rejects.toMatchObject({
      stage: "public_listener",
      cause: { code: "EADDRINUSE" },
    });
    expect(other.listening).toBe(false);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

it("also redacts credentials if a driver places them in its name, code or instance field", () => {
  const secret = "TEST_ONLY_PRIVATE_VALUE";
  const error = Object.assign(new Error("connection rejected"), {
    name: secret,
    code: secret,
  });
  const report = JSON.stringify(
    startupDiagnostic(error, {
      POSTGRES_PASSWORD: secret,
      API_INSTANCE_ID: secret,
    }),
  );
  expect(report).not.toContain(secret);
  expect(report).toContain("[redacted]");
});

const env = () => ({
  ...process.env,
  ...parseEnv(readFileSync(".env.example", "utf8")),
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_INTERNAL_HOST: "127.0.0.1",
  POSTGRES_HOST: "127.0.0.1",
  POSTGRES_PASSWORD: "test-only-postgres-password-123456",
  REDIS_PASSWORD: "test-only-redis-password-123456789",
  MEDIA_API_PASSWORD: "test-only-media-password-123456789",
  CSRF_SECRET: "test-only-csrf-secret-not-real-123456789",
  MEDIA_AUTH_SECRET: "test_only_service_secret_not_real_123456789",
  DEPENDENCY_TIMEOUT_MS: "500",
  API_INSTANCE_ID: "api-1",
  LOG_LEVEL: "silent",
});
const launch = (overrides: Record<string, string>) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", "services/api/src/server.ts"],
    {
      env: { ...env(), ...overrides },
      encoding: "utf8",
      timeout: 10000,
    },
  );
it("the real API entrypoint exits with sanitized configuration field diagnostics", () => {
  const child = launch({ API_PORT: "invalid" });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  const log = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  expect(log).toMatchObject({
    event: "api_startup_failed",
    stage: "api_configuration",
    instanceId: "api-1",
  });
  expect(JSON.stringify(log)).toContain("API_PORT");
  expect(JSON.stringify(log)).not.toContain(env().POSTGRES_PASSWORD);
}, 15000);
it("the real API entrypoint exits after a refused database connection with the actual code", async () => {
  const reserve = createServer();
  await listenReady(reserve, 0, "127.0.0.1");
  const address = reserve.address();
  if (!address || typeof address === "string") throw Error("test_bind_missing");
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const child = launch({ POSTGRES_PORT: String(address.port) });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  const log = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  expect(log.stage).toBe("postgres");
  expect(log.failures).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "ECONNREFUSED" })]),
  );
  expect(child.stdout + child.stderr).not.toContain(env().POSTGRES_PASSWORD);
}, 15000);
