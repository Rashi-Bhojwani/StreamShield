import { expect, it, vi } from "vitest";
import {
  fixtureWaiter,
  fixtureAdmission,
  pendingFixture,
  fixtureDataTmpfs,
  fixtureServiceState,
  redactFixtureText,
  fixtureStartupEvents,
} from "./fixture-diagnostics.mjs";

it("extracts bounded startup evidence without echoing arbitrary messages or secrets", () => {
  const rows = [
    {
      event: "fixture_runtime_import",
      state: "STARTING",
      environment: "private-secret",
    },
    {
      event: "fixture_startup_step",
      stage: "postgres",
      state: "STARTING",
      message: "private-secret",
    },
    {
      event: "api_startup_failed",
      stage: "postgres",
      failures: [{ code: "ECONNREFUSED", message: "private-secret" }],
    },
    { event: "request", message: "private-secret" },
  ];
  const result = fixtureStartupEvents(
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  expect(result).toEqual([
    { event: "fixture_runtime_import", state: "STARTING" },
    { event: "fixture_startup_step", stage: "postgres", state: "STARTING" },
    { event: "api_startup_failed", stage: "postgres", codes: ["ECONNREFUSED"] },
  ]);
  expect(JSON.stringify(result)).not.toContain("private-secret");
  expect(
    fixtureStartupEvents(
      'not JSON\nnull\n42\n"plain text"\n' +
        JSON.stringify({
          event: "fixture_startup_step",
          stage: "unknown",
          state: "STARTING",
        }),
    ),
  ).toEqual([]);
});

function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

it.each([
  "postgres-readiness",
  "api-authentication",
  "scenario-baseline",
  "scenario-availability:crash-edge",
])(
  "identifies the timed-out stage %s without increasing its deadline",
  async (stage) => {
    const result = {},
      probe = vi.fn(() => false);
    const until = fixtureWaiter(result, clock());
    await expect(until(stage, probe, 1000)).rejects.toMatchObject({
      stage,
      message: "fixture_wait_timeout:" + stage,
    });
    expect(result).toMatchObject({
      currentStage: stage,
      waits: [
        {
          stage,
          status: "FAIL",
          attempts: 2,
          timeoutMs: 1000,
          elapsedMs: 1000,
        },
      ],
    });
  },
);

it("retains a meaningful HTTP/connection error across later pending admission probes", async () => {
  const result = {};
  const probe = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("connection failed with private-token"), {
        httpStatus: 503,
        cause: { code: "ECONNREFUSED", message: "driver failed" },
        stderr: "failed with private-token",
      }),
    )
    .mockResolvedValue(
      pendingFixture({
        denied: [{ id: "crash-api", reason: "API-2 unhealthy" }],
      }),
    );
  const until = fixtureWaiter(result, {
    ...clock(),
    redact: (s) => redactFixtureText(s, ["private-token"]),
  });
  await expect(until("scenario-baseline", probe, 1500)).rejects.toThrow(
    "fixture_wait_timeout:scenario-baseline",
  );
  expect(result.waits[0]).toMatchObject({
    lastError: { httpStatus: "503", cause: { code: "ECONNREFUSED" } },
    lastObservation: {
      denied: [{ id: "crash-api", reason: "API-2 unhealthy" }],
    },
  });
  expect(JSON.stringify(result)).not.toContain("private-token");
});

it("does not accept a truthy pending object as a passing probe", async () => {
  const result = {},
    probe = vi
      .fn()
      .mockResolvedValueOnce(pendingFixture({ reason: "still starting" }))
      .mockResolvedValueOnce("ready");
  expect(
    await fixtureWaiter(result, clock())("api-authentication", probe, 1000),
  ).toBe("ready");
  expect(result.waits[0]).toMatchObject({
    status: "PASS",
    attempts: 2,
    lastObservation: { reason: "still starting" },
  });
});

it("records a failed control-plane guard before trying the next HTTP probe", async () => {
  const result = {},
    probe = vi.fn();
  const until = fixtureWaiter(result, {
    ...clock(),
    guard: () => {
      throw Error("fixture_control_plane_exited");
    },
  });
  await expect(until("scenario-baseline", probe)).rejects.toThrow(
    "fixture_control_plane_exited",
  );
  expect(probe).not.toHaveBeenCalled();
  expect(result.waits[0]).toMatchObject({
    stage: "scenario-baseline",
    status: "FAIL",
    lastError: { message: "fixture_control_plane_exited" },
  });
});

const ids = [
  "crash-api",
  "crash-video-gateway",
  "crash-edge",
  "network-timeout",
];
it("requires all four expected scenario IDs and preserves the actual denied reason", () => {
  const snapshot = {
    available: true,
    scenarios: ids.slice(0, 3).map((id) => ({ id, available: true })),
  };
  expect(fixtureAdmission(snapshot, ids)).toMatchObject({
    pending: true,
    evidence: { missing: ["network-timeout"] },
  });
  snapshot.scenarios.push({
    id: "network-timeout",
    available: false,
    reason: "Prior cleanup not verified",
  });
  expect(fixtureAdmission(snapshot, ids)).toMatchObject({
    pending: true,
    evidence: {
      denied: [{ id: "network-timeout", reason: "Prior cleanup not verified" }],
    },
  });
  snapshot.scenarios.at(-1).available = true;
  expect(fixtureAdmission(snapshot, ids)).toMatchObject({ scenarioIds: ids });
  expect(
    fixtureAdmission(
      {
        ...snapshot,
        available: false,
        unavailableReason: "Healer unavailable",
      },
      ids,
    ),
  ).toMatchObject({
    pending: true,
    evidence: { unavailableReason: "Healer unavailable" },
  });
});

it("keeps the monitoring data volumes writable by the pinned non-root image identities", () => {
  expect(fixtureDataTmpfs("prometheus", "/prometheus")).toContain(
    "uid=65534,gid=65534",
  );
  expect(fixtureDataTmpfs("grafana", "/var/lib/grafana")).toContain(
    "uid=472,gid=0",
  );
  expect(fixtureDataTmpfs("postgres", "/var/lib/postgresql/data")).toBe(
    "/var/lib/postgresql/data:rw,size=256m",
  );
});

it("captures real status/health fields without serializing environment, commands or credentials", () => {
  const state = fixtureServiceState(
    "postgres",
    {
      Config: { Env: ["PASSWORD=fixture-password"], Cmd: ["secret command"] },
      RestartCount: 2,
      State: {
        Status: "exited",
        ExitCode: 1,
        OOMKilled: false,
        Health: {
          Status: "unhealthy",
          Log: [{ ExitCode: 1, Output: "fixture-password failed" }],
        },
      },
    },
    (s) => redactFixtureText(s, ["fixture-password"]),
  );
  expect(state).toMatchObject({
    status: "exited",
    exitCode: 1,
    oom: false,
    health: "unhealthy",
    restartCount: 2,
    recentHealth: [{ exit: 1, output: "[redacted] failed" }],
  });
  expect(JSON.stringify(state)).not.toContain("fixture-password");
  expect(JSON.stringify(state)).not.toContain("secret command");
});

it("redacts configured, encoded, URL and authorization credentials before writing logs", () => {
  const password = 'private/value"here';
  const log = `${password} ${encodeURIComponent(password)} ${JSON.stringify(password)} https://user:unknown-password@internal/path?token=unknown-token Bearer unlisted-token`;
  const safe = redactFixtureText(log, [password]);
  for (const secret of [
    password,
    encodeURIComponent(password),
    "unknown-password",
    "unknown-token",
    "unlisted-token",
  ])
    expect(safe).not.toContain(secret);
});
