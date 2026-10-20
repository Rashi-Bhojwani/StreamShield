export type RecoveryState =
  | "SCHEDULED"
  | "EXECUTING"
  | "VERIFYING"
  | "RETRY_WAIT"
  | "VERIFIED"
  | "ESCALATED";
export interface RecoveryEvent {
  state: RecoveryState;
  at: string;
  reason: string;
}
export interface RecoveryAttempt {
  id: string;
  incidentId: string | null;
  component: string;
  episode: string;
  playbook: string;
  version: 1;
  actor: "streamshield-healer";
  diagnosis: string;
  action:
    | "start_stopped_service"
    | "safe_read_retry"
    | "observe_source"
    | "operator_review";
  state: RecoveryState;
  number: number;
  epoch: number;
  createdAt: string;
  detectedAt: string;
  actionStartedAt: string | null;
  actionFinishedAt: string | null;
  verificationStartedAt: string | null;
  finishedAt: string | null;
  nextAt: number;
  deadline: number;
  reason: string;
  evidence: Record<string, string | number | boolean | null>;
  events: RecoveryEvent[];
  databasePersisted?: boolean;
}
export interface HealingSnapshot {
  version: 1;
  available: boolean;
  enabled: boolean;
  leader: boolean;
  observedAt: string | null;
  databaseAvailable: boolean;
  attempts: RecoveryAttempt[];
  counts: {
    active: number;
    verified: number;
    escalated: number;
    averageRecoveryMs: number | null;
  };
  circuit: {
    state: "CLOSED" | "OPEN" | "HALF_OPEN";
    failures: number;
    rejected: number;
    requests: number;
    lastSuccessAt: string | null;
  };
}
