import { build } from "tsup";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pendingFixture } from "./fixture-diagnostics.mjs";

const entries = [
  "server",
  "monitoring/observer",
  "healing/server",
  "healing/adapter-server",
  "healing/dependency-demo",
  "chaos/server",
  "chaos/adapter",
];

// Compile on the host once, rather than running seven TypeScript loaders across
// Windows bind mounts. Dependencies remain in the pinned runtime Docker image.
export async function buildFixtureRuntime(root, fixture) {
  const directory = join(fixture, ".compiled");
  const runtime = JSON.parse(
    readFileSync(join(root, "infrastructure/healing/package.json"), "utf8"),
  );
  await build({
    entry: Object.fromEntries(
      entries.map((name) => [
        name,
        join(root, "services/api/src", name + ".ts"),
      ]),
    ),
    outDir: directory,
    tsconfig: join(root, "services/api/tsconfig.json"),
    format: ["esm"],
    target: "es2023",
    platform: "node",
    noExternal: ["@streamshield/shared"],
    external: Object.keys(runtime.dependencies),
    removeNodeProtocol: false,
    splitting: true,
    clean: true,
    silent: true,
    dts: false,
  });
  const readable = (path) => {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) readable(child);
      else chmodSync(child, 0o644);
    }
  };
  readable(directory);
  return directory;
}

export function compiledFixtureService(service, directory) {
  const command = service.command;
  if (
    !Array.isArray(command) ||
    command.length !== 4 ||
    command[0] !== "node" ||
    command[1] !== "--import" ||
    command[2] !== "tsx"
  )
    return service;
  const entry = entries.find(
    (name) => command[3] === "services/api/src/" + name + ".ts",
  );
  if (!entry) return service;
  return {
    ...service,
    command: ["node", "/app/.fixture-runtime/" + entry + ".js"],
    volumes: [
      ...(service.volumes || []),
      {
        type: "bind",
        source: directory,
        target: "/app/.fixture-runtime",
        read_only: true,
      },
    ],
  };
}

// Require real, fresh component health and no injected faults or repairs before
// declaring the interactive demo ready. Any bad sample restarts the window.
export function idleBaselineGate({
  now = () => performance.now(),
  stableMs = 30000,
  scenarioIds,
} = {}) {
  let since = null;
  return {
    reset() {
      since = null;
    },
    observe({ chaos, healer, health }) {
      const bad = health.components.filter((c) => c.state !== "HEALTHY");
      const scenarios = scenarioIds
        ? chaos.scenarios.filter((s) => scenarioIds.includes(s.id))
        : chaos.scenarios;
      const ready =
        chaos.available === true &&
        scenarios.length > 0 &&
        (!scenarioIds || scenarios.length === scenarioIds.length) &&
        scenarios.every((s) => s.available === true) &&
        healer.available === true &&
        healer.databaseAvailable === true &&
        healer.leader === true &&
        health.components.length > 0 &&
        bad.length === 0 &&
        chaos.experiments.length === 0 &&
        healer.attempts.length === 0 &&
        health.incidents.length === 0;
      if (!ready) {
        since = null;
        return pendingFixture({
          components: bad.map(({ id, state, code }) => ({ id, state, code })),
          experiments: chaos.experiments.length,
          recoveryAttempts: healer.attempts.length,
          incidents: health.incidents.length,
          healerAvailable: healer.available,
          databaseAvailable: healer.databaseAvailable,
          unavailableScenarios: scenarios
            .filter((s) => !s.available)
            .map(({ id, reason }) => ({ id, reason })),
        });
      }
      since ??= now();
      const stableForMs = now() - since;
      return stableForMs >= stableMs
        ? true
        : pendingFixture({ stableForMs, requiredStableMs: stableMs });
    },
  };
}
