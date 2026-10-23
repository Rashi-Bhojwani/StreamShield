import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { parse, stringify, Document } from "yaml";
import { parseResilience } from "../infrastructure/resilience/config.mjs";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
execFileSync(process.execPath, ["scripts/setup-platform.mjs"], {
  stdio: "inherit",
});
let text = readFileSync(".env", "utf8"),
  env = { ...parseEnv(text), ...process.env };
for (const name of ["RESILIENCE_REPLICATION_SECRET", "RESILIENCE_HLS_SECRET"]) {
  if (!env[name]) {
    text = text.replace(
      new RegExp("^" + name + "=.*$", "m"),
      name + "=" + randomBytes(32).toString("base64url"),
    );
    writeFileSync(".env", text, { mode: 0o600 });
    chmodSync(".env", 0o600);
    env = { ...parseEnv(text), ...process.env };
  }
}
const c = parseResilience(env),
  base = parse(readFileSync("docker-compose.yml", "utf8"));
mkdirSync(".local/resilience", { recursive: true });
// Serving-instance proof (X-Served-By, X-Edge-ID) for local/demo builds only.
const exposeServingInstance =
  (env.EXPOSE_SERVING_INSTANCE ||
    (env.NODE_ENV === "production" ? "false" : "true")) === "true";
const save = (name, content) => {
  const p = ".local/resilience/" + name;
  writeFileSync(p, content, { mode: 0o600 });
  chmodSync(p, 0o600);
};
const common = `worker_processes 1;
events { worker_connections ${c.RESILIENCE_WORKER_CONNECTIONS}; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  server_tokens off;
  absolute_redirect off;
  resolver ${c.RESILIENCE_DNS_RESOLVER} valid=${c.RESILIENCE_DNS_VALID_SECONDS}s ipv6=off;
  log_format safe '$time_iso8601 $request_id $request_method $uri status=$status upstream=$upstream_addr upstream_status=$upstream_status elapsed=$request_time';
  access_log /dev/stdout safe;
  error_log /dev/stderr warn;
  client_max_body_size 16k;
  proxy_connect_timeout ${c.RESILIENCE_CONNECT_TIMEOUT_SECONDS}s;
  proxy_read_timeout ${c.RESILIENCE_READ_TIMEOUT_SECONDS}s;
  proxy_send_timeout ${c.RESILIENCE_READ_TIMEOUT_SECONDS}s;
  proxy_next_upstream error timeout invalid_header http_502 http_503 http_504;
  proxy_next_upstream_tries ${c.RESILIENCE_UPSTREAM_TRIES};
  proxy_next_upstream_timeout ${c.RESILIENCE_READ_TIMEOUT_SECONDS}s;
  proxy_http_version 1.1;
`;
const peers = (hosts, port) =>
  hosts
    .map(
      (h) =>
        `server ${h}:${port} resolve max_fails=${c.RESILIENCE_MAX_FAILS} fail_timeout=${c.RESILIENCE_FAIL_TIMEOUT_SECONDS}s;`,
    )
    .join("\n");
save(
  "api-gateway.conf",
  common +
    `
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  upstream apis { zone apis 64k; ${peers([c.RESILIENCE_API1_HOST, c.RESILIENCE_API2_HOST], env.API_PORT)} keepalive ${c.RESILIENCE_KEEPALIVE}; }
  upstream auths { zone auths 64k; ${peers([c.RESILIENCE_API1_HOST, c.RESILIENCE_API2_HOST], env.API_INTERNAL_PORT)} }
  server {
    listen ${c.RESILIENCE_HTTP_PORT};
    location = /health { access_log off; return 200 'gateway alive'; }
    location /api/ {
      proxy_set_header Host $host;
      proxy_set_header X-Request-ID $request_id;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Connection '';
      proxy_buffering off;
      proxy_pass http://apis;
    }
    location /socket.io/ {
      proxy_set_header Host $host;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_read_timeout ${c.RESILIENCE_SOCKET_TIMEOUT_SECONDS}s;
      proxy_buffering off;
      proxy_pass http://apis;
    }
    location / { return 404; }
  }
  # Private Docker-only callback. POST is a side-effect-free auth decision here.
  server {
    listen ${c.RESILIENCE_AUTH_PORT};
    location = /internal/media/auth {
      proxy_next_upstream error timeout http_502 http_503 http_504 non_idempotent;
      proxy_pass http://auths;
    }
    location / { return 404; }
  }
}
`,
);
const allowedOrigins = env.CORS_ORIGINS.split(",").map((s) => s.trim());
const cors = allowedOrigins
  .map((o) => `"${o.replaceAll('"', "")}" "$http_origin";`)
  .join("\n");
for (const [name, id] of [
  ["edge-1", "edge-1"],
  ["edge-2", "edge-2"],
]) {
  let locations = "";
  for (const source of ["primary", "standby"])
    locations += `
    location /${source}/ {
      proxy_pass http://origin_${source}/;
      proxy_set_header Cookie '';
      proxy_set_header Authorization 'Bearer ${c.RESILIENCE_HLS_SECRET}';
      proxy_set_header Connection '';
      proxy_hide_header Access-Control-Allow-Origin;
      proxy_hide_header Cache-Control;
      add_header Access-Control-Allow-Origin $cors_origin always;
      add_header Vary Origin always;
      add_header Cache-Control $client_cache always;
      add_header X-Edge-ID "${id}" always;
      add_header X-Cache $upstream_cache_status always;
      add_header Access-Control-Expose-Headers "X-Edge-ID, X-Cache" always;
      proxy_redirect ~^(/.*)$ /${source}$1;
      proxy_ignore_headers Cache-Control Expires;
      proxy_cache media;
      proxy_cache_key "$host$uri";
      proxy_cache_bypass $skip_cache;
      proxy_no_cache $skip_cache;
      proxy_cache_valid 200 ${c.RESILIENCE_SEGMENT_CACHE_SECONDS}s;
      proxy_cache_lock on;
      proxy_buffering on;
    }
`;
  save(
    name + ".conf",
    common +
      `
  upstream origin_primary { zone origin_primary 64k; ${peers([c.RESILIENCE_PRIMARY_HOST], env.MEDIA_HLS_PORT)} }
  upstream origin_standby { zone origin_standby 64k; ${peers([c.RESILIENCE_STANDBY_HOST], env.MEDIA_HLS_PORT)} }
  map $http_origin $cors_origin { default ''; ${cors} }
  map $uri $skip_cache { default 1; ~\\.(mp4|m4s|ts)$ 0; }
  map $skip_cache $client_cache { default 'no-store'; 0 'public, max-age=${c.RESILIENCE_SEGMENT_CACHE_SECONDS}'; }
  proxy_cache_path /var/cache/nginx/media levels=1:2 keys_zone=media:8m max_size=${c.RESILIENCE_CACHE_MAX_MB}m inactive=${c.RESILIENCE_CACHE_INACTIVE_SECONDS}s use_temp_path=off;
  server { listen ${c.RESILIENCE_HTTP_PORT};
    location = /health { access_log off; return 200 'edge alive'; }
    ${locations}
    location / { return 404; }
  }
}
`,
  );
}
save(
  "video-gateway.conf",
  common +
    `
  upstream edges { zone edges 64k; ${peers([c.RESILIENCE_EDGE1_HOST, c.RESILIENCE_EDGE2_HOST], c.RESILIENCE_HTTP_PORT)} keepalive ${c.RESILIENCE_KEEPALIVE}; }
  server { listen ${c.RESILIENCE_HTTP_PORT};
    location = /health { access_log off; return 200 'video gateway alive'; }
    location ~ ^/(primary|standby)/ {
      # An origin HTTP error must not mark healthy edges dead for all sources.
      proxy_next_upstream error timeout invalid_header;
      proxy_set_header Cookie '';
      proxy_set_header Authorization '';
      proxy_set_header Connection '';
      ${exposeServingInstance ? "# X-Edge-ID passes through: the player overlay shows which edge served each segment." : "proxy_hide_header X-Edge-ID;"}
      proxy_buffering off;
      proxy_pass http://edges;
    }
    location / { return 404; }
  }
}
`,
);
const relay = parse(readFileSync(".local/mediamtx.yml", "utf8"));
relay.rtsp = true;
relay.rtspAddress = ":" + c.RESILIENCE_RTSP_PORT;
relay.rtspTransports = ["tcp"];
const auth = new URL(
  "http://" +
    c.RESILIENCE_API_GATEWAY_HOST +
    ":" +
    c.RESILIENCE_AUTH_PORT +
    "/internal/media/auth",
);
auth.username = "mediamtx";
auth.password = env.MEDIA_AUTH_SECRET;
relay.authHTTPAddress = auth.toString();
relay.authHTTPExclude = [];
for (const path of Object.values(relay.paths)) {
  path.runOnAvailable = "sh /config/warm-origins.sh";
  path.runOnAvailableRestart = true;
}
save("relay.yml", stringify(relay, { defaultStringType: "QUOTE_DOUBLE" }));
const warm = `#!/bin/sh
# Publisher-lifetime media warm-up; no credentials or command output are logged.
trap 'kill $(jobs -p) 2>/dev/null; exit 0' INT TERM
while :; do
  wget -q --header="Authorization: Bearer ${c.RESILIENCE_HLS_SECRET}" -T ${c.RESILIENCE_WARM_TIMEOUT_SECONDS} -O /dev/null "http://${c.RESILIENCE_PRIMARY_HOST}:${env.MEDIA_HLS_PORT}/$MTX_PATH/index.m3u8" >/dev/null 2>&1 &
  wget -q --header="Authorization: Bearer ${c.RESILIENCE_HLS_SECRET}" -T ${c.RESILIENCE_WARM_TIMEOUT_SECONDS} -O /dev/null "http://${c.RESILIENCE_STANDBY_HOST}:${env.MEDIA_HLS_PORT}/$MTX_PATH/index.m3u8" >/dev/null 2>&1 &
  wait
  sleep ${c.RESILIENCE_WARM_INTERVAL_SECONDS} & wait
 done
`;
save("warm-origins.sh", warm);
const origin = {
  ...relay,
  rtmp: false,
  rtsp: false,
  authMethod: "internal",
  hlsCDNSecret: c.RESILIENCE_HLS_SECRET,
  authHTTPAddress: "",
  authInternalUsers: [
    { user: "any", pass: "", ips: [], permissions: [{ action: "read" }] },
    {
      user: env.MEDIA_API_USER,
      pass: env.MEDIA_API_PASSWORD,
      ips: [],
      permissions: [{ action: "api" }],
    },
    {
      user: "any",
      pass: "",
      ips: ["127.0.0.1", "::1"],
      permissions: [{ action: "api" }],
    },
  ],
  paths: {},
};
const input =
  "rtsp://replica:" +
  c.RESILIENCE_REPLICATION_SECRET +
  "@" +
  env.MEDIA_CONTAINER_HOST +
  ":" +
  c.RESILIENCE_RTSP_PORT +
  "/";
origin.paths["~^(s-[a-f0-9]{32})$"] = {
  source: input + "$G1",
  sourceOnDemand: true,
  rtspTransport: "tcp",
};
if (env.ENABLE_LEGACY_STREAM === "true")
  origin.paths[env.MEDIA_STREAM_PATH] = {
    source: input + env.MEDIA_STREAM_PATH,
    sourceOnDemand: true,
    rtspTransport: "tcp",
  };
save("origin.yml", stringify(origin, { defaultStringType: "QUOTE_DOUBLE" }));
const publicMedia = c.MEDIA_PUBLIC_HLS_BASE_URL.replace(/\/$/, "");
const apiEnv = {
  EXPOSE_SERVING_INSTANCE: exposeServingInstance ? "true" : "false",
  MEDIA_PROBE_TIMEOUT_MS: String(c.RESILIENCE_MEDIA_PROBE_TIMEOUT_MS),
  API_INSTANCE_ID: "api-1",
  TRUST_GATEWAY_IDS: "true",
  DB_POOL_MAX: String(c.RESILIENCE_DB_POOL_MAX),
  MEDIA_REPLICATION_SECRET: c.RESILIENCE_REPLICATION_SECRET,
  MEDIA_DELIVERY_API_BASE_URL:
    "http://" + c.RESILIENCE_PRIMARY_HOST + ":" + env.MEDIA_API_PORT,
  MEDIA_HLS_BASE_URL:
    "http://" + c.RESILIENCE_PRIMARY_HOST + ":" + env.MEDIA_HLS_PORT,
  MEDIA_STANDBY_API_BASE_URL:
    "http://" + c.RESILIENCE_STANDBY_HOST + ":" + env.MEDIA_API_PORT,
  MEDIA_STANDBY_HLS_BASE_URL:
    "http://" + c.RESILIENCE_STANDBY_HOST + ":" + env.MEDIA_HLS_PORT,
  MEDIA_PUBLIC_HLS_BASE_URL: publicMedia + "/primary",
  MEDIA_STANDBY_PUBLIC_HLS_BASE_URL: publicMedia + "/standby",
};
const alias = (host) => ({ default: { aliases: [host] } });
const api2 = structuredClone(base.services.api);
api2.ports = [];
api2.environment = { ...api2.environment, ...apiEnv, API_INSTANCE_ID: "api-2" };
api2.command = ["node", "--import", "tsx", "services/api/src/server.ts"];
api2.networks = alias(c.RESILIENCE_API2_HOST);
const overlay = {
  services: {
    api: {
      environment: apiEnv,
      command: api2.command,
      networks: alias(c.RESILIENCE_API1_HOST),
    },
    "api-2": api2,
    mediamtx: {
      volumes: [
        "./.local/resilience/relay.yml:/config/mediamtx.yml:ro",
        "./.local/resilience/warm-origins.sh:/config/warm-origins.sh:ro",
      ],
      ports: ["${BIND_ADDRESS}:${MEDIA_RTMP_PORT}:${MEDIA_RTMP_PORT}"],
    },
    web: {
      environment: {
        API_PROXY_TARGET:
          "http://" +
          c.RESILIENCE_API_GATEWAY_HOST +
          ":" +
          c.RESILIENCE_HTTP_PORT,
        MEDIA_HLS_PROXY_TARGET:
          "http://" +
          c.RESILIENCE_VIDEO_GATEWAY_HOST +
          ":" +
          c.RESILIENCE_HTTP_PORT,
        MEDIA_PUBLIC_HLS_BASE_URL: publicMedia,
      },
      depends_on: {
        "api-gateway": { condition: "service_healthy" },
        "video-gateway": { condition: "service_healthy" },
      },
    },
  },
};
for (const [name, host] of [
  ["origin-primary", c.RESILIENCE_PRIMARY_HOST],
  ["origin-standby", c.RESILIENCE_STANDBY_HOST],
])
  overlay.services[name] = {
    ...structuredClone(base.services.mediamtx),
    ports: [],
    volumes: ["./.local/resilience/origin.yml:/config/mediamtx.yml:ro"],
    networks: alias(host),
  };
for (const [name, host] of [
  ["api-gateway", c.RESILIENCE_API_GATEWAY_HOST],
  ["video-gateway", c.RESILIENCE_VIDEO_GATEWAY_HOST],
  ["edge-1", c.RESILIENCE_EDGE1_HOST],
  ["edge-2", c.RESILIENCE_EDGE2_HOST],
])
  overlay.services[name] = {
    image: c.RESILIENCE_NGINX_IMAGE,
    restart: "unless-stopped",
    init: true,
    networks: alias(host),
    volumes: ["./.local/resilience/" + name + ".conf:/etc/nginx/nginx.conf:ro"],
    healthcheck: {
      ...structuredClone(base.services.redis.healthcheck),
      test: [
        "CMD-SHELL",
        "wget -q -O /dev/null http://127.0.0.1:" +
          c.RESILIENCE_HTTP_PORT +
          "/health",
      ],
    },
  };
overlay.services["api-gateway"].depends_on = {
  api: { condition: "service_healthy" },
  "api-2": { condition: "service_healthy" },
};
overlay.services["video-gateway"].depends_on = {
  "edge-1": { condition: "service_healthy" },
  "edge-2": { condition: "service_healthy" },
};
overlay.services["video-gateway"].ports = [
  "${BIND_ADDRESS}:${MEDIA_HLS_PORT}:" + c.RESILIENCE_HTTP_PORT,
];
const doc = new Document(overlay);
doc.getIn(["services", "mediamtx", "ports"]).tag = "!override";
save("compose.yml", String(doc));
console.log(
  "Resilience topology generated privately; existing credentials and durable volumes preserved.",
);
