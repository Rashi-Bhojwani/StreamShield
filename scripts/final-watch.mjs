// Read-only terminal proof: a live table of every Healer-managed container
// (state, health, exit code, StartedAt, uptime, PID) plus the latest Healer
// action in plain English. Uses only `docker ps/inspect/logs`; it never acts.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dynamicComposeArgs } from "../infrastructure/dynamic/compose.mjs";
import { sentence } from "./final-watch-format.mjs";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const once = process.argv.includes("--once");
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
// Same language as the dashboard: green ok, red failed, blue healing, grey unknown.
const tone = {
  running: ["32", "✓"],
  exited: ["31", "✕"],
  dead: ["31", "✕"],
  restarting: ["34", "⟳"],
  created: ["90", "?"],
  paused: ["33", "▲"],
};
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000,
  });
let project;
try {
  project = JSON.parse(
    docker([...dynamicComposeArgs, "config", "--format", "json"]),
  ).name;
} catch {
  console.error("Run setup:dynamic and start Docker first (final:up).");
  process.exit(1);
}
const uptime = (startedAt, running) => {
  if (!running) return "—";
  const s = Math.max(
    0,
    Math.round((Date.now() - Date.parse(startedAt)) / 1000),
  );
  return s < 120 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s";
};
function render() {
  const ids = docker([
    "ps",
    "-a",
    "-q",
    "--filter",
    "label=com.docker.compose.project=" + project,
    "--filter",
    "label=io.streamshield.healer.service",
  ])
    .split("\n")
    .filter(Boolean);
  const rows = ids.length
    ? JSON.parse(docker(["inspect", ...ids])).map((c) => ({
        service: c.Config.Labels["io.streamshield.healer.service"],
        state: c.State.Status,
        health: c.State.Health?.Status || "—",
        exit: c.State.Status === "running" ? "—" : String(c.State.ExitCode),
        started: c.State.StartedAt.slice(11, 19),
        uptime: uptime(c.State.StartedAt, c.State.Status === "running"),
        pid: c.State.Pid || "—",
      }))
    : [];
  rows.sort((a, b) => a.service.localeCompare(b.service));
  const out = [
    paint("1", "StreamShield managed services") +
      "  (read-only · " +
      new Date().toLocaleTimeString([], { hour12: false }) +
      ")",
    "",
    ["SERVICE", "STATE", "HEALTH", "EXIT", "STARTED(UTC)", "UPTIME", "PID"]
      .map((h, i) => h.padEnd([16, 13, 10, 6, 13, 13, 8][i]))
      .join(""),
  ];
  for (const r of rows) {
    const [code, icon] = tone[r.state] || ["90", "?"];
    out.push(
      r.service.padEnd(16) +
        paint(code, (icon + " " + r.state).padEnd(13)) +
        r.health.padEnd(10) +
        r.exit.padEnd(6) +
        r.started.padEnd(13) +
        r.uptime.padEnd(13) +
        String(r.pid).padEnd(8),
    );
  }
  let latest;
  try {
    const healer = docker([...dynamicComposeArgs, "ps", "-q", "healer"]).trim();
    latest = execFileSync("docker", ["logs", "--since", "30m", healer], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    })
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => {
        try {
          return sentence(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-5);
  } catch {
    latest = ["Healer logs unavailable."];
  }
  out.push(
    "",
    paint("1", "Latest Healer actions"),
    ...(latest.length
      ? latest
      : ["No Healer transitions in the last 30 minutes."]),
  );
  out.push(
    "",
    "A changed STARTED time and a reset UPTIME are the proof that a real restart happened.",
  );
  return out.join("\n");
}
if (once) console.log(render());
else {
  const draw = () => {
    try {
      process.stdout.write("\x1b[2J\x1b[H" + render() + "\n");
    } catch {
      process.stdout.write("\x1b[2J\x1b[HDocker unavailable; retrying…\n");
    }
  };
  draw();
  setInterval(draw, 2000);
}
