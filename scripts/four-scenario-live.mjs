import { createServer } from "node:net";
// Real isolated four-scenario validation. No user .env, services or volumes are changed.
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
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
const root = process.cwd(),
  id = randomUUID().slice(0, 8),
  project = "ss-four-" + id;
const dir = mkdtempSync(join(tmpdir(), project + "-"));
const output = join(root, "test-results/four-scenario");
mkdirSync(output, { recursive: true });
const result = {
  id,
  status: "FAIL",
  startedAt: new Date().toISOString(),
  scenarios: [],
  limitations: [
    "Isolated Linux Docker fixture using actual repository services; not the user's Windows installation. Control-plane processes share one fixture container to fit VFS disk capacity. No browser decoded-frame recovery claim unless separately recorded.",
  ],
};
const hash = () =>
    createHash("sha256")
      .update(readFileSync(join(root, ".env")))
      .digest("hex"),
  before = hash();
let secrets = [],
  browser,
  context,
  page;
const redact = (s) =>
  secrets.reduce((v, secret) => v.replaceAll(secret, "[redacted]"), String(s));
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
async function until(fn, timeout = 90000) {
  const start = performance.now();
  let last;
  while (performance.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await wait(500);
  }
  throw Error("fixture_wait_timeout" + (last ? ": " + last.message : ""));
}
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
  const disk = statfsSync(root);
  const driver = docker("info", "--format", "{{.Driver}}").trim();
  const minimumGB = driver === "vfs" ? 8 : 4;
  check(
    disk.bavail * disk.bsize > minimumGB * 1024 ** 3,
    "need_" + minimumGB + "GB_free_before_owned_fixture_" + driver,
  );
  check(
    existsSync(join(root, "apps/web/dist/index.html")),
    "build_frontend_first",
  );
  const browserCheck = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  await browserCheck.close();
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const webPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const archive = execFileSync("git", ["archive", "HEAD"], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  const paths = execFileSync(
    "git",
    ["ls-files", "-m", "-o", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const p of paths) {
    if (p === ".env" || p.startsWith(".local/"))
      throw Error("unexpected_sensitive_source_path");
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    copyFileSync(join(root, p), join(dir, p));
  }
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  let text = readFileSync(join(root, ".env.example"), "utf8");
  const set = (k, v) => {
    if (!new RegExp("^" + k + "=", "m").test(text)) text += "\n" + k + "=\n";
    text = text.replace(new RegExp("^" + k + "=.*$", "m"), k + "=" + v);
  };
  for (const [k, v] of Object.entries({
    COMPOSE_PROJECT_NAME: project,
    WEB_PORT: String(webPort),
    CORS_ORIGINS:
      "http://127.0.0.1:" + webPort + ",http://localhost:" + webPort,
    E2E_BASE_URL: "http://127.0.0.1:" + webPort,
    HEALER_ENABLED: "true",
    CHAOS_ENABLED: "true",
    CHAOS_ENVIRONMENT: "local-development",
    CHAOS_ALLOWED_SCENARIOS:
      "crash-api,crash-video-gateway,crash-edge,network-timeout",
    CHAOS_OBSERVATION_WINDOW_MS: "15000",
    CHAOS_FAULT_DURATION_MS: "8000",
    POSTGRES_DB: "fixture_" + id,
    POSTGRES_USER: "fixture",
    POSTGRES_PASSWORD: randomBytes(32).toString("base64url"),
  }))
    set(k, v);
  save(".env", text);
  run(
    process.execPath,
    ["--import", "tsx", "scripts/setup-dynamic.mjs", "--enable-local-chaos"],
    { env: { ...process.env, COMPOSE_PROJECT_NAME: project }, timeout: 120000 },
  );
  const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
  secrets = Object.entries(env)
    .filter(([k, v]) => /PASSWORD|SECRET|TOKEN/.test(k) && v.length > 8)
    .map(([, v]) => v);
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
  const roles = [
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
    "toxiproxy",
    "web",
  ];
  const services = {};
  const sanitize = (svc) => {
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
    s.restart = "no";
    s.labels = { ...s.labels, "streamshield.four-run": id };
    s.networks = {
      default: {
        aliases: Object.values(svc.networks || {}).flatMap(
          (x) => x?.aliases || [],
        ),
      },
    };
    s.ports = (s.ports || [])
      .filter((p) => p.protocol !== "udp")
      .map((p) => ({
        ...p,
        published: p.target === webPort ? String(webPort) : "0",
        host_ip: "127.0.0.1",
      }));
    s.tmpfs = (s.tmpfs || []).filter((x) => !x.startsWith("/data"));
    s.volumes = (s.volumes || []).filter((v) => {
      if (v.type === "bind") return true;
      s.tmpfs.push(v.target + ":rw,size=256m");
      return false;
    });
    return s;
  };
  for (const key of keep) services[key] = sanitize(source.services[key]);
  services.web.volumes.push({
    type: "bind",
    source: join(root, "apps/web/dist"),
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
  const supervisor = `import {spawn,execFileSync} from 'node:child_process';import {readFileSync,mkdirSync} from 'node:fs';const roles=JSON.parse(readFileSync('/fixture/roles.json'));for(const p of ['/data/chaos','/data/healer'])mkdirSync(p,{recursive:true});if(process.argv[2]==='init'){for(const key of ${JSON.stringify(jobs)}){const s=roles[key];execFileSync(s.command[0],s.command.slice(1),{env:{...process.env,...s.env},stdio:'inherit'});}}else{const children=${JSON.stringify(roles)}.map(key=>{const s=roles[key];const child=spawn(s.command[0],s.command.slice(1),{env:{...process.env,...s.env},stdio:'inherit'});child.on('exit',code=>{if(!closing){console.error('fixture role exited',key,code);process.exitCode=1;shutdown();}});return child;});let closing=false;function shutdown(){closing=true;for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(process.exitCode||0),2000);}process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);}`;
  save("supervisor.mjs", supervisor);
  services["control-plane"] = {
    image: "streamshield-healing-runtime:latest",
    pull_policy: "never",
    user: "0:0",
    working_dir: "/app",
    read_only: true,
    init: true,
    restart: "no",
    labels: { "streamshield.four-run": id },
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
    networks: { default: { labels: { "streamshield.four-run": id } } },
  };
  save("fixture.json", config);
  for (const image of new Set(Object.values(services).map((s) => s.image)))
    docker("image", "inspect", image);
  compose("config", "--quiet");
  compose("up", "-d", "--no-build", "--pull", "never", "postgres", "redis");
  await until(() => {
    try {
      compose("exec", "-T", "postgres", "pg_isready", "-U", env.POSTGRES_USER);
      return true;
    } catch {
      return false;
    }
  }, 30000);
  compose(
    "run",
    "--rm",
    "--no-deps",
    "control-plane",
    "node",
    "/fixture/supervisor.mjs",
    "init",
  );
  compose(
    "up",
    "-d",
    "--no-build",
    "--pull",
    "never",
    ...keep.filter((k) => !["postgres", "redis"].includes(k)),
    "control-plane",
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
    const data = await r.json().catch(() => null);
    if (!r.ok)
      throw Error(
        "HTTP_" +
          r.status +
          "_" +
          path +
          "_" +
          (data?.error?.message || data?.message || "request_failed"),
      );
    return data;
  }
  await until(async () => {
    try {
      return (await api("/auth/me")).csrf;
    } catch {
      return false;
    }
  });
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
    "api-2",
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
      title: "Actual four-scenario validation",
      description: "Bounded test source",
    },
  });
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
    "480",
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
      compose("port", "control-plane", String(target)).trim().split(":").at(-1),
    );
  const internal = async (target, path, secret) => {
    const r = await fetch("http://127.0.0.1:" + port(target) + path, {
      headers: { Authorization: "Bearer " + secret },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw Error("private_fixture_read_failed");
    return r.json();
  };
  result.baseline = await until(async () => {
    const s = await api("/monitoring/chaos");
    const unavailable = s.scenarios.filter(
      (s) =>
        [
          "crash-api",
          "crash-video-gateway",
          "crash-edge",
          "network-timeout",
        ].includes(s.id) && !s.available,
    );
    result.lastAdmission = unavailable.map((s) => ({
      id: s.id,
      reason: s.reason,
    }));
    return unavailable.length
      ? false
      : {
          observedAt: s.observedAt,
          scenarioIds: s.scenarios
            .filter((s) =>
              [
                "crash-api",
                "crash-video-gateway",
                "crash-edge",
                "network-timeout",
              ].includes(s.id),
            )
            .map((s) => s.id),
        };
  }, 120000);
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
  });
  await context.addCookies(
    [...jar].map(([name, value]) => ({ name, value, url: base })),
  );
  page = await context.newPage();
  await page.goto(base + "/control/presentation");
  await page
    .getByRole("heading", { name: "Watch the system recover." })
    .waitFor();
  check(
    (await page.locator(".demo-choice").count()) === 4,
    "primary_card_count",
  );
  await page.screenshot({ path: join(output, "baseline.png"), fullPage: true });
  for (const [scenario, service, target] of [
    ["crash-api", "api", "api-1"],
    ["crash-video-gateway", "video-gateway", "video-gateway"],
    ["crash-edge", "edge-1", "edge-1"],
    ["network-timeout", null, "demo-dependency"],
  ]) {
    await until(
      async () =>
        (await api("/monitoring/chaos")).scenarios.find(
          (s) => s.id === scenario,
        )?.available,
      120000,
    );
    const initial = service ? inspect(service) : null,
      peer = scenario === "crash-edge" ? inspect("edge-2") : null;
    await page.locator('[data-scenario="' + scenario + '"]').click();
    await page
      .getByRole("button", { name: "Run failure demonstration" })
      .click();
    await page.getByRole("checkbox").check();
    await page.getByLabel("Confirm target").fill(target);
    await page
      .getByRole("button", { name: "Inject controlled failure" })
      .click();
    let experiment,
      stopped = false,
      fallback = false;
    const start = performance.now();
    while (performance.now() - start < 200000) {
      const s = await api("/monitoring/chaos");
      experiment = s.experiments.find((e) => e.scenario === scenario);
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
    const attempts = (await api("/monitoring/healing")).attempts.filter((a) =>
      experiment.recoveryIds.includes(a.id),
    );
    const record = {
      scenario,
      experiment,
      attempts,
      stoppedObserved: stopped,
      edgeFallbackObserved: scenario === "crash-edge" ? fallback : null,
      peerUnchanged: peer
        ? inspect("edge-2").State.StartedAt === peer.State.StartedAt
        : null,
      actualRecoveryMs: experiment.measurements.restorationMs,
      demonstrationMs: experiment.measurements.demonstrationMs,
    };
    result.scenarios.push(record);
    check(
      experiment.state === "COMPLETED",
      "scenario_failed_" +
        scenario +
        "_" +
        experiment.state +
        "_" +
        experiment.reason,
    );
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
    }
    if (scenario === "network-timeout")
      check(
        experiment.evidence.networkWithinTolerance === true &&
          experiment.cleanup === "COMPLETED",
        "network_baseline_not_restored",
      );
    await page.screenshot({
      path: join(output, scenario + ".png"),
      fullPage: true,
    });
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
  result.status = "PASS";
} catch (e) {
  result.error = redact(e.message);
  if (e.stderr)
    writeFileSync(join(output, "fixture-error.log"), redact(e.stderr));
  if (/^need_\d+GB_free_before_owned_fixture/.test(e.message)) {
    result.status = "BLOCKED";
    process.exitCode = 2;
  } else process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  try {
    writeFileSync(
      join(output, "fixture.log"),
      redact(compose("logs", "--no-color", "--tail", "100")),
    );
  } catch {
    /* fixture may not have reached service creation */
  }
  const ids = docker(
    "ps",
    "-aq",
    "--filter",
    "label=streamshield.four-run=" + id,
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const cid of ids) {
    const labels = JSON.parse(
      docker("inspect", "--format", "{{json .Config.Labels}}", cid),
    );
    check(labels["streamshield.four-run"] === id, "cleanup_identity_mismatch");
    docker("rm", "-f", cid);
  }
  const nets = docker(
    "network",
    "ls",
    "-q",
    "--filter",
    "label=streamshield.four-run=" + id,
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const net of nets) docker("network", "rm", net);
  result.cleanedContainers = ids.length;
  result.userEnvUnchanged = hash() === before;
  result.finishedAt = new Date().toISOString();
  if (!result.userEnvUnchanged) {
    result.status = "FAIL";
    process.exitCode = 1;
  }
  writeFileSync(
    join(output, "measurements.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  rmSync(dir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      status: result.status,
      error: result.error || null,
      scenarios: result.scenarios.length,
      cleanedContainers: ids.length,
      userEnvUnchanged: result.userEnvUnchanged,
      results: "test-results/four-scenario/measurements.json",
    }),
  );
}
