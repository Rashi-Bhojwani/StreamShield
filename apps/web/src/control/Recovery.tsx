import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RecoveryAttempt } from "@streamshield/shared";
import { useRecovery } from "./useRecovery";
const clock = (s: string | null) =>
  s ? new Date(s).toLocaleString() : "Not observed";
const duration = (a: string | null, b: string | null) =>
  a && b
    ? ((Date.parse(b) - Date.parse(a)) / 1000).toFixed(2) + " s"
    : "Not measured";
export function RecoverySummary() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const query = useRecovery(),
    s = query.data;
  const current =
    !!s?.available && !!s.observedAt && now - Date.parse(s.observedAt) < 12000;
  return (
    <section
      className="cc-recovery-banner"
      aria-label="Autonomous recovery status"
    >
      <div>
        <p className="cc-kicker">STREAMSHIELD HEALER</p>
        <strong>
          {!current
            ? "Controller activity unconfirmed"
            : s?.enabled
              ? "Independent recovery controller online"
              : "Automatic actions disabled"}
        </strong>
        <p>
          {current
            ? `${s?.counts.active} active · ${s?.counts.verified} verified outcomes · ${s?.counts.escalated} escalated`
            : "Durable history remains available. Live execution cannot be inferred."}
        </p>
      </div>
      <Link to="/control/recoveries">Recovery workspace ↗</Link>
    </section>
  );
}
function Attempt({ a }: { a: RecoveryAttempt }) {
  return (
    <article
      className={"cc-recovery-card cc-recovery-" + a.state.toLowerCase()}
      data-attempt={a.id}
    >
      <div className="cc-section-head">
        <div>
          <p className="cc-kicker">
            {a.playbook} / v{a.version}
          </p>
          <h3>{a.component}</h3>
        </div>
        <span className={"cc-badge cc-" + a.state.toLowerCase()}>
          {a.state.replaceAll("_", " ")}
        </span>
      </div>
      <p className="cc-recovery-reason">{a.reason.replaceAll("_", " ")}</p>
      <div className="cc-detail-facts">
        <div>
          Attempt<strong>{a.number}</strong>
        </div>
        <div>
          Mechanism<strong>{a.action.replaceAll("_", " ")}</strong>
        </div>
        <div>
          Failure → outcome
          <strong>{duration(a.detectedAt, a.finishedAt)}</strong>
        </div>
        <div>
          Audit storage
          <strong>
            {a.databasePersisted
              ? "PostgreSQL confirmed"
              : "Local journal · sync pending"}
          </strong>
        </div>
      </div>
      <div
        className="cc-recovery-track"
        aria-label="Recorded recovery lifecycle"
      >
        {[
          "SCHEDULED",
          "EXECUTING",
          "VERIFYING",
          a.state === "ESCALATED" ? "ESCALATED" : "VERIFIED",
        ].map((state) => (
          <span
            key={state}
            className={
              a.events.some((e) => e.state === state) ? "recorded" : ""
            }
          >
            {state.replaceAll("_", " ")}
          </span>
        ))}
      </div>
      <details>
        <summary>Evidence & execution timeline</summary>
        <p>Diagnosis: {a.diagnosis.replaceAll("_", " ")}</p>
        <div className="cc-detail-facts">
          <div>
            First observed<strong>{clock(a.detectedAt)}</strong>
          </div>
          <div>
            Action started<strong>{clock(a.actionStartedAt)}</strong>
          </div>
          <div>
            Action completed<strong>{clock(a.actionFinishedAt)}</strong>
          </div>
          <div>
            Verification began<strong>{clock(a.verificationStartedAt)}</strong>
          </div>
          <div>
            Terminal outcome<strong>{clock(a.finishedAt)}</strong>
          </div>
          <div>
            Action duration
            <strong>{duration(a.actionStartedAt, a.actionFinishedAt)}</strong>
          </div>
        </div>
        <ol className="cc-timeline">
          {a.events.map((e, n) => (
            <li key={n}>
              <span className="cc-timeline-dot" />
              <div>
                <strong>{e.state.replaceAll("_", " ")}</strong>
                <time>{clock(e.at)}</time>
                <p>{e.reason.replaceAll("_", " ")}</p>
              </div>
            </li>
          ))}
        </ol>
        <pre className="cc-recovery-evidence">
          {JSON.stringify(a.evidence, null, 2)}
        </pre>
        <p className="cc-note">
          Actor: {a.actor} · {a.id}
        </p>
      </details>
      {a.incidentId ? (
        <Link
          className="cc-recovery-incident"
          to={"/control/incidents/" + a.incidentId}
        >
          Correlated incident ↗
        </Link>
      ) : (
        <p className="cc-note">
          Incident correlation pending database reconciliation.
        </p>
      )}
    </article>
  );
}
export function Recoveries({
  incidentId,
  component,
}: {
  incidentId?: string;
  component?: string;
}) {
  const q = useRecovery(),
    [filter, setFilter] = useState("all");
  const s = q.data,
    rows = (s?.attempts || []).filter(
      (a) =>
        (!incidentId || a.incidentId === incidentId) &&
        (!component || a.component === component) &&
        (filter === "all" || filter === "active"
          ? !["VERIFIED", "ESCALATED"].includes(a.state) || filter === "all"
          : a.state === filter),
    );
  return (
    <section aria-label="Recovery evidence">
      <div className="cc-section-head">
        <div>
          <p className="cc-kicker">
            DETERMINISTIC ACTIONS / INDEPENDENT VERIFICATION
          </p>
          <h2>
            {incidentId || component
              ? "Correlated recovery attempts"
              : "Autonomous recovery"}
          </h2>
        </div>
        <label>
          Outcome{" "}
          <select
            aria-label="Recovery outcome"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All outcomes</option>
            <option value="active">Active</option>
            <option value="VERIFIED">Verified</option>
            <option value="ESCALATED">Escalated</option>
          </select>
        </label>
      </div>
      {!incidentId && !component && (
        <>
          <div className="cc-stat-grid cc-recovery-stats">
            {[
              ["Active attempts", s?.counts.active],
              ["Verified outcomes", s?.counts.verified],
              ["Escalated", s?.counts.escalated],
              [
                "Mean verified episode",
                s?.counts.averageRecoveryMs == null
                  ? "—"
                  : (s.counts.averageRecoveryMs / 1000).toFixed(2) + " s",
              ],
            ].map(([label, value]) => (
              <article key={String(label)}>
                <span>{label}</span>
                <strong>{value ?? "—"}</strong>
                <small>Most recent 100 retained episodes</small>
              </article>
            ))}
          </div>
          <div className="cc-panel cc-circuit">
            <div>
              <p className="cc-kicker">SIMULATED READ-ONLY DEPENDENCY</p>
              <h3>Recommendation circuit</h3>
              <p>
                No payment operations. Failure returns an explicit unavailable
                fallback.
              </p>
            </div>
            <div>
              <span className="cc-badge">
                {s?.available ? s.circuit.state : "UNKNOWN"}
              </span>
              <p>
                {s?.circuit.requests ?? "—"} actual requests ·{" "}
                {s?.circuit.rejected ?? "—"} rejected
              </p>
            </div>
          </div>
        </>
      )}
      {q.isError ? (
        <p role="alert">Recovery audit unavailable.</p>
      ) : q.isPending ? (
        <p>Loading recovery audit…</p>
      ) : !rows.length ? (
        <div className="cc-empty">
          No recorded recovery attempts match this view.
        </div>
      ) : (
        <div className="cc-recovery-list">
          {rows.map((a) => (
            <Attempt a={a} key={a.id} />
          ))}
        </div>
      )}
      <p className="cc-note">
        Infrastructure verification and decoded viewer playback are separate.
        Source reconnection is external broadcaster activity. No live activity
        is inferred from a retained timestamp.
      </p>
    </section>
  );
}
