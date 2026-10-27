import type { Router } from "express";
import { z } from "zod";
import { systemLogsSchema, type SystemLog } from "@streamshield/shared";
import type { Resources } from "../platform/resources.js";
import { PlatformError } from "../platform/security.js";

const components: Record<string, string> = {
  web: "Website",
  "api-gateway": "API gateway",
  "api-1": "API server 1",
  "api-2": "API server 2",
  "api-3": "Spare API server",
  "api-tier": "API capacity",
  postgres: "Database",
  redis: "Chat message bus",
  relay: "Broadcast ingest",
  "origin-primary": "Primary video origin",
  "origin-standby": "Backup video origin",
  "edge-1": "Delivery edge 1",
  "edge-2": "Delivery edge 2",
  "video-gateway": "Video gateway",
  "demo-dependency": "Recommendations",
  "publisher-source": "Broadcaster source",
  "media-authority": "Media authorization",
  prometheus: "Metrics collector",
  grafana: "Metrics dashboard",
};
const experiments: Record<string, string> = {
  CREATED:
    "An administrator requested a controlled failure. Nothing has been disrupted yet.",
  VALIDATING:
    "Checking current health and recovery prerequisites before injecting a fault.",
  INJECTING: "The approved fault is being applied to this demo deployment.",
  FAULT_CONFIRMED: "The fault was confirmed by actual service checks.",
  AWAITING_DETECTION:
    "Waiting for the independent health observer to detect the fault.",
  HEALING_OBSERVED: "An independent recovery attempt was observed.",
  VERIFYING: "Checking actual service behavior before declaring recovery.",
  COMPLETED: "The experiment ended with independently verified restoration.",
  FAILED:
    "The experiment failed. Successful recovery has not been established by this result.",
  TIMED_OUT: "The recovery deadline elapsed without verified restoration.",
  CANCELLED:
    "The observation was cancelled. Cancellation alone does not prove service recovery.",
  HUMAN_ACTION_REQUIRED:
    "Automatic recovery is not possible: the external media signing authority is unavailable. A restart cannot recreate a missing key or permission.",
  AWAITING_OPERATOR:
    "Video delivery is blocked while waiting for an authorized operator.",
  OPERATOR_RESET_REQUESTED:
    "An administrator requested the demo's manual media authorization reset. This is human intervention.",
  OPERATOR_ACCESS_RESTORED:
    "An administrator restored the simulated media authorization. Actual video recovery still needs verification.",
  BASELINE_REVERIFIED:
    "Fresh functional checks verified a safe baseline. The original failed or cancelled result is retained.",
  CLEANUP_COMPLETED:
    "The experiment-owned temporary fault was removed. Cleanup is separate from automatic healing.",
  CLEANUP_FAILED:
    "Removal of the experiment-owned fault has not been confirmed.",
  CIRCUIT_OPEN:
    "Repeated dependency errors opened the circuit breaker; calls fail quickly while the dependency is unavailable.",
  CIRCUIT_HALF_OPEN:
    "The circuit breaker is sending a bounded test request to check reconnection.",
  CIRCUIT_CLOSED:
    "Dependency reads are succeeding and the circuit breaker is closed.",
  EDGE_FAILOVER_VERIFIED:
    "Real video requests reached the backup edge while the first edge was unavailable.",
  STANDBY_VALIDATING:
    "Checking that backup video is advancing. No fault is injected until the backup is verified.",
  CANCEL_REQUESTED:
    "An administrator requested cancellation; actual cleanup and recovery still need confirmation.",
  INCIDENT_CORRELATED:
    "The experiment was linked to an independent recovery attempt.",
  INCIDENT_DETECTED: "The independent observer confirmed a service incident.",
  OBSERVATION_UNAVAILABLE:
    "Fresh evidence is unavailable. No unconfirmed fault or repair is replayed.",
  RECEIPT_PENDING:
    "The fault request has no confirmed receipt yet. The same experiment is being checked without injecting again.",
  SERVICE_VERIFIED:
    "Independent functional checks verified the affected service.",
  NO_ACCEPTED_FAULT:
    "The adapter has no accepted fault for this experiment; a successful injection is not claimed.",
  FAULT_PROBE_PENDING:
    "Actual unavailability has not been established. Waiting for a reliable service check.",
  TARGET_VERIFIED:
    "The independent recovery system verified an affected target and recorded its permitted action.",
  BROADCASTER_CLIENT_RECONNECTED:
    "The broadcaster's own client reconnected. The server did not recreate the camera source.",
  BROADCASTER_NOT_RETURNED:
    "The ingest service is back, but the broadcaster has not reconnected. Source recovery is not verified.",
  BROWSER_EVIDENCE:
    "A browser submitted bounded playback measurements, recorded separately from server verification.",
  LOAD_STARTED:
    "A bounded local test workload started against this disposable deployment.",
  LOAD_ENDED: "The test workload stopped. Stopping load is not a repair.",
  SCALED_IN:
    "Spare API capacity returned to its stopped standby state after load decreased.",
  SCALE_IN_NOT_OBSERVED:
    "The expected return to standby capacity was not verified within the observation window.",
};
const recovery: Record<string, string> = {
  SCHEDULED: "The recovery system scheduled a permitted repair.",
  EXECUTING: "The recovery system is performing its allowed repair action.",
  VERIFYING:
    "The repair action finished; independent functional checks are still required.",
  RETRY_WAIT:
    "A repair did not verify yet. Waiting within the bounded retry budget.",
  VERIFIED: "Independent service checks verified recovery.",
  ESCALATED: "Automatic recovery stopped and requires operator review.",
};
const broadcasts: Record<string, string> = {
  CREATED: "A broadcast was created; it is not live yet.",
  PREPARING: "The broadcaster is preparing a live source.",
  PUBLISHING: "A publisher connected; actual media is being checked.",
  LIVE: "Live media was verified and the broadcast became discoverable.",
  CONNECTION_LOST:
    "The publisher connection was lost. Existing buffered video may continue briefly.",
  RECONNECTING: "The broadcast is waiting for its source to reconnect.",
  ENDING: "The broadcaster requested an end to the session.",
  ENDED: "The broadcast ended.",
  FAILED: "The broadcast could not establish or maintain verified media.",
};
const reasons: Record<string, string> = {
  control_precondition_rejected:
    "A container safety check rejected the action. Inspect its actual state before retrying.",
  eligibility_deadline:
    "Fresh, reliable evidence was not available before the repair eligibility deadline.",
  database_storage_review_required:
    "A storage specialist must review the database and its backups. No destructive database repair was attempted.",
  broadcaster_reconnection_required:
    "Only the broadcaster can restore their camera, capture permission or internet connection.",
  verification_budget_exhausted:
    "Functional verification did not succeed within the allowed retry budget.",
  authority_or_dependency_symptom:
    "This service depends on another failing service; restarting it is not an approved repair.",
};
type Row = {
  id: string;
  at: string;
  component?: string;
  state?: string;
  kind?: string;
  reason?: string;
  code?: string;
  experiment_id?: string;
  manual?: boolean;
};
export function understandableLog(
  source: SystemLog["source"],
  row: Row,
): SystemLog | null {
  const at = new Date(row.at).toISOString();
  const state = row.kind || row.state || "";
  const component =
    source === "broadcast"
      ? "Live broadcast"
      : components[row.component || ""] || "System service";
  let message: string;
  let level: SystemLog["level"] = "info";
  let nextStep: string | null = null;
  if (source === "health") {
    const states: Record<string, string> = {
      HEALTHY: "is responding to its current health checks.",
      DEGRADED: "is degraded; some behavior is failing or slow.",
      UNHEALTHY: "failed its health checks.",
      UNKNOWN: "has no confirmed current health result.",
      RECOVERING:
        "is responding again and is being checked for stable recovery.",
    };
    message =
      component + " " + (states[state] || "changed its observed state.");
    if (row.code === "probe_timeout")
      nextStep =
        "The health check timed out. Check resource pressure, the service and its dependencies before retrying.";
    if (row.code === "probe_unreachable")
      nextStep =
        "The observer could not reach the service. Check whether its container is running and reachable.";
    if (row.code === "probe_denied")
      nextStep =
        "The health check was denied. Check monitoring authorization; this alone does not prove the service is down.";
  } else {
    const copies =
      source === "experiment"
        ? experiments
        : source === "recovery"
          ? recovery
          : broadcasts;
    if (!copies[state]) return null; // Never copy arbitrary process output or details into the log feed.
    message =
      source === "experiment" && state === "COMPLETED" && row.manual
        ? "Human restoration was independently verified. This experiment was not automatically healed."
        : copies[state];
    if (source === "recovery" && state === "ESCALATED")
      nextStep =
        Object.entries(reasons).find(([prefix]) =>
          row.reason?.startsWith(prefix),
        )?.[1] ||
        "Inspect this service's recovery evidence and the unmet prerequisite before retrying.";
  }
  if (
    [
      "HEALTHY",
      "VERIFIED",
      "COMPLETED",
      "BASELINE_REVERIFIED",
      "LIVE",
      "CIRCUIT_CLOSED",
    ].includes(state)
  )
    level = "success";
  else if (
    ["UNHEALTHY", "FAILED", "TIMED_OUT", "CLEANUP_FAILED"].includes(state)
  )
    level = "error";
  else if (
    [
      "DEGRADED",
      "UNKNOWN",
      "ESCALATED",
      "CONNECTION_LOST",
      "RECONNECTING",
      "RETRY_WAIT",
      "HUMAN_ACTION_REQUIRED",
      "AWAITING_OPERATOR",
      "CIRCUIT_OPEN",
      "OBSERVATION_UNAVAILABLE",
      "BROADCASTER_NOT_RETURNED",
      "CLEANUP_FAILED",
      "SCALE_IN_NOT_OBSERVED",
    ].includes(state)
  )
    level = "warning";
  if (["HUMAN_ACTION_REQUIRED", "AWAITING_OPERATOR"].includes(state))
    nextStep =
      "Real-world prerequisite: original signing-key backup or privileged external key-vault access. In this isolated simulation, use Restore demo media authorization, then wait for video verification.";
  return {
    id: source + ":" + row.id,
    at,
    level,
    source,
    component,
    message,
    nextStep,
    experimentId: row.experiment_id || null,
  };
}

/** Administrative operational events, not a Docker terminal or arbitrary log-file reader. */
export function logRoutes(router: Router, r: Resources) {
  router.get("/logs", async (req, res, next) => {
    try {
      const q = z
        .object({ hours: z.coerce.number().int().min(1).max(24).default(1) })
        .strict()
        .safeParse(req.query);
      if (!q.success)
        throw new PlatformError(
          400,
          "INVALID_LOG_WINDOW",
          "Choose a log window between 1 and 24 hours.",
        );
      const now = Date.now();
      const from = new Date(now - q.data.hours * 3600000).toISOString();
      const to = new Date(now).toISOString();
      const queries = [
        [
          "health",
          "SELECT id::text,at,component,state,code FROM monitoring_state_changes WHERE at BETWEEN $1 AND $2 ORDER BY at DESC,id DESC LIMIT 501",
        ],
        [
          "recovery",
          "SELECT (e.attempt_id::text||':'||e.ordinal::text) AS id,e.at,a.component,e.state,e.reason FROM healing_events e JOIN healing_attempts a ON a.id=e.attempt_id WHERE e.at BETWEEN $1 AND $2 ORDER BY e.at DESC LIMIT 501",
        ],
        [
          "experiment",
          "SELECT x.id::text AS experiment_id,(x.id::text||':'||e.ordinality::text) AS id,e.value->>'at' AS at,x.body->>'target' AS component,e.value->>'kind' AS kind,(x.scenario='media-authority-loss') AS manual FROM chaos_experiments x CROSS JOIN LATERAL jsonb_array_elements(x.body->'events') WITH ORDINALITY e(value,ordinality) WHERE x.updated_at >= $1 AND (e.value->>'at')::timestamptz BETWEEN $1 AND $2 ORDER BY (e.value->>'at')::timestamptz DESC LIMIT 501",
        ],
        [
          "broadcast",
          "SELECT id::text,observed_at AS at,state FROM broadcast_events WHERE observed_at BETWEEN $1 AND $2 ORDER BY observed_at DESC,id DESC LIMIT 501",
        ],
      ] as const;
      const results = await Promise.allSettled(
        queries.map(([, sql]) => r.db.query(sql, [from, to])),
      );
      const unavailableSources: string[] = [];
      const entries: SystemLog[] = [];
      let truncated = false;
      results.forEach((result, i) => {
        const source = queries[i]![0];
        if (result.status === "rejected") {
          unavailableSources.push(source);
          return;
        }
        if (result.value.rows.length > 500) truncated = true;
        for (const row of result.value.rows) {
          const entry = understandableLog(source, row as Row);
          if (entry) entries.push(entry);
        }
      });
      entries.sort(
        (a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id),
      );
      res.json(
        systemLogsSchema.parse({
          entries: entries.slice(0, 500),
          from,
          observedAt: to,
          partial: unavailableSources.length > 0,
          unavailableSources,
          truncated: truncated || entries.length > 500,
        }),
      );
    } catch (e) {
      next(e);
    }
  });
}
