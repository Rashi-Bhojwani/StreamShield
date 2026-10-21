import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type {
  CapacitySummary,
  MonitoringMetrics,
  MonitoringSnapshot,
  HealingSnapshot,
  PlaybackObservation,
} from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import { useDemoChannels, type DemoChannel } from "../demo/useDemoChannels";
import { LivePlayer } from "../streaming/LivePlayer";
import { CompactChaos } from "./Chaos";
import { Icon } from "../ui/Icon";
import "../demo/demo.css";
const number = (n: number | null | undefined, digits = 0) =>
  n == null
    ? "—"
    : n.toLocaleString(undefined, { maximumFractionDigits: digits });
const profileLabel = {
  api: "API request activity",
  socket: "Socket.IO connections",
  chat: "Synthetic chat connections",
  hls: "Concurrent HLS HTTP fetches",
  browser: "Decoded browser viewers",
};
function useCapacity() {
  const { call } = useAuth();
  return useQuery({
    queryKey: ["monitoring", "capacity"],
    queryFn: () => call<{ runs: CapacitySummary[] }>("/monitoring/capacity"),
    refetchInterval: 3000,
    retry: false,
  });
}
function Kpi({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <article className="capacity-kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}
function ActiveChart({ run }: { run: CapacitySummary | undefined }) {
  const rows = run?.samples.filter((s) => s.active !== null) || [],
    maximum = Math.max(1, ...rows.map((s) => s.active!)),
    from = Date.parse(rows[0]?.at || "") || 0,
    span = (Date.parse(rows.at(-1)?.at || "") || 0) - from || 1;
  const points = rows
    .map(
      (r) =>
        `${((Date.parse(r.at) - from) / span) * 700},${165 - (r.active! / maximum) * 150}`,
    )
    .join(" ");
  return (
    <div>
      {rows.length > 1 ? (
        <>
          <svg
            className="capacity-chart"
            role="img"
            aria-label="Actual reported concurrent activity over time"
            viewBox="0 0 700 185"
            preserveAspectRatio="none"
          >
            <path
              className="capacity-chart-grid"
              d="M0 15H700 M0 90H700 M0 165H700"
            />
            <polygon
              className="capacity-chart-area"
              points={`0,185 ${points} 700,185`}
            />
            <polyline className="capacity-chart-line" points={points} />
          </svg>
          <div className="capacity-axis">
            <span>{new Date(from).toLocaleTimeString()}</span>
            <span>
              Actual sampled peak {number(run?.peakReported)} ·{" "}
              {profileLabel[run!.profile]}
            </span>
            <span>{new Date(rows.at(-1)!.at).toLocaleTimeString()}</span>
          </div>
        </>
      ) : (
        <p className="capacity-empty">
          Waiting for actual generator reports. A requested target is never
          plotted as achieved traffic.
        </p>
      )}
    </div>
  );
}
function WorkloadKpis({ run }: { run: CapacitySummary | undefined }) {
  return (
    <div className="capacity-kpis">
      <Kpi
        label="Requested simulated clients"
        value={number(run?.targetClients)}
        note={
          run
            ? `${profileLabel[run.profile]} · allocation ceiling`
            : "Choose a recorded run"
        }
      />
      <Kpi
        label={
          run
            ? "Actual active · " + profileLabel[run.profile]
            : "Actual active workload"
        }
        value={number(run?.actualActive)}
        note={
          run?.staleWorkers
            ? `${run.staleWorkers} stale workers; current activity unknown`
            : "Fresh generator reports; separate from target"
        }
      />
      <Kpi
        label="Average measured request rate"
        value={
          run?.requestsPerSecond == null
            ? "—"
            : number(run.requestsPerSecond, 1) + " /s"
        }
        note="Total HTTP completions / run wall time"
      />
      <Kpi
        label="Measured request p95"
        value={run?.p95Ms == null ? "—" : number(run.p95Ms) + " ms"}
        note="Merged histogram bucket upper bound"
      />
    </div>
  );
}
export function CapacityPage() {
  const q = useCapacity(),
    [selected, setSelected] = useState(""),
    runs = q.data?.runs || [],
    run = runs.find((r) => r.id === selected) || runs[0];
  const { call } = useAuth(),
    metrics = useQuery({
      queryKey: ["monitoring", "metrics"],
      queryFn: () => call<MonitoringMetrics>("/monitoring/metrics"),
      refetchInterval: 15000,
      retry: false,
    });
  const metric = (id: string) => {
    const point =
      metrics.data?.available && !metrics.isError
        ? metrics.data.series.find((s) => s.id === id)?.points.at(-1)
        : null;
    return point &&
      Date.parse(metrics.data?.checkedAt || "") / 1000 - point[0] <= 30
      ? point[1]
      : null;
  };
  const snapshot = useQuery({
    queryKey: ["monitoring", "snapshot"],
    queryFn: () => call<MonitoringSnapshot>("/monitoring/snapshot"),
    refetchInterval: 5000,
    retry: false,
  });
  const stale = q.isError || !q.data;
  return (
    <div className="capacity-page">
      <header className="capacity-heading">
        <div>
          <p className="cc-kicker">STREAMSHIELD / CAPACITY OBSERVATORY</p>
          <h1>Measure the load. Know the limit.</h1>
          <p>
            Independent workloads. Actual concurrency. Recorded outcomes. API
            requests, connected sockets and decoded video are different
            measurements.
          </p>
        </div>
        <span className="capacity-live">50,000 TARGET · UNVERIFIED</span>
      </header>
      <div className="capacity-notice">
        The 50K capacity milestone is unverified. Opening this dashboard starts
        no traffic. Use the owned-target CLI for a bounded run; compare the
        achieved sampled concurrency and errors below.
      </div>
      {stale && (
        <p role="alert" className="capacity-notice">
          Live run data is unavailable. Last recorded values cannot establish
          current traffic.
        </p>
      )}
      <WorkloadKpis run={stale ? undefined : run} />
      <div className="capacity-grid">
        <section className="capacity-panel">
          <div className="capacity-profile">
            {run ? profileLabel[run.profile] : "NO WORKLOAD SELECTED"}
          </div>
          <h2>Actual concurrent activity</h2>
          <p>
            Fresh worker reports, sampled once per second. Stale intervals are
            omitted. A single-worker peak is directly observed; distributed peak
            uses aggregate samples, never a sum of unrelated worker peaks.
          </p>
          <ActiveChart run={run} />
          <dl className="capacity-metadata">
            {[
              ["Run state", run?.state || "Not started"],
              ["Allocated clients", number(run?.allocatedClients)],
              [
                "HTTP requests / errors",
                `${number(run?.requests)} / ${number(run?.errors)}`,
              ],
              [
                "HTTP error rate",
                run?.requests
                  ? number((run.errors / run.requests) * 100, 2) + "%"
                  : "—",
              ],
              [
                "HTTP response bytes",
                run ? number(run.bytes / 1048576, 2) + " MiB" : "—",
              ],
              [
                "p50 / p95 / p99",
                run
                  ? `${number(run.p50Ms)} / ${number(run.p95Ms)} / ${number(run.p99Ms)} ms`
                  : "—",
              ],
              [
                "Chat sends / confirmed delivery",
                `${number(run?.messages)} / ${number(run?.delivered)}`,
              ],
              [
                "Chat delivery failures / p95",
                `${number(run?.deliveryFailures)} / ${number(run?.deliveryP95Ms)} ms`,
              ],
              [
                "Connects / disconnects / reconnects",
                `${number(run?.connections)} / ${number(run?.disconnects)} / ${number(run?.reconnects)}`,
              ],
              [
                "Connection / join failures",
                `${number(run?.connectionFailures)} / ${number(run?.joinFailures)}`,
              ],
              [
                "Average connects / disconnects per second",
                `${number(run?.connectionsPerSecond, 2)} / ${number(run?.disconnectsPerSecond, 2)}`,
              ],
              ["Verified decoded browsers", number(run?.verifiedBrowsers)],
              [
                "Browser startup max / stalls",
                `${number(run?.startupMs)} ms / ${number(run?.stalls)}`,
              ],
              [
                "Average synthetic chat rate",
                run?.messagesPerSecond == null
                  ? "—"
                  : number(run.messagesPerSecond, 2) + " msg/s",
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="capacity-panel">
          <p className="cc-kicker">DURABLE RUN HISTORY</p>
          <h2>Compare actual test runs</h2>
          <p>
            Independent profiles and generator allocations are labelled
            explicitly. Reports are authenticated generator observations, not
            audience census data.
          </p>
          <div className="capacity-history">
            {runs.length ? (
              runs.map((r) => (
                <button
                  key={r.id}
                  className={
                    "capacity-run " + (r.id === run?.id ? "selected" : "")
                  }
                  onClick={() => setSelected(r.id)}
                >
                  <span>
                    <strong>
                      {r.profile.toUpperCase()} · target{" "}
                      {number(r.targetClients)}
                    </strong>
                    <small>
                      {new Date(r.createdAt).toLocaleString()} · peak{" "}
                      {number(r.peakReported)}
                    </small>
                  </span>
                  <span className="capacity-state">{r.state}</span>
                </button>
              ))
            ) : (
              <p className="capacity-empty">
                No capacity runs yet. Create a small authorized CLI run to
                record actual traffic.
              </p>
            )}
          </div>
          {run && (
            <p>
              Owned target: {run.targetOrigin}
              <br />
              Run {run.id}
              <br />
              {run.freshWorkers} fresh / {run.staleWorkers} stale workers
            </p>
          )}
        </section>
      </div>
      <section className="capacity-panel">
        <p className="cc-kicker">INDEPENDENT INFRASTRUCTURE TELEMETRY</p>
        <h2>Application and generator resources</h2>
        <div className="capacity-kpis">
          <Kpi
            label="API process CPU"
            value={number(metric("cpu"), 2)}
            note="Prometheus cores; all scraped API replicas"
          />
          <Kpi
            label="API process memory"
            value={number(metric("memory"), 1) + " MiB"}
            note="Actual process RSS from Prometheus"
          />
          <Kpi
            label="Active Socket.IO connections"
            value={number(metric("sockets"))}
            note="All API sockets; includes monitoring and synthetic"
          />
          <Kpi
            label="Generator memory"
            value={
              run?.generatorRssBytes == null
                ? "—"
                : number(run.generatorRssBytes / 1048576, 1) + " MiB"
            }
            note={
              "Reported generator CPU " +
              number(run?.generatorCpuPercent, 1) +
              "%"
            }
          />
        </div>
        <p>
          API throughput {number(metric("throughput"), 1)} req/s · Active
          incidents{" "}
          {snapshot.data && !snapshot.data.stale
            ? number(snapshot.data.openCount)
            : "unknown"}
          .{" "}
          <Link to="/control/recoveries">
            Inspect independent recovery attempts ↗
          </Link>
        </p>
      </section>
    </div>
  );
}
function Preview({ channel }: { channel: DemoChannel }) {
  const [o, setO] = useState<PlaybackObservation | null>(null);
  return (
    <section className="three-preview" data-channel={channel.slot}>
      <header className="three-preview-head">
        <h2>{channel.channelName}</h2>
        <span className={"three-signal " + channel.status}>
          <i />
          {channel.status.toUpperCase()}
        </span>
      </header>
      {channel.status === "live" ? (
        <LivePlayer
          source={channel.playbackUrl}
          alternateSources={channel.playbackSources}
          sourceId={channel.id}
          onObservation={setO}
        />
      ) : (
        <div className="three-preview-offline">
          <Icon name="studio" />
          <strong>Waiting for Streamer {channel.slot}</strong>
          <span>Start the provisioned OBS or FFmpeg publisher.</span>
        </div>
      )}
      <div className="three-preview-metrics">
        <span>Source {o?.event.deliverySource || "unobserved"}</span>
        <span>
          Startup{" "}
          {o?.metrics.startupMs == null
            ? "—"
            : number(o.metrics.startupMs) + " ms"}
        </span>
        <span>Stalls {o?.metrics.stallCount ?? "—"}</span>
      </div>
    </section>
  );
}
export function ThreeStreamDemo({
  snapshot,
}: {
  snapshot: MonitoringSnapshot;
}) {
  const channels = useDemoChannels(),
    load = useCapacity(),
    { call } = useAuth(),
    healing = useQuery({
      queryKey: ["monitoring", "healing"],
      queryFn: () => call<HealingSnapshot>("/monitoring/healing"),
      refetchInterval: 5000,
      retry: false,
    });
  const run = load.isError
    ? undefined
    : load.data?.runs.find((r) => r.state === "RUNNING") || load.data?.runs[0];
  return (
    <div className="capacity-page">
      <header className="capacity-heading">
        <div>
          <p className="cc-kicker">
            STREAMSHIELD / THREE PERSPECTIVES, ONE SYSTEM
          </p>
          <h1>Live. Under pressure. Recovering.</h1>
          <p>
            Three independent broadcasts, actual load and independently verified
            recovery.
          </p>
        </div>
        <Link className="chaos-demo-link" to="/control/capacity">
          Capacity Observatory ↗
        </Link>
      </header>
      <div className="three-preview-grid">
        {channels.data?.channels.map((c) => (
          <Preview key={c.id} channel={c} />
        ))}
        {channels.isError && (
          <p role="alert">Live-channel observations unavailable.</p>
        )}
      </div>
      <div
        className="three-demo-health"
        aria-label="Current infrastructure health"
      >
        {snapshot.components
          .filter((c) =>
            [
              "api-1",
              "api-2",
              "edge-1",
              "edge-2",
              "origin-primary",
              "origin-standby",
              "redis",
              "postgres",
            ].includes(c.id),
          )
          .map((c) => (
            <div key={c.id}>
              <span>{c.id}</span>
              <strong className={snapshot.stale ? "" : c.state.toLowerCase()}>
                {snapshot.stale ? "UNKNOWN" : c.state}
              </strong>
            </div>
          ))}
      </div>
      <WorkloadKpis run={run} />
      <div className="three-demo-bottom">
        <CompactChaos />
        <section className="capacity-panel">
          <p className="cc-kicker">OBSERVED IMPACT / DURABLE EVIDENCE</p>
          <h2>Follow the system response</h2>
          <p>
            Active player leases:{" "}
            {snapshot.stale ? "unknown" : number(snapshot.playback.advancing)} ·
            These are advancing player reports, not a decoded capacity test or
            all users.
          </p>
          <p>
            Current run profile:{" "}
            {run ? profileLabel[run.profile] : "No load run"}. Synthetic
            messages are explicitly labelled and excluded from permanent chat
            history. Serving edge identity remains unobserved by the browser.
          </p>
          <ActiveChart run={run} />
          <dl className="capacity-metadata">
            <div>
              <dt>Open incidents</dt>
              <dd>{snapshot.stale ? "—" : snapshot.openCount}</dd>
            </div>
            <div>
              <dt>Healer verified attempts</dt>
              <dd>
                {healing.data?.available ? healing.data.counts.verified : "—"}
              </dd>
            </div>
            <div>
              <dt>Synthetic chat sends / delivery</dt>
              <dd>
                {number(run?.messages)} / {number(run?.delivered)}
              </dd>
            </div>
            <div>
              <dt>Load request errors</dt>
              <dd>{number(run?.errors)}</dd>
            </div>
          </dl>
          <div className="capacity-history">
            {snapshot.incidents.slice(0, 4).map((i) => (
              <Link
                className="capacity-run"
                key={i.id}
                to={"/control/incidents/" + i.id}
              >
                <span>
                  <strong>
                    {i.component} · {i.failure_identity}
                  </strong>
                  <small>{new Date(i.detected_at).toLocaleTimeString()}</small>
                </span>
                <span className="capacity-state">{i.state}</span>
              </Link>
            ))}
          </div>
          <p>
            <Link to="/control/recoveries">Independent Healer audit ↗</Link> ·{" "}
            <Link to="/control/incidents">Incident history ↗</Link>
          </p>
        </section>
      </div>
    </div>
  );
}
