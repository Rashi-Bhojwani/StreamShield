import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { parse, stringify, Document } from "yaml";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const args = process.argv.slice(2),
  at = args.indexOf("--ingest-host");
const ingestHost = at >= 0 ? args[at + 1] : "127.0.0.1";
if (
  !isIP(ingestHost) ||
  !Object.values(networkInterfaces())
    .flat()
    .some((x) => x?.address === ingestHost) ||
  ["0.0.0.0", "::"].includes(ingestHost)
)
  throw Error("Use an explicit assigned --ingest-host IP, never a wildcard.");
let text = readFileSync(existsSync(".env") ? ".env" : ".env.example", "utf8");
const set = (key, value) => {
  if (!new RegExp("^" + key + "=", "m").test(text)) text += "\n" + key + "=\n";
  text = text.replace(new RegExp("^" + key + "=.*$", "m"), key + "=" + value);
};
for (const [key, value] of Object.entries({
  DYNAMIC_ENABLED: "true",
  VITE_DYNAMIC_MODE: "true",
  DEMO_ENABLED: "false",
  VITE_DEMO_MODE: "false",
  ENABLE_LEGACY_STREAM: "false",
}))
  set(key, value);
const initial = parseEnv(text);
// A live player and chat must outlast a Healer repair (~10-25 s) on their own.
// Upgrade only the previous defaults; operator values are left untouched.
if (["", "3"].includes(initial.VITE_PLAYER_RETRY_LIMIT || ""))
  set("VITE_PLAYER_RETRY_LIMIT", "12");
if (["", "5"].includes(initial.VITE_CHAT_RECONNECT_LIMIT || ""))
  set("VITE_CHAT_RECONNECT_LIMIT", "30");
// Browser timeout must exceed the gateway's 10 s next-upstream budget, or the
// browser gives up before the gateway fails over from a hung API.
if (["", "5000"].includes(initial.VITE_API_TIMEOUT_MS || ""))
  set("VITE_API_TIMEOUT_MS", "12000");
// Final build: the gateway and ingest relay are Healer-managed. Upgrade only the
// previous default allowlist; an operator-narrowed list is left untouched.
if (
  !initial.HEALER_ALLOWED_SERVICES ||
  [
    "api-1,api-2,edge-1,edge-2,origin-primary,redis",
    "api-1,api-2,edge-1,edge-2,origin-primary,redis,video-gateway,relay",
  ].includes(initial.HEALER_ALLOWED_SERVICES)
)
  set(
    "HEALER_ALLOWED_SERVICES",
    "api-1,api-2,edge-1,edge-2,origin-primary,redis,video-gateway,relay,api-3",
  );
if (
  !initial.CHAOS_ALLOWED_SCENARIOS ||
  [
    "crash-api,crash-edge,crash-primary,crash-redis,network-timeout,external-api",
    "crash-redis,crash-video-gateway,crash-api-tier,crash-relay,hang-api,crash-api,crash-edge,crash-primary,network-timeout,external-api",
  ].includes(initial.CHAOS_ALLOWED_SCENARIOS)
)
  set(
    "CHAOS_ALLOWED_SCENARIOS",
    "crash-redis,crash-video-gateway,crash-api-tier,crash-relay,hang-api,traffic-surge,crash-api,crash-edge,crash-primary,network-timeout,external-api",
  );
set(
  "MEDIA_RTMP_PUBLIC_URL",
  `rtmp://${ingestHost.includes(":") ? "[" + ingestHost + "]" : ingestHost}:${initial.MEDIA_RTMP_PORT || 1935}`,
);
writeFileSync(".env", text, { mode: 0o600 });
chmodSync(".env", 0o600);
execFileSync(
  process.execPath,
  [
    "scripts/setup-chaos.mjs",
    ...(args.includes("--enable-local-chaos") ? ["--enable-local-chaos"] : []),
  ],
  { stdio: "inherit" },
);
const env = parseEnv(readFileSync(".env", "utf8"));
if (!["127.0.0.1", "::1"].includes(env.BIND_ADDRESS))
  throw Error(
    "Dynamic local setup keeps web/admin loopback; LAN option exposes only RTMP.",
  );
const port = Number(env.BROWSER_WHIP_PORT || 8889),
  ice = Number(env.BROWSER_ICE_PORT || 8189);
if (![port, ice].every((n) => Number.isInteger(n) && n >= 1024 && n <= 65535))
  throw Error("Invalid browser ingest port.");
const save = (file, value) => {
  writeFileSync(".local/dynamic/" + file, value, { mode: 0o600 });
  chmodSync(".local/dynamic/" + file, 0o600);
};
mkdirSync(".local/dynamic", { recursive: true, mode: 0o700 });
// Read by non-root containers; neither file contains credentials.
const share = (file, value) => {
  writeFileSync(".local/dynamic/" + file, value, { mode: 0o644 });
  chmodSync(".local/dynamic/" + file, 0o644);
};
const relay = parse(readFileSync(".local/resilience/relay.yml", "utf8"));
Object.assign(relay, {
  webrtc: true,
  webrtcAddress: ":" + port,
  webrtcAllowOrigins: env.CORS_ORIGINS.split(",").map((v) => v.trim()),
  webrtcLocalUDPAddress: ":" + ice,
  webrtcLocalTCPAddress: ":" + ice,
  webrtcIPsFromInterfaces: false,
  webrtcAdditionalHosts: ["127.0.0.1"],
  webrtcICEServers2: [],
});
save("relay.yml", stringify(relay, { defaultStringType: "QUOTE_DOUBLE" }));
let web = readFileSync(".local/healing/web.conf", "utf8");
web = web.replace(
  " server {\n  listen",
  ` upstream browser_ingest { zone browser_ingest 64k; server ${env.MEDIA_CONTAINER_HOST}:${port} resolve; }\n server {\n  listen`,
);
web = web.replace(
  "  location /api/",
  `  location ~ "^/ingest/(s-[a-f0-9]{32}/whip(?:/[a-f0-9-]+)?)$" {
    access_log off; client_max_body_size 64k; proxy_pass http://browser_ingest/$1;
    proxy_set_header Cookie ''; proxy_set_header Authorization $http_authorization;
    proxy_set_header Host $host; proxy_buffering off; proxy_read_timeout 20s;
    proxy_redirect ~^(/.*)$ /ingest$1;
  }
  location /ingest/ { return 404; }
  location /api/`,
);
save("web.conf", web);
const overlay = {
  services: {
    api: {
      environment: {
        DYNAMIC_ENABLED: "true",
        DEMO_ENABLED: "false",
        ENABLE_LEGACY_STREAM: "false",
        DYNAMIC_SOURCE_GRACE_MS: env.DYNAMIC_SOURCE_GRACE_MS || "8000",
        DYNAMIC_PROGRESS_TTL_MS: env.DYNAMIC_PROGRESS_TTL_MS || "6000",
      },
    },
    "api-2": {
      environment: {
        DYNAMIC_ENABLED: "true",
        DEMO_ENABLED: "false",
        ENABLE_LEGACY_STREAM: "false",
        DYNAMIC_SOURCE_GRACE_MS: env.DYNAMIC_SOURCE_GRACE_MS || "8000",
        DYNAMIC_PROGRESS_TTL_MS: env.DYNAMIC_PROGRESS_TTL_MS || "6000",
      },
    },
    mediamtx: {
      volumes: ["./.local/dynamic/relay.yml:/config/mediamtx.yml:ro"],
      ports: [
        `${ingestHost.includes(":") ? "[" + ingestHost + "]" : ingestHost}:${env.MEDIA_RTMP_PORT}:${env.MEDIA_RTMP_PORT}`,
        `127.0.0.1:${ice}:${ice}/udp`,
        `127.0.0.1:${ice}:${ice}/tcp`,
      ],
    },
    web: { volumes: ["./.local/dynamic/web.conf:/etc/nginx/nginx.conf:ro"] },
    // Relay verification checks that browser WHIP ingest is listening again.
    healer: {
      environment: {
        RELAY_WHIP_PORT: String(port),
        MEDIA_RTMP_PORT: env.MEDIA_RTMP_PORT,
      },
    },
    "chaos-controller": {
      environment: {
        RELAY_WHIP_PORT: String(port),
        MEDIA_RTMP_PORT: env.MEDIA_RTMP_PORT,
      },
    },
  },
};
// ---- Final build: spare API capacity, small API servers, tier overload signal ----
const apiCpus = Number(env.FINAL_API_CPUS || "0.2");
if (!(apiCpus >= 0.1 && apiCpus <= 8))
  throw Error("FINAL_API_CPUS must be between 0.1 and 8.");
const baseFiles = [
  "docker-compose.yml",
  ".local/resilience/compose.yml",
  ".local/monitoring/compose.yml",
  ".local/healing/compose.yml",
  ".local/chaos/compose.yml",
  ...(existsSync(".local/chaos/cloud-vfs.yml")
    ? [".local/chaos/cloud-vfs.yml"]
    : []),
];
// Resolved locally only to clone API-2's definition; written to ignored .local
// with owner-only permissions and never printed.
const resolved = JSON.parse(
  execFileSync(
    "docker",
    [
      "compose",
      ...baseFiles.flatMap((f) => ["-f", f]),
      "config",
      "--format",
      "json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ),
);
const spare = structuredClone(resolved.services["api-2"]);
delete spare.container_name;
spare.environment = {
  ...spare.environment,
  ...overlay.services["api-2"].environment,
  API_INSTANCE_ID: "api-3",
};
spare.networks = { default: { aliases: ["api-3"] } };
spare.labels = { ...spare.labels, "io.streamshield.healer.service": "api-3" };
spare.restart = "no";
spare.ports = [];
// Created stopped by final:up; only the Healer's scale-out playbook starts it.
spare.profiles = ["spare"];
spare.cpus = apiCpus;
delete spare.depends_on;
overlay.services["api-3"] = spare;
for (const api of ["api", "api-2"])
  overlay.services[api] = { ...overlay.services[api], cpus: apiCpus };
let gateway = readFileSync(".local/resilience/api-gateway.conf", "utf8");
for (const port of [env.API_PORT || "4000", env.RESILIENCE_AUTH_PORT || "4001"])
  gateway = gateway.replace(
    new RegExp(`(server [a-z0-9-]+2:${port} resolve[^;]*;)`),
    `$1\nserver api-3:${port} resolve max_fails=1 fail_timeout=5s;`,
  );
if (!gateway.includes("server api-3:"))
  throw Error("Could not add the spare API to the gateway upstream.");
save("api-gateway.conf", gateway);
overlay.services["api-gateway"] = {
  volumes: ["./.local/dynamic/api-gateway.conf:/etc/nginx/nginx.conf:ro"],
};
const targets = JSON.parse(readFileSync(".local/healing/targets.json", "utf8"));
const api2 = targets.find((t) => t.id === "api-2");
targets.push(
  {
    ...api2,
    id: "api-3",
    name: "API-3 (spare)",
    role: "Pre-provisioned spare API; started only by the Healer's scale-out playbook",
    url: api2.url.replace(/\/\/[^:/]+/, "//api-3"),
    spare: true,
  },
  {
    id: "api-tier",
    name: "API tier load",
    group: "Application",
    role: "Logical: p95 latency and 5xx ratio across all API instances",
    dependencies: ["api-1", "api-2"],
    kind: "tier",
  },
);
share("targets.json", JSON.stringify(targets, null, 2));
const prometheus = parse(readFileSync(".local/healing/prometheus.yml", "utf8"));
const apiJob = prometheus.scrape_configs.find((j) => j.job_name === "api");
const apiTargets = apiJob.static_configs[0].targets;
if (!apiTargets.some((t) => t.startsWith("api-3:")))
  apiTargets.push(apiTargets[0].replace(/^[^:]+/, "api-3"));
share("prometheus.yml", stringify(prometheus));
overlay.services.prometheus = {
  volumes: [
    "./.local/dynamic/prometheus.yml:/etc/prometheus/prometheus.yml:ro",
  ],
};
const targetMount = "./.local/dynamic/targets.json:/config/targets.json:ro";
for (const name of ["observer", "healer", "chaos-controller"])
  overlay.services[name] = {
    ...overlay.services[name],
    volumes: [...(overlay.services[name]?.volumes || []), targetMount],
    environment: {
      ...(overlay.services[name]?.environment || {}),
      PROMETHEUS_URL: "http://prometheus:9090",
      OBS_OVERLOAD_P95_MS: env.OBS_OVERLOAD_P95_MS || "1200",
      OBS_OVERLOAD_ERROR_PCT: env.OBS_OVERLOAD_ERROR_PCT || "5",
      OBS_OVERLOAD_SAMPLES: env.OBS_OVERLOAD_SAMPLES || "3",
      FINAL_API_CPUS: String(apiCpus),
    },
  };
const doc = new Document(overlay);
doc.getIn(["services", "mediamtx", "ports"]).tag = "!override";
save("compose.yml", String(doc));
console.log(
  "Dynamic accounts/channels configured without seed accounts. Run dynamic:up. Browser WHIP uses loopback ICE; selected LAN IP applies only to OBS RTMP.",
);
