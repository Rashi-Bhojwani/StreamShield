import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const child = spawn(
  "docker",
  [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    ".local/resilience/compose.yml",
    "-f",
    ".local/monitoring/compose.yml",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
child.on("error", () => {
  console.error("Start Docker and run setup:monitoring.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
