import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile(".env");
const child = spawn(
  process.execPath,
  [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test"],
  { stdio: "inherit", env: { ...process.env, PLATFORM_MEDIA_E2E: "1" } },
);
child.on("error", () => {
  console.error("Could not start platform media tests.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
