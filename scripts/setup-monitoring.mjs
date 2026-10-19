import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { parseMonitoring } from "../infrastructure/monitoring/config.mjs";
import { parseResilience } from "../infrastructure/resilience/config.mjs";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
execFileSync(process.execPath, ["scripts/setup-resilience.mjs"], {
  stdio: "inherit",
});
let text = readFileSync(".env", "utf8");
for (const key of [
  "OBS_SECRET",
  "OBS_GRAFANA_PASSWORD",
  "OBS_PG_PASSWORD",
  "OBS_DB_PASSWORD",
]) {
  if (!(key in parseEnv(text))) text += "\n" + key + "=\n";
  if (!parseEnv(text)[key])
    text = text.replace(
      new RegExp("^" + key + "=.*$", "m"),
      key + "=" + randomBytes(32).toString("base64url"),
    );
}
writeFileSync(".env", text, { mode: 0o600 });
chmodSync(".env", 0o600);
const env = { ...parseEnv(text), ...process.env },
  c = parseMonitoring(env),
  r = parseResilience(env);
if (
  env.NODE_ENV !== "development" ||
  !["127.0.0.1", "::1"].includes(env.BIND_ADDRESS)
)
  throw new Error("Monitoring bootstrap requires loopback development");
const directory = ".local/monitoring";
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
// Mode 0644 inside a private 0700 parent lets non-root container UIDs read mounted files.
const save = (name, content) => {
  writeFileSync(directory + "/" + name, content, { mode: 0o644 });
  chmodSync(directory + "/" + name, 0o644);
};
save(
  "dashboard.json",
  readFileSync("infrastructure/monitoring/dashboard.json", "utf8"),
);
save("observer-secret", c.OBS_SECRET);
save("grafana-password", c.OBS_GRAFANA_PASSWORD);
save("pg-password", env.OBS_PG_PASSWORD);
const http = (h, p, path) => "http://" + h + ":" + p + path;
const targets = [
  {
    id: "web",
    name: "Live frontend",
    group: "Application",
    role: "Viewer and broadcaster experience",
    url: http("web", env.WEB_PORT, "/"),
    dependencies: ["api-gateway", "video-gateway"],
    kind: "http",
  },
  {
    id: "api-gateway",
    name: "API gateway",
    group: "Application",
    role: "REST and WebSocket routing",
    url: http(r.RESILIENCE_API_GATEWAY_HOST, r.RESILIENCE_HTTP_PORT, "/health"),
    dependencies: ["api-1", "api-2"],
    kind: "http",
  },
  ...[
    ["api-1", r.RESILIENCE_API1_HOST],
    ["api-2", r.RESILIENCE_API2_HOST],
  ].map(([id, host]) => ({
    id,
    name: id.toUpperCase(),
    group: "Application",
    role: "Accounts, control and chat",
    url: http(host, env.API_PORT, "/api/v1/health/ready"),
    dependencies: ["postgres", "redis"],
    kind: "api",
  })),
  {
    id: "postgres",
    name: "PostgreSQL",
    group: "Data",
    role: "Durable platform and incident store",
    dependencies: [],
    kind: "postgres",
  },
  {
    id: "redis",
    name: "Redis",
    group: "Data",
    role: "Realtime distribution and expiring leases",
    dependencies: [],
    kind: "redis",
  },
  {
    id: "video-gateway",
    name: "Video gateway",
    group: "Delivery",
    role: "HLS edge routing",
    url: http(
      r.RESILIENCE_VIDEO_GATEWAY_HOST,
      r.RESILIENCE_HTTP_PORT,
      "/health",
    ),
    dependencies: ["edge-1", "edge-2"],
    kind: "http",
  },
  ...[
    ["edge-1", r.RESILIENCE_EDGE1_HOST],
    ["edge-2", r.RESILIENCE_EDGE2_HOST],
  ].map(([id, host]) => ({
    id,
    name: id === "edge-1" ? "Video edge 01" : "Video edge 02",
    group: "Delivery",
    role: "Origin-aware HLS cache",
    url: http(host, r.RESILIENCE_HTTP_PORT, "/health"),
    dependencies: ["origin-primary", "origin-standby"],
    kind: "http",
  })),
  ...[
    ["origin-primary", r.RESILIENCE_PRIMARY_HOST],
    ["origin-standby", r.RESILIENCE_STANDBY_HOST],
    ["relay", env.MEDIA_CONTAINER_HOST],
  ].map(([id, host]) => ({
    id,
    name:
      id === "relay"
        ? "Ingest relay"
        : id === "origin-primary"
          ? "Primary origin"
          : "Standby origin",
    group: "Media",
    role:
      id === "relay"
        ? "Authenticated RTMP ingestion"
        : "Independent HLS packaging",
    url: http(host, env.MEDIA_API_PORT, "/v3/paths/list"),
    dependencies: id === "relay" ? [] : ["relay"],
    kind: "media",
  })),
  {
    id: "prometheus",
    name: "Prometheus",
    group: "Observability",
    role: "Time-series collection",
    url: "http://prometheus:9090/-/ready",
    dependencies: [],
    kind: "http",
  },
  {
    id: "grafana",
    name: "Grafana",
    group: "Observability",
    role: "Engineering dashboards",
    url: "http://grafana:3000/api/health",
    dependencies: ["prometheus"],
    kind: "http",
  },
];
save("targets.json", JSON.stringify(targets, null, 2));
const base = parse(readFileSync("docker-compose.yml", "utf8"));
const environment = {
  POSTGRES_HOST: "postgres",
  POSTGRES_PORT: env.POSTGRES_PORT,
  POSTGRES_DB: env.POSTGRES_DB,
  POSTGRES_USER: "streamshield_observer",
  POSTGRES_PASSWORD: env.OBS_DB_PASSWORD,
  REDIS_HOST: "redis",
  REDIS_PORT: env.REDIS_PORT,
  REDIS_PASSWORD: env.REDIS_PASSWORD,
  REDIS_DB: env.REDIS_DB || "0",
  MEDIA_API_USER: env.MEDIA_API_USER,
  MEDIA_API_PASSWORD: env.MEDIA_API_PASSWORD,
  MEDIA_HLS_PORT: env.MEDIA_HLS_PORT,
  MEDIA_STREAM_PATH: env.MEDIA_STREAM_PATH,
  RESILIENCE_HLS_SECRET: env.RESILIENCE_HLS_SECRET,
  OBS_URL: http("observer", c.OBS_PORT, ""),
  PROMETHEUS_URL: "http://prometheus:9090",
  ...Object.fromEntries(
    Object.entries(c)
      .filter(
        ([key]) =>
          ![
            "OBS_GRAFANA_PASSWORD",
            "OBS_PG_PASSWORD",
            "OBS_DB_PASSWORD",
          ].includes(key),
      )
      .map(([key, value]) => [key, String(value)]),
  ),
};
const services = {
  api: {
    environment: {
      OBS_URL: environment.OBS_URL,
      OBS_SECRET: c.OBS_SECRET,
      PROMETHEUS_URL: environment.PROMETHEUS_URL,
    },
  },
  "api-2": {
    environment: {
      OBS_URL: environment.OBS_URL,
      OBS_SECRET: c.OBS_SECRET,
      PROMETHEUS_URL: environment.PROMETHEUS_URL,
    },
  },
};
services.observer = {
  ...structuredClone(base.services.api),
  environment,
  command: [
    "node",
    "--import",
    "tsx",
    "services/api/src/monitoring/observer.ts",
  ],
  ports: [],
  depends_on: {
    "metrics-db-setup": { condition: "service_completed_successfully" },
  },
  mem_limit: "256m",
  volumes: [...base.services.api.volumes, "./.local/monitoring:/config:ro"],
  healthcheck: {
    interval: "10s",
    timeout: "3s",
    retries: 5,
    start_period: "15s",
    test: [
      "CMD",
      "node",
      "-e",
      "fetch('http://127.0.0.1:'+process.env.OBS_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ],
  },
};
services["metrics-db-setup"] = {
  ...structuredClone(base.services.migrate),
  command: ["node", "scripts/setup-metrics-db.mjs"],
  depends_on: { migrate: { condition: "service_completed_successfully" } },
  environment: {
    ...base.services.migrate.environment,
    OBS_PG_PASSWORD: env.OBS_PG_PASSWORD,
    OBS_DB_PASSWORD: env.OBS_DB_PASSWORD,
  },
};
const hardening = {
  restart: "unless-stopped",
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
};
services.prometheus = {
  ...hardening,
  image: "prom/prometheus:v3.15.0",
  mem_limit: "512m",
  command: [
    "--config.file=/etc/prometheus/prometheus.yml",
    "--storage.tsdb.path=/prometheus",
    "--storage.tsdb.retention.time=" + c.OBS_PROMETHEUS_RETENTION,
    "--storage.tsdb.retention.size=512MB",
    "--query.max-concurrency=4",
    "--query.timeout=5s",
  ],
  volumes: [
    "./.local/monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro",
    "./.local/monitoring/observer-secret:/etc/prometheus/observer-secret:ro",
    "prometheus-data:/prometheus",
  ],
  healthcheck: {
    interval: "10s",
    timeout: "3s",
    retries: 5,
    test: [
      "CMD",
      "wget",
      "-q",
      "-O",
      "/dev/null",
      "http://127.0.0.1:9090/-/ready",
    ],
  },
};
services.grafana = {
  ...hardening,
  image: "grafana/grafana:13.2.4",
  mem_limit: "384m",
  environment: {
    PATH: "/usr/share/grafana/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    GF_SECURITY_ADMIN_USER: "operator",
    GF_SECURITY_ADMIN_PASSWORD__FILE: "/run/secrets/grafana-password",
    GF_AUTH_ANONYMOUS_ENABLED: "false",
    GF_USERS_ALLOW_SIGN_UP: "false",
    GF_ANALYTICS_REPORTING_ENABLED: "false",
    GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
    GF_LOG_LEVEL: "warn",
    GF_PLUGINS_PREINSTALL_DISABLED: "true",
    GF_PLUGINS_PREINSTALL_AUTO_UPDATE: "false",
    GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false",
  },
  ports: ["127.0.0.1:" + c.OBS_GRAFANA_PORT + ":3000"],
  volumes: [
    "./.local/monitoring/grafana-password:/run/secrets/grafana-password:ro",
    "./.local/monitoring/datasources.yml:/etc/grafana/provisioning/datasources/sources.yml:ro",
    "./.local/monitoring/dashboards.yml:/etc/grafana/provisioning/dashboards/sources.yml:ro",
    "./.local/monitoring/dashboard.json:/var/lib/grafana/dashboards/streamshield.json:ro",
    "grafana-data:/var/lib/grafana",
  ],
  healthcheck: {
    interval: "10s",
    timeout: "3s",
    retries: 10,
    start_period: "30s",
    test: [
      "CMD",
      "wget",
      "-q",
      "-O",
      "/dev/null",
      "http://127.0.0.1:3000/api/health",
    ],
  },
};
services["redis-exporter"] = {
  ...hardening,
  image: "oliver006/redis_exporter:v1.94.0",
  mem_limit: "64m",
  environment: {
    REDIS_ADDR: "redis://redis:" + env.REDIS_PORT,
    REDIS_PASSWORD: env.REDIS_PASSWORD,
  },
  command: ["--redis-only-metrics", "--connection-timeout=2s"],
};
services["postgres-exporter"] = {
  ...hardening,
  image: "prometheuscommunity/postgres-exporter:v0.20.1",
  mem_limit: "64m",
  environment: {
    DATA_SOURCE_URI:
      "postgres:" +
      env.POSTGRES_PORT +
      "/" +
      env.POSTGRES_DB +
      "?sslmode=disable",
    DATA_SOURCE_USER: "streamshield_metrics",
    DATA_SOURCE_PASS_FILE: "/run/secrets/pg-password",
  },
  volumes: ["./.local/monitoring/pg-password:/run/secrets/pg-password:ro"],
  depends_on: {
    "metrics-db-setup": { condition: "service_completed_successfully" },
  },
};
for (const name of [
  "api-gateway",
  "video-gateway",
  "edge-1",
  "edge-2",
  "mediamtx",
  "origin-primary",
  "origin-standby",
])
  services[name] = { environment: { STREAMSHIELD_MONITORING_ENABLED: "1" } };
const scrape = [
  {
    job_name: "api",
    authorization: {
      type: "Bearer",
      credentials_file: "/etc/prometheus/observer-secret",
    },
    static_configs: [
      {
        targets: [
          r.RESILIENCE_API1_HOST + ":" + env.API_INTERNAL_PORT,
          r.RESILIENCE_API2_HOST + ":" + env.API_INTERNAL_PORT,
        ],
      },
    ],
  },
  {
    job_name: "observer",
    authorization: {
      type: "Bearer",
      credentials_file: "/etc/prometheus/observer-secret",
    },
    static_configs: [{ targets: ["observer:" + c.OBS_PORT] }],
  },
  {
    job_name: "media",
    sample_limit: 2000,
    basic_auth: {
      username: env.MEDIA_API_USER,
      password: env.MEDIA_API_PASSWORD,
    },
    static_configs: [
      {
        targets: [
          env.MEDIA_CONTAINER_HOST + ":" + c.OBS_METRICS_PORT,
          r.RESILIENCE_PRIMARY_HOST + ":" + c.OBS_METRICS_PORT,
          r.RESILIENCE_STANDBY_HOST + ":" + c.OBS_METRICS_PORT,
        ],
      },
    ],
    metric_relabel_configs: [
      {
        source_labels: ["__name__"],
        regex:
          "paths|paths_.*|hls_muxers|hls_muxers_outbound_bytes|rtmp_conns|rtmp_conns_inbound_bytes|rtmp_conns_outbound_bytes",
        action: "keep",
      },
    ],
  },
  { job_name: "redis", static_configs: [{ targets: ["redis-exporter:9121"] }] },
  {
    job_name: "postgres",
    static_configs: [{ targets: ["postgres-exporter:9187"] }],
  },
];
for (const [id, host] of [
  ["api-gateway", r.RESILIENCE_API_GATEWAY_HOST],
  ["video-gateway", r.RESILIENCE_VIDEO_GATEWAY_HOST],
  ["edge-1", r.RESILIENCE_EDGE1_HOST],
  ["edge-2", r.RESILIENCE_EDGE2_HOST],
]) {
  const filename = ".local/resilience/" + id + ".conf";
  let nginx = readFileSync(filename, "utf8");
  nginx = nginx.replace(
    /\n}\s*$/,
    "\n server { listen " +
      c.OBS_NGINX_STATUS_PORT +
      "; location = /stub_status { stub_status; access_log off; } location / { return 404; } }\n}\n",
  );
  writeFileSync(filename, nginx, { mode: 0o600 });
  services[id + "-exporter"] = {
    ...hardening,
    image: "nginx/nginx-prometheus-exporter:1.5.3",
    mem_limit: "32m",
    command: [
      "--nginx.scrape-uri=" +
        http(host, c.OBS_NGINX_STATUS_PORT, "/stub_status"),
      "--nginx.timeout=2s",
    ],
  };
  scrape.push({
    job_name: id,
    static_configs: [{ targets: [id + "-exporter:9113"] }],
  });
}
for (const name of ["relay", "origin"]) {
  const filename = ".local/resilience/" + name + ".yml",
    config = parse(readFileSync(filename, "utf8"));
  config.metrics = true;
  config.metricsAddress = ":" + c.OBS_METRICS_PORT;
  if (name === "origin")
    for (const user of config.authInternalUsers)
      if (user.permissions.some((p) => p.action === "api"))
        user.permissions.push({ action: "metrics" });
  writeFileSync(
    filename,
    stringify(config, { defaultStringType: "QUOTE_DOUBLE" }),
    { mode: 0o600 },
  );
}
save(
  "prometheus.yml",
  stringify({
    global: {
      scrape_interval: "5s",
      scrape_timeout: "3s",
      evaluation_interval: "10s",
    },
    scrape_configs: scrape,
  }),
);
save(
  "datasources.yml",
  stringify({
    apiVersion: 1,
    datasources: [
      {
        name: "StreamShield Prometheus",
        uid: "streamshield-prometheus",
        type: "prometheus",
        access: "proxy",
        url: "http://prometheus:9090",
        isDefault: true,
        editable: false,
      },
    ],
  }),
);
save(
  "dashboards.yml",
  stringify({
    apiVersion: 1,
    providers: [
      {
        name: "StreamShield",
        folder: "StreamShield",
        type: "file",
        disableDeletion: true,
        options: { path: "/var/lib/grafana/dashboards" },
      },
    ],
  }),
);
save(
  "compose.yml",
  stringify({
    services,
    volumes: { "prometheus-data": {}, "grafana-data": {} },
  }),
);
console.log(
  "Monitoring overlay generated. Secrets preserved in private .env/configuration; no credentials displayed.",
);
