import type {
  RecoveryAttempt,
  ChaosExperiment,
  ChaosSnapshot,
  ChaosScenarioId,
  HealingSnapshot,
  ExperimentState,
  ExperimentEventKind,
} from "@streamshield/shared";
import {
  chaosConfig,
  scenarioFor,
  scenarios,
  temporary,
  terminal,
  type ChaosConfig,
} from "./config.js";
import { ChaosJournal } from "./journal.js";
import { ChaosStore } from "./store.js";
import { Verifier, type Frame } from "../healing/verification.js";
import { managed } from "../healing/config.js";
import { probeFailureCode } from "../monitoring/policy.js";
/** The playbook the Healer must use for each scenario target. */
export const playbookFor = (id: ChaosScenarioId, target: string) =>
  id === "hang-api"
    ? "api-restart-unresponsive"
    : (
        {
          "api-1": "api-start",
          "api-2": "api-start",
          "edge-1": "edge-start",
          "origin-primary": "primary-start",
          redis: "redis-start",
          "video-gateway": "gateway-start",
          relay: "relay-start",
        } as Record<string, string>
      )[target]!;
export class ChaosEngine {
  frame: Frame | undefined;
  healer: HealingSnapshot | undefined;
  controlAvailable = false;
  adapterActive = 0;
  lastCompleted = 0;
  private nextSync = 0;
  private stable = new Map<string, number>();
  constructor(
    public c: ChaosConfig,
    public journal: ChaosJournal,
    public store: ChaosStore,
    public verifier: Verifier,
  ) {}
  async control(path: string, body?: object) {
    const r = await fetch(process.env.CHAOS_CONTROL_URL + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + this.c.CHAOS_CONTROL_SECRET,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(6500),
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.code || "fault_control_unavailable");
    return data;
  }
  current() {
    return (
      !!this.frame &&
      this.frame.persistence &&
      Date.now() - this.frame.lastCompleted < 12000 &&
      !!this.healer?.available &&
      this.healer.enabled &&
      this.healer.databaseAvailable &&
      this.healer.leader &&
      !!this.healer.observedAt &&
      Date.now() - Date.parse(this.healer.observedAt) < 12000 &&
      this.controlAvailable
    );
  }
  reason(id: ChaosScenarioId) {
    const s = scenarioFor(id);
    if (!s.supported) return s.reason;
    if (!this.c.enabled) return "Explicit local chaos enablement is required.";
    if (!this.c.allowed.includes(id))
      return "Scenario disabled by deployment policy.";
    if (!this.current())
      return "Fresh observer, Healer leader and fault adapter are required.";
    if (!this.store.available)
      return "Experiment audit storage is unavailable.";
    if (this.journal.all().some((e) => !terminal(e.state)))
      return "Another experiment is active.";
    if (this.journal.cooldownRemaining(s.target, this.c.CHAOS_COOLDOWN_MS))
      return "Target cooldown remains active; wait before repeating this failure boundary.";
    if (this.adapterActive)
      return "An owned fault still awaits adapter cleanup.";
    if (this.frame!.components.some((c) => c.state !== "HEALTHY"))
      return "All monitored components must return to a healthy baseline.";
    const allowed = (
      process.env.HEALER_ALLOWED_SERVICES || managed.join(",")
    ).split(",");
    const disabled = (process.env.HEALER_DISABLED_PLAYBOOKS || "").split(",");
    if (
      !temporary(id) &&
      s.targets.some(
        (t) => !allowed.includes(t) || disabled.includes(playbookFor(id, t)),
      )
    )
      return "The required independent Healer playbook is disabled.";
    if (!temporary(id)) {
      // Never inject a fault the Healer is not currently permitted to repair.
      if (!this.healer!.budgets)
        return "Healer repair budget is not reported yet.";
      for (const t of s.targets) {
        const b = this.healer!.budgets[t];
        if (!b) return "Healer repair budget is not reported for " + t + ".";
        if (b.availableAt)
          return `Healer repair budget/cooldown for ${t} is spent until ${b.availableAt.slice(11, 19)} UTC; wait so the Healer can repair it.`;
        if (b.max - b.used < 1)
          return "Healer repair budget for " + t + " is exhausted.";
      }
    }
    if (
      ["crash-edge", "crash-primary"].includes(id) &&
      (!this.frame!.mediaAvailable ||
        !this.frame!.media.some(
          (p) =>
            p.publisher &&
            p.sources.some((s) => s.id === "standby" && s.segment && s.fresh),
        ))
    )
      return "Start a real stream and wait for verified standby media.";
    if (temporary(id) && this.healer!.circuit.state !== "CLOSED")
      return "Wait for the recommendation circuit to close.";
    return null;
  }
  snapshot(): ChaosSnapshot {
    const experiments = this.journal.all();
    return {
      version: 1,
      available: this.current(),
      enabled: this.c.enabled,
      databaseAvailable: this.store.available,
      observedAt: this.lastCompleted
        ? new Date(this.lastCompleted).toISOString()
        : null,
      activeId: experiments.find((e) => !terminal(e.state))?.id || null,
      faultDurationMs: this.c.CHAOS_FAULT_DURATION_MS,
      timeoutMs: this.c.CHAOS_TIMEOUT_MS,
      scenarios: scenarios.map((s) => ({
        ...s,
        available: !this.reason(s.id),
        reason: this.reason(s.id),
      })),
      experiments,
    };
  }
  event(
    e: ChaosExperiment,
    kind: ExperimentEventKind,
    detail: string,
    at = new Date().toISOString(),
  ) {
    if (
      !kind.startsWith("CIRCUIT_") &&
      e.events.some((x) => x.kind === kind && x.detail === detail)
    )
      return;
    e.events.push({ kind, detail, at });
    if (e.events.length > 100) e.events.splice(1, 1);
    this.journal.save(e);
  }
  transition(e: ChaosExperiment, state: ExperimentState, reason: string) {
    e.state = state;
    e.reason = reason;
    if (terminal(state)) e.finishedAt = new Date().toISOString();
    this.event(e, state, reason);
    this.journal.save(e);
  }
  async submit(
    id: string,
    actor: string,
    scenario: ChaosScenarioId,
    confirmation: string,
  ) {
    const old =
      this.journal.get(id) ||
      (this.store.available ? await this.store.get(id) : undefined);
    if (old) {
      if (old.actor !== actor || old.scenario !== scenario)
        throw Error("identity_conflict");
      return old;
    }
    if (!this.c.enabled) throw Error("chaos_disabled");
    if (!scenarioFor(scenario).supported || !this.c.allowed.includes(scenario))
      throw Error("unsupported_scenario");
    if (confirmation !== scenarioFor(scenario).target)
      throw Error("confirmation_required");
    const reason = this.reason(scenario);
    if (reason) throw Error("prerequisites_unavailable");
    const now = new Date().toISOString();
    const e: ChaosExperiment = {
      id,
      actor,
      scenario,
      target: scenarioFor(scenario).target,
      state: "CREATED",
      createdAt: now,
      updatedAt: now,
      injectedAt: null,
      faultConfirmedAt: null,
      incidentDetectedAt: null,
      actionStartedAt: null,
      actionFinishedAt: null,
      verifiedAt: null,
      finishedAt: null,
      deadline: Date.now() + this.c.CHAOS_TIMEOUT_MS,
      faultExpiresAt: null,
      incidentId: null,
      recoveryIds: [],
      priorRecoveryIds: this.healer!.attempts.map((a) => a.id),
      reason: "administrator_confirmed_target",
      mechanism: null,
      cleanup: temporary(scenario) ? "PENDING" : "NOT_REQUIRED",
      cancelRequestedBy: null,
      databasePersisted: false,
      evidence: {},
      events: [
        {
          kind: "CREATED",
          at: now,
          detail: "Administrator confirmed " + scenarioFor(scenario).target,
        },
      ],
      measurements: {
        detectionMs: null,
        healingStartMs: null,
        actionMs: null,
        restorationMs: null,
        playbackInterruptionMs: null,
      },
    };
    this.journal.create(
      e,
      this.c.CHAOS_RATE_LIMIT,
      this.c.CHAOS_RATE_WINDOW_MS,
      this.c.CHAOS_COOLDOWN_MS,
    );
    try {
      await this.store.sync(e);
      this.journal.synced(e);
    } catch {
      this.store.available = false;
      e.cleanup = "NOT_REQUIRED";
      this.transition(
        e,
        "FAILED",
        "audit_storage_unavailable_no_fault_injected",
      );
      throw Error("audit_unavailable");
    }
    return e;
  }
  cancel(id: string, actor: string) {
    const e = this.journal.get(id);
    if (!e) throw Error("experiment_not_found");
    if (!terminal(e.state)) {
      e.cancelRequestedBy = actor;
      this.event(
        e,
        "CANCEL_REQUESTED",
        "Cancellation requested by administrator " + actor,
      );
    }
    return e;
  }
  async finish(
    e: ChaosExperiment,
    state: "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED",
    reason: string,
  ) {
    this.stable.delete(e.id);
    if (["CREATED", "VALIDATING"].includes(e.state) && !e.injectedAt) {
      e.cleanup = "NOT_REQUIRED";
      this.transition(e, state, reason);
      return;
    }
    try {
      const f = await this.control("/v1/faults/" + e.id + "/release", {});
      e.cleanup = f.cleanup;
      if (f.cleanupAt && !e.events.some((x) => x.kind === "CLEANUP_COMPLETED"))
        this.event(
          e,
          "CLEANUP_COMPLETED",
          "Only the experiment-owned fault was removed",
          f.cleanupAt,
        );
    } catch (error) {
      if (error instanceof Error && error.message === "not_accepted") {
        e.cleanup = "NOT_REQUIRED";
        this.event(
          e,
          "NO_ACCEPTED_FAULT",
          "The adapter has no durable accepted fault for this UUID",
        );
      } else if (e.injectedAt || e.state === "INJECTING") {
        e.cleanup = "FAILED";
        this.event(
          e,
          "CLEANUP_FAILED",
          "Fault cleanup is unconfirmed; adapter retains durable expiry and retries",
        );
        if (state === "COMPLETED") state = "FAILED";
      }
    }
    this.transition(e, state, reason);
  }
  private async sync(e: ChaosExperiment) {
    e = this.journal.get(e.id) || e;
    if (e.databasePersisted || Date.now() < this.nextSync) return;
    try {
      await this.store.sync(e);
      this.journal.synced(e);
    } catch {
      this.store.available = false;
      this.nextSync = Date.now() + 5000;
    }
  }
  async tick() {
    try {
      await this.store.check();
    } catch {
      this.store.available = false;
    }
    try {
      this.frame = await this.verifier.frame();
      const r = await fetch(process.env.HEALER_URL + "/state", {
        headers: { Authorization: "Bearer " + process.env.HEALER_SECRET },
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) throw Error("healer");
      this.healer = await r.json();
      const control = await this.control("/v1/status");
      this.controlAvailable = control.enabled === this.c.enabled;
      this.adapterActive = control.active.length;
    } catch {
      this.controlAvailable = false;
    }
    this.lastCompleted = Date.now();
    for (const e of this.journal.work()) {
      if (!terminal(e.state))
        try {
          await this.advance(e);
        } catch {
          this.event(
            e,
            "OBSERVATION_UNAVAILABLE",
            "Fresh evidence unavailable; no unconfirmed fault or repair will be replayed",
          );
        }
      else if (["PENDING", "FAILED"].includes(e.cleanup)) {
        try {
          const f = await this.control("/v1/faults/" + e.id);
          if (f.cleanup === "COMPLETED" || f.cleanup === "NOT_REQUIRED") {
            e.cleanup = f.cleanup;
            this.event(
              e,
              "CLEANUP_COMPLETED",
              "Adapter reconciled owned fault cleanup after terminal outcome",
              f.cleanupAt || undefined,
            );
          }
        } catch {
          /* Keep unresolved cleanup visible. */
        }
      }
      await this.sync(e);
    }
    this.journal.prune(this.c.CHAOS_RETENTION_DAYS);
  }
  private async advance(e: ChaosExperiment) {
    if (e.cancelRequestedBy) {
      await this.finish(
        e,
        "CANCELLED",
        e.injectedAt
          ? "Observation cancelled; an accepted crash cannot be undone by Chaos"
          : "Cancelled before injection",
      );
      return;
    }
    if (Date.now() > e.deadline) {
      await this.finish(
        e,
        "TIMED_OUT",
        "Experiment deadline elapsed; infrastructure restoration remains unconfirmed",
      );
      return;
    }
    if (e.state === "CREATED") {
      this.transition(
        e,
        "VALIDATING",
        "Checking fresh health, independent Healer and deployment policy",
      );
      return;
    }
    if (e.state === "VALIDATING") {
      if (
        !this.c.enabled ||
        !this.c.allowed.includes(e.scenario) ||
        !this.current() ||
        !this.store.available ||
        !this.healer?.enabled ||
        this.frame!.components.some((c) => c.state !== "HEALTHY")
      ) {
        await this.finish(
          e,
          "FAILED",
          "Baseline or independent healing authority unavailable; no fault injected",
        );
        return;
      }
      if (["crash-edge", "crash-primary"].includes(e.scenario)) {
        const paths = await this.verifier.paths();
        const safe =
          paths.length > 0 &&
          (await this.verifier.hls("origin-standby", paths, "standby")).ok;
        if (!safe) {
          this.event(
            e,
            "STANDBY_VALIDATING",
            "Waiting for independently observed standby segment progression; no fault injected",
          );
          return;
        }
      }
      this.transition(
        e,
        "INJECTING",
        "Durable intent recorded before restricted fault injection",
      );
      await this.store.sync(e);
      this.journal.synced(e);
      if (this.journal.get(e.id)?.cancelRequestedBy) return;
      try {
        const f = await this.control("/v1/inject", {
          id: e.id,
          scenario: e.scenario,
        });
        await this.receipt(e, f);
      } catch {
        this.event(
          e,
          "RECEIPT_PENDING",
          "Injection response unconfirmed; reconcile the same UUID without repeating the POST",
        );
      }
      return;
    }
    if (e.state === "INJECTING") {
      try {
        await this.receipt(e, await this.control("/v1/faults/" + e.id));
      } catch {
        /* Never repeat an ambiguous destructive operation. */
      }
      return;
    }
    if (e.state === "FAULT_CONFIRMED") {
      this.transition(
        e,
        "AWAITING_DETECTION",
        "Awaiting a confirmed Phase 5 incident",
      );
      return;
    }
    const f = await this.control("/v1/faults/" + e.id);
    if (f.cleanup !== e.cleanup) {
      e.cleanup = f.cleanup;
      if (f.cleanupAt)
        this.event(
          e,
          "CLEANUP_COMPLETED",
          "Timed toxic removal is fault cleanup, not Healer service repair",
          f.cleanupAt,
        );
    }
    if (!this.current()) return;
    if (
      temporary(e.scenario) &&
      e.evidence.lastCircuitState !== this.healer!.circuit.state
    ) {
      e.evidence.lastCircuitState = this.healer!.circuit.state;
      this.event(
        e,
        `CIRCUIT_${this.healer!.circuit.state}`,
        "Observed recommendation circuit " + this.healer!.circuit.state,
      );
    }
    const scenario = scenarioFor(e.scenario);
    // One independent attempt per target; all must verify with the expected receipt.
    const attempts: RecoveryAttempt[] = [];
    for (const target of scenario.targets) {
      const a = this.healer!.attempts.find(
        (a) =>
          a.component === target &&
          !e.priorRecoveryIds.includes(a.id) &&
          Date.parse(a.createdAt) >= Date.parse(e.injectedAt!),
      );
      if (a) attempts.push(a);
    }
    if (!attempts.length) return;
    for (const a of attempts) {
      if (!e.recoveryIds.includes(a.id)) {
        e.recoveryIds.push(a.id);
        this.event(
          e,
          "INCIDENT_CORRELATED",
          `Independent recovery attempt ${a.id} for ${a.component} (${a.playbook})`,
        );
      }
      if (!e.incidentId && a.incidentId) e.incidentId = a.incidentId;
    }
    e.evidence.recoveryAction = [
      ...new Set(attempts.map((a) => a.action)),
    ].join(",");
    e.evidence.recoveryPlaybook = [
      ...new Set(attempts.map((a) => a.playbook)),
    ].join(",");
    e.evidence.diagnosis = attempts[0]!.diagnosis;
    e.evidence.failureCode = attempts[0]!.evidence.failureCode ?? null;
    if (e.incidentId) {
      const i = await this.store.incident(e.incidentId);
      if (i && !e.incidentDetectedAt) {
        e.incidentDetectedAt = i.detected_at.toISOString();
        const detection =
          Date.parse(e.incidentDetectedAt) - Date.parse(e.injectedAt!);
        e.measurements.detectionMs = detection >= 0 ? detection : null;
        e.evidence.incidentPredatesFault = detection < 0;
        this.event(
          e,
          "INCIDENT_DETECTED",
          "Confirmed Phase 5 detection",
          e.incidentDetectedAt,
        );
      }
    }
    const started = attempts
      .map((a) => a.actionStartedAt)
      .filter((x): x is string => !!x)
      .sort();
    if (started.length && !e.actionStartedAt) {
      e.actionStartedAt = started[0]!;
      e.measurements.healingStartMs = Math.max(
        0,
        Date.parse(started[0]!) - Date.parse(e.injectedAt!),
      );
      this.transition(
        e,
        "HEALING_OBSERVED",
        "Independent Healer action observed: " +
          attempts
            .filter((a) => a.actionStartedAt)
            .map((a) => a.action.replaceAll("_", " ") + " " + a.component)
            .join(", "),
      );
    }
    if (
      attempts.some((a) => a.verificationStartedAt) &&
      e.state !== "VERIFYING" &&
      !e.verifiedAt
    )
      this.transition(
        e,
        "VERIFYING",
        "Independent Healer verification observed",
      );
    const escalated = attempts.find((a) => a.state === "ESCALATED");
    if (escalated) {
      await this.finish(
        e,
        "FAILED",
        `Independent Healer escalated (${escalated.component}): ${escalated.reason}`,
      );
      return;
    }
    for (const a of attempts)
      if (a.state === "VERIFIED")
        this.event(
          e,
          "TARGET_VERIFIED",
          `${a.component} verified by the Healer (${a.evidence.controlReceipt ?? "no receipt"})`,
          a.finishedAt || undefined,
        );
    if (
      attempts.length < scenario.targets.length ||
      attempts.some((a) => a.state !== "VERIFIED")
    )
      return;
    if (!temporary(e.scenario)) {
      const wrong = attempts.find(
        (a) =>
          a.evidence.controlReceipt !== scenario.expectedReceipt ||
          a.playbook !== playbookFor(e.scenario, a.component),
      );
      if (wrong) {
        await this.finish(
          e,
          "FAILED",
          `No accepted ${scenario.expectedReceipt} receipt from ${playbookFor(e.scenario, wrong.component)} for ${wrong.component}`,
        );
        return;
      }
    }
    if (!e.verifiedAt) {
      let verified = true;
      if (temporary(e.scenario))
        verified =
          this.healer!.circuit.state === "CLOSED" &&
          e.cleanup === "COMPLETED" &&
          (
            await this.verifier.text(process.env.HEALER_DEPENDENCY_URL!)
          ).includes('"available"');
      else
        for (const a of attempts)
          verified &&= (await this.verifier.verify(a, this.frame!)).ok;
      if (!verified) {
        this.stable.delete(e.id);
        return;
      }
      const since = this.stable.get(e.id) || Date.now();
      this.stable.set(e.id, since);
      if (Date.now() - since < 2000) return;
      const finished = attempts
        .map((a) => a.actionFinishedAt)
        .filter((x): x is string => !!x)
        .sort();
      e.actionFinishedAt = finished.at(-1) || null;
      e.measurements.actionMs =
        e.actionStartedAt && e.actionFinishedAt
          ? Date.parse(e.actionFinishedAt) - Date.parse(e.actionStartedAt)
          : null;
      e.verifiedAt = new Date().toISOString();
      e.measurements.restorationMs =
        Date.parse(e.verifiedAt) - Date.parse(e.injectedAt!);
      e.mechanism = temporary(e.scenario)
        ? "Timed fault cleanup + autonomous safe-read/circuit reconnection"
        : e.scenario === "hang-api"
          ? "Independent Healer bounded restart of an unresponsive service"
          : "Independent Healer allowlisted service start" +
            (attempts.length > 1 ? " of every failed instance" : "");
      e.evidence = {
        ...e.evidence,
        healerVerifiedAt: attempts
          .map((a) => a.finishedAt || "")
          .sort()
          .at(-1)!,
        healerReceipt: attempts
          .map((a) => String(a.evidence.controlReceipt || "safe_read"))
          .join(","),
        healerReceipts: attempts.length,
        independentBehaviorVerified: true,
        browserPlaybackVerified: false,
      };
      this.event(
        e,
        "SERVICE_VERIFIED",
        "Experiment independently verified actual service behavior",
        e.verifiedAt,
      );
    }
    if (
      e.scenario === "crash-relay" &&
      Number(e.evidence.livePathsAtInjection || 0) > 0 &&
      e.evidence.broadcasterClientReconnected === undefined
    ) {
      // The Healer restored the server; the broadcast returns only if the
      // broadcaster's own client reconnects. Record that separately.
      if (this.frame!.media.some((p) => p.publisher)) {
        e.evidence.broadcasterClientReconnected = true;
        e.evidence.sourceRestoredByHealer = false;
        e.evidence.broadcasterReconnectedAt = new Date().toISOString();
        this.event(
          e,
          "BROADCASTER_CLIENT_RECONNECTED",
          "broadcaster_client_reconnected: the publisher returned by itself after the relay repair",
        );
      } else if (
        Date.now() - Date.parse(e.verifiedAt!) >=
        this.c.CHAOS_BROADCASTER_WAIT_MS
      ) {
        e.evidence.broadcasterClientReconnected = false;
        e.evidence.sourceRestoredByHealer = false;
        this.event(
          e,
          "BROADCASTER_NOT_RETURNED",
          "Relay verified; no broadcaster reconnected within the observation window",
        );
      } else {
        this.journal.save(e);
        return;
      }
    }
    await this.finish(e, "COMPLETED", "Restoration independently verified");
  }
  /** Direct readiness probe of a frozen target: only a timeout confirms a hang. */
  async hangProbe(target: string) {
    try {
      const r = await fetch(this.verifier.url(target), {
        redirect: "error",
        signal: AbortSignal.timeout(this.c.CHAOS_PROBE_TIMEOUT_MS),
      });
      await r.body?.cancel();
      return "answered_" + r.status;
    } catch (error) {
      return probeFailureCode(error);
    }
  }
  private async receipt(
    e: ChaosExperiment,
    f: {
      state: string;
      injectedAt: string | null;
      confirmedAt: string | null;
      expiresAt: number;
      cleanup: ChaosExperiment["cleanup"];
      evidence: ChaosExperiment["evidence"];
    },
  ) {
    e.injectedAt = f.injectedAt;
    e.faultConfirmedAt = f.confirmedAt;
    e.faultExpiresAt = temporary(e.scenario) ? f.expiresAt : null;
    e.cleanup = f.cleanup;
    e.evidence = { ...f.evidence };
    if (f.state !== "CONFIRMED" && f.state !== "CLOSED") {
      this.transition(
        e,
        "FAILED",
        "Fault injection unconfirmed; no replay permitted",
      );
      return;
    }
    if (e.scenario === "hang-api") {
      const probe = await this.hangProbe(e.target);
      e.evidence.readinessProbe = probe;
      if (probe !== "probe_timeout") {
        // Stay INJECTING; the same accepted fault is re-checked, never re-sent.
        this.event(
          e,
          "FAULT_PROBE_PENDING",
          "Container running but readiness probe " +
            probe +
            "; awaiting timeout",
        );
        this.journal.save(e);
        return;
      }
    }
    if (!e.evidence.livePathsAtInjection && this.frame)
      e.evidence.livePathsAtInjection = this.frame.media.filter(
        (p) => p.publisher,
      ).length;
    this.transition(
      e,
      "FAULT_CONFIRMED",
      e.scenario === "hang-api"
        ? "Hang confirmed: container running and direct readiness probe timed out"
        : "Actual infrastructure fault confirmed by restricted adapter",
    );
  }
}
export const createChaosConfig = chaosConfig;
