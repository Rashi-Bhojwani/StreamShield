export type ChaosScenarioId =
  | "crash-api"
  | "crash-edge"
  | "crash-primary"
  | "crash-redis"
  | "network-timeout"
  | "external-api"
  | "database-outage"
  | "broadcast-interruption";
export type ExperimentState =
  | "CREATED"
  | "VALIDATING"
  | "INJECTING"
  | "FAULT_CONFIRMED"
  | "AWAITING_DETECTION"
  | "HEALING_OBSERVED"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";
export interface ChaosScenario {
  id: ChaosScenarioId;
  name: string;
  target: string;
  risk: "moderate" | "high";
  failure: string;
  recovery: string;
  prerequisites: string;
  supported: boolean;
  available: boolean;
  reason: string | null;
}
export type ExperimentEventKind =
  | ExperimentState
  | "STANDBY_VALIDATING"
  | "CANCEL_REQUESTED"
  | "CLEANUP_COMPLETED"
  | "CLEANUP_FAILED"
  | "INCIDENT_CORRELATED"
  | "INCIDENT_DETECTED"
  | "OBSERVATION_UNAVAILABLE"
  | "RECEIPT_PENDING"
  | "SERVICE_VERIFIED"
  | "NO_ACCEPTED_FAULT"
  | `CIRCUIT_${"CLOSED" | "OPEN" | "HALF_OPEN"}`;
export interface ExperimentEvent {
  kind: ExperimentEventKind;
  at: string;
  detail: string;
}
export interface ChaosExperiment {
  id: string;
  actor: string;
  scenario: ChaosScenarioId;
  target: string;
  state: ExperimentState;
  createdAt: string;
  updatedAt: string;
  injectedAt: string | null;
  faultConfirmedAt: string | null;
  incidentDetectedAt: string | null;
  actionStartedAt: string | null;
  actionFinishedAt: string | null;
  verifiedAt: string | null;
  finishedAt: string | null;
  deadline: number;
  faultExpiresAt: number | null;
  incidentId: string | null;
  recoveryIds: string[];
  priorRecoveryIds: string[];
  reason: string;
  mechanism: string | null;
  cleanup: "NOT_REQUIRED" | "PENDING" | "COMPLETED" | "FAILED";
  cancelRequestedBy: string | null;
  databasePersisted: boolean;
  evidence: Record<string, string | number | boolean | null>;
  events: ExperimentEvent[];
  measurements: {
    detectionMs: number | null;
    healingStartMs: number | null;
    actionMs: number | null;
    restorationMs: number | null;
    playbackInterruptionMs: number | null;
  };
}
export interface ChaosSnapshot {
  version: 1;
  available: boolean;
  enabled: boolean;
  databaseAvailable: boolean;
  observedAt: string | null;
  activeId: string | null;
  faultDurationMs: number;
  timeoutMs: number;
  scenarios: ChaosScenario[];
  experiments: ChaosExperiment[];
}
