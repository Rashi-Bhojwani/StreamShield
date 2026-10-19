import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
execFileSync(process.execPath, ["scripts/setup-media.mjs"], {
  stdio: "inherit",
});
let text = readFileSync(".env", "utf8");
let env = parseEnv(text);
for (const name of [
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "CSRF_SECRET",
  "MEDIA_AUTH_SECRET",
]) {
  if (!env[name])
    text = text.replace(
      new RegExp("^" + name + "=.*$", "m"),
      name + "=" + randomBytes(32).toString("base64url"),
    );
}
env = { ...parseEnv(text), ...process.env };
if (env.NODE_ENV !== "development")
  throw new Error("Platform bootstrap is for local development only.");
writeFileSync(".env", text, { mode: 0o600 });
chmodSync(".env", 0o600);
const conf = parse(readFileSync(".local/mediamtx.yml", "utf8"));
const address = new URL(env.MEDIA_AUTH_BASE_URL);
address.pathname = "/internal/media/auth";
address.username = "mediamtx";
address.password = env.MEDIA_AUTH_SECRET;
conf.authMethod = "http";
conf.authHTTPAddress = address.toString();
conf.authHTTPExclude = [{ action: "read" }];
conf.authInternalUsers = [];
conf.paths = {};
if (env.ENABLE_LEGACY_STREAM === "true")
  conf.paths[env.MEDIA_STREAM_PATH] = {
    source: "publisher",
    overridePublisher: false,
  };
conf.paths["~^s-[a-f0-9]{32}$"] = {
  source: "publisher",
  overridePublisher: false,
};
writeFileSync(
  ".local/mediamtx.yml",
  "# Generated private development configuration. Do not commit.\n" +
    stringify(conf, { defaultStringType: "QUOTE_DOUBLE" }),
  { mode: 0o600 },
);
console.log(
  "Platform secrets and private media authorization configured; existing values preserved.",
);
