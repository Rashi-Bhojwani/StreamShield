import { useEffect, useRef, useState } from "react";
import {
  parseChaosSnapshot,
  type ChaosSnapshot,
  type ChaosScenario,
  type ChaosExperiment,
} from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import { RequestError } from "../platform/request";
import { chaosReadiness, scenarioDenial } from "./chaos-readiness";
export function Confirmation({
  scenario,
  snapshot,
  onClose,
  onCreated,
}: {
  scenario: ChaosScenario;
  snapshot: ChaosSnapshot;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    identity = useRef(crypto.randomUUID()),
    inFlight = useRef(false),
    { call } = useAuth();
  const [target, setTarget] = useState(""),
    [ack, setAck] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  async function inject() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const latest = parseChaosSnapshot(
        await call<unknown>("/monitoring/chaos"),
      );
      const denial = scenarioDenial(
        latest.scenarios.find((s) => s.id === scenario.id),
        chaosReadiness(latest),
      );
      if (denial) throw new Error(denial);
      let result: ChaosExperiment | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          result = await call<ChaosExperiment>(
            "/monitoring/chaos/experiments",
            {
              method: "POST",
              body: JSON.stringify({
                id: identity.current,
                scenario: scenario.id,
                confirmation: target,
              }),
            },
          );
          break;
        } catch (e) {
          if ((e instanceof RequestError && e.status < 500) || attempt === 1)
            throw e;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (result) {
        onCreated(result.id);
        onClose();
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Injection response unavailable. Reconcile experiment history before retrying.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="chaos-dialog"
      aria-labelledby="chaos-confirm-title"
      onCancel={(e) => {
        if (pending) e.preventDefault();
        else onClose();
      }}
    >
      <div className="chaos-dialog-head">
        <span className="cc-kicker">RESTRICTED LOCAL EXPERIMENT</span>
        <button
          aria-label="Close confirmation"
          disabled={pending}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <h2 id="chaos-confirm-title">Confirm controlled failure</h2>
      <p className="chaos-target-name">
        {scenario.name} <code>{scenario.target}</code>
      </p>
      <p>{scenario.failure}</p>
      {scenario.audienceSees && (
        <p>
          <strong>What the audience will see:</strong> {scenario.audienceSees}
        </p>
      )}
      {scenario.realWorldCause && (
        <p className="chaos-cause">
          <strong>Real-world cause:</strong> {scenario.realWorldCause}{" "}
          {scenario.kind === "manual"
            ? "This demo simulates the unavailable prerequisite; no real private key is destroyed."
            : "The demo injects the same end state on purpose; the Healer is never told the cause."}
        </p>
      )}
      <dl className="chaos-confirm-facts">
        <div>
          <dt>Expected recovery</dt>
          <dd>{scenario.recovery}</dd>
        </div>
        <div>
          <dt>Safety deadline</dt>
          <dd>
            {scenario.kind === "manual"
              ? "No timed automatic repair. The gate stays blocked until an authorized operator resets this simulation or stops the disposable demo."
              : `${Math.round(snapshot.timeoutMs / 1000)} seconds; an unresolved experiment times out.`}
          </dd>
        </div>
        <div>
          <dt>Temporary network fault</dt>
          <dd>
            {scenario.kind === "manual"
              ? "Manual restoration is required. A restart, cancellation or timer cannot recreate external signing authority."
              : scenario.id === "network-timeout" ||
                  scenario.id === "external-api"
                ? Math.round(snapshot.faultDurationMs / 1000) +
                  " seconds; owned fault removal is cleanup."
                : "A crash cannot be undone by cancellation. The independent Healer must repair it."}
          </dd>
        </div>
      </dl>
      <p className="chaos-warning">
        Active users may be affected. Recovery can fail or escalate. This does
        not delete application data or volumes.
      </p>
      <label className="chaos-check">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        I understand this can disrupt active users.
      </label>
      <label className="chaos-target-input">
        Type <strong>{scenario.target}</strong> to confirm the exact target
        <input
          aria-label="Confirm target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {error && (
        <p role="alert" className="chaos-warning">
          {error}
        </p>
      )}
      <div className="chaos-dialog-actions">
        <button onClick={onClose} disabled={pending}>
          Keep infrastructure unchanged
        </button>
        <button
          className="chaos-inject"
          disabled={!ack || target !== scenario.target || pending}
          onClick={() => void inject()}
        >
          {pending ? "Recording experiment…" : "Inject controlled failure"}
        </button>
      </div>
    </dialog>
  );
}
