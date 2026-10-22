import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  ComponentObservation,
  RecoveryAttempt,
  RecoveryState,
  HealingSnapshot,
} from "@streamshield/shared";
import {
  eligibility,
  selectPlaybook,
  terminal,
  backoff,
  failureCodeOf,
  playbooks,
} from "./policy.js";
import { probeFailureCode } from "../monitoring/policy.js";
import { type HealingConfig } from "./config.js";
import { Journal } from "./journal.js";
import { RecoveryStore } from "./store.js";
import { Verifier, type Frame } from "./verification.js";
import { Circuit } from "./circuit.js";
import { healingMetrics } from "./metrics.js";
import type { Lease } from "./control.js";
export class Healer {
  readonly owner = randomUUID();
  readonly metrics = healingMetrics();
  readonly circuit: Circuit;
  lease: Lease | null = null;
  observedAt: string | null = null;
  available = false;
  private lastFrame: Frame | undefined;
  private lastDependency = 0;
  private nextDatabaseRetry = 0;
  private databaseFailures = 0;
  private lastDatabaseCheck = 0;
  constructor(
    public c: HealingConfig,
    public journal: Journal,
    public store: RecoveryStore,
    public verifier: Verifier,
    private log: Logger,
  ) {
    this.circuit = new Circuit(
      c.HEALER_CIRCUIT_FAILURES,
      c.HEALER_CIRCUIT_RESET_MS,
    );
  }
  async control(path: string, body?: object) {
    const r = await fetch(process.env.CONTROL_URL + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + this.c.CONTROL_SECRET,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(this.c.HEALER_ACTION_TIMEOUT_MS + 1500),
    });
    return { ok: r.ok, status: r.status, body: await r.json() };
  }
  snapshot(): HealingSnapshot {
    const attempts = this.journal.all();
    const verified = attempts.filter((a) => a.state === "VERIFIED"),
      samples = verified
        .map((a) => Date.parse(a.finishedAt!) - Date.parse(a.detectedAt))
        .filter((n) => Number.isFinite(n) && n >= 0);
    return {
      version: 1,
      available:
        this.available &&
        !!this.lastFrame &&
        Date.now() - this.lastFrame.lastCompleted <
          Number(process.env.OBS_STALE_MS || 12000),
      enabled: this.c.enabled,
      leader: !!this.lease && this.lease.expires > Date.now(),
      observedAt: this.observedAt,
      databaseAvailable: this.store.available,
      attempts,
      counts: {
        active: attempts.filter((a) => !terminal(a)).length,
        verified: verified.length,
        escalated: attempts.filter((a) => a.state === "ESCALATED").length,
        averageRecoveryMs: samples.length
          ? samples.reduce((a, b) => a + b, 0) / samples.length
          : null,
      },
      circuit: this.circuit.snapshot(),
    };
  }
  transition(
    a: RecoveryAttempt,
    state: RecoveryState,
    reason: string,
    evidence: RecoveryAttempt["evidence"] = {},
  ) {
    a.state = state;
    a.reason = reason;
    a.evidence = { ...a.evidence, ...evidence };
    a.databasePersisted = false;
    a.events.push({ state, reason, at: new Date().toISOString() });
    if (a.events.length > 30) a.events.splice(1, 1);
    if (terminal(a)) {
      a.finishedAt = new Date().toISOString();
      this.metrics.finished(a);
    }
    this.journal.save(a, a.epoch);
    this.log.info(
      {
        attemptId: a.id,
        component: a.component,
        playbook: a.playbook,
        state,
        reason,
      },
      "Recovery transition",
    );
  }
  create(
    component: ComponentObservation,
    epoch: number,
    reason: string,
    incidentId: string | null = null,
    episode?: string,
  ) {
    const failureCode = component.id.includes("-source")
      ? null
      : failureCodeOf(component);
    const p = selectPlaybook(component.id, failureCode);
    if (!p) return;
    const now = new Date().toISOString(),
      detectedAt = component.firstFailureAt || component.confirmedAt || now;
    const a: RecoveryAttempt = {
      id: randomUUID(),
      incidentId,
      component: component.id,
      episode: episode || component.id + ":" + detectedAt,
      playbook: p.id,
      version: 1,
      actor: "streamshield-healer",
      diagnosis: p.diagnosis,
      action: p.action,
      state: "SCHEDULED",
      number: 1,
      epoch,
      createdAt: now,
      detectedAt,
      actionStartedAt: null,
      actionFinishedAt: null,
      verificationStartedAt: null,
      finishedAt: null,
      nextAt: 0,
      deadline: Date.now() + this.c.HEALER_VERIFY_MS,
      reason,
      evidence: {
        browserPlaybackVerified: false,
        failureCode: failureCode ?? null,
        consecutiveFailures: component.failures ?? null,
        observerConfirmedAt: component.confirmedAt ?? null,
      },
      events: [{ state: "SCHEDULED", at: now, reason }],
      databasePersisted: false,
    };
    if (this.journal.insert(a)) {
      this.metrics.attempts.inc({ playbook: a.playbook });
      return a;
    }
  }
  private async sync(a: RecoveryAttempt) {
    if (a.databasePersisted) return true;
    if (Date.now() < this.nextDatabaseRetry) return false;
    try {
      if (await this.store.sync(a)) {
        this.databaseFailures = 0;
        a.databasePersisted = true;
        this.journal.save(a, a.epoch);
        return true;
      }
    } catch {
      this.store.available = false;
      this.nextDatabaseRetry =
        Date.now() + backoff(++this.databaseFailures, 500);
    }
    return false;
  }
  async dependency() {
    return this.circuit.execute(async () => {
      const value = JSON.parse(
        await this.verifier.text(process.env.HEALER_DEPENDENCY_URL!),
      );
      if (value.simulated !== true || value.status !== "available")
        throw new Error("invalid_dependency");
      return {
        status: "available",
        simulated: true,
        feature: "recommendation-demo",
        recommendations: value.recommendations,
      };
    });
  }
  private async sources(frame: Frame) {
    if (
      !this.store.available ||
      !frame.mediaAvailable ||
      !["relay", "origin-primary", "origin-standby"].every(
        (id) => frame.components.find((x) => x.id === id)?.state === "HEALTHY",
      )
    )
      return;
    let expected: string[];
    try {
      expected = (
        await this.store.db.query(
          "SELECT media_path FROM healing_expected_sources LIMIT 100",
        )
      ).rows.map((r) => r.media_path);
    } catch {
      return;
    }
    if (process.env.ENABLE_LEGACY_STREAM === "true")
      expected.push(process.env.MEDIA_STREAM_PATH!);
    const now = Date.now(),
      seen = new Set(frame.media.filter((p) => p.publisher).map((p) => p.path));
    for (const path of seen)
      this.journal.source(path, { path, lastSeen: now, missingAt: null });
    for (const source of this.journal.sources()) {
      if (seen.has(source.path) || !expected.includes(source.path)) continue;
      source.missingAt ||= now;
      this.journal.source(source.path, source);
      if (now - source.missingAt < this.c.HEALER_SOURCE_GRACE_MS) continue;
      // Corroborate the absent publisher; a stale observer list alone is insufficient.
      if ((await this.verifier.paths()).includes(source.path)) continue;
      const at = new Date(source.missingAt).toISOString();
      const c = {
        id: "publisher-source",
        firstFailureAt: at,
        confirmedAt: at,
      } as ComponentObservation;
      const a = this.create(
        c,
        this.lease!.epoch,
        "broadcaster_offline_cannot_recreate_source",
        randomUUID(),
        "publisher-source:" + source.path + ":" + at,
      );
      if (a)
        this.transition(a, "ESCALATED", "broadcaster_reconnection_required", {
          sourcePath: source.path,
          sourceRecreatedByHealer: false,
        });
    }
  }
  async tick() {
    try {
      const r = await this.control("/v1/lease", { owner: this.owner });
      this.lease = r.ok ? r.body : null;
    } catch {
      this.lease = null;
      this.available = false;
      return;
    }
    if (!this.lease) {
      this.available = false;
      return;
    }
    if (
      Date.now() >= this.nextDatabaseRetry &&
      Date.now() - this.lastDatabaseCheck > 5000
    ) {
      this.lastDatabaseCheck = Date.now();
      try {
        await this.store.check();
        this.databaseFailures = 0;
      } catch {
        this.store.available = false;
        this.nextDatabaseRetry =
          Date.now() + backoff(++this.databaseFailures, 500);
      }
    }
    let frame: Frame;
    try {
      frame = await this.verifier.frame();
      this.lastFrame = frame;
      this.observedAt = new Date().toISOString();
      this.available = true;
    } catch {
      this.available = false;
      return;
    }
    if (Date.now() - this.lastDependency >= this.c.HEALER_INTERVAL_MS * 2) {
      this.lastDependency = Date.now();
      await this.dependency().catch(() => {});
    }
    for (const component of frame.components) {
      if (
        !component.confirmedAt ||
        !component.firstFailureAt ||
        !["UNHEALTHY", "DEGRADED"].includes(component.state) ||
        !selectPlaybook(component.id)
      )
        continue;
      const decision = eligibility(component, frame.components, this.c);
      const a = this.create(component, this.lease.epoch, decision.reason);
      if (a && component.id === "postgres")
        this.transition(
          a,
          "ESCALATED",
          "database_storage_review_required_no_automatic_action",
        );
      else if (
        a &&
        [
          "policy_disabled",
          "service_not_allowed",
          "authority_or_dependency_symptom",
          "unresponsive_without_restart_playbook",
        ].includes(decision.reason)
      )
        this.transition(a, "ESCALATED", decision.reason);
    }
    if (this.c.enabled) await this.sources(frame).catch(() => {});
    const rows = this.journal.work();
    for (const a of rows) {
      if (
        a.epoch !== this.lease.epoch &&
        !this.journal.adopt(a, this.lease.epoch)
      )
        continue;
      await this.sync(a);
      if (
        a.component === "postgres" &&
        a.state === "ESCALATED" &&
        this.store.available &&
        frame.components.find((c) => c.id === "postgres")?.state === "HEALTHY"
      ) {
        this.transition(
          a,
          "VERIFIED",
          "external_database_restoration_independently_verified",
          {
            actionOrigin: "external_operator",
            automatedDatabaseAction: false,
            databaseReadWriteVerified: true,
          },
        );
      }
      if (
        a.state === "ESCALATED" &&
        [
          "authority_or_dependency_symptom",
          "component_returned_without_healer_action",
          "policy_disabled",
          "service_not_allowed",
        ].includes(a.reason) &&
        frame.components.find((c) => c.id === a.component)?.state === "HEALTHY"
      ) {
        try {
          const result = await this.verifyAttempt(a, frame);
          if (result.ok)
            this.transition(
              a,
              "VERIFIED",
              "dependency_returned_without_component_restart",
              {
                ...result.evidence,
                actionOrigin: "dependency_restoration",
                componentRestarted: false,
              },
            );
        } catch {
          /* Independent verification remains required. */
        }
      }
      if (a.component === "publisher-source" && a.state === "ESCALATED") {
        const path = String(a.evidence.sourcePath);
        if (frame.media.some((p) => p.path === path && p.publisher)) {
          try {
            const result = await this.verifier.hls("origin-primary", [path]);
            if (result.ok)
              this.transition(
                a,
                "VERIFIED",
                "authorized_broadcaster_reconnected",
                { sourceRecreatedByHealer: false, freshMediaVerified: true },
              );
          } catch {
            /* Source remains unresolved. */
          }
        }
      }
    }
    // One staged operation per cycle. Dependency-suppressed work cannot starve roots.
    for (const a of this.journal
      .work()
      .filter((a) => !terminal(a))
      .sort(
        (a, b) =>
          Number(a.component.startsWith("api")) -
          Number(b.component.startsWith("api")),
      )) {
      if (await this.advance(a, frame)) break;
    }
    const snapshot = this.snapshot();
    this.metrics.active.set(snapshot.counts.active);
    this.metrics.circuit.set(
      snapshot.circuit.state === "CLOSED"
        ? 0
        : snapshot.circuit.state === "OPEN"
          ? 1
          : 2,
    );
    this.metrics.rejected.set(snapshot.circuit.rejected);
    this.journal.prune();
  }
  private async advance(a: RecoveryAttempt, frame: Frame) {
    if (!this.lease || a.epoch !== this.lease.epoch) return false;
    if (a.state === "RETRY_WAIT") {
      if (Date.now() < a.nextAt) return false;
      this.transition(a, "VERIFYING", "bounded_verification_retry");
    }
    if (a.state === "SCHEDULED") {
      const c = frame.components.find((x) => x.id === a.component);
      if (!c) return false;
      if (c.state === "HEALTHY") {
        a.verificationStartedAt = new Date().toISOString();
        a.deadline = Date.now() + this.c.HEALER_VERIFY_MS;
        this.transition(a, "VERIFYING", "component_returned_before_action", {
          actionOrigin: "external_return_without_healer_action",
          actionPerformed: false,
        });
        return true;
      }
      const eligible = eligibility(
        c,
        frame.components,
        this.c,
        Date.now(),
        a.playbook,
      );
      if (!eligible.allowed) {
        if (Date.now() > a.deadline)
          this.transition(
            a,
            "ESCALATED",
            "eligibility_deadline:" + eligible.reason,
          );
        return false;
      }
      if (
        a.component === "origin-primary" &&
        !(await this.verifier.standbySafe().catch(() => false))
      ) {
        if (Date.now() > a.deadline)
          this.transition(a, "ESCALATED", "standby_media_unverified");
        return false;
      }
      if (!(await this.sync(a))) {
        if (Date.now() > a.deadline)
          this.transition(a, "ESCALATED", "audit_database_unavailable");
        return false;
      }
      if (a.action !== "safe_read_retry") await this.containerEvidence(a);
      if (a.action === "restart_unresponsive_service") {
        // The Healer's own direct probe must also time out before any restart.
        const outcome = await this.corroborate(a);
        a.evidence.corroboration = outcome;
        if (outcome === "answered") {
          a.verificationStartedAt = new Date().toISOString();
          a.deadline = Date.now() + this.c.HEALER_VERIFY_MS;
          this.transition(
            a,
            "VERIFYING",
            "corroborating_probe_answered_no_restart",
            { actionOrigin: "none", actionPerformed: false },
          );
          return true;
        }
        if (outcome === "probe_unreachable") {
          // Process is gone, not hung: the start playbook is the correct repair.
          const start = playbooks.find(
            (p) =>
              p.action === "start_stopped_service" &&
              p.services.includes(a.component),
          )!;
          a.playbook = start.id;
          a.action = start.action;
          a.diagnosis =
            start.diagnosis + " (revised: corroborating probe unreachable)";
          a.evidence.diagnosisRevised = true;
          this.transition(
            a,
            "SCHEDULED",
            "diagnosis_revised_to_start_playbook",
          );
          return true;
        }
        if (outcome !== "probe_timeout") {
          this.transition(
            a,
            "ESCALATED",
            "corroboration_contradicts_timeout:" + outcome,
          );
          return true;
        }
      }
      a.actionStartedAt = new Date().toISOString();
      this.transition(a, "EXECUTING", "allowlisted_playbook_selected");
      // Durable intent before side effect; SQLite also survives controller restart.
      if (!(await this.sync(a))) return true;
      this.metrics.actions.inc({ playbook: a.playbook });
      this.metrics.detection.observe(
        { playbook: a.playbook },
        Math.max(0, Date.now() - Date.parse(a.detectedAt)) / 1000,
      );
      if (
        a.action === "start_stopped_service" ||
        a.action === "restart_unresponsive_service"
      ) {
        try {
          const operation =
            a.action === "start_stopped_service" ? "/v1/start" : "/v1/restart";
          const r = await this.control(operation, {
            service: a.component,
            attemptId: a.id,
            owner: this.owner,
            epoch: this.lease.epoch,
          });
          if (!r.ok) {
            this.metrics.budgets.inc({
              reason: ["cooldown", "budget_exhausted"].includes(r.body.code)
                ? r.body.code
                : "authority",
            });
            this.transition(a, "ESCALATED", r.body.code || "control_rejected");
            return true;
          }
          if (r.body.state !== "ACCEPTED") {
            a.evidence.controlReceipt = r.body.code || null;
            this.transition(
              a,
              "ESCALATED",
              r.body.state === "REJECTED"
                ? "control_precondition_rejected:" + r.body.code
                : "ambiguous_or_unsafe_action_no_replay",
            );
            return true;
          }
          a.evidence.controlReceipt = r.body.code;
          a.evidence.actionOrigin = "healer_control_adapter";
          a.evidence.actionPerformed = [
            "docker_start_accepted",
            "docker_restart_accepted",
          ].includes(r.body.code);
        } catch {
          return true; /* Reconcile receipt next cycle; never repeat POST. */
        }
      } else {
        await this.dependency().catch(() => {});
        a.evidence.actionOrigin = "bounded_safe_get";
      }
      a.actionFinishedAt = new Date().toISOString();
      this.metrics.action.observe(
        { playbook: a.playbook },
        Math.max(0, Date.now() - Date.parse(a.actionStartedAt)) / 1000,
      );
      a.verificationStartedAt = new Date().toISOString();
      a.deadline = Date.now() + this.c.HEALER_VERIFY_MS;
      this.transition(a, "VERIFYING", "independent_verification_started");
      return true;
    }
    if (a.state === "EXECUTING") {
      if (
        a.action === "start_stopped_service" ||
        a.action === "restart_unresponsive_service"
      ) {
        try {
          const r = await this.control("/v1/actions/" + a.id);
          if (!r.ok || r.body.state !== "ACCEPTED") {
            this.transition(
              a,
              "ESCALATED",
              "interrupted_action_unconfirmed_no_replay",
            );
            return true;
          }
          a.evidence.controlReceipt = r.body.code;
        } catch {
          if (Date.now() > a.deadline)
            this.transition(a, "ESCALATED", "control_unavailable_after_action");
          return true;
        }
      }
      a.actionFinishedAt ||= new Date().toISOString();
      a.verificationStartedAt ||= new Date().toISOString();
      a.deadline = Date.now() + this.c.HEALER_VERIFY_MS;
      this.transition(
        a,
        "VERIFYING",
        "interrupted_attempt_reconciled_without_repeat_action",
      );
      return true;
    }
    if (a.state === "VERIFYING") {
      let result: { ok: boolean; evidence: RecoveryAttempt["evidence"] } = {
        ok: false,
        evidence: {},
      };
      try {
        result = await this.verifyAttempt(a, frame);
      } catch {
        /* Retry verification, never assume running means restored. */
      }
      if (result.ok) {
        a.evidence.stableSince ||= Date.now();
        a.evidence = { ...a.evidence, ...result.evidence };
        a.databasePersisted = false;
        if (
          Date.now() - Number(a.evidence.stableSince) >=
          this.c.HEALER_STABILITY_MS
        )
          this.transition(
            a,
            "VERIFIED",
            "independent_behavior_verified",
            result.evidence,
          );
        else this.journal.save(a, a.epoch);
      } else {
        delete a.evidence.stableSince;
        a.databasePersisted = false;
        this.journal.save(a, a.epoch);
      }
      if (a.state === "VERIFYING" && Date.now() > a.deadline) {
        if (a.number < this.c.HEALER_MAX_ATTEMPTS) {
          a.number++;
          a.nextAt = Date.now() + backoff(a.number, this.c.HEALER_BACKOFF_MS);
          a.deadline = a.nextAt + this.c.HEALER_VERIFY_MS;
          this.transition(
            a,
            "RETRY_WAIT",
            "verification_window_failed_no_repeat_start",
          );
        } else this.transition(a, "ESCALATED", "verification_budget_exhausted");
      }
      return true;
    }
    return false;
  }
  /** Read-only container facts from the adapter, recorded as diagnosis evidence. */
  private async containerEvidence(a: RecoveryAttempt) {
    try {
      const r = await this.control("/v1/inspect/" + a.component);
      if (!r.ok) return;
      a.evidence.containerState = String(r.body.state);
      a.evidence.containerExitCode =
        typeof r.body.exitCode === "number" ? r.body.exitCode : null;
      a.evidence.containerStartedAtBefore = r.body.startedAt || null;
    } catch {
      /* Evidence only; the adapter still enforces its own preconditions. */
    }
  }
  private async corroborate(a: RecoveryAttempt) {
    try {
      const r = await fetch(this.verifier.url(a.component), {
        redirect: "error",
        signal: AbortSignal.timeout(this.c.HEALER_PROBE_TIMEOUT_MS),
      });
      await r.body?.cancel();
      return r.ok ? "answered" : "http_" + r.status;
    } catch (error) {
      return probeFailureCode(error);
    }
  }
  private async verifyAttempt(a: RecoveryAttempt, frame: Frame) {
    if (a.component === "demo-dependency")
      return {
        ok:
          this.circuit.state === "CLOSED" &&
          !!this.circuit.lastSuccessAt &&
          Date.parse(this.circuit.lastSuccessAt) >= Date.parse(a.detectedAt),
        evidence: {
          circuit: this.circuit.state,
          safeReadVerified: this.circuit.state === "CLOSED",
        },
      };
    return this.verifier.verify(a, frame);
  }
}
