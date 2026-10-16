import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile(".env");
const cli = fileURLToPath(import.meta.resolve("@playwright/test/cli"));
const child = spawn(process.execPath, [cli, "test"], {
  stdio: "inherit",
  env: { ...process.env, STREAMING_E2E: "1" },
});
child.on("error", () => {
  console.error("Could not start media integration tests");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
