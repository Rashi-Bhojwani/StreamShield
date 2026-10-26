import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const base = process.env.STUDIO_E2E_BASE_URL || "http://127.0.0.1:5174";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw Error("Studio verification requires the disposable local demo.");
const child = spawn(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve("@playwright/test/cli")),
    "test",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, STUDIO_E2E: "1", E2E_BASE_URL: base },
  },
);
child.on("error", () => {
  console.error("Could not start Studio browser verification");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
