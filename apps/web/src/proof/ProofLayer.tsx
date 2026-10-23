import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { healthSchema } from "@streamshield/shared";
import { request } from "../api";
import { config } from "../config";
import { instanceLabel, useTelemetry } from "./telemetry";

const PROBE_MS = 3000;
/**
 * Shown only while real requests cannot reach any API instance. It probes
 * readiness itself and disappears the moment a real answer arrives, then
 * reloads every query so the page's data comes back without a refresh.
 */
export function OutageBanner() {
  const t = useTelemetry();
  const client = useQueryClient();
  const down = t.outageSince !== null && t.failures >= 1;
  const [next, setNext] = useState(PROBE_MS);
  const [elapsed, setElapsed] = useState(0);
  const wasDown = useRef(false);
  useEffect(() => {
    if (!down) {
      if (wasDown.current) void client.invalidateQueries();
      wasDown.current = false;
      return;
    }
    wasDown.current = true;
    let due = Date.now() + PROBE_MS;
    const tick = setInterval(() => {
      const left = due - Date.now();
      if (left <= 0) {
        due = Date.now() + PROBE_MS;
        void request("/health/ready", healthSchema).catch(() => {});
      }
      setNext(Math.max(0, due - Date.now()));
      if (t.outageSince) setElapsed(Date.now() - t.outageSince);
    }, 250);
    return () => clearInterval(tick);
  }, [down, client, t.outageSince]);
  if (!down) return null;
  const seconds = Math.ceil(next / 1000);
  return (
    <div className="outage-banner" role="alert" data-testid="outage-banner">
      <span className="outage-icon" aria-hidden="true">
        ✕
      </span>
      <div>
        <strong>StreamShield can’t reach the server — retrying…</strong>
        <span>
          Retrying in {seconds}s · unreachable for{" "}
          {Math.max(0, Math.round(elapsed / 1000))}s. Live video uses a separate
          path and may keep playing.
        </span>
      </div>
    </div>
  );
}
/** Footer proof of which redundant API instance answered real requests. */
export function ServedByBadge({ signedIn }: { signedIn: boolean }) {
  const t = useTelemetry();
  if (!config.VITE_SHOW_SERVING_INSTANCE || !signedIn) return null;
  const seen = [...new Set(t.recent.map((r) => r.instance))].sort();
  return (
    <span
      className={
        "served-by" +
        (t.outageSince ? " is-down" : t.servedBy ? " is-up" : " is-unknown")
      }
      data-testid="served-by"
      data-instance={t.servedBy || ""}
      title="From the X-Served-By header of real responses (demo builds only)"
    >
      <span aria-hidden="true">
        {t.outageSince ? "✕" : t.servedBy ? "✓" : "?"}
      </span>
      {t.outageSince ? (
        "No API reachable"
      ) : (
        <>
          Served by <strong>{instanceLabel(t.servedBy)}</strong>
          {t.latencyMs !== null && (
            <span data-testid="request-latency"> · {t.latencyMs} ms</span>
          )}
          {seen.length > 1 && (
            <span className="served-seen">
              {" "}
              · last 30 s: {seen.map(instanceLabel).join(", ")}
            </span>
          )}
        </>
      )}
    </span>
  );
}
