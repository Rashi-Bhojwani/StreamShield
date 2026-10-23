import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dynamicComposeArgs } from "../infrastructure/dynamic/compose.mjs";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile(".env");
if (
  process.env.NODE_ENV !== "development" ||
  process.env.DYNAMIC_ENABLED !== "true" ||
  process.env.DEMO_ENABLED === "true" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(process.env.E2E_BASE_URL).hostname,
  )
)
  throw Error(
    "Final tests require the explicitly configured owned loopback topology.",
  );
execFileSync("docker", [...dynamicComposeArgs, "config", "--quiet"], {
  stdio: "inherit",
});
const child = spawn(
  process.execPath,
  [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test"],
  { stdio: "inherit", env: { ...process.env, FINAL_E2E: "1" } },
);
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
