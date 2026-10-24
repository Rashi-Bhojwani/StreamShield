import { z } from "zod";
import type { ChaosScenario, ChaosScenarioId, ChaosSnapshot } from "./chaos";
export const DEFAULT_OBSERVATION_STALE_MS = 12000;
export type ObservationFreshness =
  "fresh" | "missing" | "invalid" | "future" | "stale";
/** No future/invalid observation can establish health or admit a fault. */
export function observationFreshness(
  value: string | number | null | undefined,
  now = Date.now(),
  ttl = DEFAULT_OBSERVATION_STALE_MS,
): ObservationFreshness {
  if (value == null || value === "") return "missing";
  const at = typeof value === "number" ? value : Date.parse(value);
  if (
    !Number.isFinite(at) ||
    !Number.isFinite(now) ||
    !Number.isFinite(ttl) ||
    ttl <= 0
  )
    return "invalid";
  if (at > now) return "future";
  return now - at >= ttl ? "stale" : "fresh";
}
export const primaryDemoIds = [
  "crash-api",
  "crash-redis",
  "crash-video-gateway",
  "network-timeout",
  "traffic-surge",
] as const satisfies readonly ChaosScenarioId[];
export const primaryDemoScenarios = (rows: readonly ChaosScenario[]) =>
  primaryDemoIds.flatMap((id) => rows.filter((s) => s.id === id));
const stamp = z.iso.datetime(),
  nullableStamp = stamp.nullable();
const scenarioSchema = z.object({
  id: z.enum([
    "crash-api",
    "crash-redis",
    "crash-video-gateway",
    "network-timeout",
    "traffic-surge",
    "crash-api-tier",
    "crash-relay",
    "hang-api",
    "crash-edge",
    "crash-primary",
    "external-api",
    "database-outage",
    "broadcast-interruption",
  ]),
  name: z.string(),
  target: z.string(),
  targets: z.array(z.string()).max(3),
  kind: z.enum(["healer", "resilience", "disabled"]),
  order: z.number().int(),
  audienceSees: z.string(),
  realWorldCause: z.string(),
  expectedReceipt: z
    .enum(["docker_start_accepted", "docker_restart_accepted"])
    .nullable(),
  risk: z.enum(["moderate", "high"]),
  failure: z.string(),
  recovery: z.string(),
  prerequisites: z.string(),
  supported: z.boolean(),
  available: z.boolean(),
  reason: z.string().nullable(),
});
const experimentSchema = z.object({
  id: z.uuid(),
  actor: z.uuid(),
  scenario: scenarioSchema.shape.id,
  target: z.string(),
  state: z.enum([
    "CREATED",
    "VALIDATING",
    "INJECTING",
    "FAULT_CONFIRMED",
    "AWAITING_DETECTION",
    "HEALING_OBSERVED",
    "VERIFYING",
    "COMPLETED",
    "FAILED",
    "TIMED_OUT",
    "CANCELLED",
  ]),
  createdAt: stamp,
  updatedAt: stamp,
  injectedAt: nullableStamp,
  faultConfirmedAt: nullableStamp,
  incidentDetectedAt: nullableStamp,
  actionStartedAt: nullableStamp,
  actionFinishedAt: nullableStamp,
  verifiedAt: nullableStamp,
  finishedAt: nullableStamp,
  deadline: z.number().finite(),
  faultExpiresAt: z.number().finite().nullable(),
  incidentId: z.uuid().nullable(),
  recoveryIds: z.array(z.uuid()),
  priorRecoveryIds: z.array(z.uuid()),
  reason: z.string(),
  mechanism: z.string().nullable(),
  cleanup: z.enum(["NOT_REQUIRED", "PENDING", "COMPLETED", "FAILED"]),
  cancelRequestedBy: z.uuid().nullable(),
  databasePersisted: z.boolean(),
  evidence: z.record(
    z.string(),
    z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  ),
  events: z
    .array(z.object({ kind: z.string(), at: stamp, detail: z.string() }))
    .max(100),
  measurements: z.object({
    detectionMs: z.number().nonnegative().nullable(),
    healingStartMs: z.number().nonnegative().nullable(),
    actionMs: z.number().nonnegative().nullable(),
    restorationMs: z.number().nonnegative().nullable(),
    playbackInterruptionMs: z.number().nonnegative().nullable(),
  }),
});
export const chaosSnapshotSchema = z.object({
  version: z.literal(1),
  available: z.boolean(),
  enabled: z.boolean(),
  databaseAvailable: z.boolean(),
  observedAt: nullableStamp,
  serverTime: stamp.optional(),
  staleAfterMs: z.number().int().min(6000).max(120000).optional(),
  unavailableReason: z.string().nullable().optional(),
  activeId: z.uuid().nullable(),
  faultDurationMs: z.number().nonnegative(),
  timeoutMs: z.number().nonnegative(),
  scenarios: z
    .array(scenarioSchema)
    .max(32)
    .refine(
      (rows) =>
        new Set(rows.map((s) => s.id)).size === rows.length &&
        primaryDemoIds.every((id) => rows.some((s) => s.id === id)),
      "Missing or duplicate primary scenario",
    ),
  experiments: z.array(experimentSchema).max(100),
});
export function parseChaosSnapshot(value: unknown): ChaosSnapshot {
  return chaosSnapshotSchema.parse(value) as ChaosSnapshot;
}

const componentObservationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    group: z.string(),
    dependencies: z.array(z.string()),
    state: z.enum([
      "HEALTHY",
      "DEGRADED",
      "UNHEALTHY",
      "UNKNOWN",
      "RECOVERING",
    ]),
    observedAt: stamp,
    lastSuccessAt: nullableStamp,
    code: z.string(),
    latencyMs: z.number().finite().nullable(),
    failures: z.number().nonnegative(),
    successes: z.number().nonnegative(),
    firstFailureAt: nullableStamp,
    detectionMs: z.number().nonnegative().nullable(),
  })
  .passthrough();
export const monitoringSnapshotSchema = z.object({
  version: z.literal(1),
  sequence: z.string(),
  observedAt: nullableStamp,
  serverTime: stamp.optional(),
  durableObservedAt: nullableStamp.optional(),
  staleAfterMs: z.number().int().min(6000).max(120000),
  stale: z.boolean(),
  persistence: z.boolean(),
  incidentHistoryAvailable: z.boolean().optional(),
  components: z.array(componentObservationSchema).max(20),
  incidents: z.array(
    z
      .object({
        id: z.uuid(),
        component: z.string(),
        state: z.string(),
        detected_at: stamp,
        severity: z.enum(["warning", "critical"]),
        first_observed_at: stamp,
        restored_at: nullableStamp,
        verified_at: nullableStamp,
        resolved_at: nullableStamp,
        detection_ms: z.number().nullable(),
        duration_ms: z.number().nullable(),
        evidence: z.record(z.string(), z.unknown()),
        source: z.string(),
        failure_identity: z.string(),
        correlation_id: z.uuid(),
        updated_at: stamp,
      })
      .passthrough(),
  ),
  openCount: z.number().nonnegative(),
  verifiedCount: z.number().nonnegative(),
  media: z.array(
    z.object({
      path: z.string(),
      publisher: z.boolean(),
      checkedAt: stamp,
      sources: z.array(
        z
          .object({
            id: z.enum(["primary", "standby"]),
            manifest: z.boolean(),
            segment: z.boolean(),
            fresh: z.boolean().nullable(),
            code: z.string(),
          })
          .passthrough(),
      ),
    }),
  ),
  mediaAvailable: z.boolean(),
  playback: z.object({
    reports: z.number().nonnegative(),
    advancing: z.number().nonnegative(),
    standby: z.number().nonnegative(),
    checkedAt: nullableStamp,
    label: z.string(),
  }),
});
export function parseMonitoringSnapshot(
  value: unknown,
): import("./monitoring").MonitoringSnapshot {
  return monitoringSnapshotSchema.parse(
    value,
  ) as import("./monitoring").MonitoringSnapshot;
}
