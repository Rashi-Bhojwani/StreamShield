import { CrashDemonstration } from "./Demonstration";
import { SystemLogs } from "./Logs";
import {
  observationFreshness,
  idleLoadObservation,
  parseMonitoringSnapshot,
} from "@streamshield/shared";
import { Presentation } from "./Presentation";
import { Analysis, ExperimentAnalysis, RecoveryReport } from "./Analysis";
import { CapacityPage, ThreeStreamDemo } from "./Capacity";
import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  useParams,
  useLocation,
  Routes,
  Route,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { io } from "socket.io-client";
import type {
  ComponentObservation,
  HealthState,
  Incident,
  MetricSeries,
  MonitoringMetrics,
  MonitoringSnapshot,
} from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import { Protected } from "../platform/Auth";
import { Brand } from "../ui/Brand";
import { config } from "../config";
import "./control.css";
import { ChaosLab, ChaosDemo } from "./Chaos";
import { useChaos } from "./useChaos";
import { Recoveries, RecoverySummary } from "./Recovery";
const clock = (date: string | null | undefined) =>
  date ? new Date(date).toLocaleString() : "Not observed";
const shortTime = (date: string | null | undefined) =>
  date ? new Date(date).toLocaleTimeString() : "—";
const elapsed = (ms: number | null | undefined) =>
  ms == null
    ? "Not measured"
    : ms < 1000
      ? Math.round(ms) + " ms"
      : (ms / 1000).toFixed(2) + " s";
function Badge({ state }: { state: string }) {
  return (
    <span className={"cc-badge cc-" + state.toLowerCase()}>
      <i aria-hidden="true" />
      {state.replaceAll("_", " ")}
    </span>
  );
}
function Chart({ series }: { series: MetricSeries }) {
  const p = series.points,
    max = Math.max(...p.map((x) => x[1]), 0.001),
    last = p.at(-1)?.[1];
  const from = p[0]?.[0] || 0,
    span = (p.at(-1)?.[0] || 0) - from || 1;
  const points = p
    .map((v) => `${((v[0] - from) / span) * 600},${115 - (v[1] / max) * 100}`)
    .join(" ");
  return (
    <article className="cc-chart">
      <div className="cc-section-head">
        <h3>{series.label}</h3>
        <span className="cc-unit">{series.unit}</span>
      </div>
      <div className="cc-chart-value">
        {last == null
          ? "—"
          : last.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        <small>
          {last == null ? "No collected samples" : "Latest collected sample"}
        </small>
      </div>
      {p.length > 1 ? (
        <svg
          role="img"
          aria-label={
            series.label + " over the last 10 minutes, " + series.unit
          }
          viewBox="0 0 600 130"
          preserveAspectRatio="none"
        >
          <path d="M0 15H600 M0 65H600 M0 115H600" className="cc-gridline" />
          <polygon
            points={"0,130 " + points + " 600,130"}
            className="cc-area"
          />
          <polyline points={points} className="cc-line" />
        </svg>
      ) : (
        <div className="cc-chart-empty">Waiting for sufficient metrics</div>
      )}
      <div className="cc-axis">
        <span>
          {p.length ? new Date(from * 1000).toLocaleTimeString() : "No data"}
        </span>
        <span>
          {p.length
            ? new Date(p.at(-1)![0] * 1000).toLocaleTimeString()
            : "Prometheus collection required"}
        </span>
      </div>
    </article>
  );
}
function useSnapshot(now?: { wall: number; monotonic: number }) {
  const { call } = useAuth();
  const q = useQuery({
    queryKey: ["monitoring", "snapshot"],
    queryFn: async () => ({
      ...parseMonitoringSnapshot(await call<unknown>("/monitoring/snapshot")),
      receivedAtMonotonic: performance.now(),
    }),
    refetchInterval: config.VITE_STREAM_POLL_MS,
    retry: false,
  });
  return {
    ...q,
    freshNow:
      q.data?.serverTime && now
        ? Date.parse(q.data.serverTime) +
          Math.max(0, now.monotonic - q.data.receivedAtMonotonic)
        : (now?.wall ?? q.dataUpdatedAt),
  };
}
function useIncidents(filters = "") {
  const { call } = useAuth();
  return useQuery({
    queryKey: ["monitoring", "incidents", filters],
    queryFn: () =>
      call<{ incidents: Incident[]; nextOffset: number | null }>(
        "/monitoring/incidents" + filters,
      ),
    refetchInterval: config.VITE_STATUS_POLL_MS,
    retry: false,
  });
}
function effective(c: ComponentObservation, stale: boolean): HealthState {
  return stale ? "UNKNOWN" : c.state;
}
function IncidentRows({ rows }: { rows: Incident[] }) {
  return (
    <div className="cc-incident-rows">
      {rows.map((i) => (
        <Link
          className="cc-incident-row"
          to={"/control/incidents/" + i.id}
          key={i.id}
        >
          <span
            className={"cc-severity cc-" + i.severity}
            aria-label={i.severity}
          >
            {i.severity === "critical" ? "!" : "△"}
          </span>
          <div>
            <strong>
              {i.component} · {i.failure_identity}
            </strong>
            <p>
              {(i.evidence.failureCode || i.evidence.code) as string}{" "}
              <span>· {shortTime(i.detected_at)}</span>
            </p>
          </div>
          <Badge state={i.state} />
          <span aria-hidden="true">↗</span>
        </Link>
      ))}
      {!rows.length && (
        <div className="cc-empty">No incidents match this view.</div>
      )}
    </div>
  );
}
function Topology({
  components,
  stale,
}: {
  components: ComponentObservation[];
  stale: boolean;
}) {
  const chaos = useChaos();
  const experiment = chaos.data?.experiments.find(
    (e) => !["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(e.state),
  );
  const layers = [
    ["web"],
    ["api-gateway", "video-gateway"],
    ["api-1", "api-2", "edge-1", "edge-2"],
    ["postgres", "redis", "origin-primary", "origin-standby"],
    ["relay"],
    ["demo-dependency"],
    ["prometheus", "grafana"],
  ];
  const groups = [
    "Experience",
    "Routing",
    "Service peers",
    "Dependencies & origins",
    "Ingest",
    "Simulated external dependency",
    "Independent observability",
  ];
  return (
    <section className="cc-panel">
      <div className="cc-section-head">
        <div>
          <p className="cc-kicker">DEPENDENCY MAP</p>
          <h2>Infrastructure topology</h2>
        </div>
        <span className="cc-unit">Select a component to investigate ↗</span>
      </div>
      <div className="cc-topology">
        {layers.map((ids, n) =>
          ids.some((id) => components.some((c) => c.id === id)) ? (
            <div className="cc-topology-layer" key={groups[n]}>
              <span className="cc-layer-label">{groups[n]}</span>
              <div className="cc-topology-nodes">
                {ids.map((id) => {
                  const c = components.find((c) => c.id === id);
                  return c ? (
                    <Link
                      className={
                        "cc-node cc-border-" +
                        effective(c, stale).toLowerCase() +
                        (chaos.live && experiment?.target === id
                          ? " chaos-target-active"
                          : "")
                      }
                      to={"/control/services/" + id}
                      key={id}
                    >
                      <span className="cc-node-icon" aria-hidden="true">
                        {c.group === "Data"
                          ? "▱"
                          : c.group === "Media"
                            ? "▷"
                            : "▦"}
                      </span>
                      <strong>{c.name}</strong>
                      <Badge state={effective(c, stale)} />
                      {chaos.live && experiment?.target === id && (
                        <span className="chaos-target-label">
                          Experiment · {experiment.state.replaceAll("_", " ")}
                        </span>
                      )}
                      <small>
                        {c.dependencies.length
                          ? "→ " + c.dependencies.join(" · ")
                          : "No downstream dependencies"}
                      </small>
                    </Link>
                  ) : null;
                })}
              </div>
            </div>
          ) : null,
        )}
      </div>
      <p className="cc-note">
        Arrows list actual downstream dependencies. HLS flows relay → origins →
        edges → video gateway → frontend. Monitoring does not restart services.
      </p>
    </section>
  );
}
function MetricsPage() {
  const { call } = useAuth();
  const metrics = useQuery({
    queryKey: ["monitoring", "metrics"],
    queryFn: () => call<MonitoringMetrics>("/monitoring/metrics"),
    refetchInterval: config.VITE_STATUS_POLL_MS,
    retry: false,
  });
  return (
    <>
      <section className="cc-panel">
        <p className="cc-kicker">COLLECTED TELEMETRY</p>
        <h2>Metrics explorer</h2>
        <p className="cc-note">
          Fixed operational PromQL queries · 10-minute window · sampled every 10
          seconds. Empty series mean unavailable data. Request metrics include
          health checks. Process resources cover the APIs, not the Docker host.
        </p>
        <p className="cc-note">
          Last metrics query: {clock(metrics.data?.checkedAt)} ·{" "}
          {metrics.data?.available
            ? "Prometheus available"
            : "Collection unavailable or warming up"}
        </p>
      </section>
      <section className="cc-metrics-grid">
        {metrics.data?.series.map((s) => (
          <Chart key={s.id} series={s} />
        ))}
      </section>
    </>
  );
}
function Overview({
  snapshot,
  stale,
}: {
  snapshot: MonitoringSnapshot;
  stale: boolean;
}) {
  const { call } = useAuth();
  const metrics = useQuery({
    queryKey: ["monitoring", "metrics"],
    queryFn: () => call<MonitoringMetrics>("/monitoring/metrics"),
    refetchInterval: config.VITE_STATUS_POLL_MS,
    retry: false,
  });
  const [view, setView] = useState("All components");
  const components = snapshot.components.filter(
    (c) => view === "All components" || c.group === view,
  );
  return (
    <>
      <section
        className="cc-metrics-grid cc-overview-charts"
        aria-label="Live metric charts"
      >
        {metrics.data?.series.slice(0, 4).map((s) => (
          <Chart key={s.id} series={s} />
        ))}
        {(!metrics.data || !metrics.data.available) && (
          <p className="cc-notice">
            {metrics.isError
              ? "Metrics request unavailable."
              : "Metrics collection unavailable or warming up."}{" "}
            Component probes remain independent.
          </p>
        )}
      </section>
      <section className="cc-panel">
        <div className="cc-section-head">
          <div>
            <p className="cc-kicker">LIVE INVENTORY</p>
            <h2>Service health</h2>
          </div>
          <select
            aria-label="Filter service group"
            value={view}
            onChange={(e) => setView(e.target.value)}
          >
            {[
              "All components",
              "Application",
              "Delivery",
              "Media",
              "Data",
              "Observability",
            ].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </div>
        <div className="cc-service-grid">
          {components.map((c) => (
            <Link
              key={c.id}
              to={"/control/services/" + c.id}
              className="cc-service-card"
            >
              <div>
                <span className="cc-service-icon" aria-hidden="true">
                  ▦
                </span>
                <Badge state={effective(c, stale)} />
              </div>
              <h3>{c.name}</h3>
              <p>{c.role}</p>
              <div className="cc-service-footer">
                <span>
                  {c.latencyMs == null ? "—" : c.latencyMs + " ms"}
                  <small>probe response</small>
                </span>
                <span>
                  {shortTime(c.observedAt)}
                  <small>last observation</small>
                </span>
              </div>
              {c.code !== "probe_ok" && (
                <p className="cc-code">{c.code.replaceAll("_", " ")}</p>
              )}
            </Link>
          ))}
        </div>
      </section>
      <Topology components={snapshot.components} stale={stale} />
      <div className="cc-bottom-grid">
        <section className="cc-panel">
          <div className="cc-section-head">
            <div>
              <p className="cc-kicker">DURABLE EVIDENCE</p>
              <h2>Incident activity</h2>
            </div>
            <Link to="/control/incidents">View history ↗</Link>
          </div>
          <IncidentRows rows={snapshot.incidents} />
        </section>
        <section className="cc-panel">
          <p className="cc-kicker">MEDIA & PLAYER SIGNALS</p>
          <h2>Playback observations</h2>
          <div className="cc-playback-number">
            {snapshot.playback.checkedAt ? snapshot.playback.advancing : "—"}
            <small>recent advancing player reports</small>
          </div>
          <p className="cc-note">
            {snapshot.playback.label}. Standby reports:{" "}
            {snapshot.playback.checkedAt
              ? snapshot.playback.standby
              : "unknown"}
            .
          </p>
          <p className="cc-note">
            Client-reported, expiring signals. No global playback guarantee.
            Last report query: {shortTime(snapshot.playback.checkedAt)}.
          </p>
          <h3>Observed publisher paths</h3>
          {!snapshot.mediaAvailable ? (
            <p>Media observations unavailable.</p>
          ) : !snapshot.media.length ? (
            <p>No active publisher observed.</p>
          ) : (
            snapshot.media.map((p) => (
              <div className="cc-media-path" key={p.path}>
                <code>{p.path}</code>
                <small>{clock(p.checkedAt)}</small>
                {p.sources.map((s) => (
                  <p key={s.id}>
                    <strong>{s.id}</strong> · manifest{" "}
                    {s.manifest ? "available" : "unavailable"} · segment{" "}
                    {s.segment ? "bytes verified" : "unverified"} · freshness{" "}
                    {s.fresh === null
                      ? "unknown"
                      : s.fresh
                        ? "advancing"
                        : "stale"}
                  </p>
                ))}
              </div>
            ))
          )}
          <p className="cc-note">
            Selected origin is reported by players. Server segment probes verify
            media bytes, never browser decoding.
          </p>
        </section>
      </div>
    </>
  );
}
function History() {
  const [severity, setSeverity] = useState(""),
    [status, setStatus] = useState(""),
    [component, setComponent] = useState(""),
    [offset, setOffset] = useState(0),
    [order, setOrder] = useState("newest");
  const snap = useSnapshot();
  const params = new URLSearchParams({ offset: String(offset), order });
  if (severity) params.set("severity", severity);
  if (status) params.set("status", status);
  if (component) params.set("component", component);
  const result = useIncidents("?" + params);
  return (
    <section className="cc-panel">
      <div className="cc-section-head">
        <div>
          <p className="cc-kicker">INVESTIGATION</p>
          <h2>Incident history</h2>
        </div>
        <span className="cc-unit">Persisted in PostgreSQL</span>
      </div>
      <div className="cc-filters">
        <label>
          Severity
          <select
            aria-label="Severity"
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
          </select>
        </label>
        <label>
          State
          <select
            aria-label="State"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All states</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
        <label>
          Component
          <select
            aria-label="Component"
            value={component}
            onChange={(e) => {
              setComponent(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All components</option>
            {snap.data?.components.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select
            aria-label="Sort"
            value={order}
            onChange={(e) => {
              setOrder(e.target.value);
              setOffset(0);
            }}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </div>
      {result.isError ? (
        <p role="alert">Incident history unavailable.</p>
      ) : result.isPending ? (
        <p>Loading durable history…</p>
      ) : (
        <IncidentRows rows={result.data.incidents} />
      )}
      <div className="cc-pagination">
        <button
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          ← Previous
        </button>
        <span>Page {offset / 20 + 1}</span>
        <button
          disabled={result.data?.nextOffset == null}
          onClick={() => setOffset(result.data!.nextOffset!)}
        >
          Next →
        </button>
      </div>
    </section>
  );
}
function IncidentDetail() {
  const { id } = useParams(),
    { call } = useAuth();
  const q = useQuery({
    queryKey: ["monitoring", "incident", id],
    queryFn: () => call<Incident>("/monitoring/incidents/" + id),
    refetchInterval: config.VITE_STATUS_POLL_MS,
    retry: false,
  });
  if (!q.data)
    return (
      <p role="status">
        {q.isError ? "Incident unavailable." : "Loading incident…"}
      </p>
    );
  const i = q.data;
  return (
    <>
      <Link className="cc-back" to="/control/incidents">
        ← Incident history
      </Link>
      <section className="cc-panel">
        <p className="cc-kicker">
          {i.severity.toUpperCase()} · {i.source}
        </p>
        <div className="cc-section-head">
          <h2>{i.component} availability incident</h2>
          <Badge state={i.state} />
        </div>
        <p className="cc-note">{i.id}</p>
        <div className="cc-detail-facts">
          <div>
            First observed<strong>{clock(i.first_observed_at)}</strong>
          </div>
          <div>
            Confirmed detection<strong>{clock(i.detected_at)}</strong>
          </div>
          <div>
            Detection confirmation delay
            <strong>{elapsed(i.detection_ms)}</strong>
          </div>
          <div>
            First successful probe<strong>{clock(i.restored_at)}</strong>
          </div>
          <div>
            Recovery verified<strong>{clock(i.verified_at)}</strong>
          </div>
          <div>
            Observed unavailability<strong>{elapsed(i.duration_ms)}</strong>
          </div>
        </div>
        <p className="cc-note">
          Confirmation delay begins at the first failed probe, not fault
          injection. Restart-spanning durations use UTC wall clocks.
          Verification applies to this component only; routing failover and
          playback recovery remain unverified unless separate evidence exists.
          Recovery attempts, when present, are recorded separately below.
        </p>
        <Recoveries incidentId={i.id} />
        <h3>Observation timeline</h3>
        <ol className="cc-timeline">
          {i.events?.map((e, n) => (
            <li key={n}>
              <span className="cc-timeline-dot" />
              <div>
                <Badge state={e.state} />
                <time>{clock(e.at)}</time>
                <pre>{JSON.stringify(e.evidence, null, 2)}</pre>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
function ServiceDetail({
  snapshot,
  stale,
}: {
  snapshot: MonitoringSnapshot;
  stale: boolean;
}) {
  const { id } = useParams(),
    c = snapshot.components.find((c) => c.id === id),
    history = useIncidents("?component=" + encodeURIComponent(id || ""));
  if (!c) return <p>Component not found in current inventory.</p>;
  return (
    <>
      <Link className="cc-back" to="/control">
        ← Overview
      </Link>
      <section className="cc-panel">
        <p className="cc-kicker">{c.group} / SERVICE DETAILS</p>
        <div className="cc-section-head">
          <h2>{c.name}</h2>
          <Badge state={effective(c, stale)} />
        </div>
        <p>{c.role}</p>
        <div className="cc-detail-facts">
          <div>
            Latest probe<strong>{clock(c.observedAt)}</strong>
          </div>
          <div>
            Last successful probe<strong>{clock(c.lastSuccessAt)}</strong>
          </div>
          <div>
            Response time<strong>{elapsed(c.latencyMs)}</strong>
          </div>
          <div>
            Diagnostic code<strong>{c.code}</strong>
          </div>
          <div>
            Consecutive failures<strong>{c.failures}</strong>
          </div>
          <div>
            Consecutive successes<strong>{c.successes}</strong>
          </div>
        </div>
        <h3>Downstream dependencies</h3>
        <div className="cc-dependencies">
          {c.dependencies.map((d) => (
            <Link to={"/control/services/" + d} key={d}>
              {d} ↗
            </Link>
          ))}
          {!c.dependencies.length && (
            <p>No downstream dependencies in this inventory.</p>
          )}
        </div>
        <p className="cc-note">
          Probe latency measures this service’s configured health request.
          Type-specific metrics are available in the provisioned Grafana
          dashboard; missing resource metrics are not estimated.
        </p>
        <Recoveries component={c.id} />
        <h3>Recent incidents & transitions</h3>
        {history.isError ? (
          <p>History unavailable.</p>
        ) : (
          <IncidentRows rows={history.data?.incidents || []} />
        )}
      </section>
    </>
  );
}
function Console() {
  const location = useLocation();
  const auth = useAuth(),
    query = useQueryClient(),
    [transport, setTransport] = useState("Connecting"),
    [now, setNow] = useState(() => ({
      wall: Date.now(),
      monotonic: performance.now(),
    }));
  const snapshot = useSnapshot(now);
  const csrf = auth.csrf,
    refresh = auth.refresh;
  useEffect(() => {
    const timer = setInterval(
      () => setNow({ wall: Date.now(), monotonic: performance.now() }),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const socket = io({
      transports: ["websocket"],
      auth: { csrf },
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });
    socket.on("connect", () => {
      socket.emit("monitoring:subscribe", (reply: { ok: boolean }) => {
        setTransport(reply.ok ? "Connected" : "Access denied");
        void query.invalidateQueries({ queryKey: ["monitoring"] });
      });
    });
    socket.on("monitoring:v1", (event: { kind: string }) => {
      if (["recovery_changed", "chaos_changed"].includes(event.kind)) {
        void query.invalidateQueries({ queryKey: ["monitoring", "timeline"] });
        void query.invalidateQueries({ queryKey: ["monitoring", "healing"] });
        void query.invalidateQueries({ queryKey: ["monitoring", "chaos"] });
      }
      void query.invalidateQueries({ queryKey: ["monitoring", "snapshot"] });
      void query.invalidateQueries({ queryKey: ["monitoring", "incidents"] });
      void query.invalidateQueries({ queryKey: ["monitoring", "incident"] });
    });
    socket.on("transport-status", (status: { available: boolean }) => {
      setTransport(
        status.available ? "Connected" : "Realtime degraded · REST fallback",
      );
      void query.invalidateQueries({ queryKey: ["monitoring"] });
    });
    socket.on("disconnect", () =>
      setTransport("Disconnected · reconciling by REST"),
    );
    socket.on("connect_error", () =>
      setTransport("Reconnecting · REST fallback"),
    );
    socket.on("monitoring:denied", () => {
      setTransport("Access denied");
      query.removeQueries({ queryKey: ["monitoring"] });
      void refresh();
      socket.disconnect();
    });
    socket.on("monitoring:unavailable", () =>
      setTransport("Authorization unavailable"),
    );
    return () => {
      socket.disconnect();
    };
  }, [csrf, query, refresh]);
  const s = snapshot.data,
    stale =
      !s ||
      s.stale ||
      observationFreshness(s.observedAt, snapshot.freshNow, s.staleAfterMs) !==
        "fresh" ||
      s.components.some(
        (c) =>
          observationFreshness(
            c.observedAt,
            snapshot.freshNow,
            s.staleAfterMs,
          ) !== "fresh",
      ) ||
      snapshot.isError;
  const counts = {
    HEALTHY: 0,
    DEGRADED: 0,
    UNHEALTHY: 0,
    UNKNOWN: 0,
    RECOVERING: 0,
  };
  // A stopped spare is standby capacity, not an unknown or failed component.
  s?.components
    .filter((c) => c.code !== "spare_standby" && !idleLoadObservation(c))
    .forEach((c) => counts[effective(c, stale)]++);
  let state: HealthState = stale ? "UNKNOWN" : "HEALTHY";
  if (!stale && s) {
    const down = (id: string) =>
      s.components.find((c) => c.id === id)?.state === "UNHEALTHY";
    if (
      [
        "postgres",
        "redis",
        "relay",
        "web",
        "api-gateway",
        "video-gateway",
      ].some(down) ||
      [
        ["api-1", "api-2"],
        ["edge-1", "edge-2"],
        ["origin-primary", "origin-standby"],
      ].some((ids) => ids.every(down))
    )
      state = "UNHEALTHY";
    else if (counts.UNKNOWN) state = "UNKNOWN";
    else if (counts.DEGRADED || counts.UNHEALTHY || counts.RECOVERING)
      state = "DEGRADED";
  }
  return (
    <div className="cc-app">
      <aside className="cc-sidebar">
        <Brand product="Control" />
        <p className="cc-workspace-label">RELIABILITY WORKSPACE</p>
        <nav aria-label="Control navigation">
          <NavLink end to="/control">
            <span>▦</span>Overview
          </NavLink>
          <NavLink to="/control/topology">
            <span>⌘</span>Infrastructure
          </NavLink>
          <NavLink to="/control/incidents">
            <span>◷</span>Incidents{" "}
            <b>
              {s?.incidentHistoryAvailable === false
                ? "—"
                : (s?.openCount ?? "—")}
            </b>
          </NavLink>
          <NavLink to="/control/metrics">
            <span>⌁</span>Metrics
          </NavLink>
          <NavLink to="/control/logs">
            <span>≡</span>System logs
          </NavLink>
          <NavLink to="/control/recoveries">
            <span>⟳</span>Recoveries
          </NavLink>
          <NavLink to="/control/three-stream-demo">
            <span>◉</span>Three-stream demo
          </NavLink>
          <NavLink to="/control/capacity">
            <span>⌁</span>Capacity
          </NavLink>
          <NavLink to="/control/self-healing">
            <span>↻</span>API + video demo
          </NavLink>
          <NavLink to="/control/chaos">
            <span>ϟ</span>Chaos Lab
          </NavLink>
          <NavLink to="/control/demo">
            <span>▷</span>Live Demo
          </NavLink>
          <NavLink to="/control/presentation">
            <span>◎</span>Presentation
          </NavLink>
          <NavLink to="/control/analysis">
            <span>▤</span>Analysis
          </NavLink>
        </nav>
        <div className="cc-sidebar-bottom">
          <p>
            <span className="cc-pulse" /> Independent observer
          </p>
          <small>
            Observation & verified recovery
            <br />
            Controlled experiments · Phase 7
          </small>
          <Link to="/">← StreamShield Live</Link>
        </div>
      </aside>
      <div className="cc-workspace">
        <header className="cc-topbar">
          <span>
            Operations <span className="cc-slash">/</span>{" "}
            <strong>Control Center</strong>
          </span>
          <div>
            <span className="cc-transport">{transport}</span>
            <span className="cc-admin">
              {auth.user?.username} <small>ADMIN</small>
            </span>
          </div>
        </header>
        <main
          id="main"
          className={
            "cc-main" +
            ([
              "/control/chaos",
              "/control/demo",
              "/control/capacity",
              "/control/three-stream-demo",
              "/control/logs",
            ].includes(location.pathname) ||
            /^\/control\/(presentation|analysis)/.test(location.pathname)
              ? " chaos-focused"
              : "")
          }
        >
          <div className="cc-page-title">
            <div>
              <p className="cc-kicker">STREAMSHIELD / LIVE OPERATIONS</p>
              <h1>Every signal. One clear picture.</h1>
              <p>
                Infrastructure health, media evidence and durable incident
                history.
              </p>
            </div>
            <Badge state={state} />
          </div>
          <div className="cc-status-strip">
            <div>
              <span className="cc-pulse" />
              <strong>
                {stale
                  ? "Telemetry stale or unavailable"
                  : "Observations current"}
              </strong>
              <span>
                Last probe {shortTime(s?.observedAt)} · Durable checkpoint{" "}
                {shortTime(
                  s?.durableObservedAt === undefined
                    ? s?.observedAt
                    : s.durableObservedAt,
                )}
              </span>
            </div>
            <span>
              {s?.persistence
                ? "Persistence available"
                : "Persistence unconfirmed"}{" "}
              · read-only operations
            </span>
          </div>
          {s && !s.persistence && (
            <p role="status" className="cc-notice">
              Monitoring persistence is unavailable or behind. Component states
              below are independent probe results; new fault admission remains
              disabled.
            </p>
          )}
          {s?.incidentHistoryAvailable === false && (
            <p role="status" className="cc-notice">
              Durable incident history/counts are unavailable or stale. Retained
              rows do not establish current recovery.
            </p>
          )}
          {stale && (
            <p role="alert" className="cc-notice">
              Live health cannot be confirmed. All component states are UNKNOWN
              until a fresh authoritative snapshot arrives.{" "}
              {snapshot.isError ? "Monitoring request unavailable." : ""}
            </p>
          )}
          <section className="cc-stat-grid" aria-label="Operational summary">
            {[
              [
                "Monitored services",
                s?.components.length ?? "—",
                "Configured infrastructure",
              ],
              [
                "Healthy",
                counts.HEALTHY,
                counts.DEGRADED +
                  " degraded · " +
                  counts.UNHEALTHY +
                  " unhealthy",
              ],
              [
                "Open incidents",
                s?.incidentHistoryAvailable === false
                  ? "—"
                  : (s?.openCount ?? "—"),
                "Durable detection records",
              ],
              [
                "Verified restorations",
                s?.incidentHistoryAvailable === false
                  ? "—"
                  : (s?.verifiedCount ?? "—"),
                "Consecutive probe evidence",
              ],
            ].map(([label, value, note]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{note}</small>
              </article>
            ))}
          </section>
          <RecoverySummary />
          {!s ? (
            <section className="cc-panel">
              <h2>
                {snapshot.isError
                  ? "Monitoring unavailable"
                  : "Connecting to the observer…"}
              </h2>
              <p>
                {snapshot.isError
                  ? "Check monitoring deployment and authorized session. No infrastructure state can be inferred."
                  : "Loading an authenticated operational snapshot."}
              </p>
              <button onClick={() => void snapshot.refetch()}>
                Refresh snapshot
              </button>
            </section>
          ) : (
            <Routes>
              <Route index element={<Overview snapshot={s} stale={stale} />} />
              <Route
                path="topology"
                element={<Topology components={s.components} stale={stale} />}
              />
              <Route path="capacity" element={<CapacityPage />} />
              <Route
                path="three-stream-demo"
                element={<ThreeStreamDemo snapshot={s} />}
              />
              <Route
                path="self-healing"
                element={
                  <CrashDemonstration components={s.components} stale={stale} />
                }
              />
              <Route
                path="chaos"
                element={<ChaosLab components={s.components} stale={stale} />}
              />
              <Route
                path="demo"
                element={
                  <ChaosDemo
                    components={s.components}
                    stale={stale}
                    topology={
                      <Topology components={s.components} stale={stale} />
                    }
                  />
                }
              />
              <Route
                path="presentation"
                element={
                  <Presentation components={s.components} stale={stale} />
                }
              />
              <Route path="presentation/report" element={<RecoveryReport />} />
              <Route path="analysis" element={<Analysis />} />
              <Route path="analysis/:id" element={<ExperimentAnalysis />} />
              <Route path="metrics" element={<MetricsPage />} />
              <Route path="logs" element={<SystemLogs />} />
              <Route path="recoveries" element={<Recoveries />} />
              <Route path="incidents" element={<History />} />
              <Route path="incidents/:id" element={<IncidentDetail />} />
              <Route
                path="services/:id"
                element={<ServiceDetail snapshot={s} stale={stale} />}
              />
              <Route path="*" element={<p>Control page not found.</p>} />
            </Routes>
          )}
          <footer className="cc-footer">
            <span>StreamShield Control · Recovery audit v1</span>
            <span>
              UTC evidence · {counts.UNKNOWN} unknown · Allowlisted recovery
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
export default function Control() {
  const auth = useAuth();
  return (
    <Protected>
      {auth.user?.role === "administrator" ? (
        <Console />
      ) : (
        <div className="cc-access">
          <Brand product="Control" />
          <h1>Administrator access required</h1>
          <p>
            Your account does not have permission to view infrastructure or
            incident data.
          </p>
          <Link className="button secondary" to="/">
            Return to Live
          </Link>
        </div>
      )}
    </Protected>
  );
}
