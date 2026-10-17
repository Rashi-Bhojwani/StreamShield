import { useQuery } from "@tanstack/react-query";
import { fetchFoundation } from "../api";
import { config } from "../config";
import { Icon } from "./Icon";
export function ConnectionStatus() {
  const query = useQuery({
    queryKey: ["foundation"],
    queryFn: ({ signal }) => fetchFoundation(signal),
    refetchInterval: config.VITE_STATUS_POLL_MS,
  });
  return (
    <section className="connection-status">
      <div>
        <span
          className={
            "channel-dot " +
            (query.isError
              ? "unavailable"
              : query.isPending
                ? "starting"
                : "live")
          }
        />
        <h2>
          {query.isPending
            ? "Checking API"
            : query.isError
              ? "API unavailable"
              : "API connected"}
        </h2>
      </div>
      <p role="status">
        {query.isPending
          ? "Checking application readiness…"
          : query.isError
            ? "Readiness could not be verified. Check your connection and the application service."
            : `Readiness verified · ${query.data.info.name} v${query.data.info.version}`}
      </p>
      <button
        className="button secondary"
        onClick={() => void query.refetch()}
        disabled={query.isFetching}
      >
        <Icon name="refresh" />
        {query.isFetching ? "Checking…" : "Check again"}
      </button>
      <p className="fine-print">
        Application readiness is separate from stream and video playback
        availability.
      </p>
    </section>
  );
}
