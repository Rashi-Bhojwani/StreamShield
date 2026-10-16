import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchStreams } from "../api";
import { config } from "../config";

export function Discovery() {
  const query = useQuery({
    queryKey: ["streams"],
    queryFn: ({ signal }) => fetchStreams(signal),
    refetchInterval: config.VITE_STREAM_POLL_MS,
  });
  const stream = query.data?.streams[0];
  return (
    <section className="panel discovery">
      <div className="panel-heading">
        <span className="eyebrow">LIVE DISCOVERY</span>
        <span className="tag">RTMP → HLS</span>
      </div>
      {query.isPending ? (
        <p role="status">Checking the media origin…</p>
      ) : query.isError || !stream ? (
        <>
          <h3>Stream status unavailable</h3>
          <p role="status">Could not retrieve current stream information.</p>
          <button
            className="text-button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            Retry discovery
          </button>
        </>
      ) : (
        <>
          <div className="discovery-title">
            <span
              className={`status-dot ${stream.status === "live" ? "ready" : stream.status === "unavailable" ? "error" : "pending"}`}
            />
            <h3>{stream.title}</h3>
            <span className="tag">
              {stream.status === "live"
                ? "SOURCE AVAILABLE"
                : stream.status.toUpperCase()}
            </span>
          </div>
          <p>
            {stream.status === "offline"
              ? "No streams yet. Start an OBS or FFmpeg publisher to go live."
              : stream.status === "live"
                ? "Publisher online and HLS playlist verified. Open the player to watch."
                : stream.status === "starting"
                  ? "Publisher connected. Waiting for a verified HLS playlist."
                  : "The origin could not be verified. This does not establish whether a publisher is offline."}
          </p>
          <Link
            className="text-button"
            to={"/watch/" + encodeURIComponent(stream.id)}
          >
            Open live player <span aria-hidden="true">→</span>
          </Link>
        </>
      )}
    </section>
  );
}
