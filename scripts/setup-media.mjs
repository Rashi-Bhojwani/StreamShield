import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { mediaEnv } from "./media-env.mjs";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const example = readFileSync(".env.example", "utf8");
let text = existsSync(".env") ? readFileSync(".env", "utf8") : example;
let values = parseEnv(text);
for (const [key, value] of Object.entries(parseEnv(example))) {
  if (!(key in values)) text += `\n${key}=${value}`;
}
values = parseEnv(text);
for (const key of ["MEDIA_PUBLISH_PASSWORD", "MEDIA_API_PASSWORD"]) {
  if (!values[key])
    text = text.replace(
      new RegExp(`^${key}=.*$`, "m"),
      `${key}=${randomBytes(32).toString("base64url")}`,
    );
}
const c = mediaEnv({ ...parseEnv(text), ...process.env });
writeFileSync(".env", text.endsWith("\n") ? text : text + "\n", {
  mode: 0o600,
});
chmodSync(".env", 0o600);
const conf = parse(
  readFileSync("infrastructure/mediamtx/mediamtx.yml", "utf8"),
);
const hash = (value) =>
  "sha256:" + createHash("sha256").update(value).digest("base64");
Object.assign(conf, {
  apiAddress: ":" + c.MEDIA_API_PORT,
  rtmpAddress: ":" + c.MEDIA_RTMP_PORT,
  hlsAddress: ":" + c.MEDIA_HLS_PORT,
  readTimeout: c.MEDIA_READ_TIMEOUT,
  writeTimeout: c.MEDIA_WRITE_TIMEOUT,
  hlsAllowOrigins: c.CORS_ORIGINS,
  hlsSegmentDuration: c.MEDIA_HLS_SEGMENT_DURATION,
  hlsSegmentCount: c.MEDIA_HLS_SEGMENT_COUNT,
  hlsSegmentMaxSize: c.MEDIA_HLS_SEGMENT_MAX_SIZE,
  authInternalUsers: [
    {
      user: c.MEDIA_PUBLISH_USER,
      pass: hash(c.MEDIA_PUBLISH_PASSWORD),
      ips: [],
      permissions: [{ action: "publish", path: c.MEDIA_STREAM_PATH }],
    },
    {
      user: "any",
      ips: [],
      permissions: [{ action: "read", path: c.MEDIA_STREAM_PATH }],
    },
    {
      user: c.MEDIA_API_USER,
      pass: hash(c.MEDIA_API_PASSWORD),
      ips: [],
      permissions: [{ action: "api" }],
    },
    {
      user: "any",
      ips: ["127.0.0.1", "::1"],
      permissions: [{ action: "api" }],
    },
  ],
  paths: {
    [c.MEDIA_STREAM_PATH]: { source: "publisher", overridePublisher: false },
  },
});
mkdirSync(".local", { recursive: true, mode: 0o700 });
writeFileSync(
  ".local/mediamtx.yml",
  "# Generated local configuration. Do not commit.\n" +
    stringify(conf, { defaultStringType: "QUOTE_DOUBLE" }),
  { mode: 0o600 },
);
console.log(
  "Media configuration prepared. Existing nonempty .env values preserved; credentials are not displayed.",
);
