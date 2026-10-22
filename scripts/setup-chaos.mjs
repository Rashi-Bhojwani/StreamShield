import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { chaosConfig } from "../services/api/src/chaos/config.ts";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
execFileSync(
  process.execPath,
  [
    "scripts/setup-healing.mjs",
    ...(process.argv.includes("--enable-local-chaos")
      ? ["--enable-local-repairs"]
      : []),
  ],
  { stdio: "inherit" },
);
let text = readFileSync(".env", "utf8");
for (const key of [
  "CHAOS_SECRET",
  "CHAOS_CONTROL_SECRET",
  "CHAOS_DB_PASSWORD",
]) {
  if (!(key in parseEnv(text))) text += "\n" + key + "=\n";
  if (!parseEnv(text)[key])
    text = text.replace(
      new RegExp("^" + key + "=.*$", "m"),
      key + "=" + randomBytes(32).toString("base64url"),
    );
}
if (process.argv.includes("--enable-local-chaos")) {
  for (const [k, v] of Object.entries({
    CHAOS_ENABLED: "true",
    CHAOS_ENVIRONMENT: "local-development",
  })) {
    if (!new RegExp("^" + k + "=", "m").test(text)) text += "\n" + k + "=\n";
    text = text.replace(new RegExp("^" + k + "=.*$", "m"), k + "=" + v);
  }
}
const env = { ...parseEnv(text), ...process.env },
  c = chaosConfig(env);
if (
  env.NODE_ENV !== "development" ||
  !["127.0.0.1", "::1"].includes(env.BIND_ADDRESS)
)
  throw Error("Chaos setup supports only loopback development");
if (
  new Set([
    c.CHAOS_SECRET,
    c.CHAOS_CONTROL_SECRET,
    env.CHAOS_DB_PASSWORD,
    env.HEALER_SECRET,
    env.CONTROL_SECRET,
  ]).size !== 5
)
  throw Error("Chaos authority must be independent");
writeFileSync(".env", text, { mode: 0o600 });
chmodSync(".env", 0o600);
mkdirSync(".local/chaos", { recursive: true, mode: 0o700 });
chmodSync(".local/chaos", 0o700);
const save = (name, value) => {
  writeFileSync(".local/chaos/" + name, value, { mode: 0o644 });
  chmodSync(".local/chaos/" + name, 0o644);
};
const healing = parse(readFileSync(".local/healing/compose.yml", "utf8")),
  base = parse(readFileSync("docker-compose.yml", "utf8"));
const args = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  ".local/resilience/compose.yml",
  "-f",
  ".local/monitoring/compose.yml",
  "-f",
  ".local/healing/compose.yml",
];
const project = JSON.parse(
  execFileSync("docker", [...args, "config", "--format", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
).name;
const source = [
  "./services/api/src:/app/services/api/src:ro",
  "./packages/shared/src:/app/packages/shared/src:ro",
  "./package.json:/app/package.json:ro",
  "./packages/shared/package.json:/app/packages/shared/package.json:ro",
];
const config = Object.fromEntries(
  Object.entries(c)
    .filter(([k]) => k === k.toUpperCase())
    .map(([k, v]) => [k, String(v)]),
);
const common = {
  image: "streamshield-healing-runtime",
  build: {
    context: ".",
    dockerfile: "infrastructure/healing/runtime.Dockerfile",
  },
  init: true,
  restart: "unless-stopped",
  read_only: true,
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  mem_limit: "256m",
  cpus: 0.75,
  tmpfs: ["/tmp:size=16m"],
  volumes: source,
};
const health = (port) => ({
  interval: "5s",
  timeout: "3s",
  retries: 12,
  start_period: "10s",
  test: [
    "CMD",
    "node",
    "-e",
    `fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
  ],
});
const services = {};
services["chaos-db-setup"] = {
  ...healing.services["healing-db-setup"],
  command: ["node", "scripts/setup-chaos-db.mjs"],
  environment: {
    ...base.services.migrate.environment,
    CHAOS_DB_PASSWORD: env.CHAOS_DB_PASSWORD,
  },
  depends_on: {
    "healing-db-setup": { condition: "service_completed_successfully" },
  },
};
services["chaos-journal-init"] = {
  image: "streamshield-healing-runtime",
  user: "0:0",
  restart: "no",
  volumes: ["chaos-data:/data"],
  command: [
    "node",
    "-e",
    "const f=require('node:fs');f.mkdirSync('/data/chaos',{recursive:true,mode:0o700});f.chownSync('/data/chaos',1000,1000);f.chmodSync('/data/chaos',0o700)",
  ],
};
services["chaos-fault-adapter"] = {
  ...common,
  user: "0:0",
  networks: ["chaos-control", "default"],
  command: ["node", "--import", "tsx", "services/api/src/chaos/adapter.ts"],
  environment: {
    ...config,
    HEALER_COMPOSE_PROJECT: project,
    CHAOS_CONTROL_JOURNAL: "/data/faults.sqlite",
    CHAOS_TOXIPROXY_URL: "http://toxiproxy:8474",
  },
  volumes: [
    ...source,
    (env.HEALER_DOCKER_SOCKET || "/var/run/docker.sock") +
      ":/var/run/docker.sock:ro",
    "chaos-control-data:/data",
  ],
  healthcheck: health(c.CHAOS_CONTROL_PORT),
};
// Docker authority has a dedicated network; APIs cannot resolve the adapter there.
// Toxiproxy also joins this private network so the adapter needs no application network.
services["chaos-fault-adapter"].networks = ["chaos-control"];
services.toxiproxy = { networks: ["default", "chaos-control"] };
const signals = healing.services.healer.environment;
const selected = Object.fromEntries(
  [
    "OBS_URL",
    "OBS_SECRET",
    "OBS_STALE_MS",
    "API_INTERNAL_PORT",
    "MEDIA_API_USER",
    "MEDIA_API_PASSWORD",
    "MEDIA_HLS_PORT",
    "RESILIENCE_HLS_SECRET",
    "MEDIA_STREAM_PATH",
    "ENABLE_LEGACY_STREAM",
    "HEALER_DEPENDENCY_URL",
  ].map((k) => [k, signals[k]]),
);
services["chaos-controller"] = {
  ...common,
  networks: ["default", "chaos-control"],
  command: ["node", "--import", "tsx", "services/api/src/chaos/server.ts"],
  environment: {
    ...config,
    ...selected,
    HEALER_ALLOWED_SERVICES:
      env.HEALER_ALLOWED_SERVICES ||
      "api-1,api-2,edge-1,edge-2,origin-primary,redis,video-gateway,relay",
    HEALER_DISABLED_PLAYBOOKS: env.HEALER_DISABLED_PLAYBOOKS || "",
    HEALER_URL: "http://healer:" + signals.HEALER_PORT,
    HEALER_SECRET: env.HEALER_SECRET,
    CHAOS_CONTROL_URL: "http://chaos-fault-adapter:" + c.CHAOS_CONTROL_PORT,
    CHAOS_JOURNAL: "/data/chaos/experiments.sqlite",
    POSTGRES_HOST: "postgres",
    POSTGRES_PORT: env.POSTGRES_PORT,
    POSTGRES_DB: env.POSTGRES_DB,
    POSTGRES_USER: "streamshield_chaos",
    POSTGRES_PASSWORD: env.CHAOS_DB_PASSWORD,
  },
  volumes: [
    ...source,
    "chaos-data:/data",
    "./.local/healing/targets.json:/config/targets.json:ro",
  ],
  depends_on: {
    "chaos-db-setup": { condition: "service_completed_successfully" },
    "chaos-journal-init": { condition: "service_completed_successfully" },
    "chaos-fault-adapter": { condition: "service_healthy" },
    healer: { condition: "service_healthy" },
  },
  healthcheck: health(c.CHAOS_PORT),
};
for (const api of ["api", "api-2"])
  services[api] = {
    environment: {
      CHAOS_URL: "http://chaos-controller:" + c.CHAOS_PORT,
      CHAOS_SECRET: c.CHAOS_SECRET,
      CHAOS_ENABLED: c.CHAOS_ENABLED,
      CHAOS_ENVIRONMENT: c.CHAOS_ENVIRONMENT,
    },
  };
save(
  "compose.yml",
  stringify({
    services,
    networks: { "chaos-control": { internal: true } },
    volumes: { "chaos-data": {}, "chaos-control-data": {} },
  }),
);
console.log(
  "Chaos composition generated; explicit local chaos " +
    (c.enabled ? "ENABLED" : "DISABLED") +
    ". No credentials displayed. Database and publisher fault controls remain disabled.",
);
