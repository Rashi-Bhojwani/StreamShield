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
    id: "api-scale-out",
    diagnosis:
      "API tier overloaded (p95 latency or 5xx ratio above threshold across instances): add pre-provisioned capacity; restarting overloaded servers would not help",
    version: 1,
    services: ["api-tier"],
    action: "start_spare_capacity",
    symptoms: ["overloaded"],
    dependencies: ["postgres", "redis"],
    verification:
      "Spare API ready + serving through the gateway + tier p95 back under threshold",
    compensation:
      "Escalate as capacity exhausted if overload persists with the spare running; never restart overloaded APIs",
  },
  {
    id: "api-scale-in",
    diagnosis:
      "Load normal for the stability window: remove the spare capacity again",
    version: 1,
    services: ["api-tier"],
    action: "stop_spare_capacity",
    symptoms: ["scale_in"],
    dependencies: ["api-1", "api-2"],
    verification:
      "Spare stopped gracefully + both permanent APIs serving + tier healthy",
    compensation: "Only the spare may be stopped; permanent APIs are untouched",
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
  if (p.action === "stop_spare_capacity") {
    // Scale-in is decided by the Healer from sustained normal load, not by a
    // failure; it still needs both permanent APIs serving and authority.
    for (const dependency of p.dependencies)
      if (components.find((x) => x.id === dependency)?.state !== "HEALTHY")
        return { allowed: false, reason: "dependency_unhealthy:" + dependency };
    if (!c.enabled || c.HEALER_DISABLED_PLAYBOOKS.split(",").includes(p.id))
      return { allowed: false, reason: "policy_disabled" };
    if (!c.allowed.includes("api-3"))
      return { allowed: false, reason: "service_not_allowed" };
    return {
      allowed: true,
      reason: "load_normal_for_stability_window",
      playbook: p,
    };
  }
  if (
    !component.confirmedAt ||
    !["UNHEALTHY", "DEGRADED"].includes(component.state) ||
    now - Date.parse(component.observedAt) > c.OBS_STALE_MS
  )
    return { allowed: false, reason: "unconfirmed_or_stale" };
  // Overload is a DEGRADED symptom with its own playbook; other DEGRADED states
  // are dependency symptoms the Healer must not act on.
  const symptomMatched = !!p.symptoms?.includes(failureCodeOf(component) || "");
  if (
    component.code === "probe_denied" ||
    (component.state === "DEGRADED" && !symptomMatched)
  )
    return { allowed: false, reason: "authority_or_dependency_symptom" };

  if (p.action === "restart_unresponsive_service") {
    // Never restart the last serving instance: the peer must be serving now.
    const peer = peers[component.id];
    if (!peer || components.find((x) => x.id === peer)?.state !== "HEALTHY")
      return { allowed: false, reason: "peer_not_healthy:" + (peer || "none") };
    // A timeout while the tier carries real load is congestion, not a hang:
    // restarting an overloaded instance only removes capacity (scale-out owns it).
    const tier = components.find((x) => x.id === "api-tier");
    if (
      tier &&
      ((tier.state !== "HEALTHY" && failureCodeOf(tier) === "overloaded") ||
        (tier.metrics?.rps ?? 0) >= c.HEALER_HANG_MAX_RPS)
    )
      return { allowed: false, reason: "tier_under_load_timeout_not_a_hang" };
    // A hang persists; congestion at the start of a surge shows up in the
    // (lagging) tier rate within this window, so wait before restarting.
    const since = Date.parse(component.firstFailureAt || component.confirmedAt);
    if (!(now - since >= c.HEALER_HANG_CONFIRM_MS))
      return { allowed: false, reason: "hang_unconfirmed_wait" };
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
    ["start_spare_capacity", "stop_spare_capacity"].includes(p.action) &&
    !c.allowed.includes("api-3")
  )
    return { allowed: false, reason: "service_not_allowed" };
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
