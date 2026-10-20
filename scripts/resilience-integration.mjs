import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseResilience } from "../infrastructure/resilience/config.mjs";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile(".env");
parseResilience(process.env);
if (
  process.env.NODE_ENV !== "development" ||
  !["127.0.0.1", "localhost", "::1"].includes(
    new URL(process.env.E2E_BASE_URL).hostname,
  ) ||
  !["127.0.0.1", "::1"].includes(process.env.BIND_ADDRESS)
)
  throw new Error(
    "Failure tests require this project's loopback development deployment",
  );
execFileSync(
  "docker",
  [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    ".local/resilience/compose.yml",
    ...(process.env.STREAMSHIELD_COMPOSE_MODE === "monitoring"
      ? ["-f", ".local/monitoring/compose.yml"]
      : []),
    "config",
    "--quiet",
  ],
  { stdio: "inherit" },
);
const child = spawn(
  process.execPath,
  [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test"],
  { stdio: "inherit", env: { ...process.env, RESILIENCE_E2E: "1" } },
);
child.on("error", () => {
  console.error("Cannot start resilience checks");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
