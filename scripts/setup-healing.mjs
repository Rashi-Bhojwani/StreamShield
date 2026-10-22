import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { parseResilience } from "../infrastructure/resilience/config.mjs";
import {
  healingConfig,
  serviceNames,
} from "../services/api/src/healing/config.ts";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
execFileSync(process.execPath, ["scripts/setup-monitoring.mjs"], {
  stdio: "inherit",
});
let text = readFileSync(".env", "utf8");
for (const key of ["HEALER_SECRET", "CONTROL_SECRET", "HEALER_DB_PASSWORD"]) {
  if (!(key in parseEnv(text))) text += "\n" + key + "=\n";
  if (!parseEnv(text)[key])
    text = text.replace(
      new RegExp("^" + key + "=.*$", "m"),
      key + "=" + randomBytes(32).toString("base64url"),
    );
}
if (process.argv.includes("--enable-local-repairs")) {
  if (!/^HEALER_ENABLED=/m.test(text)) text += "\nHEALER_ENABLED=false\n";
  text = text.replace(/^HEALER_ENABLED=.*$/m, "HEALER_ENABLED=true");
}
const env = { ...parseEnv(text), ...process.env },
  c = healingConfig(env);
const r = parseResilience(env);
if (
  env.NODE_ENV !== "development" ||
  !["127.0.0.1", "::1"].includes(env.BIND_ADDRESS)
)
  throw new Error("Privileged bootstrap supports only loopback development");
const secrets = [
  c.HEALER_SECRET,
  c.CONTROL_SECRET,
  env.HEALER_DB_PASSWORD,
  env.OBS_SECRET,
  env.OBS_DB_PASSWORD,
  env.OBS_GRAFANA_PASSWORD,
];
if (new Set(secrets).size !== secrets.length)
  throw new Error("Recovery credentials must be independent");
writeFileSync(".env", text, { mode: 0o600 });
chmodSync(".env", 0o600);
const dir = ".local/healing";
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const save = (name, value) => {
  writeFileSync(dir + "/" + name, value, { mode: 0o644 });
  chmodSync(dir + "/" + name, 0o644);
};
const base = parse(readFileSync("docker-compose.yml", "utf8"));
const args = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  ".local/resilience/compose.yml",
  "-f",
  ".local/monitoring/compose.yml",
];
// Read only the Compose project identity; never print the resolved configuration.
const project = JSON.parse(
  execFileSync("docker", [...args, "config", "--format", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
).name;
const config = Object.fromEntries(
  Object.entries(c)
    .filter(([key]) => key === key.toUpperCase())
    .map(([key, value]) => [key, String(value)]),
);
const common = {
  ...base.services.api,
  image: "streamshield-healing-runtime",
  build: {
    context: ".",
    dockerfile: "infrastructure/healing/runtime.Dockerfile",
  },
  restart: "unless-stopped",
  ports: [],
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  mem_limit: "256m",
  cpus: 0.75,
};
const sourceVolumes = [
  "./services/api/src:/app/services/api/src:ro",
  "./packages/shared/src:/app/packages/shared/src:ro",
  "./package.json:/app/package.json:ro",
  "./packages/shared/package.json:/app/packages/shared/package.json:ro",
];
const health = (port, path = "/health") => ({
  interval: "5s",
  timeout: "3s",
  retries: 12,
  start_period: "10s",
  test: [
    "CMD",
    "node",
    "-e",
    `fetch('http://127.0.0.1:${port}${path}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
  ],
});
const services = {};
services["healing-db-setup"] = {
  ...base.services.migrate,
  image: "streamshield-healing-runtime",
  build: {
    context: ".",
    dockerfile: "infrastructure/healing/runtime.Dockerfile",
  },
  command: ["node", "scripts/setup-healing-db.mjs"],
  environment: {
    ...base.services.migrate.environment,
    HEALER_DB_PASSWORD: env.HEALER_DB_PASSWORD,
  },
  depends_on: {
    "metrics-db-setup": { condition: "service_completed_successfully" },
  },
};
services["healing-journal-init"] = {
  image: "streamshield-healing-runtime",
  user: "0:0",
  restart: "no",
  volumes: ["healer-data:/data"],
  command: [
    "node",
    "-e",
    "const f=require('node:fs');f.mkdirSync('/data/healer',{recursive:true,mode:0o700});f.chownSync('/data/healer',1000,1000);f.chmodSync('/data/healer',0o700)",
  ],
};
services["healing-control"] = {
  ...common,
  user: "0:0",
  read_only: true,
  networks: ["healing-control"],
  depends_on: {},
  command: [
    "node",
    "--import",
    "tsx",
    "services/api/src/healing/adapter-server.ts",
  ],
  environment: {
    ...config,
    HEALER_COMPOSE_PROJECT: project,
    CONTROL_JOURNAL: "/data/control.sqlite",
  },
  volumes: [
    ...sourceVolumes,
    (env.HEALER_DOCKER_SOCKET || "/var/run/docker.sock") +
      ":/var/run/docker.sock:ro",
    "healing-control-data:/data",
  ],
  tmpfs: ["/tmp:size=16m"],
  healthcheck: health(c.CONTROL_PORT),
};
services.healer = {
  ...common,
  read_only: true,
  networks: ["default", "healing-control"],
  command: ["node", "--import", "tsx", "services/api/src/healing/server.ts"],
  depends_on: {
    "healing-db-setup": { condition: "service_completed_successfully" },
    "healing-journal-init": { condition: "service_completed_successfully" },
    "healing-control": { condition: "service_healthy" },
    observer: { condition: "service_healthy" },
  },
  volumes: [
    ...sourceVolumes,
    "healer-data:/data",
    "./.local/healing/targets.json:/config/targets.json:ro",
  ],
  tmpfs: ["/tmp:size=16m"],
  environment: {
    ...config,
    POSTGRES_HOST: "postgres",
    POSTGRES_PORT: env.POSTGRES_PORT,
    POSTGRES_DB: env.POSTGRES_DB,
    POSTGRES_USER: "streamshield_healer",
    POSTGRES_PASSWORD: env.HEALER_DB_PASSWORD,
    OBS_URL: "http://observer:" + env.OBS_PORT,
    OBS_SECRET: env.OBS_SECRET,
    OBS_STALE_MS: env.OBS_STALE_MS,
    API_INTERNAL_PORT: env.API_INTERNAL_PORT,
    MEDIA_API_USER: env.MEDIA_API_USER,
    MEDIA_API_PASSWORD: env.MEDIA_API_PASSWORD,
    MEDIA_HLS_PORT: env.MEDIA_HLS_PORT,
    MEDIA_RTMP_PORT: env.MEDIA_RTMP_PORT,
    RESILIENCE_HLS_SECRET: env.RESILIENCE_HLS_SECRET,
    MEDIA_STREAM_PATH: env.MEDIA_STREAM_PATH,
    ENABLE_LEGACY_STREAM: env.ENABLE_LEGACY_STREAM,
    CONTROL_URL: "http://healing-control:" + c.CONTROL_PORT,
    HEALER_DEPENDENCY_URL:
      "http://toxiproxy:" + c.HEALER_DEPENDENCY_PORT + "/status",
  },
  healthcheck: health(c.HEALER_PORT),
};
services["dependency-demo"] = {
  ...common,
  command: [
    "node",
    "--import",
    "tsx",
    "services/api/src/healing/dependency-demo.ts",
  ],
  depends_on: {},
  volumes: sourceVolumes,
  environment: { HEALER_DEMO_PORT: String(c.HEALER_DEMO_PORT) },
  healthcheck: health(c.HEALER_DEMO_PORT, "/status"),
};
save(
  "toxiproxy.json",
  JSON.stringify(
    [
      {
        name: "recommendation-demo",
        listen: "0.0.0.0:" + c.HEALER_DEPENDENCY_PORT,
        upstream: "dependency-demo:" + c.HEALER_DEMO_PORT,
        enabled: true,
      },
    ],
    null,
    2,
  ),
);
services.toxiproxy = {
  image: "ghcr.io/shopify/toxiproxy:2.13.0",
  restart: "unless-stopped",
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  read_only: true,
  mem_limit: "64m",
  command: ["-host", "0.0.0.0", "-config", "/config/toxiproxy.json"],
  volumes: ["./.local/healing/toxiproxy.json:/config/toxiproxy.json:ro"],
};
for (const [id, name] of Object.entries(serviceNames))
  services[name] = {
    restart: "no",
    labels: { "io.streamshield.healer.service": id },
  };
// Reuse the production-only backend runtime in this optional composition.
// The lightweight/monitoring compositions keep their original development image.
for (const name of [
  "api",
  "api-2",
  "observer",
  "migrate",
  "metrics-db-setup",
]) {
  services[name] = {
    ...services[name],
    image: "streamshield-healing-runtime",
    build: {
      context: ".",
      dockerfile: "infrastructure/healing/runtime.Dockerfile",
    },
  };
}
for (const name of ["api", "api-2"])
  services[name].command = [
    "node",
    "--import",
    "tsx",
    "services/api/src/server.ts",
  ];
for (const name of ["api", "api-2"])
  services[name].volumes = [
    ...base.services.api.volumes,
    "./packages/shared/package.json:/app/packages/shared/package.json:ro",
  ];
services.migrate.command = ["node", "scripts/migrate.mjs"];
const url = "http://healer:" + c.HEALER_PORT;
for (const api of ["api", "api-2"])
  services[api] = {
    ...services[api],
    environment: { HEALER_URL: url, HEALER_SECRET: c.HEALER_SECRET },
  };
const targets = JSON.parse(
  readFileSync(".local/monitoring/targets.json", "utf8"),
);
targets.push({
  id: "demo-dependency",
  name: "Simulated recommendations",
  group: "Application",
  role: "Read-only external dependency demo through Toxiproxy",
  url: "http://toxiproxy:" + c.HEALER_DEPENDENCY_PORT + "/status",
  dependencies: [],
  kind: "http",
});
save("targets.json", JSON.stringify(targets, null, 2));
services.observer = {
  ...services.observer,
  volumes: [
    ...base.services.api.volumes,
    "./packages/shared/package.json:/app/packages/shared/package.json:ro",
    "./.local/healing/targets.json:/config/targets.json:ro",
  ],
};
const prometheus = parse(
  readFileSync(".local/monitoring/prometheus.yml", "utf8"),
);
prometheus.scrape_configs.push({
  job_name: "healer",
  authorization: {
    type: "Bearer",
    credentials_file: "/etc/prometheus/healer-secret",
  },
  static_configs: [{ targets: ["healer:" + c.HEALER_PORT] }],
});
save("healer-secret", c.HEALER_SECRET);
save("prometheus.yml", stringify(prometheus));
services.prometheus = {
  volumes: [
    "./.local/healing/prometheus.yml:/etc/prometheus/prometheus.yml:ro",
    "./.local/monitoring/observer-secret:/etc/prometheus/observer-secret:ro",
    "./.local/healing/healer-secret:/etc/prometheus/healer-secret:ro",
    "prometheus-data:/prometheus",
  ],
};
save(
  "recovery-dashboard.json",
  readFileSync("infrastructure/healing/dashboard.json", "utf8"),
);
services.grafana = {
  volumes: [
    "./.local/healing/recovery-dashboard.json:/var/lib/grafana/dashboards/recovery.json:ro",
  ],
};
// Compile the same React application; the optional recovery deployment needs no Vite server.
const npmCli = process.env.npm_execpath;
execFileSync(
  npmCli ? process.execPath : "npm",
  [...(npmCli ? [npmCli] : []), "run", "build", "-w", "@streamshield/web"],
  { stdio: "inherit" },
);
const mediaPath = r.MEDIA_PUBLIC_HLS_BASE_URL.replace(/\/$/, "");
save(
  "web.conf",
  `worker_processes auto;
events { worker_connections 1024; }
http {
 include /etc/nginx/mime.types;
 default_type application/octet-stream;
 resolver ${r.RESILIENCE_DNS_RESOLVER} valid=${r.RESILIENCE_DNS_VALID_SECONDS}s ipv6=off;
 map $http_upgrade $connection_upgrade { default upgrade; '' close; }
 upstream application { zone application 64k; server ${r.RESILIENCE_API_GATEWAY_HOST}:${r.RESILIENCE_HTTP_PORT} resolve; }
 upstream delivery { zone delivery 64k; server ${r.RESILIENCE_VIDEO_GATEWAY_HOST}:${r.RESILIENCE_HTTP_PORT} resolve; }
 server {
  listen ${Number(env.WEB_PORT)};
  root /usr/share/nginx/html;
  server_tokens off;
  location /api/ { proxy_pass http://application; proxy_set_header Host $host; proxy_set_header X-Request-ID $request_id; proxy_connect_timeout 2s; proxy_read_timeout 15s; }
  location /socket.io/ { proxy_pass http://application; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade; proxy_set_header Host $host; proxy_read_timeout ${r.RESILIENCE_SOCKET_TIMEOUT_SECONDS}s; }
  location ${mediaPath}/ { proxy_pass http://delivery/; proxy_set_header Cookie ''; proxy_set_header Authorization ''; proxy_redirect ~^(/.*)$ ${mediaPath}$1; proxy_connect_timeout 2s; proxy_read_timeout 15s; }
  location /assets/ { try_files $uri =404; add_header Cache-Control 'public, max-age=31536000, immutable'; }
  location / { try_files $uri $uri/ /index.html; add_header Cache-Control 'no-cache'; }
 }
}
`,
);
services.web = {
  image: "streamshield-healing-web",
  build: { context: ".", dockerfile: "infrastructure/healing/web.Dockerfile" },
  command: ["nginx", "-g", "daemon off;"],
  volumes: ["./.local/healing/web.conf:/etc/nginx/nginx.conf:ro"],
  healthcheck: {
    interval: "5s",
    timeout: "3s",
    retries: 12,
    test: [
      "CMD-SHELL",
      `wget -q -O /dev/null http://127.0.0.1:${Number(env.WEB_PORT)}/ && wget -q -O /dev/null http://127.0.0.1:${Number(env.WEB_PORT)}/api/v1/health/ready`,
    ],
  },
};
save(
  "compose.yml",
  stringify({
    services,
    networks: { "healing-control": { internal: true } },
    volumes: { "healer-data": {}, "healing-control-data": {} },
  }),
);
console.log(
  "Healing composition generated; explicit local repairs " +
    (c.enabled ? "ENABLED" : "DISABLED") +
    ". No credentials displayed. Journals and data volumes are retained.",
);
