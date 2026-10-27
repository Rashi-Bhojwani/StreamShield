import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  primaryDemoScenarios,
  liveDemoIds,
  idleLoadObservation,
  observationFreshness,
  type ChaosScenario,
  type ComponentObservation,
} from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import { useChaos } from "./useChaos";
import { Confirmation } from "./Confirmation";
import { scenarioDenial } from "./chaos-readiness";
import { fmt } from "./evidence";
import {
  blockedNextStep,
  demoNames,
  demoProgress,
  demoTerminal,
  scenarioPresentationState,
  systemPresentationState,
  recoveryVerified,
  definitelyNoFaultInjected,
  faultMayHaveBeenInjected,
} from "./demo-model";
import "./demonstration.css";
const clock = (at: string | null | undefined) =>
  at ? new Date(at).toLocaleTimeString() : "Not verified";
const viewerImpact: Record<string, string> = {
  "crash-api":
    "Watch for API failover and chat reconnects. Video can keep playing through the independent delivery path.",
  "crash-video-gateway":
    "Watch the live player: playback can freeze or buffer until fresh video segments return.",
  "crash-edge":
    "Watch delivery switch to the backup edge. Continuous playback is successful failover, not a failed experiment.",
  "network-timeout":
    "Watch Discover next in Studio or the watch page: recommendations reconnect while live video stays independent.",
  "media-authority-loss":
    "New video requests on both routes fail with HTTP 503. Buffered video eventually stops. The player cannot recover until an operator restores the simulated external authorization.",
};
export function Demonstration({
  components = [],
  stale = false,
  advanced,
  crashOnly = false,
}: {
  components?: ComponentObservation[];
  stale?: boolean;
  advanced?: ReactNode;
  crashOnly?: boolean;
}) {
  const q = useChaos(),
    cache = useQueryClient(),
    { call } = useAuth();
  const [selected, setSelected] = useState("crash-api"),
    [confirmation, setConfirmation] = useState<ChaosScenario | null>(null),
    [expanded, setExpanded] = useState(false),
    [error, setError] = useState(""),
    [cancelling, setCancelling] = useState(false),
    [restoreConfirmation, setRestoreConfirmation] = useState(""),
    [restoring, setRestoring] = useState(false);
  const scenarios = primaryDemoScenarios(q.data?.scenarios || []);
  const policy = scenarios.find((s) => s.id === selected);
  const experiment =
    q.data?.experiments.find((e) => !demoTerminal(e)) ||
    q.data?.experiments.find(
      (e) =>
        !crashOnly || ["crash-api", "crash-video-gateway"].includes(e.scenario),
    );
  const functional = q.data?.crashBaseline;
  const currentHealth = q.data?.componentHealth ?? components;
  const observationFresh =
    !!q.data?.available &&
    !q.isError &&
    observationFreshness(
      q.data.observedAt,
      q.serverNow,
      q.data.staleAfterMs,
    ) === "fresh";
  const functionalDenial =
    crashOnly &&
    (!functional ||
      observationFreshness(
        functional.observedAt,
        q.serverNow,
        q.data?.staleAfterMs,
      ) !== "fresh" ||
      !functional.api ||
      !functional.gateway)
      ? functional?.reason ||
        "BLOCKED: independent API and gateway streaming baseline is not verified. Keep a live source running and wait for fresh functional checks."
      : null;
  const healthFresh =
    observationFresh &&
    (q.data?.componentHealth
      ? q.data.componentHealth.every(
          (component) =>
            observationFreshness(
              component.observedAt,
              q.serverNow,
              q.data?.staleAfterMs,
            ) === "fresh",
        )
      : !stale);
  function cardState(id: (typeof liveDemoIds)[number]) {
    const s = scenarios.find((scenario) => scenario.id === id);
    const targetIds = [
      ...(s?.targets || []),
      ...(id === "crash-edge" ? ["edge-2"] : []),
    ];
    const healthy =
      targetIds.length > 0 &&
      targetIds.every((target) =>
        currentHealth.some(
          (component) =>
            component.id === target && component.state === "HEALTHY",
        ),
      );
    return scenarioPresentationState(
      q.data?.experiments.find((e) => e.scenario === id),
      healthy,
      healthFresh &&
        targetIds.every((id) => currentHealth.some((c) => c.id === id)),
    );
  }
  const denial =
    (experiment?.state === "AWAITING_OPERATOR"
      ? "Human action required. Restore the simulated external media authorization below before running another failure."
      : scenarioDenial(policy, q.reason)) ||
    functionalDenial ||
    (!healthFresh
      ? "Monitoring data is stale; wait for current health probes."
      : null);
  const progress = demoProgress(
    experiment,
    q.serverNow,
    denial ? null : q.data?.observedAt,
  );
  const failed =
    experiment &&
    faultMayHaveBeenInjected(experiment) &&
    ["FAILED", "TIMED_OUT"].includes(experiment.state);
  const safelyRestored =
    experiment?.events.some((event) => event.kind === "BASELINE_REVERIFIED") &&
    !!experiment.evidence.terminalBaselineReverifiedAt;
  const status = systemPresentationState(
    liveDemoIds.map(cardState),
    currentHealth.length > 0 &&
      currentHealth.every(
        (c) =>
          c.state === "HEALTHY" ||
          c.code === "spare_standby" ||
          idleLoadObservation(c),
      ),
    healthFresh,
  );
  const noFaultInjected = definitelyNoFaultInjected(experiment);
  async function restoreMedia() {
    if (!experiment || restoring || restoreConfirmation !== "media-authority")
      return;
    setRestoring(true);
    setError("");
    try {
      await call(
        "/monitoring/chaos/experiments/" +
          experiment.id +
          "/restore-media-authority",
        {
          method: "POST",
          body: JSON.stringify({ confirmation: restoreConfirmation }),
        },
      );
      setRestoreConfirmation("");
      await cache.invalidateQueries({ queryKey: ["monitoring", "chaos"] });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Operator restoration request failed. Check the logs before retrying.",
      );
    } finally {
      setRestoring(false);
    }
  }
  async function cancel() {
    if (!experiment || cancelling) return;
    setCancelling(true);
    setError("");
    try {
      await call("/monitoring/chaos/experiments/" + experiment.id + "/cancel", {
        method: "POST",
      });
      await cache.invalidateQueries({ queryKey: ["monitoring", "chaos"] });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Cancellation could not be confirmed. Keep monitoring the experiment.",
      );
    } finally {
      setCancelling(false);
    }
  }
  return (
    <section
      className="simple-demo chaos-workspace"
      aria-label="Self-healing demonstration"
    >
      <header className="demo-heading">
        <div>
          <p className="cc-kicker">STREAMSHIELD · LIVE RECOVERY</p>
          <h1>Watch the system recover.</h1>
          <p>
            Choose one controlled failure. Follow the evidence from detection to
            verified recovery.
          </p>
        </div>
        <span
          className={
            "demo-system status-" + status.toLowerCase().replaceAll(" ", "-")
          }
          role="status"
          data-testid="demo-system-health"
        >
          {crashOnly && status === "Healthy"
            ? "SYSTEM HEALTHY"
            : "Service health: " + status}
        </span>
      </header>
      {crashOnly && (
        <p>
          Only API and video gateway crashes are offered here. Keep OBS/Studio
          or the labelled generated sample source running before starting.
        </p>
      )}
      <div
        className={"demo-scenario-grid" + (crashOnly ? " crash-only" : "")}
        aria-label={
          crashOnly ? "Two crash scenarios" : "Five failure scenarios"
        }
      >
        {(crashOnly
          ? (["crash-api", "crash-video-gateway"] as const)
          : liveDemoIds
        ).map((id, index) => {
          const s = scenarios.find((s) => s.id === id);
          const reason =
            scenarioDenial(s, q.reason) ||
            functionalDenial ||
            (!healthFresh ? "Monitoring data is stale." : null);
          const copy = demoNames[id];
          const scenarioResult = q.data?.experiments.find(
            (e) => e.scenario === id,
          );
          // A cooldown blocks another injection; it does not make a recovered
          // service unhealthy. Current health and admission are separate facts.
          const scenarioStatus = cardState(id);
          const note =
            reason ||
            (definitelyNoFaultInjected(scenarioResult)
              ? "Last request ended before a fault was injected."
              : recoveryVerified(scenarioResult)
                ? "Recovery independently verified; current service health shown above."
                : "Health comes from current service checks. Demo readiness is checked separately.");
          if (crashOnly)
            return (
              <article
                key={id}
                data-scenario={id}
                className={
                  "demo-choice demo-crash-choice" +
                  (selected === id ? " selected" : "")
                }
              >
                <span className="demo-number">0{index + 1}</span>
                <strong>{copy[0]}</strong>
                <span>{copy[1]}</span>
                <span className={reason ? "demo-unavailable" : "demo-ready"}>
                  {reason ? "BLOCKED" : "Ready"}
                </span>
                {reason && <small>{reason}</small>}
                <button
                  className="chaos-inject"
                  disabled={!!reason || !s}
                  onClick={() => {
                    if (s) {
                      setSelected(id);
                      setConfirmation(s);
                    }
                  }}
                >
                  {id === "crash-api"
                    ? "Simulate API Crash"
                    : "Simulate Video Gateway Crash"}
                </button>
              </article>
            );
          return (
            <button
              type="button"
              key={id}
              data-scenario={id}
              aria-pressed={selected === id}
              className={"demo-choice" + (selected === id ? " selected" : "")}
              onClick={() => setSelected(id)}
            >
              <span className="demo-number">0{index + 1}</span>
              <strong>{copy[0]}</strong>
              <span>{copy[1]}</span>
              <span
                data-testid={"scenario-health-" + id}
                data-health={scenarioStatus}
                className={
                  scenarioStatus === "HEALTHY"
                    ? "demo-ready"
                    : "demo-unavailable"
                }
              >
                {scenarioStatus}
              </span>
              <small className="demo-card-note" title={note}>
                {note}
              </small>
            </button>
          );
        })}
      </div>
      {q.isPending && (
        <p role="status">Loading authenticated scenario readiness…</p>
      )}
      <section className="demo-action" aria-label="Selected demonstration">
        <div>
          <h2>{policy?.name || "Select a scenario"}</h2>
          <p>{policy?.recovery}</p>
          <p className="demo-viewer-impact">
            <strong>On the live screen:</strong> {viewerImpact[selected]}
          </p>
          <p className="demo-confirm-hint">
            The button opens a confirmation. A fault starts only after you
            acknowledge its impact, enter the target and choose Inject
            controlled failure.
          </p>
          <details>
            <summary>Prerequisites and impact</summary>
            <p>{policy?.prerequisites}</p>
            <p>{policy?.failure}</p>
          </details>
        </div>
        {!crashOnly && (
          <button
            className="chaos-inject"
            disabled={!!denial || !policy}
            onClick={() => policy && setConfirmation(policy)}
          >
            Run failure demonstration
          </button>
        )}
      </section>
      <div
        className={
          "demo-blocked demo-readiness" + (denial ? "" : " demo-admitted")
        }
        role={q.isError ? "alert" : "status"}
        data-testid="demo-readiness"
        data-ready={!denial}
      >
        <strong>
          {denial
            ? "Demo waiting: " + denial
            : "Ready to run a controlled failure"}
        </strong>
        <p>
          {denial
            ? "Next step: " + blockedNextStep(denial)
            : "Service health and permission to inject a failure are separate. Cooldowns and functional checks can block another demo while services stay healthy."}
        </p>
        <button onClick={() => void q.refetch()}>Refresh readiness</button>
      </div>
      <ol
        className="demo-cycle"
        aria-label="Failure and recovery sequence"
        data-testid="demo-recovery-cycle"
      >
        {[
          [
            "Healthy baseline",
            experiment?.evidence.baselineObservedAt ?? progress.stages[0]?.at,
          ],
          ["Failure confirmed", experiment?.faultConfirmedAt],
          [
            experiment?.scenario === "media-authority-loss"
              ? "Human action required"
              : "Recovering",
            experiment?.actionStartedAt ||
              experiment?.events.find((e) =>
                ["CIRCUIT_OPEN", "HUMAN_ACTION_REQUIRED"].includes(e.kind),
              )?.at,
          ],
          [
            "Healthy · verified",
            recoveryVerified(experiment) ? experiment?.verifiedAt : null,
          ],
        ].map(([label, at]) => (
          <li
            key={String(label)}
            data-confirmed={typeof at === "string"}
            className={typeof at === "string" ? "confirmed" : "pending"}
          >
            <strong>{String(label)}</strong>
            <time>{clock(typeof at === "string" ? at : null)}</time>
          </li>
        ))}
      </ol>
      <section className="demo-live" aria-label="Live recovery timeline">
        {experiment?.scenario === "media-authority-loss" &&
          experiment.injectedAt &&
          !demoTerminal(experiment) && (
            <section
              className="demo-operator"
              aria-label="Manual recovery requirement"
              data-testid="manual-recovery"
            >
              <p className="cc-kicker">AUTOMATIC RECOVERY NOT POSSIBLE</p>
              <h2>
                {experiment.evidence.operatorRestoredAt
                  ? "Human restoration is being verified"
                  : "Human action required"}
              </h2>
              <p>
                A restart cannot recreate a lost private signing key or grant
                privileged access to an external key vault. Real recovery needs
                the original backup or an authorized signing-service
                administrator.
              </p>
              <p>
                This disposable demo simulates that missing authority by
                blocking actual video requests. It does not destroy a real key.
                The explicit reset below represents the operator restoring that
                external prerequisite.
              </p>
              {!experiment.evidence.operatorResetRequestedAt ? (
                <>
                  <label>
                    Type media-authority to authorize the demo reset
                    <input
                      aria-label="Confirm manual media restoration"
                      value={restoreConfirmation}
                      onChange={(e) => setRestoreConfirmation(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <button
                    className="chaos-inject"
                    disabled={
                      restoreConfirmation !== "media-authority" ||
                      restoring ||
                      !observationFresh
                    }
                    onClick={() => void restoreMedia()}
                  >
                    {restoring
                      ? "Recording human intervention…"
                      : "Restore demo media authorization"}
                  </button>
                </>
              ) : (
                <p role="status">
                  Operator reset requested. Waiting for actual advancing video
                  verification; automatic healing is not being claimed.
                </p>
              )}
              <p>
                <Link to="/control/logs">
                  Follow the explanation in System logs →
                </Link>
              </p>
            </section>
          )}
        <div className="demo-section-head">
          <h2>Live recovery timeline</h2>
          <span>
            {progress.elapsedMs === null
              ? "Waiting for a confirmed fault"
              : fmt(progress.elapsedMs) + " since injection"}
          </span>
        </div>
        <p>
          {experiment?.scenario === "media-authority-loss" ? (
            "This scenario stays blocked until an operator restores the simulated prerequisite or stops the disposable demo. A timer never claims successful healing."
          ) : (
            <>
              Observation target: {Math.round(progress.windowMs / 1000)}{" "}
              seconds. Recovery is measured separately; slower recovery
              continues until verified or timed out.
            </>
          )}
        </p>
        <ol className="demo-steps">
          {progress.stages.map((step, i) => (
            <li
              key={step.label}
              data-stage={i}
              data-verified={!!step.at}
              className={step.at ? "verified" : "pending"}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              <div>
                <strong>{step.label}</strong>
                <time>{clock(step.at)}</time>
              </div>
            </li>
          ))}
        </ol>
        {experiment && (
          <>
            <p role="status">
              {progress.stages[5]?.at && progress.active
                ? "Recovery has been verified. Continuing real checks through the observation window."
                : experiment.reason}
            </p>
            <p className="demo-id">Experiment {experiment.id}</p>
            {progress.active &&
              experiment.scenario !== "media-authority-loss" && (
                <button disabled={cancelling} onClick={() => void cancel()}>
                  {cancelling
                    ? "Requesting cancellation…"
                    : "Cancel observation / clean temporary fault"}
                </button>
              )}
            <small>
              {experiment.scenario === "media-authority-loss"
                ? "Use the explicit operator reset above. Restarting a service does not restore external authority."
                : "Cancellation removes owned temporary network faults. A crashed service still requires the independent Healer or operator restoration."}
            </small>
          </>
        )}
      </section>
      <section className="demo-result" aria-label="Demonstration result">
        {crashOnly && failed && (
          <p role="status">
            <strong>RECOVERY FAILED</strong>: {experiment.reason}
          </p>
        )}
        {crashOnly &&
          experiment?.state === "COMPLETED" &&
          progress.stages[5]?.at &&
          experiment.evidence.independentBehaviorVerified === true && (
            <p className="demo-ready" role="status">
              {experiment.scenario === "crash-api"
                ? "API RECOVERED"
                : experiment.scenario === "crash-video-gateway"
                  ? "VIDEO GATEWAY RECOVERED"
                  : "RECOVERED"}
            </p>
          )}
        <h2>
          {noFaultInjected
            ? "No failure was injected"
            : experiment?.scenario === "media-authority-loss" &&
                experiment.state === "COMPLETED"
              ? "Human restoration verified · not automatically healed"
              : failed
                ? safelyRestored
                  ? "Previous demo failed; safe baseline reverified"
                  : "Recovery failed — inspect the evidence"
                : progress.stages[6]?.at
                  ? "Verified demonstration result"
                  : "Recovery result"}
        </h2>
        {noFaultInjected && (
          <p>
            The request ended before any fault was confirmed. The services were
            left running. Inspect the recorded reason below; this was not a
            successful crash demonstration.
          </p>
        )}
        {safelyRestored && (
          <p>
            The original outcome remains{" "}
            {experiment?.state.toLowerCase().replaceAll("_", " ")}. The
            controller independently rechecked the baseline; this does not turn
            the failed demo into successful automatic healing.
          </p>
        )}
        <dl>
          <div>
            <dt>Failure detected</dt>
            <dd>{clock(experiment?.incidentDetectedAt)}</dd>
          </div>
          <div>
            <dt>Recovery performed</dt>
            <dd>
              {experiment?.scenario === "media-authority-loss"
                ? experiment.evidence.operatorRestoredAt
                  ? "Administrator restored the simulated prerequisite; no automatic repair performed"
                  : "Cannot repair automatically: external signing authority is unavailable"
                : experiment?.scenario === "network-timeout"
                  ? experiment.cleanup === "COMPLETED"
                    ? "Owned network fault removed; safe reconnection probes"
                    : "Not verified"
                  : experiment?.actionStartedAt
                    ? String(
                        experiment.evidence.recoveryAction ||
                          "Independent Healer action started",
                      )
                    : "Not verified"}
            </dd>
          </div>
          <div>
            <dt>Independent verification</dt>
            <dd>
              {progress.stages[5]?.at
                ? clock(progress.stages[5].at)
                : "Not verified"}
            </dd>
          </div>
          <div>
            <dt>Actual recovery duration</dt>
            <dd>
              {fmt(
                progress.stages[5]?.at
                  ? experiment?.measurements.restorationMs
                  : null,
              )}
            </dd>
          </div>
          <div>
            <dt>Total demonstration duration</dt>
            <dd>{fmt(experiment?.measurements.demonstrationMs)}</dd>
          </div>
        </dl>
        {experiment?.scenario === "network-timeout" && (
          <p>
            Dependency read attempts since injection:{" "}
            {String(
              experiment.evidence.dependencyReadAttempts ?? "Not observed",
            )}{" "}
            · Circuit:{" "}
            {String(experiment.evidence.lastCircuitState ?? "Not observed")} ·{" "}
            Measured network baseline:{" "}
            {fmt(Number(experiment.evidence.networkBaselineMs) || null)} ·
            Restored latency:{" "}
            {fmt(Number(experiment.evidence.networkVerifiedMs) || null)} ·
            Tolerance:{" "}
            {fmt(Number(experiment.evidence.networkToleranceMs) || null)}. Fault
            expiry is cleanup, not a container restart.
          </p>
        )}
        {experiment?.scenario === "crash-edge" && (
          <p>
            Serving edge before failure:{" "}
            {String(experiment.evidence.edgeBefore || "Not observed")} · Backup
            serving a real live manifest:{" "}
            {String(experiment.evidence.edgeAfter || "Not verified")} · Failover
            verified:{" "}
            {clock(
              typeof experiment.evidence.edgeFailoverObservedAt === "string"
                ? experiment.evidence.edgeFailoverObservedAt
                : null,
            )}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
      {experiment && (
        <section
          className="demo-live"
          aria-label="Timestamped controller events"
        >
          <h2>Actual controller events</h2>
          <p>Current phase: {experiment.state.replaceAll("_", " ")}</p>
          <p>
            Failed probe:{" "}
            {String(
              experiment.evidence.unavailableProbe ||
                experiment.evidence.failureCode ||
                "Not observed",
            )}
          </p>
          <p>
            Healer receipt:{" "}
            {String(experiment.evidence.healerReceipt || "Not observed")}
          </p>
          <ol className="demo-event-log">
            {experiment.events.map((event, index) => (
              <li key={index}>
                <time>{clock(event.at)}</time>
                <strong>{event.kind.replaceAll("_", " ")}</strong>
                <span>{event.detail}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="demo-health" aria-label="Live component health">
        <h2>Live component health</h2>
        {currentHealth.length ? (
          <ul>
            {currentHealth
              .filter((c) => !["api-tier", "api-3"].includes(c.id))
              .map((c) => (
                <li key={c.id}>
                  <strong>
                    {components.find((component) => component.id === c.id)
                      ?.name || c.id}
                  </strong>
                  <span>
                    {!healthFresh
                      ? "Unknown — observations stale"
                      : c.state.toLowerCase()}
                  </span>
                  <small>
                    {!healthFresh ? "Wait for fresh probes" : c.code} ·{" "}
                    {!("latencyMs" in c) || c.latencyMs == null
                      ? "Latency not measured"
                      : c.latencyMs + " ms"}
                  </small>
                </li>
              ))}
          </ul>
        ) : (
          <p>
            Component observations are not available. Scenario admission is
            verified again by the server before injection.
          </p>
        )}
      </section>
      <details
        className="demo-advanced"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>Advanced telemetry, logs and configuration</summary>
        <p>
          <Link to="/control/incidents">Incident history</Link> ·{" "}
          <Link to="/control/recoveries">Recovery evidence</Link> ·{" "}
          <Link to="/control/metrics">Metrics</Link>
        </p>
        {expanded && advanced}
      </details>
      {confirmation && q.data && (
        <Confirmation
          scenario={confirmation}
          snapshot={q.data}
          onClose={() => setConfirmation(null)}
          onCreated={() =>
            void cache.invalidateQueries({ queryKey: ["monitoring", "chaos"] })
          }
        />
      )}
    </section>
  );
}
export function CrashDemonstration(props: {
  components?: ComponentObservation[];
  stale?: boolean;
}) {
  return <Demonstration {...props} crashOnly />;
}
