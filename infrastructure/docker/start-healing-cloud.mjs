// Optional staged startup for cloud hosts using Docker's space-heavy VFS driver.
// Source, credentials and all named data volumes are retained.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  lstatSync,
  readdirSync,
  chmodSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { stringify } from "yaml";
process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
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
const chaos = process.argv.includes("--chaos"),
  compose = [
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
if (chaos) compose.push("-f", ".local/chaos/compose.yml");
if (driver === "vfs") compose.splice(1, 0, "--parallel", "1");
const run = (...args) =>
  execFileSync("docker", [...compose, ...args], { stdio: "inherit" });
const jobs = [
  "migrate",
  "metrics-db-setup",
  "healing-db-setup",
  "healing-journal-init",
  ...(chaos ? ["chaos-db-setup", "chaos-journal-init"] : []),
];
if (driver !== "vfs") run("up", "-d", "--no-build", "--wait");
else {
  // Node owns no child processes in these services and already handles SIGTERM.
  // Avoid VFS's extra full-image init layer. Ordinary Docker Desktop retains init:true.
  const config = JSON.parse(
    execFileSync("docker", [...compose, "config", "--format", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const services = Object.fromEntries(
    Object.entries(config.services)
      .filter(([, s]) => s.image?.startsWith("streamshield-healing-runtime"))
      .map(([name]) => [name, { init: false }]),
  );
  const directory = chaos ? ".local/chaos" : ".local/healing";
  mkdirSync(directory, { recursive: true });
  const override = directory + "/cloud-vfs.yml";
  writeFileSync(override, stringify({ services }), { mode: 0o644 });
  compose.push("-f", override);
  run("stop", "grafana");
  run("rm", "--force", "grafana");
  // Complete setup before creating the whole controller topology: VFS peak usage matters.
  run(
    "up",
    "-d",
    "--no-build",
    ...(chaos
      ? ["chaos-db-setup", "chaos-journal-init"]
      : ["healing-db-setup"]),
    "healing-journal-init",
  );
  for (const service of jobs) {
    const id = execFileSync("docker", [...compose, "ps", "-a", "-q", service], {
      encoding: "utf8",
    }).trim();
    if (!id) throw Error("Missing setup job: " + service);
    let success = false;
    for (let i = 0; i < 120; i++) {
      const state = JSON.parse(
        execFileSync("docker", ["inspect", "--format", "{{json .State}}", id], {
          encoding: "utf8",
        }),
      );
      if (state.Status === "exited") {
        if (state.ExitCode !== 0) throw Error("Setup job failed: " + service);
        success = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!success) throw Error("Setup job did not complete: " + service);
    execFileSync("docker", ["rm", id], { stdio: "ignore" });
    console.log("Reclaimed successful setup container:", service);
  }
  const background = Object.keys(config.services).filter(
    (name) =>
      ![...jobs, "grafana", "healer", "chaos-controller"].includes(name),
  );
  run("up", "-d", "--no-deps", "--no-build", "--wait", ...background);
  run("up", "-d", "--no-deps", "--no-build", "--wait", "healer");
  if (chaos)
    run("up", "-d", "--no-deps", "--no-build", "--wait", "chaos-controller");
  run("up", "-d", "--no-deps", "--no-build", "--wait", "grafana");
}
execFileSync(
  process.execPath,
  [chaos ? "scripts/chaos-probe.mjs" : "scripts/healing-probe.mjs"],
  { stdio: "inherit" },
);
