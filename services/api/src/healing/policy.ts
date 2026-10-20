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
}
export const playbooks: Playbook[] = [
  {
    id: "api-start",
    version: 1,
    services: ["api-1", "api-2"],
    action: "start_stopped_service",
    dependencies: ["postgres", "redis"],
    verification: "Direct ready + stream metadata + gateway routing",
    compensation: "No peer mutation; escalate if verification fails",
  },
  {
    id: "edge-start",
    version: 1,
    services: ["edge-1", "edge-2"],
    action: "start_stopped_service",
    dependencies: ["relay"],
    verification: "Health + authorized HLS bytes + segment progression",
    compensation: "Preserve peer; no forced routing changes",
  },
  {
    id: "primary-start",
    version: 1,
    services: ["origin-primary"],
    action: "start_stopped_service",
    dependencies: ["relay", "origin-standby"],
    verification:
      "All sampled relay paths receive progressing primary segments",
    compensation: "Sticky standby; no automatic failback",
  },
  {
    id: "redis-start",
    version: 1,
    services: ["redis"],
    action: "start_stopped_service",
    dependencies: ["postgres"],
    verification: "Observer authenticated PING + both API readiness",
    compensation: "Do not replay lost Pub/Sub messages",
  },
  {
    id: "dependency-reconnect",
    version: 1,
    services: ["demo-dependency"],
    action: "safe_read_retry",
    dependencies: [],
    verification: "Circuit recovery probes + consecutive safe GET successes",
    compensation: "Explicit unavailable recommendation fallback; no writes",
  },
  {
    id: "database-review",
    version: 1,
    services: ["postgres"],
    action: "operator_review",
    dependencies: [],
    verification: "Operator storage review required",
    compensation: "Never start/reset/migrate database automatically",
  },
  {
    id: "source-wait",
    version: 1,
    services: ["publisher-source"],
    action: "observe_source",
    dependencies: ["relay", "origin-primary", "origin-standby"],
    verification: "Authorized source returns with progressing media",
    compensation: "Offline/source interrupted; cannot reconstruct live video",
  },
];
export function selectPlaybook(component: string) {
  return playbooks.find((p) => p.services.includes(component));
}
export function eligibility(
  component: ComponentObservation,
  components: ComponentObservation[],
  c: HealingConfig,
  now = Date.now(),
) {
  const p = selectPlaybook(component.id);
  if (!p) return { allowed: false, reason: "unsupported_component" };
  if (
    !component.confirmedAt ||
    !["UNHEALTHY", "DEGRADED"].includes(component.state) ||
    now - Date.parse(component.observedAt) > 12000
  )
    return { allowed: false, reason: "unconfirmed_or_stale" };
  if (component.code === "probe_denied" || component.state === "DEGRADED")
    return { allowed: false, reason: "authority_or_dependency_symptom" };
  for (const dependency of p.dependencies)
    if (components.find((x) => x.id === dependency)?.state !== "HEALTHY")
      return { allowed: false, reason: "dependency_unhealthy:" + dependency };
  if (!c.enabled || c.HEALER_DISABLED_PLAYBOOKS.split(",").includes(p.id))
    return { allowed: false, reason: "policy_disabled" };
  if (p.action === "start_stopped_service" && !c.allowed.includes(component.id))
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
