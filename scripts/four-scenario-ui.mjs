// Actual Chromium rendering with explicitly mocked REST data: UI proof only.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { scenarios } from "../services/api/src/chaos/config.ts";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const dir = "test-results/four-scenario-ui";
mkdirSync(dir, { recursive: true });
const hash = () =>
    createHash("sha256").update(readFileSync(".env")).digest("hex"),
  before = hash();
const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const server = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL("bin/vite.js", import.meta.resolve("vite/package.json")),
    ),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: fileURLToPath(new URL("../apps/web", import.meta.url)),
    env: {
      ...process.env,
      WEB_HOST: "127.0.0.1",
      WEB_PORT: String(port),
      API_PROXY_TARGET: "http://127.0.0.1:1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (v) => {
    log = (log + String(v)).slice(-30000);
  });
const result = {
  status: "FAIL",
  scope:
    "Real Chromium with mocked authenticated REST data, no live infrastructure recovery claim",
  checks: [],
  screenshots: [],
};
let browser, page;
const check = (ok, name) => {
  if (!ok) throw Error(name);
  result.checks.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const user = {
  id: randomUUID(),
  username: "ui_fixture",
  displayName: "UI fixture",
  email: "ui@example.test",
  role: "administrator",
};
let mode = "ready",
  experiment;
const ids = [
  "postgres",
  "redis",
  "api-1",
  "api-2",
  "api-gateway",
  "relay",
  "origin-primary",
  "origin-standby",
  "edge-1",
  "edge-2",
  "video-gateway",
  "demo-dependency",
];
const components = () =>
  ids.map((id) => ({
    id,
    name: id,
    group: "Fixture",
    role: "Mocked UI probe",
    dependencies: [],
    state: mode === "failed" && id === "api-1" ? "UNHEALTHY" : "HEALTHY",
    code:
      mode === "failed" && id === "api-1" ? "probe_unreachable" : "probe_ok",
    observedAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    latencyMs: 4,
    failures: mode === "failed" && id === "api-1" ? 2 : 0,
    successes: 2,
    firstFailureAt: null,
    detectionMs: null,
  }));
const state = () => ({
  version: 1,
  available: mode !== "blocked",
  enabled: true,
  databaseAvailable: true,
  serverTime: new Date().toISOString(),
  observedAt: new Date(
    Date.now() - (mode === "stale" ? 20000 : 0),
  ).toISOString(),
  staleAfterMs: 12000,
  observationWindowMs: 15000,
  unavailableReason:
    mode === "blocked" ? "Monitoring persistence is unavailable" : null,
  activeId:
    experiment && !["FAILED", "COMPLETED"].includes(experiment.state)
      ? experiment.id
      : null,
  faultDurationMs: 8000,
  timeoutMs: 180000,
  scenarios: scenarios.map((s) => ({
    ...s,
    available: s.supported && mode !== "blocked" && mode !== "failed",
    reason:
      mode === "failed" ? "Previous recovery has not been verified" : s.reason,
  })),
  experiments: experiment ? [experiment] : [],
});
const frame = () => ({
  version: 1,
  sequence: "1",
  serverTime: new Date().toISOString(),
  observedAt: new Date().toISOString(),
  durableObservedAt: new Date().toISOString(),
  incidentHistoryAvailable: true,
  staleAfterMs: 12000,
  stale: false,
  persistence: mode !== "blocked",
  components: components(),
  incidents: [],
  openCount: mode === "failed" ? 1 : 0,
  verifiedCount: 0,
  media: [],
  mediaAvailable: false,
  playback: {
    reports: 0,
    advancing: 0,
    standby: 0,
    checkedAt: null,
    label: "UI fixture: no media playback claim",
  },
});
function newExperiment(body) {
  const now = new Date().toISOString();
  return {
    id: body.id,
    actor: user.id,
    scenario: body.scenario,
    target: body.confirmation,
    state: "VALIDATING",
    createdAt: now,
    updatedAt: now,
    injectedAt: null,
    faultConfirmedAt: null,
    incidentDetectedAt: null,
    actionStartedAt: null,
    actionFinishedAt: null,
    verifiedAt: null,
    finishedAt: null,
    deadline: Date.now() + 180000,
    faultExpiresAt: null,
    incidentId: null,
    recoveryIds: [],
    priorRecoveryIds: [],
    reason: "Checking actual prerequisites before injection",
    mechanism: null,
    cleanup: "NOT_REQUIRED",
    cancelRequestedBy: null,
    databasePersisted: true,
    evidence: { observationWindowMs: 15000 },
    events: [],
    measurements: {
      detectionMs: null,
      healingStartMs: null,
      actionMs: null,
      restorationMs: null,
      playbackInterruptionMs: null,
    },
  };
}
try {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch("http://127.0.0.1:" + port)).ok) break;
    } catch {
      /* bounded Vite startup poll */
    }
    if (n === 99) throw Error("Vite startup failed");
    await sleep(100);
  }
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  await page.route("**/socket.io/**", (route) => route.abort());
  let posts = 0;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.replace("/api/v1", "");
    let data = {};
    let status = 200;
    if (path === "/auth/me")
      data = {
        user,
        csrf: "fixture-token",
        presenceHeartbeatMs: 3000,
        demoMode: false,
        guest: null,
      };
    else if (path === "/monitoring/chaos" && mode === "auth") {
      status = 401;
      data = {
        error: {
          code: "AUTH_REQUIRED",
          message: "Sign in again",
          requestId: "fixture",
        },
      };
    } else if (path === "/monitoring/chaos") data = state();
    else if (path === "/monitoring/snapshot") data = frame();
    else if (
      path === "/monitoring/chaos/experiments" &&
      route.request().method() === "POST"
    ) {
      posts++;
      experiment = newExperiment(route.request().postDataJSON());
      data = experiment;
    } else if (path === "/monitoring/healing")
      data = {
        version: 1,
        enabled: true,
        available: true,
        leader: true,
        databaseAvailable: true,
        observedAt: new Date().toISOString(),
        attempts: [],
        counts: {
          active: 0,
          verified: 0,
          escalated: 0,
          averageRecoveryMs: null,
        },
        circuit: { state: "CLOSED" },
      };
    else if (path === "/streams") data = { streams: [] };
    else if (path === "/system/info")
      data = {
        name: "StreamShield",
        version: "fixture",
        phase: 7,
        capabilities: [],
      };
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  for (const path of ["chaos", "demo", "presentation"]) {
    await page.goto("http://127.0.0.1:" + port + "/control/" + path);
    await page
      .getByRole("heading", { name: "Watch the system recover." })
      .waitFor();
    await page.locator(".demo-choice").last().waitFor();
    check(
      (await page.locator(".demo-choice").count()) === 4,
      path + "_four_cards",
    );
    check(
      (await page
        .getByRole("button", { name: "Run failure demonstration" })
        .count()) === 1,
      path + "_one_run_action",
    );
  }
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    await page.screenshot({
      path: dir + "/ready-" + width + ".png",
      fullPage: true,
    });
    result.screenshots.push("ready-" + width + ".png");
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "no_overflow_" + width,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole("button", { name: "Run failure demonstration" }).click();
  await page.getByRole("checkbox").check();
  await page.getByLabel("Confirm target").fill("api-1");
  await page.getByRole("button", { name: "Inject controlled failure" }).click();
  await page.getByText(/^Experiment /).waitFor();
  await sleep(250);
  check(posts === 1, "one_admission_POST");
  check(
    (await page.locator('[data-stage="1"]').getAttribute("data-verified")) ===
      "false",
    "validating_is_not_injected",
  );
  await page.reload();
  await page.getByText("Experiment " + experiment.id).waitFor();
  check(
    await page
      .getByRole("button", { name: "Run failure demonstration" })
      .isDisabled(),
    "refresh_rejoins_active_experiment",
  );
  experiment = {
    ...experiment,
    state: "VERIFYING",
    injectedAt: new Date(Date.now() - 5000).toISOString(),
    faultConfirmedAt: new Date(Date.now() - 4900).toISOString(),
    incidentDetectedAt: new Date(Date.now() - 4000).toISOString(),
    actionStartedAt: new Date(Date.now() - 3500).toISOString(),
    verifiedAt: new Date(Date.now() - 1000).toISOString(),
    measurements: { ...experiment.measurements, restorationMs: 4000 },
  };
  await page.reload();
  await page
    .getByText(
      "Recovery has been verified. Continuing real checks through the observation window.",
    )
    .waitFor();
  check(
    (await page.locator('[data-stage="6"]').getAttribute("data-verified")) ===
      "false",
    "fast_recovery_does_not_finish_observation",
  );
  await page.screenshot({ path: dir + "/observation.png", fullPage: true });
  result.screenshots.push("observation.png");
  experiment = {
    ...experiment,
    state: "FAILED",
    verifiedAt: null,
    finishedAt: new Date().toISOString(),
    reason: "Actual verification failed; service remains unavailable",
  };
  mode = "failed";
  await page.reload();
  await page
    .getByRole("heading", { name: "Recovery failed — inspect the evidence" })
    .waitFor();
  check(
    (await page.locator('[data-stage="6"]').getAttribute("data-verified")) ===
      "false",
    "failed_recovery_never_complete",
  );
  await page.screenshot({ path: dir + "/failed.png", fullPage: true });
  result.screenshots.push("failed.png");
  experiment.evidence.terminalBaselineReverifiedAt = new Date().toISOString();
  experiment.events.push({
    kind: "BASELINE_REVERIFIED",
    at: new Date().toISOString(),
    detail: "Mocked independent baseline evidence for UI test only",
  });
  mode = "ready";
  await page.reload();
  await page
    .getByRole("heading", {
      name: "Previous demo failed; safe baseline reverified",
    })
    .waitFor();
  check(
    await page
      .getByRole("button", { name: "Run failure demonstration" })
      .isEnabled(),
    "safely_closed_failed_history_allows_new_demo",
  );
  check(
    (await page.locator('[data-stage="6"]').getAttribute("data-verified")) ===
      "false",
    "safe_closure_does_not_rewrite_failed_outcome",
  );
  experiment = undefined;
  mode = "stale";
  await page.reload();
  await page
    .getByText(/Monitoring data is stale/)
    .first()
    .waitFor();
  check(
    await page
      .getByRole("button", { name: "Run failure demonstration" })
      .isDisabled(),
    "stale_admission_disabled",
  );
  mode = "auth";
  await page.reload();
  await page
    .getByText(/Authentication has expired/)
    .first()
    .waitFor();
  check(
    (await page.locator(".demo-choice").count()) === 4,
    "auth_error_preserves_four_blocked_cards",
  );
  check(
    await page
      .getByRole("button", { name: "Run failure demonstration" })
      .isDisabled(),
    "expired_auth_disabled",
  );
  result.status = "PASS";
} catch (e) {
  result.error = e.message;
  if (page) {
    await page
      .screenshot({ path: dir + "/failure-debug.png", fullPage: true })
      .catch(() => {});
    writeFileSync(dir + "/failure-debug.html", await page.content());
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await Promise.race([new Promise((r) => server.once("exit", r)), sleep(3000)]);
  result.userEnvUnchanged = before === hash();
  writeFileSync(
    dir + "/measurements.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  writeFileSync(dir + "/vite.log", log);
  console.log(JSON.stringify(result));
}
