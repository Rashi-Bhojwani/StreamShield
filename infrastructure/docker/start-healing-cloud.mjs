// Optional staged startup for cloud hosts using Docker's space-heavy VFS driver.
// All source files, application data and named volumes are retained.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lstatSync, readdirSync, chmodSync } from "node:fs";
process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
// Normalize read access only for the known public bind-mounted source trees.
// Never traverse .env, .local, credentials, data volumes or symlinks.
function readable(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  chmodSync(path, (info.mode & 0o777) | (info.isDirectory() ? 0o055 : 0o044));
  if (info.isDirectory())
    for (const name of readdirSync(path)) readable(path + "/" + name);
}
for (const path of [
  "services/api/src",
  "packages/shared/src",
  "scripts",
  "migrations",
  "package.json",
  "packages/shared/package.json",
])
  readable(path);
const driver = execFileSync("docker", ["info", "--format", "{{.Driver}}"], {
  encoding: "utf8",
}).trim();
const compose = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  ".local/resilience/compose.yml",
  "-f",
  ".local/monitoring/compose.yml",
  "-f",
  ".local/healing/compose.yml",
];
const run = (...args) =>
  execFileSync("docker", [...compose, ...args], { stdio: "inherit" });
if (driver !== "vfs") {
  run("up", "-d", "--no-build", "--wait");
} else {
  // Grafana's persisted data is in grafana-data; only its disposable rootfs is removed.
  run("stop", "grafana");
  run("rm", "--force", "grafana");
  run("up", "-d", "--no-build", "--wait", "--scale", "grafana=0");
  for (const service of [
    "migrate",
    "metrics-db-setup",
    "healing-db-setup",
    "healing-journal-init",
  ]) {
    const ids = execFileSync(
      "docker",
      [...compose, "ps", "-a", "-q", service],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const id of ids) {
      const state = JSON.parse(
        execFileSync("docker", ["inspect", "--format", "{{json .State}}", id], {
          encoding: "utf8",
        }),
      );
      if (state.Status !== "exited" || state.ExitCode !== 0)
        throw new Error("Setup job did not complete successfully: " + service);
      execFileSync("docker", ["rm", id], { stdio: "ignore" });
      console.log("Reclaimed completed setup container:", service);
    }
  }
  run("up", "-d", "--no-build", "--no-deps", "--wait", "grafana");
}
execFileSync(process.execPath, ["scripts/healing-probe.mjs"], {
  stdio: "inherit",
});
