import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ChaosExperiment,
  ChaosScenario,
  ComponentObservation,
  PlaybackObservation,
  RecoveryAttempt,
} from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import { Chat } from "../platform/Chat";
import { HealthChip } from "../proof/HealthChip";
import { tones, type HealthTone } from "../proof/health";
import { getTelemetry, useTelemetry } from "../proof/telemetry";
import { LivePlayer, type DeliveryHealth } from "../streaming/LivePlayer";
import { useStreams } from "../streaming/useStreams";
import { Confirmation } from "./Chaos";
import {
  attemptsFor,
  experimentOverlay,
  fmt,
  stages,
  terminalExperiment,
} from "./evidence";
import { TopologyGraph } from "./TopologyGraph";
import { useChaos } from "./useChaos";
import { useRecovery } from "./useRecovery";
import { useTimeline, type TimelineData } from "./useEvidence";
import "./presentation.css";

const clock = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleTimeString([], { hour12: false }) : "—";
/** Overall health band: one strip of real segments with event markers. */
export function HealthBand({
  data,
  label = "Overall system health",
}: {
  data: TimelineData | undefined;
  label?: string;
}) {
  if (!data)
    return <div className="health-band is-empty">Loading health history…</div>;
  const from = Date.parse(data.from),
    span = Date.parse(data.to) - from || 1;
  const pos = (s: string) => ((Date.parse(s) - from) / span) * 100;
  return (
    <div className="health-band-wrap">
      <div className="band-head">
        <strong>{label}</strong>
        <span>
          {clock(data.from)} – {clock(data.to)}
        </span>
      </div>
      <div className="health-band" role="img" aria-label={label}>
        {data.overall.map((s) => (
          <span
            key={s.from}
            className={"band-seg tone-" + s.tone}
            style={{
              left: pos(s.from) + "%",
              width: pos(s.to) - pos(s.from) + "%",
            }}
            title={`${tones[s.tone].label} ${clock(s.from)}–${clock(s.to)} (${fmt(s.durationMs)})`}
            data-tone={s.tone}
          />
        ))}
        {data.events.map((e) => (
          <span
            key={e.kind + e.at + e.component}
            className={"band-marker kind-" + e.kind}
            style={{ left: pos(e.at) + "%" }}
            title={`${e.label} at ${clock(e.at)}`}
          >
            {e.kind === "injected" ? "ϟ" : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
/** Live API-tier load from the observer's real Prometheus-derived metrics. */
function LoadMeter({
  tier,
  spare,
  active,
}: {
  tier: ComponentObservation | undefined;
  spare: ComponentObservation | undefined;
  active: ChaosExperiment | undefined;
}) {
  if (!tier) return null;
  const m = tier.metrics;
  const users =
    active?.scenario === "traffic-surge"
      ? Number(active.evidence.simulatedUsers || 0)
      : 0;
  const overloaded = tier.code === "overloaded";
  return (
    <div
      className={"load-meter" + (overloaded ? " is-overloaded" : "")}
      data-testid="load-meter"
    >
      <span>
        Simulated users <strong>{users || "—"}</strong>
      </span>
      <span>
        Requests/s <strong>{m ? m.rps : "—"}</strong>
      </span>
      <span>
        p95 latency <strong>{m ? m.p95Ms + " ms" : "—"}</strong>
      </span>
      <span>
        5xx <strong>{m ? m.errorPct + " %" : "—"}</strong>
      </span>
      <span title="Rate-limit refusals: load shedding, separate from healing">
        Load shedding (429/s) <strong>{m ? m.limitedRps : "—"}</strong>
      </span>
      <span>
        Spare API-3{" "}
        <strong>
          {spare?.code === "spare_standby"
            ? "stopped"
            : spare?.state === "HEALTHY"
              ? "serving"
              : (spare?.state.toLowerCase() ?? "—")}
        </strong>
      </span>
    </div>
  );
}
export function StageTimeline({
  experiment,
  attempts,
}: {
  experiment: ChaosExperiment;
  attempts: RecoveryAttempt[];
}) {
  const rows = stages(experiment, attempts);
  return (
    <ol className="stage-timeline" aria-label="Recovery stages">
      {rows.map((s) => (
        <li
          key={s.id}
          className={(s.at ? "lit tone-" + s.tone : "dark") + " stage-" + s.id}
          data-stage={s.id}
          data-lit={!!s.at}
        >
          <span className="stage-label">{s.label}</span>
          <span className="stage-time">{s.at ? clock(s.at) : "waiting"}</span>
          <span className="stage-elapsed">
            {s.elapsedMs !== null && s.id !== "healthy"
              ? (s.elapsedMs >= 0 ? "+" : "") + fmt(s.elapsedMs)
              : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}
interface BrowserEvidence {
  stallCount: number;
  stallMs: number;
  maxStallMs: number;
  chatDisconnects: number;
  chatReconnects: number;
  requestFailures: number;
  maxRequestLatencyMs: number;
  outageMs: number;
  edgeSwitches: number;
  samples: number;
}
const zero = (): BrowserEvidence => ({
  stallCount: 0,
  stallMs: 0,
  maxStallMs: 0,
  chatDisconnects: 0,
  chatReconnects: 0,
  requestFailures: 0,
  maxRequestLatencyMs: 0,
  outageMs: 0,
  edgeSwitches: 0,
  samples: 0,
});
/**
 * Browser-observed measurements during the active experiment, attached once
 * to that experiment (owner-only, CSRF-protected, bounded numbers only).
 */
function useBrowserEvidence(active: ChaosExperiment | undefined) {
  const { call } = useAuth();
  const current = useRef<{ id: string; data: BrowserEvidence } | null>(null);
  const baseline = useRef<{ stalls: number; stallMs: number; failed: number }>({
    stalls: 0,
    stallMs: 0,
    failed: 0,
  });
  const playback = useRef<PlaybackObservation | null>(null);
  const lastChat = useRef("Connecting");
  const lastEdge = useRef<string | null>(null);
  const outage = useRef<number | null>(null);
  const sent = useRef(new Set<string>());
  const [view, setView] = useState<BrowserEvidence | null>(null);
  const [posted, setPosted] = useState<string | null>(null);
  const id = active?.id,
    finished = active ? terminalExperiment(active.state) : false;
  useEffect(() => {
    if (!id || sent.current.has(id)) return;
    if (current.current?.id !== id) {
      current.current = { id, data: zero() };
      baseline.current = {
        stalls: playback.current?.metrics.stallCount ?? 0,
        stallMs: playback.current?.metrics.stallDurationMs ?? 0,
        failed: getTelemetry().failed,
      };
    }
  }, [id]);
  useEffect(() => {
    const t = setInterval(() => {
      const c = current.current;
      if (!c || sent.current.has(c.id)) return;
      const tel = getTelemetry();
      const p = playback.current?.metrics;
      c.data.samples++;
      if (p) {
        c.data.stallCount = Math.max(0, p.stallCount - baseline.current.stalls);
        c.data.stallMs = Math.max(
          0,
          Math.round(p.stallDurationMs - baseline.current.stallMs),
        );
      }
      c.data.requestFailures = Math.max(
        0,
        tel.failed - baseline.current.failed,
      );
      c.data.maxRequestLatencyMs = Math.max(
        c.data.maxRequestLatencyMs,
        tel.latencyMs ?? 0,
      );
      if (tel.outageSince) outage.current ??= Date.now();
      else if (outage.current) {
        c.data.outageMs += Date.now() - outage.current;
        outage.current = null;
      }
      setView({ ...c.data });
    }, 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const c = current.current;
    if (!finished || !c || c.id !== id || sent.current.has(c.id)) return;
    sent.current.add(c.id);
    if (outage.current) {
      c.data.outageMs += Date.now() - outage.current;
      outage.current = null;
    }
    void call("/monitoring/chaos/experiments/" + c.id + "/evidence", {
      method: "POST",
      body: JSON.stringify(c.data),
    })
      .then(() => setPosted(c.id))
      .catch(() => setPosted(null));
  }, [finished, id, call]);
  return {
    view,
    posted,
    onPlayback: useCallback((o: PlaybackObservation) => {
      playback.current = o;
      const c = current.current;
      if (c && o.metrics.stallDurationMs - baseline.current.stallMs > 0)
        c.data.maxStallMs = Math.max(
          c.data.maxStallMs,
          Math.round(o.metrics.stallDurationMs - baseline.current.stallMs),
        );
    }, []),
    onHealth: useCallback((h: DeliveryHealth) => {
      const c = current.current;
      if (h.edge && lastEdge.current && h.edge !== lastEdge.current && c)
        c.data.edgeSwitches++;
      lastEdge.current = h.edge;
      if (c && h.lastStallMs)
        c.data.maxStallMs = Math.max(c.data.maxStallMs, h.lastStallMs);
    }, []),
    onChat: useCallback((s: string) => {
      const c = current.current;
      const was = lastChat.current;
      lastChat.current = s;
      if (!c) return;
      if (was === "Connected" && s !== "Connected") c.data.chatDisconnects++;
      if (was !== "Connected" && s === "Connected" && c.data.chatDisconnects)
        c.data.chatReconnects++;
    }, []),
  };
}
function Tiles({
  e,
  attempts,
  components,
  browser,
}: {
  e: ChaosExperiment;
  attempts: RecoveryAttempt[];
  components: ComponentObservation[];
  browser: BrowserEvidence | null;
}) {
  const own = attemptsFor(e, attempts);
  const peer =
    e.target === "api-1" ? "api-2" : e.target === "api-2" ? "api-1" : null;
  const peerState = peer ? components.find((c) => c.id === peer)?.state : null;
  const tiles: [string, string, string?][] = [
    ["Time to detect", fmt(e.measurements.detectionMs)],
    ["Time to act", fmt(e.measurements.healingStartMs)],
    ["Action duration", fmt(e.measurements.actionMs)],
    ["Time to verified restore", fmt(e.measurements.restorationMs)],
    [
      "Healer attempts",
      own.length
        ? own.map((a) => a.component + " #" + a.number).join(", ")
        : "Not observed",
    ],
    [
      "Receipts",
      own.length
        ? own.map((a) => String(a.evidence.controlReceipt ?? "none")).join(", ")
        : "Not observed",
    ],
    [
      "Surviving peer",
      peer ? peer + " · " + (peerState || "unknown") : "No redundant peer",
    ],
    [
      "Player stalls",
      browser
        ? `${browser.stallCount} · ${fmt(browser.stallMs)}`
        : "Not measured",
      "browser-observed",
    ],
    [
      "Chat disconnect / reconnect",
      browser
        ? `${browser.chatDisconnects} / ${browser.chatReconnects}`
        : "Not measured",
      "browser-observed",
    ],
    [
      "Request failures · max latency",
      browser
        ? `${browser.requestFailures} · ${fmt(browser.maxRequestLatencyMs)}`
        : "Not measured",
      "browser-observed",
    ],
  ];
  return (
    <div className="metric-tiles">
      {tiles.map(([label, value, note]) => (
        <article key={label} data-tile={label}>
          <span>{label}</span>
          <strong>{value}</strong>
          {note && <small>{note}</small>}
        </article>
      ))}
    </div>
  );
}
function ScenarioButton({
  s,
  onPick,
}: {
  s: ChaosScenario;
  onPick: (s: ChaosScenario) => void;
}) {
  return (
    <button
      className={"scenario-button kind-" + s.kind}
      disabled={!s.available}
      onClick={() => onPick(s)}
      data-scenario={s.id}
    >
      <strong>{s.name}</strong>
      <span className="scenario-target">
        Target <code>{s.target}</code>
      </span>
      <span>{s.audienceSees}</span>
      <span className="scenario-cause">
        Real-world cause: {s.realWorldCause}
      </span>
      {!s.available && s.reason && (
        <span className="scenario-denied">{s.reason}</span>
      )}
    </button>
  );
}
export function Presentation({
  components,
  stale,
}: {
  components: ComponentObservation[];
  stale: boolean;
}) {
  const chaos = useChaos(),
    recovery = useRecovery(),
    streams = useStreams(),
    band = useTimeline(10 * 60000);
  const telemetry = useTelemetry();
  const [chosen, setChosen] = useState(""),
    [selection, setSelection] = useState<ChaosScenario | null>(null),
    [focus, setFocus] = useState<string | null>(null);
  const live = (streams.data?.streams || []).filter((s) => s.status === "live");
  const stream = live.find((s) => s.id === chosen) || live[0];
  const container = useRef<HTMLElement>(null);
  const attempts = recovery.data?.attempts || [];
  const experiments = chaos.data?.experiments || [];
  const active = experiments.find((e) => !terminalExperiment(e.state));
  const shown =
    active || experiments.find((e) => e.id === focus) || experiments[0];
  const evidence = useBrowserEvidence(active);
  const overall: HealthTone = stale
    ? "unknown"
    : (band.data?.overall.at(-1)?.tone ?? "unknown");
  const scenarios = chaos.data?.scenarios || [];
  return (
    <div className={"presentation tone-" + overall} data-overall={overall}>
      <header className="presentation-head">
        <div>
          <p className="cc-kicker">
            STREAMSHIELD / LIVE SELF-HEALING DEMONSTRATION
          </p>
          <h1>Break it. Watch it heal.</h1>
          <p>
            Real video, real faults, and a Healer that is never told the cause —
            only the symptoms it observes.
          </p>
        </div>
        <div className="presentation-pill" data-testid="overall-pill">
          <HealthChip tone={overall} />
          <Link to="/control/presentation/report">Recovery report ↗</Link>
        </div>
      </header>
      <div className="presentation-grid">
        <section
          className="presentation-video"
          ref={container}
          aria-label="Live video"
        >
          <div className="panel-head">
            <span className="cc-kicker">LIVE SIGNAL</span>
            <select
              aria-label="Presentation stream"
              value={stream?.id || ""}
              onChange={(e) => setChosen(e.target.value)}
            >
              {live.length === 0 && <option value="">No live source</option>}
              {live.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} · {s.channelName}
                </option>
              ))}
            </select>
          </div>
          {stream ? (
            <>
              <LivePlayer
                key={stream.id}
                source={stream.playbackUrl}
                alternateSources={stream.playbackSources}
                sourceId={stream.id}
                showHealth
                onObservation={evidence.onPlayback}
                onHealth={evidence.onHealth}
              />
              <p className="video-caption">
                {stream.title} · {stream.channelName}
              </p>
              <div className="mini-chat">
                <Chat
                  streamId={stream.id}
                  playerContainer={container}
                  onStatus={evidence.onChat}
                />
              </div>
            </>
          ) : (
            <div className="no-source" data-testid="no-live-source">
              <h2>No live source yet</h2>
              <ol>
                <li>
                  Sign in as the broadcaster, open{" "}
                  <Link to="/studio">Studio</Link>, create a livestream and
                  press <em>Go live</em> with the camera, or paste the
                  server/key into OBS.
                </li>
                <li>
                  Or, in a terminal: <code>npm run final:demo</code> (a bounded
                  10-minute test pattern).
                </li>
              </ol>
            </div>
          )}
        </section>
        <section className="presentation-topology" aria-label="Topology">
          <TopologyGraph
            components={components}
            attempts={attempts}
            stale={stale}
            overlay={experimentOverlay(active, attempts)}
            healerAvailable={recovery.data?.available}
          />
          <HealthBand data={band.data} label="Last 10 minutes" />
          <LoadMeter
            tier={components.find((c) => c.id === "api-tier")}
            spare={components.find((c) => c.id === "api-3")}
            active={active}
          />
          <p className="served-line">
            This browser: served by <strong>{telemetry.servedBy || "—"}</strong>
            {telemetry.latencyMs !== null && ` · ${telemetry.latencyMs} ms`}
          </p>
        </section>
        <aside className="presentation-console" aria-label="Experiment console">
          <h2>Healer scenarios</h2>
          {!chaos.live && (
            <p className="cc-note">
              Chaos controller unavailable or stale: buttons stay disabled.
            </p>
          )}
          {scenarios
            .filter((s) => s.kind === "healer")
            .map((s) => (
              <ScenarioButton key={s.id} s={s} onPick={setSelection} />
            ))}
          <h3>
            Resilience experiments — timed fault cleanup, not Healer repair
          </h3>
          {scenarios
            .filter((s) => s.kind === "resilience")
            .map((s) => (
              <ScenarioButton key={s.id} s={s} onPick={setSelection} />
            ))}
          <h3>Disabled</h3>
          {scenarios
            .filter((s) => s.kind === "disabled")
            .map((s) => (
              <div key={s.id} className="scenario-disabled">
                <strong>{s.name}</strong>
                <span>{s.reason}</span>
              </div>
            ))}
        </aside>
      </div>
      {shown ? (
        <section className="presentation-experiment" aria-label="Experiment">
          <div className="panel-head">
            <div>
              <span className="cc-kicker">
                {active ? "ACTIVE EXPERIMENT" : "LAST EXPERIMENT"}
              </span>
              <h2>
                {scenarios.find((s) => s.id === shown.scenario)?.name ||
                  shown.scenario}
              </h2>
              <p className="cc-note">
                {String(shown.evidence.diagnosis || "Awaiting diagnosis")}
                {shown.evidence.failureCode
                  ? " · failure code " + shown.evidence.failureCode
                  : ""}
              </p>
            </div>
            <div className="experiment-state" data-testid="experiment-state">
              <HealthChip
                tone={
                  shown.state === "COMPLETED"
                    ? "recovered"
                    : terminalExperiment(shown.state)
                      ? "failed"
                      : shown.actionStartedAt
                        ? "healing"
                        : "failed"
                }
                label={shown.state.replaceAll("_", " ")}
              />
              {terminalExperiment(shown.state) && (
                <Link to={"/control/analysis/" + shown.id}>
                  View analysis ↗
                </Link>
              )}
            </div>
          </div>
          <StageTimeline experiment={shown} attempts={attempts} />
          <Tiles
            e={shown}
            attempts={attempts}
            components={components}
            browser={shown.id === active?.id || !active ? evidence.view : null}
          />
          {evidence.posted === shown.id && (
            <p className="cc-note">
              Browser-observed measurements attached to this experiment.
            </p>
          )}
        </section>
      ) : (
        <section className="presentation-experiment">
          <h2>No experiment yet</h2>
          <p className="cc-note">
            Pick a Healer scenario. Stages light up only when their real
            timestamps exist.
          </p>
        </section>
      )}
      <section className="presentation-report" aria-label="Recent recoveries">
        <div className="panel-head">
          <h2>Recovery history</h2>
          <Link to="/control/presentation/report">Printable report ↗</Link>
        </div>
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Scenario</th>
              <th>Outcome</th>
              <th>Detect</th>
              <th>Act</th>
              <th>Restore</th>
            </tr>
          </thead>
          <tbody>
            {experiments.slice(0, 8).map((e) => (
              <tr key={e.id} onClick={() => setFocus(e.id)}>
                <td>{clock(e.createdAt)}</td>
                <td>{e.scenario}</td>
                <td>{e.state}</td>
                <td>{fmt(e.measurements.detectionMs)}</td>
                <td>{fmt(e.measurements.healingStartMs)}</td>
                <td>{fmt(e.measurements.restorationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {selection && chaos.data && (
        <Confirmation
          scenario={selection}
          snapshot={chaos.data}
          onClose={() => setSelection(null)}
          onCreated={(id) => setFocus(id)}
        />
      )}
    </div>
  );
}
