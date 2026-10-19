import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile(".env");
if (
  process.env.NODE_ENV !== "development" ||
  !["127.0.0.1", "localhost", "::1"].includes(
    new URL(process.env.E2E_BASE_URL).hostname,
  ) ||
  !["127.0.0.1", "::1"].includes(process.env.BIND_ADDRESS)
)
  throw new Error("Monitoring experiments require loopback development");
execFileSync(
  "docker",
  [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    ".local/resilience/compose.yml",
    "-f",
    ".local/monitoring/compose.yml",
    "config",
    "--quiet",
  ],
  { stdio: "inherit" },
);
const child = spawn(
  process.execPath,
  [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test"],
  { stdio: "inherit", env: { ...process.env, MONITORING_E2E: "1" } },
);
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
