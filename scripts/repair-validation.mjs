// Isolated real PostgreSQL/Observer and Toxiproxy checks. Never uses the user's stack/volumes.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { parseEnv } from "node:util";
import { Pool } from "pg";
import { Circuit } from "../services/api/src/healing/circuit.ts";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const root = process.cwd(),
  runId = randomUUID().slice(0, 8),
  dir = mkdtempSync(join(tmpdir(), "streamshield-repair-"));
chmodSync(dir, 0o755);
const label = "streamshield.repair-validation=" + runId,
  network = "ss-repair-" + runId,
  ids = [];
const output = "test-results/one-run-repair";
mkdirSync(output, { recursive: true });
const evidence = {
  runId,
  status: "FAIL",
  startedAt: new Date().toISOString(),
  checks: {},
  limitations: [
    "Isolated real Observer/PostgreSQL and dependency-network checks only; not the complete five-scenario deployment or the user's Windows machine.",
  ],
};
const envHash = () =>
    existsSync(".env")
      ? createHash("sha256").update(readFileSync(".env")).digest("hex")
      : null,
  originalEnv = envHash();
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  }).trim();
const port = (id, p) =>
  Number(
    docker("port", id, p + "/tcp")
      .split(":")
      .at(-1),
  );
const secret = () => randomBytes(32).toString("base64url");
const password = secret(),
  authority = secret(),
  observerSecret = secret(),
  observerPassword = secret(),
  metricsPassword = secret();
const saveEnv = (name, values) => {
  const path = join(dir, name);
  writeFileSync(
    path,
    Object.entries(values)
      .map(([k, v]) => k + "=" + v)
      .join("\n"),
    { mode: 0o600 },
  );
  return path;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const start = performance.now();
  while (performance.now() - start < ms) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      /* bounded readiness retry */
    }
    await sleep(200);
  }
  throw Error("isolated_readiness_timeout");
};
const freePort = async () => {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};
let db,
  observer,
  networkCreated = false;
const children = [];
const check = (condition, name) => {
  if (!condition) throw Error(name);
};
try {
  for (const image of [
    "postgres:17.9-alpine",
    "ghcr.io/shopify/toxiproxy:2.13.0",
    "streamshield-healing-runtime:latest",
  ])
    docker("image", "inspect", image);
  docker("network", "create", "--label", label, network);
  networkCreated = true;
  const pg = docker(
    "run",
    "-d",
    "--pull=never",
    "--label",
    label,
    "--name",
    network + "-pg",
    "--network",
    network,
    "--tmpfs",
    "/var/lib/postgresql/data:rw,size=256m",
    "-p",
    "127.0.0.1::5432",
    "--env-file",
    saveEnv("pg.vars", {
      POSTGRES_USER: "repair_test",
      POSTGRES_DB: "repair_test",
      POSTGRES_PASSWORD: password,
    }),
    "postgres:17.9-alpine",
  );
  ids.push(pg);
  const pgPort = port(pg, 5432),
    dbEnv = {
      POSTGRES_HOST: "127.0.0.1",
      POSTGRES_PORT: String(pgPort),
      POSTGRES_DB: "repair_test",
      POSTGRES_USER: "repair_test",
      POSTGRES_PASSWORD: password,
      DEPENDENCY_TIMEOUT_MS: "2000",
    };
  db = new Pool({
    host: "127.0.0.1",
    port: pgPort,
    database: "repair_test",
    user: "repair_test",
    password,
    max: 3,
    connectionTimeoutMillis: 1000,
    statement_timeout: 2000,
  });
  await until(() => db.query("SELECT 1").then(() => true));
  execFileSync(process.execPath, ["scripts/migrate.mjs"], {
    env: { ...process.env, ...dbEnv },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  execFileSync(process.execPath, ["scripts/setup-metrics-db.mjs"], {
    env: {
      ...process.env,
      ...dbEnv,
      OBS_DB_PASSWORD: observerPassword,
      OBS_PG_PASSWORD: metricsPassword,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  evidence.checks.migrations = (
    await db.query("SELECT count(*)::int AS n FROM schema_migrations")
  ).rows[0].n;
  const toxName = network + "-toxi",
    tox = docker(
      "run",
      "-d",
      "--pull=never",
      "--label",
      label,
      "--name",
      toxName,
      "--network",
      network,
      "-p",
      "127.0.0.1::8474",
      "-p",
      "127.0.0.1::8666",
      "ghcr.io/shopify/toxiproxy:2.13.0",
    );
  ids.push(tox);
  const toxUrl = "http://127.0.0.1:" + port(tox, 8474),
    proxyUrl = "http://127.0.0.1:" + port(tox, 8666) + "/status";
  await until(() => fetch(toxUrl + "/version").then((r) => r.ok));
  const runtimeName = network + "-runtime";
  const runtime = docker(
    "run",
    "-d",
    "--pull=never",
    "--label",
    label,
    "--name",
    runtimeName,
    "--network",
    network,
    "--tmpfs",
    "/data:rw,mode=1777,size=16m",
    "-p",
    "127.0.0.1::4031",
    "-p",
    "127.0.0.1::4024",
    "--env-file",
    saveEnv("adapter.vars", {
      NODE_ENV: "development",
      BIND_ADDRESS: "127.0.0.1",
      CHAOS_ENABLED: "true",
      CHAOS_ENVIRONMENT: "local-development",
      CHAOS_SECRET: secret(),
      CHAOS_CONTROL_SECRET: authority,
      CHAOS_ALLOWED_SCENARIOS: "network-timeout",
      CHAOS_FAULT_DURATION_MS: "8000",
      CHAOS_CONTROL_JOURNAL: "/data/faults.sqlite",
      HEALER_COMPOSE_PROJECT: network,
      CHAOS_TOXIPROXY_URL: "http://" + toxName + ":8474",
      HEALER_DEMO_PORT: "4024",
    }),
    "-v",
    root + "/services/api/src:/app/services/api/src:ro",
    "-v",
    root + "/packages/shared/src:/app/packages/shared/src:ro",
    "streamshield-healing-runtime:latest",
    "sh",
    "-c",
    "node --import tsx services/api/src/healing/dependency-demo.ts & exec node --import tsx services/api/src/chaos/adapter.ts",
  );
  ids.push(runtime);
  const adapterUrl = "http://127.0.0.1:" + port(runtime, 4031),
    dependencyUrl = "http://127.0.0.1:" + port(runtime, 4024) + "/status";
  await until(() => fetch(adapterUrl + "/health").then((r) => r.ok));
  await until(() => fetch(dependencyUrl).then((r) => r.ok));
  const configured = await fetch(toxUrl + "/proxies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "recommendation-demo",
      listen: "0.0.0.0:8666",
      upstream: runtimeName + ":4024",
      enabled: true,
    }),
  });
  check(configured.ok, "proxy_configuration_failed");
  const targets = join(dir, "targets.json");
  writeFileSync(
    targets,
    JSON.stringify([
      {
        id: "postgres",
        name: "PostgreSQL",
        role: "persistence",
        group: "data",
        dependencies: [],
        kind: "postgres",
      },
      {
        id: "demo-dependency",
        name: "Existing dependency demo",
        role: "dependency",
        group: "external",
        dependencies: [],
        kind: "http",
        url: dependencyUrl,
      },
    ]),
    { mode: 0o644 },
  );
  const observerPort = await freePort(),
    obsEnv = {
      ...process.env,
      ...parseEnv(readFileSync(".env.example", "utf8")),
      ...dbEnv,
      POSTGRES_USER: "streamshield_observer",
      POSTGRES_PASSWORD: observerPassword,
      OBS_INTERVAL_MS: "1000",
      OBS_TIMEOUT_MS: "500",
      OBS_STALE_MS: "6000",
      OBS_PORT: String(observerPort),
      OBS_SECRET: observerSecret,
      OBS_TARGETS_FILE: targets,
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: "1",
      REDIS_PASSWORD: secret(),
    };
  observer = spawn(
    process.execPath,
    ["--import", "tsx", "services/api/src/monitoring/observer.ts"],
    { env: obsEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(observer);
  let logs = "";
  for (const stream of [observer.stdout, observer.stderr])
    stream.on("data", (chunk) => {
      logs = (logs + chunk).slice(-60000);
    });
  const obsUrl = "http://127.0.0.1:" + observerPort,
    headers = { Authorization: "Bearer " + observerSecret };
  const observation = async () => {
    const r = await fetch(obsUrl + "/observations", {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    check(r.ok, "observer_request_failed");
    return r.json();
  };
  const baseline = await until(async () => {
    const b = await observation();
    return b.persistence && b.components.every((c) => c.state === "HEALTHY")
      ? b
      : null;
  });
  check(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='streamshield_observer'",
      )
    ).rows[0].n > 0,
    "restricted_observer_identity_not_used",
  );
  evidence.checks.observerIdentity =
    "streamshield_observer (existing restricted grants)";
  evidence.checks.baseline = {
    components: baseline.components.map((c) => ({
      id: c.id,
      state: c.state,
      code: c.code,
    })),
    persistence: baseline.persistence,
  };
  const lock = await db.connect();
  let held = false;
  try {
    await lock.query("SELECT pg_advisory_lock(52005001)");
    held = true;
    const blocked = await until(async () => {
      const b = await observation();
      return !b.persistence && b.lastCompleted > baseline.lastCompleted + 1000
        ? b
        : null;
    });
    const started = performance.now(),
      response = await fetch(obsUrl + "/snapshot", {
        headers,
        signal: AbortSignal.timeout(2000),
      }),
      snapshot = await response.json();
    const latency = performance.now() - started;
    check(
      response.ok && !snapshot.stale && !snapshot.persistence,
      "persistence_failure_hidden",
    );
    check(
      snapshot.components.every((c) => c.state === "HEALTHY"),
      "failed_history_corrupted_component_health",
    );
    check(latency < 500, "snapshot_blocked_on_sql");
    evidence.checks.persistenceLock = {
      probesAdvancedMs: blocked.lastCompleted - baseline.lastCompleted,
      snapshotLatencyMs: latency,
      components: snapshot.components.map((c) => ({
        id: c.id,
        state: c.state,
      })),
      persistence: snapshot.persistence,
    };
  } finally {
    if (held) await lock.query("SELECT pg_advisory_unlock(52005001)");
    lock.release();
  }
  await until(async () => {
    const b = await observation();
    return b.persistence && b.components.every((c) => c.state === "HEALTHY");
  });
  evidence.checks.persistenceRecovered = true;
  // Failure + restoration while writes are blocked: retain one real episode without replaying it.
  const episodeLock = await db.connect();
  let locked = false,
    paused = false;
  try {
    await episodeLock.query("SELECT pg_advisory_lock(52005001)");
    locked = true;
    docker("pause", runtime);
    paused = true;
    const failed = await until(async () => {
      const b = await observation();
      return b.components.find((c) => c.id === "demo-dependency")?.state ===
        "UNHEALTHY"
        ? b
        : null;
    });
    docker("unpause", runtime);
    paused = false;
    await until(async () => {
      const b = await observation();
      return b.components.every((c) => c.state === "HEALTHY");
    });
    await episodeLock.query("SELECT pg_advisory_unlock(52005001)");
    locked = false;
    await until(async () => {
      const r = await db.query(
        "SELECT state FROM monitoring_incidents WHERE component='demo-dependency'",
      );
      return r.rows.length === 1 && r.rows[0].state === "RESOLVED";
    });
    const resumed = await observation();
    await until(async () => {
      const b = await observation();
      return b.lastCompleted > resumed.lastCompleted + 2000;
    });
    const count = (
      await db.query(
        "SELECT count(*)::int AS n FROM monitoring_incidents WHERE component='demo-dependency'",
      )
    ).rows[0].n;
    check(count === 1, "persisted_episode_replayed");
    evidence.checks.bufferedRealFailure = {
      confirmedAt: failed.components.find((c) => c.id === "demo-dependency")
        .confirmedAt,
      incidentCount: count,
      finalState: "RESOLVED",
      mechanism:
        "Isolated fixture pause/unpause tests evidence persistence only; not a Healer recovery claim",
    };
  } finally {
    if (paused) docker("unpause", runtime);
    if (locked) await episodeLock.query("SELECT pg_advisory_unlock(52005001)");
    episodeLock.release();
  }

  const client = await db.connect();
  try {
    await client.query("SET statement_timeout='30ms'");
    try {
      await client.query("SELECT pg_sleep(0.2)");
      throw Error("statement_timeout_not_enforced");
    } catch (e) {
      check(e.code === "57014", "unexpected_sql_failure");
      evidence.checks.actualStatementTimeout = e.code;
    } finally {
      await client.query("SET statement_timeout=DEFAULT");
    }
  } finally {
    client.release();
  }
  evidence.checks.indexes = (
    await db.query(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('monitoring_incidents','healing_attempts') ORDER BY indexname",
    )
  ).rows.map((r) => r.indexname);
  evidence.checks.activeIncidentPlan = (
    await db.query(
      "EXPLAIN (FORMAT JSON) SELECT * FROM monitoring_incidents WHERE resolved_at IS NULL AND source<>'healer-capacity-v1' ORDER BY component FOR UPDATE",
    )
  ).rows[0]["QUERY PLAN"];
  const read = async () => {
    const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(300) });
    check(r.ok, "dependency_probe_failed");
    return r.json();
  };
  await read();
  const id = randomUUID(),
    faultResponse = await fetch(adapterUrl + "/v1/inject", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + authority,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id, scenario: "network-timeout" }),
    });
  const fault = await faultResponse.json();
  check(
    faultResponse.ok && fault.confirmedAt && fault.evidence.toxicCreated,
    "fault_not_confirmed",
  );
  const circuit = new Circuit(2, 200, () => 0);
  let timeouts = 0;
  for (let i = 0; i < 2; i++) {
    try {
      await circuit.execute(read);
    } catch {
      timeouts++;
    }
  }
  check(
    timeouts === 2 && circuit.state === "OPEN",
    "network_degradation_not_detected",
  );
  let called = false;
  try {
    await circuit.execute(async () => {
      called = true;
    });
  } catch {
    /* observed circuit refusal */
  }
  check(!called, "circuit_fallback_not_enforced");
  const restored = await until(async () => {
    const r = await fetch(adapterUrl + "/v1/faults/" + id, {
      headers: { Authorization: "Bearer " + authority },
    });
    const b = await r.json();
    return b.cleanup === "COMPLETED" ? b : null;
  }, 15000);
  await circuit.execute(read);
  await circuit.execute(read);
  check(circuit.state === "CLOSED", "circuit_not_recovered");
  check(
    (await (await fetch(toxUrl + "/proxies/recommendation-demo/toxics")).json())
      .length === 0,
    "owned_toxic_remains",
  );
  evidence.checks.network = {
    id,
    scenario: "network-timeout",
    injectedAt: fault.injectedAt,
    confirmedAt: fault.confirmedAt,
    cleanupAt: restored.cleanupAt,
    cleanup: restored.cleanup,
    timeouts,
    circuit: circuit.snapshot(),
    mechanism:
      "Real bounded Toxiproxy latency; adapter expiry cleanup and circuit half-open safe reads. No Redis/container restart claimed.",
  };
  check(envHash() === originalEnv, "user_env_modified");
  evidence.checks.userEnvUnchanged = true;
  evidence.status = "PASS";
  writeFileSync(
    join(output, "observer.log"),
    logs
      .replaceAll(password, "[REDACTED]")
      .replaceAll(authority, "[REDACTED]")
      .replaceAll(observerSecret, "[REDACTED]")
      .replaceAll(observerPassword, "[REDACTED]")
      .replaceAll(metricsPassword, "[REDACTED]"),
  );
} catch (error) {
  evidence.error = String(error?.message || error)
    .replaceAll(password, "[REDACTED]")
    .replaceAll(authority, "[REDACTED]")
    .replaceAll(observerSecret, "[REDACTED]")
    .replaceAll(observerPassword, "[REDACTED]")
    .replaceAll(metricsPassword, "[REDACTED]");
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        sleep(4000),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
  await db?.end().catch(() => {});
  const cleanup = [];
  for (const id of ids.reverse())
    try {
      const owned = docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "streamshield.repair-validation"}}',
        id,
      );
      check(owned === runId, "fixture_ownership_mismatch");
      docker("stop", "--time", "5", id);
      docker("rm", id);
      cleanup.push(id.slice(0, 12));
    } catch {
      process.exitCode = 1;
      evidence.cleanupError =
        "A labelled isolated fixture could not be removed; inspect ss-repair-" +
        runId;
    }
  if (networkCreated)
    try {
      docker("network", "rm", network);
    } catch {
      process.exitCode = 1;
      evidence.cleanupError = "Isolated network cleanup unconfirmed";
    }
  evidence.cleanedFixtures = cleanup.length;
  evidence.finishedAt = new Date().toISOString();
  if (process.exitCode) evidence.status = "FAIL";
  evidence.checks.userEnvUnchanged = envHash() === originalEnv;
  writeFileSync(
    join(output, "isolated-results.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  rmSync(dir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      status: evidence.status,
      error: evidence.error || null,
      cleanedFixtures: evidence.cleanedFixtures,
      userEnvUnchanged: evidence.checks.userEnvUnchanged,
      results: join(output, "isolated-results.json"),
    }),
  );
}
