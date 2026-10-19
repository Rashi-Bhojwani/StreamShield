import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile(".env");
if (
  process.env.NODE_ENV !== "development" ||
  !["127.0.0.1", "::1"].includes(process.env.BIND_ADDRESS)
)
  throw new Error("Only the local development topology can be controlled");
const [action, service] = process.argv.slice(2);
if (
  !["crash", "restore"].includes(action) ||
  !["api", "edge-1", "origin-primary"].includes(service)
)
  throw new Error(
    "Usage: npm run resilience:control -- crash|restore api|edge-1|origin-primary",
  );
const args =
  action === "crash"
    ? ["kill", "-s", "SIGKILL", service]
    : ["up", "-d", "--no-deps", service];
execFileSync(
  "docker",
  [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    ".local/resilience/compose.yml",
    ...args,
  ],
  { stdio: "inherit", timeout: Number(process.env.RESILIENCE_TEST_TIMEOUT_MS) },
);
console.log(
  JSON.stringify({
    action,
    service,
    at: new Date().toISOString(),
    note: "This is explicit local CLI fault injection, not an automatic healer",
  }),
);
