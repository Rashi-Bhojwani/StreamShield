export type HealthState =
  "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN" | "RECOVERING";
export interface ComponentObservation {
  id: string;
  name: string;
  role: string;
  group: string;
  dependencies: string[];
  state: HealthState;
  observedAt: string;
  lastSuccessAt: string | null;
  code: string;
  latencyMs: number | null;
  failures: number;
  successes: number;
  firstFailureAt: string | null;
  detectionMs: number | null;
  confirmedAt?: string | null;
  failureCode?: string | null;
  failureState?: "DEGRADED" | "UNHEALTHY" | null;
  firstSuccessAt?: string | null;
}
export interface IncidentEvent {
  state: string;
  at: string;
  evidence: Record<string, unknown>;
}
export interface Incident {
  id: string;
  component: string;
  severity: "warning" | "critical";
  state: string;
  first_observed_at: string;
  detected_at: string;
  restored_at: string | null;
  verified_at: string | null;
  resolved_at: string | null;
  detection_ms: number | null;
  duration_ms: number | null;
  evidence: Record<string, unknown>;
  events?: IncidentEvent[];
  source: string;
  failure_identity: string;
  correlation_id: string;
  updated_at: string;
}
export interface MediaObservation {
  path: string;
  publisher: boolean;
  checkedAt: string;
  sources: {
    id: "primary" | "standby";
    manifest: boolean;
    segment: boolean;
    fresh: boolean | null;
    code: string;
  }[];
}
export interface MonitoringSnapshot {
  version: 1;
  sequence: string;
  observedAt: string | null;
  staleAfterMs: number;
  stale: boolean;
  persistence: boolean;
  components: ComponentObservation[];
  incidents: Incident[];
  openCount: number;
  verifiedCount: number;
  media: MediaObservation[];
  mediaAvailable: boolean;
  playback: {
    reports: number;
    advancing: number;
    standby: number;
    checkedAt: string | null;
    label: string;
  };
}
export interface MonitoringEvent {
  version: 1;
  sequence: string;
  at: string;
  kind: "snapshot_changed" | "recovery_changed";
}
export interface MetricSeries {
  id: string;
  label: string;
  unit: string;
  points: [number, number][];
}
export interface MonitoringMetrics {
  available: boolean;
  checkedAt: string;
  series: MetricSeries[];
}
