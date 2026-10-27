import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { systemLogsSchema, type SystemLog } from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import "./logs.css";

export function SystemLogs() {
  const { call } = useAuth();
  const [hours, setHours] = useState(1);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("all");
  const [source, setSource] = useState("all");
  const q = useQuery({
    queryKey: ["monitoring", "logs", hours],
    queryFn: async () =>
      systemLogsSchema.parse(await call("/monitoring/logs?hours=" + hours)),
    refetchInterval: paused ? false : 5000,
    refetchOnWindowFocus: !paused,
    refetchOnReconnect: !paused,
    retry: false,
  });
  const needle = search.trim().toLowerCase();
  const entries = (q.data?.entries || []).filter(
    (entry) =>
      (level === "all" || entry.level === level) &&
      (source === "all" || entry.source === source) &&
      (!needle ||
        [entry.component, entry.message, entry.nextStep].some((part) =>
          part?.toLowerCase().includes(needle),
        )),
  );
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ ...q.data, entries }, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "streamshield-system-logs.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="system-logs" aria-labelledby="system-logs-heading">
      <header className="logs-header">
        <div>
          <p className="cc-kicker">SYSTEM ACTIVITY</p>
          <h1 id="system-logs-heading">Logs you can understand.</h1>
          <p>
            Health changes, broadcasts, failures and recovery decisions,
            explained in plain language.
          </p>
        </div>
        <Link to="/control/chaos">Open failure dashboard →</Link>
      </header>
      <div className="logs-controls">
        <label>
          Search logs
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Video, database, human action…"
          />
        </label>
        <label>
          Time window
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            <option value={1}>Last hour</option>
            <option value={6}>Last 6 hours</option>
            <option value={24}>Last 24 hours</option>
          </select>
        </label>
        <label>
          Severity
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="all">All severities</option>
            <option value="info">Information</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label>
          Source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">All sources</option>
            <option value="health">Health checks</option>
            <option value="broadcast">Broadcasts</option>
            <option value="experiment">Failure experiments</option>
            <option value="recovery">Automatic recovery</option>
          </select>
        </label>
      </div>
      <div className="logs-toolbar">
        <p role="status">
          {q.isError
            ? "Log refresh failed; retained entries below may be outdated."
            : q.isPending
              ? "Loading recorded events…"
              : `${entries.length} matching events · ${paused ? "Auto-refresh paused" : "Refreshes every 5 seconds"}`}
        </p>
        <div>
          <button onClick={() => setPaused(!paused)}>
            {paused ? "Resume updates" : "Pause updates"}
          </button>
          <button disabled={q.isFetching} onClick={() => void q.refetch()}>
            Refresh
          </button>
          <button disabled={!q.data} onClick={download}>
            Download filtered logs
          </button>
        </div>
      </div>
      {q.data?.partial && (
        <p className="logs-warning" role="alert">
          Some history is unavailable: {q.data.unavailableSources.join(", ")}.
          Missing events do not mean the system was healthy.
        </p>
      )}
      {q.data?.truncated && (
        <p className="logs-warning">
          Showing the newest 500 recorded events. Choose a shorter window to
          inspect busy periods.
        </p>
      )}
      <p className="logs-note">
        Recorded operational events, newest first. Routine requests and camera
        previews are not recorded here. This page contains no stream keys,
        credentials or private chat messages.
      </p>
      <ol className="logs-feed" aria-label="System log entries">
        {entries.map((entry) => (
          <LogEntry key={entry.id} entry={entry} />
        ))}
      </ol>
      {!q.isPending && !entries.length && (
        <div className="cc-panel">
          {q.isError
            ? "Log history could not be loaded. Use Refresh to try again."
            : "No recorded events match these filters. Try a wider time window or clear the filters."}
        </div>
      )}
      {q.data && (
        <p className="logs-note">
          Last history read: {new Date(q.data.observedAt).toLocaleString()}.
          Logs belong to this deployment only.
        </p>
      )}
    </section>
  );
}
function LogEntry({ entry }: { entry: SystemLog }) {
  return (
    <li className={"log-entry log-" + entry.level}>
      <div className="log-stamp">
        <time dateTime={entry.at}>
          {new Date(entry.at).toLocaleTimeString()}
        </time>
        <span>{entry.level === "info" ? "Information" : entry.level}</span>
      </div>
      <div className="log-body">
        <div className="log-meta">
          <strong>{entry.component}</strong>
          <span>{entry.source}</span>
        </div>
        <p>{entry.message}</p>
        {entry.nextStep && (
          <p className="log-next">
            <strong>Next step:</strong> {entry.nextStep}
          </p>
        )}
        {entry.experimentId && (
          <Link to={"/control/analysis/" + entry.experimentId}>
            View experiment evidence →
          </Link>
        )}
      </div>
    </li>
  );
}
