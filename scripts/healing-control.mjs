import { execFileSync } from "node:child_process";
process.loadEnvFile(".env");
if (
  process.env.NODE_ENV !== "development" ||
  !["127.0.0.1", "::1"].includes(process.env.BIND_ADDRESS)
)
  throw new Error("Loopback development only");
const [action, service] = process.argv.slice(2);
if (
  action !== "crash" ||
  !["api", "edge-1", "origin-primary", "redis"].includes(service)
)
  throw new Error(
    "Usage: npm run healing:control -- crash api|edge-1|origin-primary|redis. Healer performs restoration.",
  );
execFileSync(
  process.execPath,
  ["infrastructure/healing/compose.mjs", "kill", "-s", "SIGKILL", service],
  { stdio: "inherit", timeout: 15000 },
);
console.log(
  JSON.stringify({
    injectedAt: new Date().toISOString(),
    service,
    note: "Fault injected by local CLI; no restore command was issued.",
  }),
);
