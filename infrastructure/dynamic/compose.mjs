import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
export const dynamicComposeArgs = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  ".local/resilience/compose.yml",
  "-f",
  ".local/monitoring/compose.yml",
  "-f",
  ".local/healing/compose.yml",
  "-f",
  ".local/chaos/compose.yml",
  ...(existsSync(".local/chaos/cloud-vfs.yml")
    ? ["-f", ".local/chaos/cloud-vfs.yml"]
    : []),
  "-f",
  ".local/dynamic/compose.yml",
  "-f",
  "infrastructure/chaos/repair-policy.yml",
];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn(
    "docker",
    [...dynamicComposeArgs, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  child.on("error", () => {
    console.error("Start Docker Desktop and run setup:dynamic.");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
