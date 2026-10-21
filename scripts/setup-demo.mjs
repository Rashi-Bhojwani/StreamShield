import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { Document } from "yaml";
import { parseEnv } from "node:util";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
let text = existsSync(".env")
  ? readFileSync(".env", "utf8")
  : readFileSync(".env.example", "utf8");
const set = (k, v) => {
  if (!new RegExp("^" + k + "=", "m").test(text)) text += "\n" + k + "=\n";
  text = text.replace(new RegExp("^" + k + "=.*$", "m"), k + "=" + v);
};
const args = process.argv.slice(2),
  at = args.indexOf("--ingest-host"),
  host =
    at >= 0 ? args[at + 1] : parseEnv(text).DEMO_INGEST_BIND || "127.0.0.1";
const addresses = Object.values(networkInterfaces())
  .flat()
  .map((x) => x?.address);
if (
  !(await import("node:net")).isIP(host) ||
  !addresses.includes(host) ||
  ["0.0.0.0", "::"].includes(host)
)
  throw Error(
    "--ingest-host must be an assigned explicit local interface IP, never a wildcard",
  );
set("DEMO_ENABLED", "true");
set("VITE_DEMO_MODE", "true");
set("DEMO_INGEST_BIND", host);
set("ENABLE_LEGACY_STREAM", "false");
const port = parseEnv(text).MEDIA_RTMP_PORT || "1935";
set(
  "MEDIA_RTMP_PUBLIC_URL",
  `rtmp://${host.includes(":") ? "[" + host + "]" : host}:${port}`,
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
    "Web/API/admin must remain loopback; only RTMP supports LAN ingest",
  );
const overlay = {
  services: {
    api: {
      environment: {
        DEMO_ENABLED: "true",
        DEMO_GUEST_TTL_SECONDS: env.DEMO_GUEST_TTL_SECONDS,
        DEMO_GUEST_CREATE_LIMIT: env.DEMO_GUEST_CREATE_LIMIT,
        CAPACITY_ALLOWED_ORIGINS: env.CAPACITY_ALLOWED_ORIGINS,
      },
    },
    "api-2": {
      environment: {
        DEMO_ENABLED: "true",
        DEMO_GUEST_TTL_SECONDS: env.DEMO_GUEST_TTL_SECONDS,
        DEMO_GUEST_CREATE_LIMIT: env.DEMO_GUEST_CREATE_LIMIT,
        CAPACITY_ALLOWED_ORIGINS: env.CAPACITY_ALLOWED_ORIGINS,
      },
    },
    mediamtx: {
      ports: [
        `${host.includes(":") ? "[" + host + "]" : host}:${env.MEDIA_RTMP_PORT}:${env.MEDIA_RTMP_PORT}`,
      ],
    },
  },
};
const doc = new Document(overlay);
doc.getIn(["services", "mediamtx", "ports"]).tag = "!override";
mkdirSync(".local/demo", { recursive: true, mode: 0o700 });
writeFileSync(".local/demo/compose.yml", String(doc), { mode: 0o600 });
console.log(
  "Three-channel mode configured. RTMP uses the selected interface; web/control remain loopback. Run demo:up, then demo:admin.",
);
