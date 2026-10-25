import { Demonstration } from "./Demonstration";
import { Confirmation } from "./Confirmation";
export { Confirmation } from "./Confirmation";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type {
  ChaosScenario,
  ChaosExperiment,
  PlaybackObservation,
  ComponentObservation,
} from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import { useStreams } from "../streaming/useStreams";
import { LivePlayer } from "../streaming/LivePlayer";
import "./chaos.css";
import { useChaos } from "./useChaos";
import { primaryDemoScenarios } from "@streamshield/shared";
import { scenarioDenial } from "./chaos-readiness";
const done = (s: string) =>
  ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(s);
const time = (s: string | null) =>
  s ? new Date(s).toLocaleTimeString() : "Not observed";
const ms = (n: number | null) =>
  n == null ? "—" : (n / 1000).toFixed(2) + " s";
function Status({ state }: { state: string }) {
  return (
    <span className={"chaos-status chaos-" + state.toLowerCase()}>
      {state.replaceAll("_", " ")}
    </span>
  );
}
function Experiment({
  e,
  compact = false,
}: {
  e: ChaosExperiment;
  compact?: boolean;
}) {
  const { call } = useAuth(),
    cache = useQueryClient(),
    [error, setError] = useState(""),
    [cancelling, setCancelling] = useState(false);
  async function cancel() {
    setCancelling(true);
    try {
      await call("/monitoring/chaos/experiments/" + e.id + "/cancel", {
        method: "POST",
        body: "{}",
      });
      await cache.invalidateQueries({ queryKey: ["monitoring", "chaos"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation unconfirmed");
    } finally {
      setCancelling(false);
    }
  }
  return (
    <article
      className={"chaos-experiment " + (compact ? "chaos-compact" : "")}
      data-experiment={e.id}
    >
      <header>
        <div>
          <p className="cc-kicker">
            {e.scenario} / {e.target}
          </p>
          <h3>{done(e.state) ? "Experiment result" : "Live experiment"}</h3>
        </div>
        <Status state={e.state} />
      </header>
      <p>{e.reason}</p>
      <div className="chaos-measurements">
        <div>
          Detection<strong>{ms(e.measurements.detectionMs)}</strong>
        </div>
        <div>
          Healing started<strong>{ms(e.measurements.healingStartMs)}</strong>
        </div>
        <div>
          Restoration<strong>{ms(e.measurements.restorationMs)}</strong>
        </div>
        <div>
          Action request<strong>{ms(e.measurements.actionMs)}</strong>
        </div>
      </div>
      <p className="chaos-mechanism">
        {e.mechanism ||
          (e.actionStartedAt && e.evidence.recoveryAction
            ? "Observed independent Healer action: " +
              String(e.evidence.recoveryAction).replaceAll("_", " ") +
              ". Awaiting functional verification."
            : "Awaiting observed recovery evidence. No completion is inferred.")}
      </p>
      <div className="chaos-audit-strip">
        <span>
          Cleanup: <strong>{e.cleanup.replaceAll("_", " ")}</strong>
        </span>
        <span>
          {e.databasePersisted
            ? "PostgreSQL confirmed"
            : "Local journal · sync pending"}
        </span>
      </div>
      <details open={!done(e.state)}>
        <summary>Recorded execution timeline</summary>
        <ol className="chaos-timeline">
          {[...e.events]
            .sort((a, b) => a.at.localeCompare(b.at))
            .map((event, i) => (
              <li key={i}>
                <i />
                <div>
                  <strong>{event.kind.replaceAll("_", " ")}</strong>
                  <p>{event.detail}</p>
                </div>
                <time>{time(event.at)}</time>
              </li>
            ))}
        </ol>
      </details>
      <footer>
        {e.incidentId ? (
          <Link to={"/control/incidents/" + e.incidentId}>
            Inspect correlated incident ↗
          </Link>
        ) : (
          <span>
            Incident correlation{" "}
            {e.injectedAt ? "pending" : "not yet applicable"}
          </span>
        )}
        {!done(e.state) && (
          <button
            disabled={cancelling || !!e.cancelRequestedBy}
            onClick={() => void cancel()}
          >
            {e.cancelRequestedBy
              ? "Cancellation requested"
              : cancelling
                ? "Requesting…"
                : "Cancel observation / clean owned fault"}
          </button>
        )}
      </footer>
      {error && <p role="alert">{error}</p>}
      <small className="chaos-id">
        Experiment {e.id} · Initiator {e.actor} · Started{" "}
        {new Date(e.createdAt).toLocaleString()} · Finished{" "}
        {e.finishedAt ? new Date(e.finishedAt).toLocaleString() : "In progress"}
      </small>
    </article>
  );
}
function ScenarioCard({
  s,
  live,
  launch,
  index,
  reason,
}: {
  reason: string | null;
  s: ChaosScenario;
  live: boolean;
  launch: (s: ChaosScenario) => void;
  index: number;
}) {
  return (
    <article
      className={"chaos-scenario " + (!s.supported ? "chaos-disabled" : "")}
      data-scenario={s.id}
    >
      <div className="chaos-card-top">
        <span className="chaos-card-symbol" aria-hidden="true">
          {["API", "REDIS", "VIDEO", "NET", "LOAD"][index]}
        </span>
        <span className={"chaos-risk chaos-risk-" + s.risk}>
          {s.risk} disruption
        </span>
      </div>
      <p className="cc-kicker">TARGET / {s.target}</p>
      <h2>{s.name}</h2>
      <p>{s.failure}</p>
      <div className="chaos-card-recovery">
        <strong>
          {s.kind === "resilience"
            ? "Controlled cleanup / reconnection"
            : "Independent recovery"}
        </strong>
        <p>{s.recovery}</p>
      </div>
      <p className="chaos-prerequisites">{s.prerequisites}</p>
      <div className="chaos-card-bottom">
        <span className={s.available && live ? "chaos-ready" : ""}>
          {s.available && live
            ? "● Ready for admission"
            : s.supported
              ? "○ Prerequisites required"
              : "○ Not enabled"}
        </span>
        <button
          className="chaos-launch"
          disabled={!s.available || !live}
          onClick={() => launch(s)}
        >
          Configure experiment <span aria-hidden="true">↗</span>
        </button>
      </div>
      {(s.reason || !live) && (
        <small className="chaos-denial">
          {scenarioDenial(s, reason) || "Controller status unconfirmed."}
        </small>
      )}
    </article>
  );
}
export function CompactChaos() {
  const q = useChaos(),
    cache = useQueryClient(),
    [chosen, setChosen] = useState("crash-api"),
    [selection, setSelection] = useState<ChaosScenario | null>(null);
  const policy = q.data?.scenarios.find((s) => s.id === chosen),
    experiment =
      q.data?.experiments.find((e) => e.id === q.data?.activeId) ||
      q.data?.experiments[0];
  return (
    <section className="capacity-panel chaos-workspace">
      <p className="cc-kicker">CONTROLLED FAILURE / INDEPENDENT RECOVERY</p>
      <h2>Introduce a real failure</h2>
      <p>
        Confirm the exact target. The independent Healer detects and repairs;
        this panel never restores a service.
      </p>
      <label>
        Failure scenario
        <select
          aria-label="Presentation failure scenario"
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
        >
          {primaryDemoScenarios(q.data?.scenarios || []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {q.reason && (
        <p role="status" className="chaos-denial">
          {q.reason}
        </p>
      )}
      <p>{policy?.failure}</p>
      {policy && (
        <p className="chaos-prerequisites">
          Prerequisites: {policy.prerequisites} Recovery: {policy.recovery}
        </p>
      )}
      <button
        className="chaos-inject"
        disabled={!q.live || !policy?.available}
        onClick={() => policy && setSelection(policy)}
      >
        Configure selected failure
      </button>
      {scenarioDenial(policy, q.reason) && (
        <p className="chaos-denial">{scenarioDenial(policy, q.reason)}</p>
      )}
      {!q.live && (
        <p className="chaos-denial">
          Current local controller admission is unconfirmed.
        </p>
      )}
      {experiment ? (
        <Experiment e={experiment} compact />
      ) : (
        <p className="capacity-empty">
          The actual timeline appears after an experiment is admitted.
        </p>
      )}
      {selection && q.data && (
        <Confirmation
          scenario={selection}
          snapshot={q.data}
          onClose={() => setSelection(null)}
          onCreated={() =>
            void cache.invalidateQueries({ queryKey: ["monitoring"] })
          }
        />
      )}
      <Link className="text-link" to="/control/chaos">
        All scenarios and experiment history ↗
      </Link>
    </section>
  );
}
function AdvancedChaosLab() {
  const q = useChaos(),
    cache = useQueryClient(),
    [selection, setSelection] = useState<ChaosScenario | null>(null),
    [filter, setFilter] = useState("all");
  const active = q.data?.experiments.find((e) => !done(e.state));
  const complete =
    q.data?.experiments.filter((e) => e.state === "COMPLETED").length || 0;
  return (
    <div className="chaos-workspace">
      <div className="chaos-page-head">
        <div>
          <p className="cc-kicker">STREAMSHIELD / CONTROLLED RESILIENCE</p>
          <h1>Chaos Laboratory</h1>
          <p>
            Introduce a real failure. Follow the evidence from detection to
            verified restoration.
          </p>
        </div>
        <Link className="chaos-demo-link" to="/control/demo">
          Open live demonstration ↗
        </Link>
      </div>
      <div className="chaos-policy">
        <span
          className={
            "chaos-policy-dot " + (q.live && q.data?.enabled ? "ready" : "")
          }
        />
        <div>
          <strong>
            {q.live && q.data?.enabled
              ? "Local chaos environment enabled"
              : "Chaos injection unavailable"}
          </strong>
          <p>
            {q.live
              ? "Administrator authorization · one concurrent experiment · independent Healer"
              : q.reason}
          </p>
        </div>
        <span className="chaos-policy-tag">LOCAL DEVELOPMENT</span>
      </div>
      <div className="chaos-facts">
        <div>
          <span>Supported scenarios</span>
          <strong>
            {primaryDemoScenarios(q.data?.scenarios || []).length}
            <small>Real infrastructure faults</small>
          </strong>
        </div>
        <div>
          <span>Verified experiments</span>
          <strong>
            {complete}
            <small>In latest retained history</small>
          </strong>
        </div>
        <div>
          <span>Network fault duration</span>
          <strong>
            {q.data?.faultDurationMs
              ? Math.round(q.data.faultDurationMs / 1000) + " s"
              : "—"}
            <small>Independent bounded cleanup</small>
          </strong>
        </div>
        <div>
          <span>Execution model</span>
          <strong>
            1 at a time<small>Durable admission guard</small>
          </strong>
        </div>
      </div>
      {q.reason && (
        <p role="status" className="chaos-denial">
          {q.reason}
        </p>
      )}
      {active && (
        <section aria-label="Current experiment">
          <Experiment e={active} />
        </section>
      )}
      <div className="cc-section-head">
        <div>
          <p className="cc-kicker">CHOOSE A FAILURE BOUNDARY</p>
          <h2>Experiment catalog</h2>
        </div>
        <span className="cc-unit">Exact-target confirmation required</span>
      </div>
      {q.isError ? (
        <p role="alert">{q.reason}</p>
      ) : q.isPending ? (
        <p>Loading authenticated experiment policy…</p>
      ) : (
        <div className="chaos-scenarios">
          {primaryDemoScenarios(q.data?.scenarios || []).map((s, i) => (
            <ScenarioCard
              key={s.id}
              s={s}
              index={i}
              reason={q.reason}
              live={q.live}
              launch={setSelection}
            />
          ))}
        </div>
      )}
      <section className="chaos-history">
        <div className="cc-section-head">
          <div>
            <p className="cc-kicker">DURABLE EVIDENCE / LATEST 100</p>
            <h2>Experiment history</h2>
          </div>
          <label>
            Outcome{" "}
            <select
              aria-label="Experiment outcome"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All outcomes</option>
              <option value="COMPLETED">Completed</option>
              <option value="FAILED">Failed</option>
              <option value="TIMED_OUT">Timed out</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </label>
        </div>
        <div className="chaos-history-list">
          {q.data?.experiments
            .filter(
              (e) => done(e.state) && (filter === "all" || e.state === filter),
            )
            .map((e) => (
              <Experiment key={e.id} e={e} />
            ))}
          {!q.data?.experiments.some((e) => done(e.state)) && (
            <p className="cc-empty">
              No completed experiments. History appears only after actual
              execution.
            </p>
          )}
        </div>
      </section>
      <p className="cc-note">
        A completed experiment does not make every component healthy. Inspect
        current topology. Routing continuity, timed cleanup, client reconnection
        and Healer service repair are separate mechanisms.
      </p>
      {selection && q.data && (
        <Confirmation
          scenario={selection}
          snapshot={q.data}
          onClose={() => setSelection(null)}
          onCreated={() =>
            void cache.invalidateQueries({ queryKey: ["monitoring"] })
          }
        />
      )}
    </div>
  );
}
function AdvancedChaosDemo({
  components,
  stale,
  topology,
}: {
  components: ComponentObservation[];
  stale: boolean;
  topology: ReactNode;
}) {
  const q = useChaos(),
    streams = useStreams(),
    cache = useQueryClient();
  const [chosen, setChosen] = useState(""),
    [scenario, setScenario] = useState("crash-api"),
    [selection, setSelection] = useState<ChaosScenario | null>(null),
    [observation, setObservation] = useState<PlaybackObservation | null>(null);
  const rows = streams.data?.streams || [],
    stream =
      rows.find((s) => s.id === chosen) ||
      rows.find((s) => s.status === "live"),
    policy = q.data?.scenarios.find((s) => s.id === scenario),
    experiment =
      q.data?.experiments.find((e) => !done(e.state)) || q.data?.experiments[0];
  return (
    <div className="chaos-workspace chaos-demo">
      <div className="chaos-page-head">
        <div>
          <p className="cc-kicker">
            STREAMSHIELD / LIVE RESILIENCE DEMONSTRATION
          </p>
          <h1>Watch the system respond.</h1>
          <p>
            Genuine live video. Controlled infrastructure faults. Independently
            verified recovery.
          </p>
        </div>
        <Link to="/control/chaos" className="chaos-demo-link">
          Chaos Laboratory ↗
        </Link>
      </div>
      <div className="chaos-demo-grid">
        <section
          className="chaos-demo-video"
          aria-label="Live demonstration player"
        >
          <div className="chaos-player-heading">
            <span className="cc-kicker">LIVE SIGNAL</span>
            <select
              aria-label="Demonstration stream"
              value={stream?.id || ""}
              onChange={(e) => {
                setChosen(e.target.value);
                setObservation(null);
              }}
            >
              <option value="">Select a live source</option>
              {rows.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} · {s.status}
                </option>
              ))}
            </select>
          </div>
          {stream?.status === "live" ? (
            <LivePlayer
              key={stream.id}
              source={stream.playbackUrl}
              alternateSources={stream.playbackSources}
              sourceId={stream.id}
              onObservation={setObservation}
            />
          ) : (
            <div className="chaos-no-source">
              <span aria-hidden="true">▷</span>
              <h2>Start a real live source</h2>
              <p>
                Publish from OBS using Studio’s server/key, or run{" "}
                <code>npm run broadcast:test</code> in your terminal.
              </p>
              <Link to="/studio">Open broadcaster Studio ↗</Link>
            </div>
          )}
          <div className="chaos-player-details">
            <h2>{stream?.title || "No live broadcaster"}</h2>
            <p>
              {stream?.channelName ||
                "Live source required for the demonstration"}
            </p>
            <div className="chaos-playback-facts">
              <div>
                Observed source
                <strong>
                  {observation?.event.deliverySource || "Not observed"}
                </strong>
              </div>
              <div>
                Startup
                <strong>{ms(observation?.metrics.startupMs ?? null)}</strong>
              </div>
              <div>
                Observed stalls
                <strong>
                  {observation ? observation.metrics.stallCount : "—"}
                </strong>
              </div>
              <div>
                Stall duration
                <strong>
                  {ms(observation?.metrics.stallDurationMs ?? null)}
                </strong>
              </div>
            </div>
            <p className="cc-note">
              Serving edge is not exposed by the player. Source selection is
              observed separately from server restoration; these are local
              browser measurements.
            </p>
          </div>
        </section>
        <aside className="chaos-demo-console">
          <p className="cc-kicker">CONTROLLED FAULT / REAL RESPONSE</p>
          <h2>Run an experiment</h2>
          <label>
            Failure scenario
            <select
              aria-label="Demo failure scenario"
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
            >
              {primaryDemoScenarios(q.data?.scenarios || []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <p>{policy?.failure}</p>
          {policy && (
            <p className="chaos-prerequisites">
              Prerequisites: {policy.prerequisites} Recovery: {policy.recovery}
            </p>
          )}
          <button
            className="chaos-inject"
            disabled={!q.live || !policy?.available}
            onClick={() => policy && setSelection(policy)}
          >
            Configure selected failure
          </button>
          {scenarioDenial(policy, q.reason) && (
            <p className="chaos-denial">{scenarioDenial(policy, q.reason)}</p>
          )}
          {experiment ? (
            <Experiment e={experiment} compact />
          ) : (
            <div className="chaos-demo-empty">
              The execution timeline appears after a real experiment is
              admitted.
            </div>
          )}
          <div
            className="chaos-live-services"
            aria-label="Current service health"
          >
            {components
              .filter((c) =>
                [
                  "api-1",
                  "api-2",
                  "edge-1",
                  "edge-2",
                  "origin-primary",
                  "origin-standby",
                  "redis",
                  "demo-dependency",
                ].includes(c.id),
              )
              .map((c) => (
                <Link key={c.id} to={"/control/services/" + c.id}>
                  <span>{c.id}</span>
                  <Status state={stale ? "UNKNOWN" : c.state} />
                </Link>
              ))}
          </div>
          <p className="cc-note">
            Health comes from the independent observer. Ending an experiment
            never paints a service green.
          </p>
        </aside>
      </div>
      {topology}
      {selection && q.data && (
        <Confirmation
          scenario={selection}
          snapshot={q.data}
          onClose={() => setSelection(null)}
          onCreated={() =>
            void cache.invalidateQueries({ queryKey: ["monitoring"] })
          }
        />
      )}
    </div>
  );
}

export function ChaosLab(
  props: { components?: ComponentObservation[]; stale?: boolean } = {},
) {
  return <Demonstration {...props} advanced={<AdvancedChaosLab />} />;
}
export function ChaosDemo(props: {
  components: ComponentObservation[];
  stale: boolean;
  topology: ReactNode;
}) {
  return (
    <Demonstration {...props} advanced={<AdvancedChaosDemo {...props} />} />
  );
}
