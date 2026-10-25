import { Counter, Gauge, Histogram } from "@prometheus-io/client";
import { createMetrics } from "../monitoring/metrics.js";
import type { RecoveryAttempt } from "@streamshield/shared";
export function healingMetrics() {
  const { registry } = createMetrics();
  const attempts = new Counter({
    name: "streamshield_recovery_attempts_total",
    help: "Created real recovery episodes",
    labelNames: ["playbook"],
    registers: [registry],
  });
  const outcomes = new Counter({
    name: "streamshield_recovery_outcomes_total",
    help: "Recovery terminal transitions, including explicit escalation",
    labelNames: ["playbook", "outcome"],
    registers: [registry],
  });
  const actions = new Counter({
    name: "streamshield_recovery_actions_total",
    help: "Actual control requests and bounded safe read actions",
    labelNames: ["playbook"],
    registers: [registry],
  });
  const duration = (name: string, help: string) =>
    new Histogram({
      name,
      help,
      labelNames: ["playbook"],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
      registers: [registry],
    });
  const action = duration(
      "streamshield_recovery_action_seconds",
      "Actual action request elapsed duration",
    ),
    verification = duration(
      "streamshield_recovery_verification_seconds",
      "Independent verification elapsed duration",
    ),
    total = duration(
      "streamshield_recovery_total_seconds",
      "First observed failure to terminal recovery state",
    ),
    detection = duration(
      "streamshield_recovery_detection_to_action_seconds",
      "Recorded failure observation to action start",
    );
  const active = new Gauge({
    name: "streamshield_recovery_active",
    help: "Current nonterminal local attempts",
    registers: [registry],
  });
  const circuit = new Gauge({
    name: "streamshield_dependency_circuit_state",
    help: "Circuit CLOSED=0 OPEN=1 HALF_OPEN=2",
    registers: [registry],
  });
  const rejected = new Gauge({
    name: "streamshield_dependency_circuit_rejected",
    help: "Actual circuit rejections since process start",
    registers: [registry],
  });
  const budgets = new Counter({
    name: "streamshield_recovery_suppressed_total",
    help: "Rejected execution budget/cooldown/authority",
    labelNames: ["reason"],
    registers: [registry],
  });
  const finished = (a: RecoveryAttempt) => {
    outcomes.inc({ playbook: a.playbook, outcome: a.state.toLowerCase() });
    const end = Date.parse(a.finishedAt!);
    if (a.verificationStartedAt)
      verification.observe(
        { playbook: a.playbook },
        Math.max(0, end - Date.parse(a.verificationStartedAt)) / 1000,
      );
    total.observe(
      { playbook: a.playbook },
      Math.max(0, end - Date.parse(a.detectedAt)) / 1000,
    );
  };
  return {
    registry,
    attempts,
    outcomes,
    actions,
    action,
    verification,
    total,
    detection,
    active,
    circuit,
    rejected,
    budgets,
    finished,
  };
}
