import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { dynamicComposeArgs } from "../infrastructure/dynamic/compose.mjs";
const env = parseEnv(readFileSync(".env", "utf8"));
const secrets = Object.entries(env)
  .filter(([key, value]) => /(SECRET|PASSWORD)/.test(key) && value.length >= 12)
  .flatMap(([, value]) => [value, encodeURIComponent(value)]);
let output = "";
for (const args of [
  ["ps", "-a"],
  [
    "logs",
    "--no-color",
    "--tail",
    "100",
    "mediamtx",
    "web",
    "api",
    "api-2",
    "observer",
    "origin-primary",
    "origin-standby",
    "edge-1",
    "edge-2",
  ],
]) {
  try {
    output += execFileSync("docker", [...dynamicComposeArgs, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    output += "Diagnostics unavailable for this service group.\n";
  }
}
for (const secret of secrets) output = output.replaceAll(secret, "[REDACTED]");
output = output
  .replace(/(pass|token|key)=([^\s&"']+)/gi, "$1=[REDACTED]")
  .replace(
    /Authorization:\s*(Basic|Bearer)\s+\S+/gi,
    "Authorization: [REDACTED]",
  );
mkdirSync("test-results/dynamic", { recursive: true });
writeFileSync("test-results/dynamic/services.log", output.slice(-200000));
console.log(
  "Bounded service diagnostics saved with configured credentials redacted.",
);
