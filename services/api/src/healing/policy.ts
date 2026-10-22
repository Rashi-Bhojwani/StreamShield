import type {
  ComponentObservation,
  RecoveryAttempt,
} from "@streamshield/shared";
import type { HealingConfig } from "./config.js";
export interface Playbook {
  id: string;
  version: 1;
  services: string[];
  action: RecoveryAttempt["action"];
  dependencies: string[];
  verification: string;
  compensation: string;
  /** Failure codes this playbook answers; absent = any code except a timeout. */
  symptoms?: string[];
  /** Plain-language diagnosis recorded on the attempt. */
  diagnosis: string;
}
export const playbooks: Playbook[] = [
  {
    id: "api-start",
    diagnosis:
      "API process is gone (connection refused or name unresolvable): start the stopped container",
    version: 1,
    services: ["api-1", "api-2"],
    action: "start_stopped_service",
    dependencies: ["postgres", "redis"],
    verification: "Direct ready + stream metadata + gateway routing",
    compensation: "No peer mutation; escalate if verification fails",
  },
  {
    id: "edge-start",
    diagnosis: "HLS edge process is gone: start the stopped container",
    version: 1,
    services: ["edge-1", "edge-2"],
    action: "start_stopped_service",
    dependencies: ["relay"],
    verification: "Health + authorized HLS bytes + segment progression",
    compensation: "Preserve peer; no forced routing changes",
  },
  {
    id: "primary-start",
    diagnosis:
      "Primary media origin is gone: start it once standby media is verified",
    version: 1,
    services: ["origin-primary"],
    action: "start_stopped_service",
    dependencies: ["relay", "origin-standby"],
    verification:
      "All sampled relay paths receive progressing primary segments",
    compensation: "Sticky standby; no automatic failback",
  },
  {
    id: "api-restart-unresponsive",
    diagnosis:
      "API process alive but unresponsive (probe timeout, container running): bounded restart",
    version: 1,
    services: ["api-1", "api-2"],
    action: "restart_unresponsive_service",
    symptoms: ["probe_timeout"],
    dependencies: ["postgres", "redis"],
    verification:
      "Direct ready + stream metadata + gateway routing + bounded response time",
    compensation:
      "Never restart the last serving API; no repeat of an ambiguous restart",
  },
  {
    id: "gateway-start",
    diagnosis:
      "Video gateway process is gone (single HLS entry): start the stopped container",
    version: 1,
    services: ["video-gateway"],
    action: "start_stopped_service",
    dependencies: [],
    verification:
      "Gateway /health + authorized HLS playlist and advancing segment fetched through the gateway",
    compensation: "No edge or origin mutation",
  },
  {
    id: "relay-start",
    diagnosis:
      "Ingest relay process is gone: start it; broadcasters must reconnect themselves",
    version: 1,
    services: ["relay"],
    action: "start_stopped_service",
    // MediaMTX authenticates its control API through the API tier, so an API
    // outage makes a healthy relay look failed: never act on it then.
    dependencies: ["api-1", "api-2"],
    verification:
      "Relay API answers + RTMP and WHIP listeners accept connections; broadcaster return recorded separately",
    compensation:
      "Never claims the broadcast was restored; source return is the broadcaster client's own reconnection",
  },
  {
    id: "redis-start",
    diagnosis: "Redis is gone: start the stopped container",
    version: 1,
    services: ["redis"],
    action: "start_stopped_service",
    dependencies: ["postgres"],
    verification: "Observer authenticated PING + both API readiness",
    compensation: "Do not replay lost Pub/Sub messages",
  },
  {
    id: "dependency-reconnect",
    diagnosis:
      "External read-only dependency failing: let the circuit probe and reconnect",
    version: 1,
    services: ["demo-dependency"],
    action: "safe_read_retry",
    dependencies: [],
    verification: "Circuit recovery probes + consecutive safe GET successes",
    compensation: "Explicit unavailable recommendation fallback; no writes",
  },
  {
    id: "database-review",
    diagnosis:
      "Database failure: storage needs operator review, never automatic action",
    version: 1,
    services: ["postgres"],
    action: "operator_review",
    dependencies: [],
    verification: "Operator storage review required",
    compensation: "Never start/reset/migrate database automatically",
  },
  {
    id: "source-wait",
    diagnosis: "Broadcaster source missing: only the broadcaster can return it",
    version: 1,
    services: ["publisher-source"],
    action: "observe_source",
    dependencies: ["relay", "origin-primary", "origin-standby"],
    verification: "Authorized source returns with progressing media",
    compensation: "Offline/source interrupted; cannot reconstruct live video",
  },
];
/**
 * Chooses by component AND symptom. A timeout means the process is alive but not
 * answering, so a start (which only acts on an exited container) cannot help; only a
 * symptom-matched restart playbook may answer it. Without one, the start playbook is
 * still returned so the attempt is recorded, and eligibility() refuses it.
 */
export function selectPlaybook(component: string, failureCode?: string | null) {
  const candidates = playbooks.filter((p) => p.services.includes(component));
  return (
    candidates.find((p) => p.symptoms?.includes(failureCode || "")) ||
    candidates.find((p) => !p.symptoms)
  );
}
export const failureCodeOf = (c: ComponentObservation) =>
  c.failureCode || c.code;
const peers: Record<string, string> = { "api-1": "api-2", "api-2": "api-1" };
export function eligibility(
  component: ComponentObservation,
  components: ComponentObservation[],
  c: HealingConfig,
  now = Date.now(),
  playbookId?: string,
) {
  // An attempt keeps the playbook it was diagnosed with (or revised to).
  const p = playbookId
    ? playbooks.find(
        (x) => x.id === playbookId && x.services.includes(component.id),
      )
    : selectPlaybook(component.id, failureCodeOf(component));
  if (!p) return { allowed: false, reason: "unsupported_component" };
  if (
    !component.confirmedAt ||
    !["UNHEALTHY", "DEGRADED"].includes(component.state) ||
    now - Date.parse(component.observedAt) > 12000
  )
    return { allowed: false, reason: "unconfirmed_or_stale" };
  if (component.code === "probe_denied" || component.state === "DEGRADED")
    return { allowed: false, reason: "authority_or_dependency_symptom" };

  if (p.action === "restart_unresponsive_service") {
    // Never restart the last serving instance: the peer must be serving now.
    const peer = peers[component.id];
    if (!peer || components.find((x) => x.id === peer)?.state !== "HEALTHY")
      return { allowed: false, reason: "peer_not_healthy:" + (peer || "none") };
  }
  for (const dependency of p.dependencies)
    if (components.find((x) => x.id === dependency)?.state !== "HEALTHY")
      return { allowed: false, reason: "dependency_unhealthy:" + dependency };
  if (
    !playbookId &&
    p.action === "start_stopped_service" &&
    failureCodeOf(component) === "probe_timeout"
  )
    return { allowed: false, reason: "unresponsive_without_restart_playbook" };
  if (!c.enabled || c.HEALER_DISABLED_PLAYBOOKS.split(",").includes(p.id))
    return { allowed: false, reason: "policy_disabled" };
  if (
    ["start_stopped_service", "restart_unresponsive_service"].includes(
      p.action,
    ) &&
    !c.allowed.includes(component.id)
  )
    return { allowed: false, reason: "service_not_allowed" };
  return {
    allowed: true,
    reason: "confirmed_independent_failure",
    playbook: p,
  };
}
export const backoff = (
  attempt: number,
  base: number,
  random = Math.random(),
) =>
  Math.min(base * 2 ** Math.max(0, attempt - 1), 10000) +
  Math.floor(random * base * 0.25);
export const terminal = (a: RecoveryAttempt) =>
  a.state === "VERIFIED" || a.state === "ESCALATED";
