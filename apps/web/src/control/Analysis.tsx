import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ChaosExperiment, ChaosScenario } from "@streamshield/shared";
import { HealthChip } from "../proof/HealthChip";
import { tones } from "../proof/health";
import { attemptsFor, fmt, terminalExperiment } from "./evidence";
import { HealthBand, StageTimeline } from "./Presentation";
import { useChaos } from "./useChaos";
import { useRecovery } from "./useRecovery";
import {
  useImpact,
  useTimeline,
  useTimelineRange,
  windowAverage,
  type ImpactData,
  type TimelineData,
  type TimelineSegment,
} from "./useEvidence";
import "./presentation.css";

const clock = (s: string | number | null | undefined) =>
  s == null ? "—" : new Date(s).toLocaleTimeString([], { hour12: false });
const spans = { "15 min": 15 * 60000, "1 h": 3600000, "6 h": 6 * 3600000 };
const pct = (from: number, span: number, at: string | number) =>
  ((new Date(at).getTime() - from) / span) * 100;
function Lane({
  id,
  segments,
  from,
  span,
}: {
  id: string;
  segments: TimelineSegment[];
  from: number;
  span: number;
}) {
  return (
    <div className="lane" data-component={id}>
      <span className="lane-name">{id}</span>
      <div className="lane-track">
        {segments.map((s) => {
          const left = pct(from, span, s.from),
            width = pct(from, span, s.to) - left;
          const body = (
            <span
              className={"lane-seg tone-" + s.tone}
              style={{ left: left + "%", width: Math.max(width, 0.15) + "%" }}
              data-tone={s.tone}
              data-from={s.from}
              data-to={s.to}
              data-duration={s.durationMs}
              title={`${tones[s.tone].label} · ${clock(s.from)}–${clock(s.to)} · ${fmt(s.durationMs)}${s.code ? " · " + s.code : ""}`}
            />
          );
          return s.attemptId ? (
            <Link key={s.from} to={"/control/recoveries"} className="lane-link">
              {body}
            </Link>
          ) : (
            <span key={s.from}>{body}</span>
          );
        })}
      </div>
    </div>
  );
}
/** One impact chart with failure/healing/degraded phases shaded behind it. */
function ImpactChart({
  series,
  timeline,
  from,
  to,
}: {
  series: ImpactData["series"][number];
  timeline: TimelineData | undefined;
  from: number;
  to: number;
}) {
  const span = to - from || 1;
  const pts = series.points;
  const max = Math.max(...pts.map((p) => p[1]), 0.001);
  const x = (ms: number) => ((ms - from) / span) * 600;
  const line = pts
    .map(
      ([at, v]) =>
        `${x(at * 1000).toFixed(1)},${(120 - (v / max) * 105).toFixed(1)}`,
    )
    .join(" ");
  const last = pts.at(-1)?.[1];
  return (
    <article className="impact-chart" data-series={series.id}>
      <div className="impact-head">
        <h3>{series.label}</h3>
        <span>
          {last == null
            ? "No samples"
            : last.toLocaleString(undefined, { maximumFractionDigits: 2 }) +
              " " +
              series.unit}
        </span>
      </div>
      <svg
        viewBox="0 0 600 130"
        preserveAspectRatio="none"
        role="img"
        aria-label={series.label + " with failure and healing phases shaded"}
      >
        {timeline?.overall
          .filter((s) =>
            ["failed", "healing", "degraded", "escalated"].includes(s.tone),
          )
          .map((s) => (
            <rect
              key={s.from}
              x={x(Date.parse(s.from))}
              width={Math.max(1, x(Date.parse(s.to)) - x(Date.parse(s.from)))}
              y="0"
              height="130"
              className={"phase-shade tone-" + s.tone}
              data-tone={s.tone}
              data-from={s.from}
              data-to={s.to}
            />
          ))}
        <path d="M0 15H600M0 67H600M0 120H600" className="cc-gridline" />
        {pts.length > 1 && <polyline points={line} className="impact-line" />}
        {timeline?.events.map((e) => (
          <line
            key={e.kind + e.at}
            x1={x(Date.parse(e.at))}
            x2={x(Date.parse(e.at))}
            y1="0"
            y2="130"
            className={"event-line kind-" + e.kind}
          />
        ))}
      </svg>
      {pts.length < 2 && (
        <p className="cc-note">Not enough collected samples in this window.</p>
      )}
      <div className="cc-axis">
        <span>{clock(from)}</span>
        <span>{clock(to)}</span>
      </div>
    </article>
  );
}
function Scorecard({
  experiments,
  scenarios,
  timeline,
}: {
  experiments: ChaosExperiment[];
  scenarios: ChaosScenario[];
  timeline: TimelineData | undefined;
}) {
  const rows = scenarios
    .filter((s) => s.kind !== "disabled")
    .map((s) => {
      const runs = experiments.filter(
        (e) => e.scenario === s.id && terminalExperiment(e.state),
      );
      const ok = runs.filter((e) => e.state === "COMPLETED");
      const values = (k: "detectionMs" | "restorationMs") =>
        ok
          .map((e) => e.measurements[k])
          .filter((v): v is number => v != null)
          .sort((a, b) => a - b);
      const stat = (v: number[]) =>
        v.length
          ? `${fmt(v[Math.floor(v.length / 2)]!)} (${fmt(v[0]!)}–${fmt(v.at(-1)!)})`
          : "—";
      const impact = ok.reduce(
        (n, e) => n + (e.measurements.restorationMs ?? 0),
        0,
      );
      return {
        s,
        runs,
        ok,
        detect: values("detectionMs"),
        restore: values("restorationMs"),
        stat,
        impact,
      };
    })
    .filter((r) => r.runs.length);
  const availability = (timeline?.components || []).map((c) => {
    let up = 0,
      known = 0;
    for (const s of c.segments) {
      if (s.tone === "unknown") continue;
      known += s.durationMs;
      if (s.tone === "healthy" || s.tone === "recovered") up += s.durationMs;
    }
    return { id: c.id, value: known ? (100 * up) / known : null };
  });
  return (
    <section className="cc-panel scorecard" aria-label="Scorecard">
      <h2>Scorecard across all runs</h2>
      {rows.length ? (
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th>Runs</th>
              <th>Verified restorations</th>
              <th>Escalated / failed</th>
              <th>Detect median (min–max)</th>
              <th>Restore median (min–max)</th>
              <th>Total impact</th>
              <th>Recovery trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.s.id} data-scenario={r.s.id}>
                <td>{r.s.name}</td>
                <td>{r.runs.length}</td>
                <td>
                  {r.ok.length}
                  {r.s.kind === "manual" && " · human intervention"}
                </td>
                <td>{r.runs.length - r.ok.length}</td>
                <td>{r.stat(r.detect)}</td>
                <td>{r.stat(r.restore)}</td>
                <td>{fmt(r.impact)}</td>
                <td>
                  <svg
                    viewBox="0 0 100 24"
                    className="trend"
                    aria-label="Restore time per run"
                  >
                    <polyline
                      points={r.ok
                        .slice()
                        .reverse()
                        .map(
                          (e, i, a) =>
                            `${a.length > 1 ? (i / (a.length - 1)) * 100 : 50},${22 - ((e.measurements.restorationMs ?? 0) / Math.max(...r.restore, 1)) * 20}`,
                        )
                        .join(" ")}
                    />
                  </svg>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="cc-note">No finished experiments retained yet.</p>
      )}
      <h3>Availability in the selected window (observed time only)</h3>
      <div className="availability-grid">
        {availability.map((a) => (
          <span key={a.id} data-component={a.id}>
            {a.id}:{" "}
            <strong>
              {a.value == null ? "no data" : a.value.toFixed(2) + " %"}
            </strong>
          </span>
        ))}
      </div>
    </section>
  );
}
export function Analysis() {
  const [label, setLabel] = useState<keyof typeof spans>("15 min");
  const span = spans[label];
  const timeline = useTimeline(span, 10000);
  const [opened] = useState(() => Date.now());
  const from = timeline.data ? Date.parse(timeline.data.from) : opened - span;
  const to = timeline.data ? Date.parse(timeline.data.to) : opened;
  const impact = useImpact(from, to, false);
  const chaos = useChaos();
  return (
    <div className="analysis" aria-label="Health analysis">
      <header className="presentation-head">
        <div>
          <p className="cc-kicker">STREAMSHIELD / HEALTH ANALYSIS</p>
          <h1>Good → failure → healing → good.</h1>
          <p>
            Every segment comes from persisted evidence: observer transitions,
            Healer attempts and chaos experiments. Grey means no evidence.
          </p>
        </div>
        <div className="window-picker" role="group" aria-label="Time window">
          {(Object.keys(spans) as (keyof typeof spans)[]).map((k) => (
            <button
              key={k}
              aria-pressed={k === label}
              onClick={() => setLabel(k)}
            >
              {k}
            </button>
          ))}
        </div>
      </header>
      <HealthBand data={timeline.data} />
      <section className="cc-panel" aria-label="Service swimlanes">
        <h2>Service swimlanes</h2>
        {timeline.isError && (
          <p role="alert" className="cc-notice">
            Timeline unavailable; nothing is inferred.
          </p>
        )}
        <div className="lanes">
          {timeline.data?.components.map((c) => (
            <Lane
              key={c.id}
              id={c.id}
              segments={c.segments}
              from={from}
              span={to - from}
            />
          ))}
        </div>
        <div className="topology-legend">
          {(
            [
              "healthy",
              "degraded",
              "failed",
              "healing",
              "recovered",
              "escalated",
              "unknown",
              "injected",
            ] as const
          ).map((t) => (
            <HealthChip key={t} tone={t} />
          ))}
        </div>
      </section>
      <section className="impact-grid" aria-label="Impact charts">
        {impact.data?.series.map((s) => (
          <ImpactChart
            key={s.id}
            series={s}
            timeline={timeline.data}
            from={from}
            to={to}
          />
        ))}
        {impact.data && !impact.data.available && (
          <p className="cc-note">
            Some metrics are unavailable (Prometheus not reachable).
          </p>
        )}
      </section>
      <section className="cc-panel" aria-label="Experiments in window">
        <h2>Experiments</h2>
        <ul className="experiment-links">
          {(chaos.data?.experiments || []).slice(0, 20).map((e) => (
            <li key={e.id}>
              <Link to={"/control/analysis/" + e.id}>
                {clock(e.createdAt)} · {e.scenario} · {e.state}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <Scorecard
        experiments={chaos.data?.experiments || []}
        scenarios={chaos.data?.scenarios || []}
        timeline={timeline.data}
      />
    </div>
  );
}
type Row = [
  string,
  string,
  number | null,
  number | null,
  number | null,
  boolean?,
];
/** Phase bar, stacked durations and before/during/after for one experiment. */
export function ExperimentSummary({
  e,
  scenario,
  compact = false,
}: {
  e: ChaosExperiment;
  scenario?: ChaosScenario;
  compact?: boolean;
}) {
  const recovery = useRecovery();
  const [opened] = useState(() => Date.now());
  const injected = e.injectedAt
    ? Date.parse(e.injectedAt)
    : Date.parse(e.createdAt);
  const end = Date.parse(
    e.verifiedAt || e.finishedAt || new Date(opened).toISOString(),
  );
  const from = injected - 60000,
    to = end + 60000;
  const timeline = useTimelineRange(from, Math.min(to, opened));
  const impact = useImpact(from, Math.min(to, opened), false);
  const attempts = recovery.data?.attempts || timeline.data?.attempts || [];
  const m = e.measurements;
  const pieces: [string, number | null, string][] = [
    ["Detect", m.detectionMs, "failed"],
    [
      "Act",
      m.healingStartMs != null && m.detectionMs != null
        ? m.healingStartMs - m.detectionMs
        : null,
      "degraded",
    ],
    ["Action", m.actionMs, "healing"],
    [
      "Verify",
      m.restorationMs != null && m.healingStartMs != null && m.actionMs != null
        ? m.restorationMs - m.healingStartMs - m.actionMs
        : null,
      "recovered",
    ],
  ];
  const total = pieces.reduce((n, [, v]) => n + Math.max(0, v ?? 0), 0) || 1;
  const series = (id: string) =>
    impact.data?.series.find((s) => s.id === id)?.points || [];
  const verified = e.verifiedAt ? Date.parse(e.verifiedAt) : null;
  const avg = (id: string, a: number, b: number) =>
    windowAverage(series(id), a, b);
  const browser = timeline.data?.browserEvidence
    .filter((b) => b.experimentId === e.id)
    .at(-1)?.metrics;
  const rows: Row[] = (
    [
      ["API p95 latency", "ms", "latency"],
      ["5xx error rate", "%", "errors"],
      ["Requests per second", "req/s", "throughput"],
      ["Chat messages delivered", "msg/s", "chat"],
      ["Live connections", "conn", "sockets"],
    ] as const
  ).map(([label, unit, id]) => [
    label,
    unit,
    avg(id, injected - 60000, injected),
    verified ? avg(id, injected, verified) : null,
    verified ? avg(id, verified, verified + 60000) : null,
  ]);
  rows.push([
    "Video stall time (browser-observed)",
    "s",
    null,
    browser && typeof browser.stallMs === "number"
      ? browser.stallMs / 1000
      : null,
    null,
    true,
  ]);
  const near = (b: number | null, a: number | null) =>
    a != null &&
    b != null &&
    Math.abs(a - b) <= Math.max(Math.abs(b) * 0.25, 1);
  const own = attemptsFor(e, attempts);
  return (
    <article
      className={"experiment-summary" + (compact ? " compact" : "")}
      data-experiment={e.id}
    >
      <div className="panel-head">
        <div>
          <span className="cc-kicker">
            {clock(e.createdAt)} · {e.state}
          </span>
          <h2>{scenario?.name || e.scenario}</h2>
          {scenario && (
            <p className="cc-note">
              <strong>Real-world cause:</strong> {scenario.realWorldCause}{" "}
              <strong>Audience saw:</strong> {scenario.audienceSees}
            </p>
          )}
        </div>
        <HealthChip
          tone={
            e.state === "COMPLETED"
              ? "recovered"
              : e.state === "AWAITING_OPERATOR"
                ? "escalated"
                : terminalExperiment(e.state)
                  ? "failed"
                  : "healing"
          }
          label={
            e.scenario === "media-authority-loss" && e.state === "COMPLETED"
              ? "RESTORED BY OPERATOR"
              : e.state.replaceAll("_", " ")
          }
        />
      </div>
      <div className="phase-bar" aria-label="Phase durations">
        {pieces.map(([label, v, tone]) => (
          <span
            key={label}
            className={"phase tone-" + tone}
            style={{ width: (Math.max(0, v ?? 0) / total) * 100 + "%" }}
            title={label + " " + fmt(v)}
            data-phase={label}
            data-ms={v ?? ""}
          >
            {label} {fmt(v)}
          </span>
        ))}
      </div>
      <p className="cc-note">
        {e.scenario === "media-authority-loss" ? (
          <>
            Video authorization denied {clock(e.faultConfirmedAt)} → human
            action required → operator restored access{" "}
            {clock(
              typeof e.evidence.operatorRestoredAt === "string"
                ? e.evidence.operatorRestoredAt
                : null,
            )}{" "}
            → video restoration verified {clock(e.verifiedAt)}. No automatic
            repair is claimed.
          </>
        ) : (
          <>
            Healthy → ϟ fault injected {clock(e.injectedAt)} → detected{" "}
            {clock(e.incidentDetectedAt)} → Healer acted{" "}
            {clock(e.actionStartedAt)} → verified {clock(e.verifiedAt)} →
            healthy.
          </>
        )}
      </p>
      <p>
        <strong>Diagnosis:</strong>{" "}
        {String(e.evidence.diagnosis || "Not recorded")}.{" "}
        <strong>Playbook:</strong> {String(e.evidence.recoveryPlaybook || "—")}{" "}
        ({String(e.evidence.healerReceipt || "no receipt")}).{" "}
        <strong>Verification:</strong> {e.mechanism || "not completed"}.
        {e.evidence.broadcasterClientReconnected === true &&
          " The broadcaster's own client reconnected afterwards; the Healer did not restore the source."}
      </p>
      <table className="bda-table">
        <thead>
          <tr>
            <th>Measure</th>
            <th>Before</th>
            <th>During</th>
            <th>After</th>
            <th>Δ after vs before</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, unit, b, d, a, browserOnly]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>
                {b == null
                  ? browserOnly
                    ? "—"
                    : "Not measured"
                  : b.toFixed(2) + " " + unit}
              </td>
              <td>{d == null ? "Not measured" : d.toFixed(2) + " " + unit}</td>
              <td>
                {a == null
                  ? browserOnly
                    ? "—"
                    : "Not measured"
                  : a.toFixed(2) + " " + unit}
              </td>
              <td className={near(b, a) ? "back-to-baseline" : ""}>
                {a == null || b == null
                  ? "—"
                  : (a - b >= 0 ? "+" : "") + (a - b).toFixed(2)}
                {near(b, a) && " ✓ baseline"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!compact && (
        <StageTimeline experiment={e} attempts={own.length ? attempts : []} />
      )}
    </article>
  );
}
export function ExperimentAnalysis() {
  const { id } = useParams();
  const chaos = useChaos();
  const e = chaos.data?.experiments.find((x) => x.id === id);
  if (!e)
    return (
      <p className="cc-note">
        {chaos.isPending ? "Loading experiment…" : "Experiment not retained."}{" "}
        <Link to="/control/analysis">Back to analysis</Link>
      </p>
    );
  return (
    <div className="analysis">
      <Link className="cc-back" to="/control/analysis">
        ← Health analysis
      </Link>
      <ExperimentSummary
        e={e}
        scenario={chaos.data?.scenarios.find((s) => s.id === e.scenario)}
      />
    </div>
  );
}
export function RecoveryReport() {
  const chaos = useChaos();
  const finished = (chaos.data?.experiments || [])
    .filter((e) => terminalExperiment(e.state))
    .slice(0, 12);
  return (
    <div className="recovery-report">
      <header className="presentation-head">
        <div>
          <p className="cc-kicker">STREAMSHIELD / RECOVERY REPORT</p>
          <h1>What broke, what users saw, and how it healed.</h1>
          <p>
            From persisted experiment history. Durations are differences of
            stored timestamps; browser measurements are labelled as such.
          </p>
        </div>
        <button className="no-print" onClick={() => window.print()}>
          Print
        </button>
      </header>
      {finished.length === 0 && (
        <p className="cc-note">No finished experiments yet.</p>
      )}
      {finished.map((e) => (
        <ExperimentSummary
          key={e.id}
          e={e}
          compact
          scenario={chaos.data?.scenarios.find((s) => s.id === e.scenario)}
        />
      ))}
    </div>
  );
}
