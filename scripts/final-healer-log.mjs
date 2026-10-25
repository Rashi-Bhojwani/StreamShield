// Follows the Healer's structured logs and prints each transition as a sentence.
// Read-only (`docker logs -f`).
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dynamicComposeArgs } from "../infrastructure/dynamic/compose.mjs";
import { sentence } from "./final-watch-format.mjs";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const id = execFileSync(
  "docker",
  [...dynamicComposeArgs, "ps", "-q", "healer"],
  {
    encoding: "utf8",
  },
).trim();
if (!id) {
  console.error("The healer container is not running. Start it with final:up.");
  process.exit(1);
}
console.log("Following Healer decisions (Ctrl+C stops; nothing is changed)…");
const child = spawn("docker", ["logs", "-f", "--since", "10m", id], {
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr])
  createInterface({ input: stream }).on("line", (line) => {
    if (!line.startsWith("{")) return;
    try {
      const s = sentence(line);
      if (s) console.log(s);
    } catch {
      /* Non-transition log line. */
    }
  });
child.on("exit", (code) => (process.exitCode = code ?? 0));
