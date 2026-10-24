import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  primaryDemoScenarios,
  primaryDemoIds,
  idleLoadObservation,
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
} from "./demo-model";
import "./demonstration.css";
const clock = (at: string | null | undefined) =>
  at ? new Date(at).toLocaleTimeString() : "Not verified";
export function Demonstration({
  components = [],
  stale = false,
  advanced,
}: {
  components?: ComponentObservation[];
  stale?: boolean;
  advanced?: ReactNode;
}) {
  const q = useChaos(),
    cache = useQueryClient(),
    { call } = useAuth();
  const [selected, setSelected] = useState("crash-api"),
    [confirmation, setConfirmation] = useState<ChaosScenario | null>(null),
    [expanded, setExpanded] = useState(false),
    [error, setError] = useState(""),
    [cancelling, setCancelling] = useState(false);
  const scenarios = primaryDemoScenarios(q.data?.scenarios || []);
  const policy = scenarios.find((s) => s.id === selected);
  const experiment =
    q.data?.experiments.find((e) => !demoTerminal(e)) || q.data?.experiments[0];
  const denial =
    scenarioDenial(policy, q.reason) ||
    (stale
      ? "Monitoring data is stale; wait for current health probes."
      : null);
  const progress = demoProgress(
    experiment,
    q.serverNow,
    denial ? null : q.data?.observedAt,
  );
  const failed =
    experiment &&
    experiment.injectedAt &&
    ["FAILED", "TIMED_OUT"].includes(experiment.state);
  const safelyRestored =
    experiment?.events.some((event) => event.kind === "BASELINE_REVERIFIED") &&
    !!experiment.evidence.terminalBaselineReverifiedAt;
  const status =
    failed && !safelyRestored
      ? "Recovery Failed"
      : progress.active
        ? "Recovering"
        : q.reason ||
            stale ||
            components.some(
              (c) =>
                c.state !== "HEALTHY" &&
                c.code !== "spare_standby" &&
                !idleLoadObservation(c),
            )
          ? "Degraded"
          : "Healthy";
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
        >
          System status: {status}
        </span>
      </header>
      <div className="demo-scenario-grid" aria-label="Four failure scenarios">
        {primaryDemoIds.map((id, index) => {
          const s = scenarios.find((s) => s.id === id);
          const reason =
            scenarioDenial(s, q.reason) ||
            (stale ? "Monitoring data is stale." : null);
          const copy = demoNames[id];
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
              <span className={reason ? "demo-unavailable" : "demo-ready"}>
                {reason ? "Blocked" : "Ready"}
              </span>
              {reason && <small>{reason}</small>}
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
          <details>
            <summary>Prerequisites and impact</summary>
            <p>{policy?.prerequisites}</p>
            <p>{policy?.failure}</p>
          </details>
        </div>
        <button
          className="chaos-inject"
          disabled={!!denial || !policy}
          onClick={() => policy && setConfirmation(policy)}
        >
          Run failure demonstration
        </button>
      </section>
      {denial && (
        <div className="demo-blocked" role={q.isError ? "alert" : "status"}>
          <strong>{denial}</strong>
          <p>Next step: {blockedNextStep(denial)}</p>
          <button onClick={() => void q.refetch()}>Refresh readiness</button>
        </div>
      )}
      <section className="demo-live" aria-label="Live recovery timeline">
        <div className="demo-section-head">
          <h2>Live recovery timeline</h2>
          <span>
            {progress.elapsedMs === null
              ? "Waiting for a confirmed fault"
              : fmt(progress.elapsedMs) + " since injection"}
          </span>
        </div>
        <p>
          Observation target: {Math.round(progress.windowMs / 1000)} seconds.
          Recovery is measured separately; slower recovery continues until
          verified or timed out.
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
            {progress.active && (
              <button disabled={cancelling} onClick={() => void cancel()}>
                {cancelling
                  ? "Requesting cancellation…"
                  : "Cancel observation / clean temporary fault"}
              </button>
            )}
            <small>
              Cancellation removes owned temporary network faults. A crashed
              service still requires the independent Healer or operator
              restoration.
            </small>
          </>
        )}
      </section>
      <section className="demo-result" aria-label="Demonstration result">
        <h2>
          {failed
            ? safelyRestored
              ? "Previous demo failed; safe baseline reverified"
              : "Recovery failed — inspect the evidence"
            : progress.stages[6]?.at
              ? "Verified demonstration result"
              : "Recovery result"}
        </h2>
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
              {experiment?.scenario === "network-timeout"
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
            Measured network baseline:{" "}
            {fmt(Number(experiment.evidence.networkBaselineMs) || null)} ·
            Restored latency:{" "}
            {fmt(Number(experiment.evidence.networkVerifiedMs) || null)} ·
            Tolerance:{" "}
            {fmt(Number(experiment.evidence.networkToleranceMs) || null)}. Fault
            expiry is cleanup, not a container restart.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
      <section className="demo-health" aria-label="Live component health">
        <h2>Live component health</h2>
        {components.length ? (
          <ul>
            {components
              .filter((c) => !["api-tier", "api-3"].includes(c.id))
              .map((c) => (
                <li key={c.id}>
                  <strong>{c.name}</strong>
                  <span>
                    {stale
                      ? "Unknown — observations stale"
                      : c.state.toLowerCase()}
                  </span>
                  <small>
                    {stale ? "Wait for fresh probes" : c.code} ·{" "}
                    {c.latencyMs == null
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
