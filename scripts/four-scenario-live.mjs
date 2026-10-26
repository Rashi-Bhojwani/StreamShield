import {
  fixtureWaiter,
  fixtureError,
  fixtureAdmission,
  pendingFixture,
  fixtureDataTmpfs,
  fixtureServiceState,
  redactFixtureText,
} from "./fixture-diagnostics.mjs";
import {
  fixtureProfile,
  demoBackupEdge,
  demoMediaAuthority,
} from "./fixture-profile.mjs";
import { fixtureSupervisor } from "./fixture-supervisor.mjs";
import {
  buildFixtureRuntime,
  compiledFixtureService,
  idleBaselineGate,
} from "./fixture-runtime.mjs";
import {
  prepareFixtureWorkspace,
  readableFixtureBuild,
  crashTestSelection,
} from "./fixture-workspace.mjs";
import { createServer } from "node:net";
// Real isolated four-scenario validation. No user .env, services or volumes are changed.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  mkdtempSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { chromium } from "@playwright/test";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const profile = fixtureProfile(process.argv);
const { crashOnly, compact, interactive } = profile;
const prepareOnly = process.argv.includes("--prepare-only"),
  existingUi =
    profile.lightweight ||
    (crashOnly && process.argv.includes("--existing-ui"));
const repeatAt = process.argv.indexOf("--repeat"),
  repetitions = repeatAt < 0 ? 1 : Number(process.argv[repeatAt + 1]);
if (
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 3 ||
  (!crashOnly && repetitions !== 1)
)
  throw Error("two_scenario_repeat_must_be_1_to_3");
const selectedScenarios = crashOnly
  ? crashTestSelection(process.argv)
  : ["crash-api", "crash-video-gateway", "crash-edge", "network-timeout"];
const fixtureLabel = profile.label;
const root = process.cwd(),
  id = randomUUID().slice(0, 8),
  project = profile.projectPrefix + id;
const dir = mkdtempSync(join(tmpdir(), project + "-"));
const outputRoot = join(root, profile.output);
const output = crashOnly ? outputRoot : join(outputRoot, "runs", id);
mkdirSync(output, { recursive: true });
const result = {
  id,
  status: "FAIL",
  startedAt: new Date().toISOString(),
  scenarios: [],
  selectedScenarios,
  repetitions,
  controlRoute: existingUi
    ? "/control/chaos"
    : crashOnly
      ? "/control/self-healing"
      : "/control/presentation",
  currentStage: "resource-preflight",
  artifacts: {
    directory: crashOnly ? profile.output : profile.output + "/runs/" + id,
  },
  hostPlatform: process.platform,
  omittedOptionalTelemetry: compact
    ? ["prometheus", "grafana", "api-tier", "api-3"]
    : [],
  sourceType: "generated FFmpeg test pattern (sample content)",
  limitations: [
    "Isolated actual-service Docker fixture. Control-plane processes share one fixture container; targeted API/gateway containers remain separate. The host operating system and source type are recorded; no production-stream or browser-decoding claim is inferred.",
  ],
};
const hash = () => {
    const digest = createHash("sha256");
    for (const name of [".env", ".env.local"]) {
      digest.update(name);
      digest.update(
        existsSync(join(root, name))
          ? readFileSync(join(root, name))
          : "ABSENT",
      );
    }
    return digest.digest("hex");
  },
  before = hash();
let stopRequested = false;
const requestStop = () => {
  stopRequested = true;
};
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);
let mayHaveContainers = false,
  controlPlaneExpected = false;
let configuredServices = [];
let secrets = [],
  browser,
  context,
  page;
const redact = (s) => redactFixtureText(s, secrets);
const run = (command, args, opts = {}) =>
  execFileSync(command, args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
    ...opts,
  });
const docker = (...args) => run("docker", args);
const compose = (...args) =>
  docker("compose", "-p", project, "-f", join(dir, "fixture.json"), ...args);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = fixtureWaiter(result, {
  redact,
  onStage: (stage) => console.log(JSON.stringify({ stage, status: "WAITING" })),
  guard: () => {
    if (stopRequested) throw Error("demo_stop_requested");
    if (
      controlPlaneExpected &&
      inspect("control-plane").State.Status !== "running"
    )
      throw Error("fixture_control_plane_exited");
  },
});

const check = (value, reason) => {
  if (!value) throw Error(reason);
};
const save = (name, value) => {
  const p = join(dir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value), {
    mode: 0o600,
  });
  return p;
};
const inspect = (service) =>
  JSON.parse(docker("inspect", compose("ps", "-aq", service).trim()))[0];
try {
  if (prepareOnly) {
    result.currentStage = "source-preparation";
    result.preparation = prepareFixtureWorkspace(root, dir);
    run(process.execPath, [
      "--input-type=module",
      "-e",
      "import {z} from 'zod'; console.log(z.string().parse('dependency-resolution-ok'))",
    ]);
    result.preparation.dependenciesResolve = true;
    result.status = "PASS";
  } else {
    const disk = statfsSync(root);
    const driver = docker("info", "--format", "{{.Driver}}").trim();
    const minimumGB = profile.minimumGB(driver);
    result.resources = {
      storageDriver: driver,
      repositoryFreeBytes: disk.bavail * disk.bsize,
      minimumFreeBytes: minimumGB * 1024 ** 3,
    };
    check(
      disk.bavail * disk.bsize > minimumGB * 1024 ** 3,
      "need_" + minimumGB + "GB_free_before_owned_fixture_" + driver,
    );
    check(
      existsSync(join(root, "apps/web/dist/index.html")),
      "build_frontend_first",
    );
    const browserCheck = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    await browserCheck.close();
    const listener = createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(interactive ? 5174 : 0, "127.0.0.1", resolve);
    });
    const webPort = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    result.currentStage = "fixture-configuration";
    result.preparation = prepareFixtureWorkspace(root, dir);
    let compiledDirectory = null;
    if (profile.lightweight) {
      result.currentStage = "compile-demo-runtime";
      console.log(JSON.stringify({ stage: result.currentStage }));
      compiledDirectory = await buildFixtureRuntime(root, dir);
    }
    let text = readFileSync(join(root, ".env.example"), "utf8");
    const set = (k, v) => {
      if (!new RegExp("^" + k + "=", "m").test(text)) text += "\n" + k + "=\n";
      text = text.replace(new RegExp("^" + k + "=.*$", "m"), k + "=" + v);
    };
    for (const [k, v] of Object.entries({
      COMPOSE_PROJECT_NAME: project,
      WEB_PORT: String(webPort),
      ...(interactive ? { BROWSER_ICE_PORT: "18189" } : {}),
      CORS_ORIGINS:
        "http://127.0.0.1:" + webPort + ",http://localhost:" + webPort,
      E2E_BASE_URL: "http://127.0.0.1:" + webPort,
      HEALER_ENABLED: "true",
      CHAOS_ENABLED: "true",
      CHAOS_ENVIRONMENT: "local-development",
      CHAOS_ALLOWED_SCENARIOS: [
        ...selectedScenarios,
        ...(profile.lightweight ? ["media-authority-loss"] : []),
      ].join(","),
      CHAOS_MEDIA_GATE_ENABLED: profile.lightweight ? "true" : "false",
      CHAOS_OBSERVATION_WINDOW_MS: "15000",
      CHAOS_FAULT_DURATION_MS: profile.lightweight ? "20000" : "8000",
      POSTGRES_DB: "fixture_" + id,
      POSTGRES_USER: "fixture",
      POSTGRES_PASSWORD: randomBytes(32).toString("base64url"),
    }))
      set(k, v);
    save(".env", text);
    run(
      process.execPath,
      ["--import", "tsx", "scripts/setup-dynamic.mjs", "--enable-local-chaos"],
      {
        env: { ...process.env, COMPOSE_PROJECT_NAME: project },
        timeout: 120000,
      },
    );
    readableFixtureBuild(dir);
    const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    secrets = Object.entries(env)
      .filter(([k, v]) => /PASSWORD|SECRET|TOKEN/.test(k) && v.length > 8)
      .map(([, v]) => v);
    secrets.push(
      Buffer.from(env.MEDIA_API_USER + ":" + env.MEDIA_API_PASSWORD).toString(
        "base64",
      ),
    );
    const files = [
      "docker-compose.yml",
      ".local/resilience/compose.yml",
      ".local/monitoring/compose.yml",
      ".local/healing/compose.yml",
      ".local/chaos/compose.yml",
      ".local/dynamic/compose.yml",
      "infrastructure/chaos/repair-policy.yml",
    ];
    const source = JSON.parse(
      docker(
        "compose",
        "-p",
        project,
        ...files.flatMap((f) => ["-f", join(dir, f)]),
        "config",
        "--format",
        "json",
      ),
    );
    if (compiledDirectory) {
      for (const [name, service] of Object.entries(source.services))
        source.services[name] = compiledFixtureService(
          service,
          compiledDirectory,
        );
    }
    if (profile.lightweight) {
      const gatewayConfig = source.services["video-gateway"].volumes.find(
        (v) => v.target === "/etc/nginx/nginx.conf",
      ).source;
      writeFileSync(
        gatewayConfig,
        demoMediaAuthority(
          demoBackupEdge(
            readFileSync(gatewayConfig, "utf8"),
            env.RESILIENCE_EDGE2_HOST,
            env.RESILIENCE_HTTP_PORT,
          ),
          env.CHAOS_PORT,
        ),
      );
    }
    const roles = [
      ...(compact ? ["api-2"] : []),
      "observer",
      "healer",
      "healing-control",
      "dependency-demo",
      "chaos-controller",
      "chaos-fault-adapter",
    ];
    const jobs = [
      "migrate",
      "metrics-db-setup",
      "healing-db-setup",
      "chaos-db-setup",
    ];
    const keep = [
      "postgres",
      "redis",
      "mediamtx",
      "origin-primary",
      "origin-standby",
      "edge-1",
      "edge-2",
      "video-gateway",
      "api",
      "api-2",
      "api-gateway",
      "prometheus",
      "grafana",
      "toxiproxy",
      "web",
    ].filter(
      (name) => !compact || !["api-2", "prometheus", "grafana"].includes(name),
    );
    if (compact) {
      const targets = source.services.observer.volumes.find(
        (v) => v.target === "/config/targets.json",
      ).source;
      const rows = JSON.parse(readFileSync(targets, "utf8"));
      writeFileSync(
        targets,
        JSON.stringify(
          rows.filter(
            (t) =>
              !["api-3", "api-tier", "prometheus", "grafana"].includes(t.id),
          ),
        ),
      );
    }
    const privateTraffic = {
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      NO_PROXY: "*",
      no_proxy: "*",
    };
    const services = {};
    const capacityBefore = (name) => {
      const disk = statfsSync(root),
        bytes = Number(
          docker(
            "image",
            "inspect",
            "--format",
            "{{.Size}}",
            services[name].image,
          ).trim(),
        );
      const required =
        (driver === "vfs" ? bytes * 2.5 : bytes * 0.25) + 768 * 1024 ** 2;
      (result.resourceChecks ||= []).push({
        service: name,
        freeBytes: disk.bavail * disk.bsize,
        estimatedNeededBytes: required,
      });
      check(
        disk.bavail * disk.bsize > required,
        "insufficient_space_before_owned_service_" + name,
      );
    };
    const startOwned = (names) => {
      for (const name of names) {
        capacityBefore(name);
        console.log(JSON.stringify({ stage: "start:" + name }));
        compose("up", "-d", "--no-build", "--pull", "never", name);
        if (name === "control-plane") controlPlaneExpected = true;
      }
    };

    const sanitize = (svc, name) => {
      const s = structuredClone(svc);
      for (const k of [
        "build",
        "depends_on",
        "container_name",
        "profiles",
        "networks",
        "deploy",
        "expose",
      ])
        delete s[k];
      s.pull_policy = "never";
      if (profile.lightweight)
        s.logging = {
          driver: "json-file",
          options: { "max-size": "5m", "max-file": "1" },
        };
      s.environment = { ...s.environment, ...privateTraffic };

      s.labels = { ...s.labels, [fixtureLabel]: id };
      s.networks = {
        default: {
          aliases: Object.values(svc.networks || {}).flatMap(
            (x) => x?.aliases || [],
          ),
        },
      };
      const browserIce = (p) =>
        interactive &&
        name === "mediamtx" &&
        Number(p.target) === Number(env.BROWSER_ICE_PORT);
      s.ports = (s.ports || [])
        .filter((p) => p.protocol !== "udp" || browserIce(p))
        .map((p) => ({
          ...p,
          published:
            p.target === webPort || browserIce(p) ? String(p.target) : "0",
          host_ip: "127.0.0.1",
        }));
      s.tmpfs = (s.tmpfs || []).filter((x) => !x.startsWith("/data"));
      s.volumes = (s.volumes || []).filter((v) => {
        if (v.type === "bind") return true;
        s.tmpfs.push(fixtureDataTmpfs(name, v.target));
        return false;
      });
      return s;
    };
    for (const key of keep) services[key] = sanitize(source.services[key], key);
    services.web.volumes.push({
      type: "bind",
      source: join(dir, "apps/web/dist"),
      target: "/usr/share/nginx/html",
      read_only: true,
    });
    const volumes = new Map();
    for (const name of [...roles, ...jobs])
      for (const v of source.services[name].volumes || [])
        if (v.type === "bind") {
          const previous = volumes.get(v.target);
          if (previous && previous.source !== v.source)
            throw Error("fixture_mount_collision_" + v.target);
          volumes.set(v.target, v);
        }
    save(
      "roles.json",
      Object.fromEntries(
        [...roles, ...jobs].map((name) => [
          name,
          {
            command: source.services[name].command,
            env: source.services[name].environment,
          },
        ]),
      ),
    );
    const supervisor = fixtureSupervisor({ roles, jobs, staged: true });
    save("supervisor.mjs", supervisor);
    services["control-plane"] = {
      ...(profile.lightweight
        ? {
            logging: {
              driver: "json-file",
              options: { "max-size": "5m", "max-file": "1" },
            },
          }
        : {}),
      image: "streamshield-healing-runtime:latest",
      environment: privateTraffic,
      pull_policy: "never",
      user: "0:0",
      working_dir: "/app",
      read_only: true,
      init: true,
      restart: "no",
      labels: { [fixtureLabel]: id },
      networks: { default: { aliases: roles } },
      ports: [4010, 4020, 4030].map((target) => ({
        target,
        published: "0",
        host_ip: "127.0.0.1",
      })),
      volumes: [
        ...volumes.values(),
        { type: "bind", source: dir, target: "/fixture", read_only: true },
      ],
      tmpfs: ["/tmp:rw,size=64m", "/data:rw,size=128m"],
      command: ["node", "/fixture/supervisor.mjs"],
    };
    const config = {
      name: project,
      services,
      networks: { default: { labels: { [fixtureLabel]: id } } },
    };
    configuredServices = Object.keys(services);
    save("fixture.json", config);
    result.currentStage = "image-and-compose-preflight";
    for (const image of new Set(Object.values(services).map((s) => s.image)))
      docker("image", "inspect", image);
    compose("config", "--quiet");
    for (const name of ["api", "video-gateway"])
      check(
        ["no", undefined].includes(source.services[name].restart),
        "fault_target_restart_policy_is_not_healer_managed",
      );
    mayHaveContainers = true;
    result.currentStage = "database-startup";
    startOwned(["postgres", "redis"]);
    await until(
      "postgres-readiness",
      () => {
        compose(
          "exec",
          "-T",
          "postgres",
          "pg_isready",
          "-U",
          env.POSTGRES_USER,
          "-d",
          env.POSTGRES_DB,
        );
        return true;
      },
      30000,
    );
    result.currentStage = "database-migrations";

    compose(
      "run",
      "--rm",
      "--no-deps",
      "control-plane",
      "node",
      "/fixture/supervisor.mjs",
      "init",
    );
    result.currentStage = "application-startup";
    startOwned(keep.filter((k) => !["postgres", "redis"].includes(k)));
    const baselineStartup = Object.fromEntries(
      (compact
        ? ["api", "video-gateway"]
        : ["api", "api-2", "video-gateway"]
      ).map((name) => [name, inspect(name).State.StartedAt]),
    );
    const base = "http://127.0.0.1:" + webPort;
    const jar = new Map();
    let csrf;
    async function api(path, { method = "GET", body } = {}) {
      const r = await fetch(base + "/api/v1" + path, {
        method,
        headers: {
          Origin: base,
          Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      for (const c of r.headers.getSetCookie()) {
        const part = c.split(";")[0],
          i = part.indexOf("=");
        jar.set(part.slice(0, i), part.slice(i + 1));
      }
      const data = await r.json().catch(() => {
        // Do not serialize the body/parser excerpt: it can contain credentials.
        if (r.ok)
          throw Object.assign(Error("invalid_json_response:" + path), {
            httpStatus: r.status,
          });
        return null;
      });
      if (!r.ok)
        throw Object.assign(
          Error(
            "HTTP_" +
              r.status +
              "_" +
              path +
              "_" +
              (data?.error?.message || data?.message || "request_failed"),
          ),
          { httpStatus: r.status },
        );
      return data;
    }
    await until("api-authentication", async () => {
      const me = await api("/auth/me");
      if (!me?.csrf)
        return pendingFixture({
          reason: "authentication response missing CSRF token",
        });
      return me.csrf;
    });
    let stableApiSince = null;
    await until(
      "api-stable-before-registration",
      async () => {
        const started = performance.now();
        try {
          const readiness = await api("/health/ready");
          const auth = await api("/auth/me");
          await api("/streams");
          const latencyMs = performance.now() - started;
          if (readiness.status !== "ready" || !auth?.csrf || latencyMs > 2500) {
            stableApiSince = null;
            return pendingFixture({
              reason: "API or dependencies have not finished warming up",
              ready: readiness.status === "ready",
              csrfAvailable: Boolean(auth?.csrf),
              latencyMs,
            });
          }
          stableApiSince ??= performance.now();
          const stableForMs = performance.now() - stableApiSince;
          return stableForMs >= 10000
            ? true
            : pendingFixture({ stableForMs, requiredStableMs: 10000 });
        } catch (error) {
          stableApiSince = null;
          throw error;
        }
      },
      120000,
    );
    result.currentStage = "fixture-account-and-source";
    csrf = (await api("/auth/me")).csrf;
    const username = "four_" + id,
      password = randomBytes(20).toString("base64url") + "A1";
    secrets.push(password);
    await api("/auth/register", {
      method: "POST",
      body: { username, email: username + "@example.test", password },
    });
    csrf = (await api("/auth/me")).csrf;
    compose(
      "exec",
      "-T",
      compact ? "api" : "api-2",
      "node",
      "scripts/set-role.mjs",
      username,
      "administrator",
    );
    await api("/channels", {
      method: "POST",
      body: {
        slug: "four-" + id,
        displayName: "Isolated four-scenario source",
        description: "Temporary validation only",
      },
    });
    const channel = (await api("/studio/channel")).channel;
    const stream = await api("/studio/streams", {
      method: "POST",
      body: {
        channelId: channel.id,
        title: crashOnly
          ? "Generated test pattern — two crash scenarios"
          : "Actual four-scenario validation",
        description: "Bounded generated sample video; not production content",
      },
    });
    let mediaControlStableSince = null;
    await until(
      "media-control-readiness",
      async () => {
        try {
          const state = await api("/monitoring/media-control-readiness");
          if (!state.available) {
            mediaControlStableSince = null;
            const reason = /^media_control_[a-z_]{1,40}$/.test(
              String(state.reason),
            )
              ? state.reason
              : "media_control_unavailable";
            throw Error("Media control is not ready (" + reason + ").");
          }
          mediaControlStableSince ??= performance.now();
          const stableForMs = performance.now() - mediaControlStableSince;
          return stableForMs >= 3000
            ? true
            : pendingFixture({ stableForMs, requiredStableMs: 3000 });
        } catch (error) {
          mediaControlStableSince = null;
          throw error;
        }
      },
      90000,
    );
    result.currentStage = "fixture-account-and-source";
    const key = await api("/studio/streams/" + stream.id + "/publishing", {
      method: "POST",
    });
    secrets.push(key.key);
    const rtmp =
      "rtmp://127.0.0.1:" +
      env.MEDIA_RTMP_PORT +
      "/" +
      key.path +
      "?user=" +
      encodeURIComponent(key.user) +
      "&pass=" +
      encodeURIComponent(key.key);
    // Runs in the owned ingest container; no publisher process on the user's machine.
    compose(
      "exec",
      "-d",
      "-T",
      "mediamtx",
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      interactive ? "3600" : compact ? "900" : "480",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "24",
      "-b:v",
      "600k",
      "-c:a",
      "aac",
      "-f",
      "flv",
      rtmp,
    );
    const port = (target) =>
      Number(
        compose("port", "control-plane", String(target))
          .trim()
          .split(":")
          .at(-1),
      );
    const internal = async (target, path, secret) => {
      const r = await fetch("http://127.0.0.1:" + port(target) + path, {
        headers: { Authorization: "Bearer " + secret },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw Error("private_fixture_read_failed");
      return r.json();
    };
    result.currentStage = "control-plane-startup";
    startOwned(["control-plane"]);
    const controlPlaneStartedAt = inspect("control-plane").State.StartedAt;
    result.baseline = await until(
      "scenario-baseline",
      async () => {
        const s = await api("/monitoring/chaos");
        const admission = fixtureAdmission(s, selectedScenarios);
        result.lastAdmission = admission.pending
          ? admission.evidence.denied
          : [];
        return admission;
      },
      120000,
    );
    if (profile.lightweight) {
      const gate = idleBaselineGate({ scenarioIds: selectedScenarios });
      await until(
        "idle-baseline-stable",
        async () => {
          try {
            const chaos = await api("/monitoring/chaos");
            const healer = await api("/monitoring/healing");
            const health = await api("/monitoring/snapshot");
            return gate.observe({ chaos, healer, health });
          } catch (error) {
            gate.reset();
            throw error;
          }
        },
        120000,
      );
      result.baseline.stableIdleMs = 30000;
    }
    result.currentStage = "browser-control";
    const runningDisk = statfsSync(root);
    result.resources.runningFreeBytes = runningDisk.bavail * runningDisk.bsize;
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      headless:
        !interactive || profile.smoke || process.argv.includes("--headless"),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    });
    await context.addCookies(
      [...jar].map(([name, value]) => ({ name, value, url: base })),
    );
    page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(redact(error.message)));
    if (compact) {
      const state = await api("/monitoring/chaos"),
        heal = await api("/monitoring/healing"),
        health = await api("/monitoring/snapshot");
      check(
        state.experiments.length === 0 &&
          heal.attempts.length === 0 &&
          health.incidents.length === 0,
        "baseline_has_unrequested_fault_or_recovery",
      );
      check(
        Object.entries(baselineStartup).every(
          ([name, at]) => inspect(name).State.StartedAt === at,
        ),
        "service_restarted_during_baseline",
      );
      result.baseline.noFaultInjected = true;
      result.baseline.noRecoveryBeforeClick = true;
      check(
        compose(
          "exec",
          "-T",
          "control-plane",
          "node",
          "-e",
          "process.stdout.write(require('node:fs').readFileSync('/data/api-peer-isolated','utf8'))",
        ).trim() === "socket-permission-denied",
        "api_peer_docker_isolation_not_verified",
      );
      result.baseline.apiPeerDockerAccessDenied = true;
      result.baseline.functional = state.crashBaseline;
      result.baseline.components = health.components.map((c) => ({
        id: c.id,
        state: c.state,
        code: c.code,
        observedAt: c.observedAt,
        latencyMs: c.latencyMs,
      }));
      await until(
        "baseline-components-healthy",
        async () => {
          const snapshot = await api("/monitoring/snapshot");
          result.baseline.components = snapshot.components.map((c) => ({
            id: c.id,
            state: c.state,
            code: c.code,
            observedAt: c.observedAt,
            latencyMs: c.latencyMs,
          }));
          const pending = result.baseline.components.filter(
            (c) => c.state !== "HEALTHY",
          );
          return result.baseline.components.length > 0 && pending.length === 0
            ? true
            : pendingFixture({ components: pending });
        },
        120000,
      );
      result.baseline.containerStates = keep.map((name) => {
        const c = inspect(name);
        return {
          service: name,
          state: c.State.Status,
          health: c.State.Health?.Status || null,
          restartCount: c.RestartCount,
        };
      });
    }
    result.urls = {
      control: base + result.controlRoute,
      watch: base + "/watch/" + stream.id,
    };
    await page.goto(result.urls.control);
    await page
      .getByRole("heading", { name: "Watch the system recover." })
      .waitFor();
    check(
      (await page.locator(".demo-choice").count()) ===
        (crashOnly && !existingUi ? 2 : 5),
      "primary_card_count",
    );
    if (crashOnly && !existingUi)
      await page.getByText("SYSTEM HEALTHY", { exact: true }).waitFor();
    let viewer;
    const mediaResponses = [];
    async function browserVideo() {
      const responsesBefore = mediaResponses.length;
      const sample = () =>
        viewer.locator("video").evaluate((video) => ({
          currentTime: video.currentTime,
          width: video.videoWidth,
          height: video.videoHeight,
          frames: video.getVideoPlaybackQuality().totalVideoFrames,
          paused: video.paused,
        }));
      await until(
        "browser-video-element",
        async () => (await viewer.locator("video").count()) > 0,
        30000,
      );
      const before = await sample();
      const after = await until(
        "browser-video-progress",
        async () => {
          const now = await sample();
          return now.width > 0 &&
            now.frames > before.frames &&
            now.currentTime > before.currentTime + 0.5 &&
            mediaResponses.length > responsesBefore &&
            !now.paused
            ? now
            : false;
        },
        30000,
      );
      return {
        observedAt: new Date().toISOString(),
        before,
        after,
        newMediaResponses: mediaResponses.length - responsesBefore,
      };
    }
    if (existingUi) {
      await page.reload();
      await page
        .getByRole("heading", { name: "Watch the system recover." })
        .waitFor();
      viewer = await context.newPage();
      viewer.on("pageerror", (error) => pageErrors.push(redact(error.message)));
      viewer.on("response", (response) => {
        const url = new URL(response.url());
        if (
          response.ok() &&
          url.pathname.startsWith("/media/") &&
          /\.(mp4|ts)$/.test(url.pathname)
        )
          mediaResponses.push({ at: Date.now(), status: response.status() });
      });
      await viewer.goto(base + "/watch/" + stream.id);
      result.baseline.browserPlayback = await browserVideo();
      const home = await context.newPage();
      home.on("pageerror", (error) => pageErrors.push(redact(error.message)));
      await home.goto(base + "/");
      await home
        .locator('a[href="/watch/' + stream.id + '"]:visible')
        .first()
        .waitFor();
      result.baseline.homepageDiscoversOwnedLiveStream = true;
      await home.screenshot({
        path: join(output, "existing-homepage.png"),
        fullPage: true,
      });
      await home.close();
      await page.waitForTimeout(5000); // Read-only refresh/polling must not inject a fault.
      const idle = await api("/monitoring/chaos"),
        heal = await api("/monitoring/healing");
      check(
        idle.experiments.length === 0 && heal.attempts.length === 0,
        "refresh_or_polling_triggered_fault",
      );
      result.baseline.refreshAndPollingNoFault = true;
    }
    await page.screenshot({
      path: join(output, "baseline.png"),
      fullPage: true,
    });
    if (interactive) {
      result.currentStage = "interactive-demo";
      result.status = "READY";
      console.log(
        JSON.stringify({
          status: "READY",
          ...result.urls,
          message:
            "Use the signed-in demo browser. Close it or press Ctrl+C to stop only this disposable demo. Session expires after 60 minutes.",
        }),
      );
      await page.bringToFront();
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          clearInterval(capacityTimer);
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          browser.off("disconnected", stop);
          if (error) reject(error);
          else resolve();
        };
        const stop = () => finish();
        const timer = setTimeout(stop, profile.smoke ? 3000 : 3600000);
        const capacityTimer = setInterval(() => {
          try {
            const disk = statfsSync(root);
            if (disk.bavail * disk.bsize < 768 * 1024 ** 2)
              finish(Error("demo_disk_safety_margin_reached"));
            else if (inspect("control-plane").State.Status !== "running")
              finish(Error("demo_control_plane_exited"));
          } catch (error) {
            finish(error);
          }
        }, 5000);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        browser.once("disconnected", stop);
      });
      result.status = "DEMO_STOPPED";
      result.interactiveSnapshot = await api("/monitoring/chaos");
      if (profile.smoke)
        check(
          result.interactiveSnapshot.experiments.length === 0,
          "startup_injected_fault",
        );
    } else {
      const cases = [
        ["crash-api", "api", "api-1"],
        ["crash-video-gateway", "video-gateway", "video-gateway"],
        ["crash-edge", "edge-1", "edge-1"],
        ["network-timeout", null, "demo-dependency"],
      ].filter(([scenario]) => selectedScenarios.includes(scenario));
      for (const [scenario, service, target] of Array.from(
        { length: repetitions },
        () => cases,
      ).flat()) {
        await until(
          "scenario-availability:" + scenario,
          async () => {
            const snapshot = await api("/monitoring/chaos");
            return fixtureAdmission(snapshot, [scenario]);
          },
          120000,
        );
        result.currentStage = "scenario-execution:" + scenario;
        const cardHealthStates = new Set();
        let apiBackupResponseObserved = false;
        let actionTopBefore = null;
        if (existingUi) {
          await until(
            "card-healthy-before:" + scenario,
            async () =>
              (await page
                .getByTestId("scenario-health-" + scenario)
                .textContent()) === "HEALTHY",
            30000,
          );
          cardHealthStates.add("HEALTHY");
          actionTopBefore = await page
            .locator(".demo-action")
            .evaluate(
              (element) => element.getBoundingClientRect().top + window.scrollY,
            );
        }

        const initial = service ? inspect(service) : null,
          peer = scenario === "crash-edge" ? inspect("edge-2") : null;
        if (crashOnly && !existingUi)
          await page
            .getByRole("button", {
              name:
                scenario === "crash-api"
                  ? "Simulate API Crash"
                  : "Simulate Video Gateway Crash",
            })
            .click();
        else {
          await page.locator('[data-scenario="' + scenario + '"]').click();
          await page
            .getByRole("button", { name: "Run failure demonstration" })
            .click();
        }
        await page.getByRole("checkbox").check();
        await page.getByLabel("Confirm target").fill(target);
        const submissionResponse = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname ===
              "/api/v1/monitoring/chaos/experiments",
        );
        await page
          .getByRole("button", { name: "Inject controlled failure" })
          .click();
        const submitted = await submissionResponse;
        check(submitted.ok(), "button_submission_http_" + submitted.status());
        const submittedExperiment = await submitted.json();
        check(
          typeof submittedExperiment.id === "string",
          "button_submission_missing_run_id",
        );
        let experiment,
          stopped = false,
          fallback = false,
          viewerImpactObserved = false,
          dependencyLoadingObserved = false;
        const start = performance.now();
        while (performance.now() - start < 200000) {
          if (stopRequested) throw Error("demo_stop_requested");
          let s;
          try {
            s = await api("/monitoring/chaos");
          } catch (error) {
            // A crash can briefly interrupt a control read through the gateway.
            // Keep the original deadline and all independent success requirements;
            // never retry fault submission or treat an unavailable read as recovery.
            if (!(
              [502, 503, 504].includes(error.httpStatus) ||
              error.name === "TimeoutError" ||
              ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(
                error.cause?.code,
              )
            ))
              throw error;
            (result.monitoringReadFailures ||= []).push({
              scenario,
              observedAt: new Date().toISOString(),
              code: error.httpStatus
                ? "http_" + error.httpStatus
                : error.cause?.code || error.name,
            });
            await wait(500);
            continue;
          }
          experiment = s.experiments.find(
            (e) => e.id === submittedExperiment.id && e.scenario === scenario,
          );
          if (existingUi)
            cardHealthStates.add(
              await page
                .getByTestId("scenario-health-" + scenario)
                .textContent(),
            );
          if (profile.lightweight && viewer && experiment?.injectedAt) {
            if (
              scenario === "crash-api" &&
              experiment.faultConfirmedAt &&
              !experiment.verifiedAt &&
              (await viewer.getByTestId("api-continuity").count())
            )
              apiBackupResponseObserved ||=
                (await viewer
                  .getByTestId("api-continuity")
                  .getAttribute("data-served-by")) === "api-2";
            const impact = viewer.getByTestId("live-service-impact");
            if (await impact.count())
              viewerImpactObserved ||=
                (await impact.getAttribute("data-state")) === "recovering";
            const recommendations = viewer.getByTestId("recommendation-status");
            if (
              scenario === "network-timeout" &&
              (await recommendations.count())
            )
              dependencyLoadingObserved ||=
                (await recommendations.getAttribute("data-state")) ===
                "reconnecting";
          }
          if (experiment?.faultConfirmedAt && service) {
            stopped ||= inspect(service).State.Status === "exited";
            if (scenario === "crash-edge" && !fallback) {
              try {
                const r = await fetch(
                  base + "/media/primary/" + key.path + "/index.m3u8",
                  { signal: AbortSignal.timeout(5000) },
                );
                fallback = r.ok && r.headers.get("x-edge-id") === "edge-2";
                await r.body?.cancel();
              } catch {
                /* failed media read is not fallback evidence */
              }
            }
          }
          if (
            experiment &&
            ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(
              experiment.state,
            )
          )
            break;
          await wait(500);
        }
        check(experiment, "experiment_missing");
        const attempts = (await api("/monitoring/healing")).attempts.filter(
          (a) => experiment.recoveryIds.includes(a.id),
        );
        const record = {
          scenario,
          status: "FAIL",
          experiment,
          attempts,
          stoppedObserved: stopped,
          viewerImpactObserved,
          dependencyLoadingObserved,
          edgeFallbackObserved: scenario === "crash-edge" ? fallback : null,
          peerUnchanged: peer
            ? inspect("edge-2").State.StartedAt === peer.State.StartedAt
            : null,
          controlPlaneUnchanged:
            inspect("control-plane").State.StartedAt === controlPlaneStartedAt,
          actualRecoveryMs: experiment.measurements.restorationMs,
          apiBackupResponseObserved:
            scenario === "crash-api" ? apiBackupResponseObserved : null,
          demonstrationMs: experiment.measurements.demonstrationMs,
        };
        result.scenarios.push(record);
        check(
          record.controlPlaneUnchanged,
          "independent_control_plane_restarted",
        );
        check(
          experiment.state === "COMPLETED",
          "scenario_failed_" +
            scenario +
            "_" +
            experiment.state +
            "_" +
            experiment.reason,
        );
        if (profile.lightweight) {
          check(viewerImpactObserved, "live_recovery_status_not_visible");
          if (scenario === "network-timeout")
            check(
              dependencyLoadingObserved,
              "affected_recommendations_loading_not_visible",
            );
        }
        check(
          experiment.faultConfirmedAt &&
            experiment.incidentDetectedAt &&
            experiment.verifiedAt,
          "missing_actual_lifecycle_evidence",
        );
        check(
          experiment.measurements.demonstrationMs >= 15000,
          "observation_window_shortened",
        );
        check(
          experiment.evidence.independentBehaviorVerified === true,
          "behavior_not_verified",
        );
        if (service) {
          check(stopped, "actual_target_stop_not_observed");
          check(
            inspect(service).State.StartedAt !== initial.State.StartedAt,
            "container_not_restarted",
          );
          check(
            attempts.some(
              (a) =>
                a.state === "VERIFIED" &&
                a.evidence.controlReceipt === "docker_start_accepted",
            ),
            "independent_healer_receipt_missing",
          );
        }
        if (scenario === "crash-edge") {
          check(record.peerUnchanged, "surviving_edge_restarted");
          check(fallback, "healthy_edge_fallback_not_observed");
          if (profile.lightweight)
            check(
              experiment.evidence.edgeBefore === "edge-1" &&
                experiment.evidence.edgeAfter === "edge-2" &&
                experiment.evidence.edgeFailoverObservedAt,
              "controller_edge_identity_change_not_verified",
            );
        }
        if (scenario === "network-timeout") {
          if (profile.lightweight)
            check(
              experiment.evidence.dependencyReadAttempts >= 2 &&
                experiment.evidence.lastCircuitState === "CLOSED" &&
                experiment.events.some((e) => e.kind === "CIRCUIT_OPEN"),
              "bounded_dependency_reconnection_not_observed",
            );
          check(
            experiment.evidence.networkWithinTolerance === true &&
              experiment.cleanup === "COMPLETED",
            "network_baseline_not_restored",
          );
        }
        if (crashOnly && !existingUi) {
          const label =
            scenario === "crash-api"
              ? "API RECOVERED"
              : "VIDEO GATEWAY RECOVERED";
          await page.getByText(label, { exact: true }).waitFor();
          record.uiRecoveredLabel = label;
        }
        if (existingUi) {
          await page
            .getByRole("heading", {
              name: "Verified demonstration result",
              exact: true,
            })
            .waitFor();
          await until(
            "card-healthy-after:" + scenario,
            async () =>
              (await page
                .getByTestId("scenario-health-" + scenario)
                .textContent()) === "HEALTHY",
            30000,
          );
          cardHealthStates.add("HEALTHY");
          check(
            (await page
              .getByTestId("demo-recovery-cycle")
              .locator('[data-confirmed="true"]')
              .count()) === 4,
            "missing_persistent_recovery_sequence",
          );
          const actionTopAfter = await page
            .locator(".demo-action")
            .evaluate(
              (element) => element.getBoundingClientRect().top + window.scrollY,
            );
          record.stableCardLayout =
            Math.abs(actionTopAfter - actionTopBefore) <= 2;
          check(
            record.stableCardLayout,
            "card_layout_shifted_between_ready_and_recovered",
          );
          record.cardHealthStates = [...cardHealthStates];
          record.currentHealthReturnedToHealthy = true;
          record.persistentRecoverySequence = true;
          if (profile.lightweight && scenario === "crash-api")
            check(
              apiBackupResponseObserved,
              "actual_backup_api_response_not_shown",
            );
          record.browserPlayback = await browserVideo();
          record.existingUiVerifiedResult = true;
          await viewer.screenshot({
            path: join(output, scenario + "-watch.png"),
            fullPage: true,
          });
        }
        await page.screenshot({
          path: join(output, scenario + ".png"),
          fullPage: true,
        });
        if (existingUi)
          await page.screenshot({
            path: join(
              output,
              scenario + "-" + submittedExperiment.id + ".png",
            ),
            fullPage: true,
          });
        record.status = "PASS";
        console.log(
          JSON.stringify({
            scenario,
            status: "PASS",
            recoveryMs: record.actualRecoveryMs,
            demonstrationMs: record.demonstrationMs,
          }),
        );
      }
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 1050 });
        await page.screenshot({
          path: join(output, "responsive-" + width + ".png"),
          fullPage: true,
        });
        check(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "horizontal_overflow_" + width,
        );
      }
      result.finalObservations = await internal(
        4010,
        "/observations",
        env.OBS_SECRET,
      );
      if (existingUi) {
        const startedAt = inspect("api").State.StartedAt;
        // Separate, bounded negative startup test. The running API is never stopped:
        // an owned child must reject the occupied port and clean up its own clients.
        result.currentStage = "occupied-port-startup-probe";
        // Trace only the disposable negative-test child. Never change the running API.
        const startupSource = readFileSync(
          join(dir, "services/api/src/server.ts"),
          "utf8",
        );
        const tracedStartup = startupSource
          .replace(
            "    await r.start();",
            "    console.error('probe:resources:start'); await r.start(); console.error('probe:resources:ready');",
          )
          .replace(
            "    // Close partially initialized listeners/clients, retaining the original cause.",
            "    console.error(JSON.stringify(startupDiagnostic(error, process.env)));\n    let closeIndex = 0;",
          )
          .replace(
            "        await close();",
            "        console.error('probe:cleanup:' + closeIndex + ':start'); await close(); console.error('probe:cleanup:' + closeIndex++ + ':done');",
          );
        writeFileSync(
          join(dir, "services/api/src/fixture-startup-probe.ts"),
          tracedStartup,
          { mode: 0o644 },
        );
        chmodSync(
          join(dir, "services/api/src/fixture-startup-probe.ts"),
          0o644,
        );
        const collisionProbe = String.raw`
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['--import','tsx','services/api/src/fixture-startup-probe.ts'],{env:{...process.env,LOG_LEVEL:'silent'},stdio:['ignore','pipe','pipe']});
        let output='',errors='',timedOut=false;
        child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors=(errors+c).slice(-12000));
        const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},10000);
        child.on('close',(exitCode)=>{clearTimeout(timeout);const diagnostic=output.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(x=>x.event==='api_startup_failed');console.log(JSON.stringify({exitCode,timedOut,diagnostic,trace:errors}));});
      `;
        const collision = JSON.parse(
          redact(compose("exec", "-T", "api", "node", "-e", collisionProbe)),
        );
        result.occupiedPortStartupProbe = collision;
        check(
          !collision.timedOut &&
            collision.exitCode === 1 &&
            collision.diagnostic?.stage === "public_listener" &&
            collision.diagnostic.failures.some((x) => x.code === "EADDRINUSE"),
          "startup_conflict_not_safely_reported",
        );
        check(
          inspect("api").State.StartedAt === startedAt,
          "startup_probe_restarted_running_api",
        );
        const healthy = await until(
          "api-ready-after-startup-probe",
          async () => {
            const r = await api("/health/ready");
            return r.status === "ready";
          },
        );
        check(healthy, "running_api_unhealthy_after_startup_probe");
      }
      result.pageErrors = pageErrors;
      check(pageErrors.length === 0, "unhandled_existing_website_error");
      result.status = "PASS";
    }
  }
} catch (e) {
  result.error = redact(e.message);
  result.failure = {
    stage: e.stage || result.currentStage,
    at: new Date().toISOString(),
    error: fixtureError(e, redact),
  };
  if (mayHaveContainers) {
    result.startupDiagnostics = [];
    for (const name of configuredServices) {
      try {
        const c = inspect(name);
        result.startupDiagnostics.push(fixtureServiceState(name, c, redact));
      } catch (error) {
        result.startupDiagnostics.push({
          service: name,
          status: "not-inspectable",
          error: fixtureError(error, redact),
        });
      }
    }
  }

  if (e.stderr)
    writeFileSync(join(output, "fixture-error.log"), redact(e.stderr));
  if (
    /^need_\d+GB_free_before_owned_fixture|^insufficient_space_before_owned_service/.test(
      e.message,
    )
  ) {
    result.status = "BLOCKED";
    process.exitCode = 2;
  } else process.exitCode = 1;
} finally {
  process.off("SIGINT", requestStop);
  process.off("SIGTERM", requestStop);
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (mayHaveContainers) {
    result.artifacts.serviceLogs = [];
    for (const name of configuredServices) {
      try {
        const cid = compose("ps", "-aq", name).trim();
        if (!cid) continue;
        const logs = spawnSync(
          "docker",
          ["logs", "--timestamps", "--tail", "120", cid],
          {
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 256 * 1024,
          },
        );
        if (logs.error || logs.status !== 0) {
          (result.diagnosticErrors ||= []).push({
            service: name,
            error: fixtureError(
              logs.error || Error("container_logs_exit_" + logs.status),
              redact,
            ),
          });
          continue;
        }
        mkdirSync(join(output, "services"), { recursive: true });
        const file = "services/" + name + ".log";
        writeFileSync(
          join(output, file),
          redact(String(logs.stdout) + String(logs.stderr)),
          { mode: 0o600 },
        );
        result.artifacts.serviceLogs.push({ service: name, file });
      } catch (error) {
        (result.diagnosticErrors ||= []).push({
          service: name,
          error: fixtureError(error, redact),
        });
      }
    }
    try {
      writeFileSync(
        join(output, "fixture.log"),
        redact(compose("logs", "--no-color", "--tail", "100")),
        { mode: 0o600 },
      );
      result.artifacts.combinedLog = "fixture.log";
    } catch (error) {
      (result.diagnosticErrors ||= []).push({
        stage: "combined-logs",
        error: fixtureError(error, redact),
      });
    }
  }
  let removedContainers = 0;
  try {
    if (mayHaveContainers) {
      const ids = docker(
        "ps",
        "-aq",
        "--filter",
        "label=" + fixtureLabel + "=" + id,
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const cid of ids) {
        const labels = JSON.parse(
          docker("inspect", "--format", "{{json .Config.Labels}}", cid),
        );
        check(labels[fixtureLabel] === id, "cleanup_identity_mismatch");
        docker("rm", "-f", cid);
        removedContainers++;
      }
      const nets = docker(
        "network",
        "ls",
        "-q",
        "--filter",
        "label=" + fixtureLabel + "=" + id,
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const net of nets) docker("network", "rm", net);
    }
  } catch (error) {
    result.cleanupFailure = fixtureError(error, redact);
    result.status = "FAIL";
    process.exitCode = 1;
  }
  result.cleanedContainers = removedContainers;
  result.verifiedScenarios = result.scenarios.filter(
    (s) => s.status === "PASS",
  ).length;
  result.userEnvUnchanged = hash() === before;
  result.finishedAt = new Date().toISOString();
  if (!result.userEnvUnchanged) {
    result.status = "FAIL";
    process.exitCode = 1;
  }
  const measurements = JSON.stringify(result, null, 2) + "\n";
  writeFileSync(join(output, "measurements.json"), measurements);
  if (output !== outputRoot)
    writeFileSync(join(outputRoot, "measurements.json"), measurements);
  if (!result.cleanupFailure) rmSync(dir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      status: result.status,
      error: result.error || null,
      scenarios: result.scenarios.length,
      verifiedScenarios: result.verifiedScenarios,
      cleanedContainers: removedContainers,
      stage: result.failure?.stage || result.currentStage,
      artifacts: result.artifacts.directory,
      userEnvUnchanged: result.userEnvUnchanged,
      results: profile.output + "/measurements.json",
    }),
  );
}
