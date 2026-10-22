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
// Final build: the gateway and ingest relay are Healer-managed. Upgrade only the
// previous default allowlist; an operator-narrowed list is left untouched.
if (
  !initial.HEALER_ALLOWED_SERVICES ||
  initial.HEALER_ALLOWED_SERVICES ===
    "api-1,api-2,edge-1,edge-2,origin-primary,redis"
)
  set(
    "HEALER_ALLOWED_SERVICES",
    "api-1,api-2,edge-1,edge-2,origin-primary,redis,video-gateway,relay",
  );
if (
  !initial.CHAOS_ALLOWED_SCENARIOS ||
  initial.CHAOS_ALLOWED_SCENARIOS ===
    "crash-api,crash-edge,crash-primary,crash-redis,network-timeout,external-api"
)
  set(
    "CHAOS_ALLOWED_SCENARIOS",
    "crash-redis,crash-video-gateway,crash-api-tier,crash-relay,hang-api,crash-api,crash-edge,crash-primary,network-timeout,external-api",
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
const doc = new Document(overlay);
doc.getIn(["services", "mediamtx", "ports"]).tag = "!override";
save("compose.yml", String(doc));
console.log(
  "Dynamic accounts/channels configured without seed accounts. Run dynamic:up. Browser WHIP uses loopback ICE; selected LAN IP applies only to OBS RTMP.",
);
