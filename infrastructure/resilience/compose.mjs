import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const args = process.argv.slice(2);
const child = spawn(
  "docker",
  [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    ".local/resilience/compose.yml",
    ...args,
  ],
  { stdio: "inherit" },
);
child.on("error", () => {
  console.error("Cannot start Compose; run setup:resilience and start Docker.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
