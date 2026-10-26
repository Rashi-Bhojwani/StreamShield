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

/** Completed startup history is retained evidence, not an active outage. Missing
 * verification, open incidents and unavailable history must still block entry. */
export function idleBaselineAssessment({ chaos, healer, health }, scenarioIds) {
  const bad = health.components.filter((c) => c.state !== "HEALTHY");
  const scenarios = scenarioIds
    ? chaos.scenarios.filter((s) => scenarioIds.includes(s.id))
    : chaos.scenarios;
  const stamp = (value) =>
    typeof value === "string" && Number.isFinite(Date.parse(value));
  const repairs = healer.attempts.map(
    ({ id, component, state, reason, finishedAt, databasePersisted }) => ({
      id,
      component,
      state,
      reason,
      finishedAt,
      databasePersisted,
    }),
  );
  const incidents = health.incidents.map(
    ({ id, component, state, verified_at, resolved_at }) => ({
      id,
      component,
      state,
      verified_at,
      resolved_at,
    }),
  );
  const pendingRepairs = repairs.filter(
    (a) =>
      a.state !== "VERIFIED" ||
      !stamp(a.finishedAt) ||
      a.databasePersisted !== true,
  );
  const pendingIncidents = incidents.filter(
    (i) =>
      i.state !== "RESOLVED" || !stamp(i.verified_at) || !stamp(i.resolved_at),
  );
  const observationsFresh =
    health.stale === false &&
    health.persistence === true &&
    health.incidentHistoryAvailable === true;
  return {
    ready:
      chaos.available === true &&
      scenarios.length > 0 &&
      (!scenarioIds || scenarios.length === scenarioIds.length) &&
      scenarios.every((s) => s.available === true) &&
      healer.available === true &&
      healer.databaseAvailable === true &&
      healer.leader === true &&
      observationsFresh &&
      health.components.length > 0 &&
      bad.length === 0 &&
      chaos.experiments.length === 0 &&
      pendingRepairs.length === 0 &&
      pendingIncidents.length === 0 &&
      health.openCount === 0,
    // Stable across API history order; changes in completed work reset the clock
    // even when the complete failure/recovery happened between two samples.
    historyIdentity: JSON.stringify([
      repairs.map((a) => [a.id, a.state, a.finishedAt]).sort(),
      incidents
        .map((i) => [i.id, i.state, i.verified_at, i.resolved_at])
        .sort(),
    ]),
    history: { recoveryAttempts: repairs, incidents },
    blockers: {
      components: bad.map(({ id, state, code }) => ({ id, state, code })),
      experiments: chaos.experiments.length,
      recoveryAttempts: pendingRepairs,
      incidents: pendingIncidents,
      openCount: health.openCount,
      observationsFresh,
      healerAvailable: healer.available,
      healerLeader: healer.leader,
      databaseAvailable: healer.databaseAvailable,
      unavailableScenarios: scenarios
        .filter((s) => !s.available)
        .map(({ id, reason }) => ({ id, reason })),
    },
  };
}

// Require fresh healthy services and a quiet window after verified startup
// recovery. Never delete history or bypass unresolved repair/incident evidence.
export function idleBaselineGate({
  now = () => performance.now(),
  stableMs = 30000,
  scenarioIds,
} = {}) {
  let since = null,
    historyIdentity = null;
  return {
    reset() {
      since = null;
    },
    observe({ chaos, healer, health }) {
      const assessment = idleBaselineAssessment(
        { chaos, healer, health },
        scenarioIds,
      );
      if (assessment.historyIdentity !== historyIdentity) {
        since = null;
        historyIdentity = assessment.historyIdentity;
      }
      if (!assessment.ready) {
        since = null;
        return pendingFixture({
          ...assessment.blockers,
          history: assessment.history,
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
