import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchStream } from "../api";
import { config } from "../config";
import { LivePlayer } from "./LivePlayer";

export default function Watch() {
  const { id = "" } = useParams();
  const query = useQuery({
    queryKey: ["stream", id],
    queryFn: ({ signal }) => fetchStream(id, signal),
    refetchInterval: config.VITE_STREAM_POLL_MS,
    retry: false,
  });
  const stream = query.data;
  return (
    <>
      <div className="page-heading">
        <Link className="eyebrow" to="/">
          ← PLATFORM OVERVIEW
        </Link>
        <span className="tag">PHASE 02 / LIVE VIDEO</span>
      </div>
      <div className="watch-heading">
        <div>
          <span className="eyebrow">THE LIVE EXPERIENCE</span>
          <h1>{stream?.title || "Live player"}</h1>
          <p>One genuine source. A direct media delivery path.</p>
        </div>
        <span
          className={`source-badge ${!query.isError && stream?.status === "live" ? "available" : ""}`}
        >
          {query.isPending
            ? "Checking source"
            : query.isError
              ? "Source status unknown"
              : stream?.status === "live"
                ? "Source available"
                : stream?.status === "offline"
                  ? "Publisher offline"
                  : stream?.status === "starting"
                    ? "Preparing HLS"
                    : "Origin unavailable"}
        </span>
      </div>
      <div className="watch-grid">
        <section className="watch-main" aria-label="Video playback">
          {stream?.status === "live" ? (
            <LivePlayer key={stream.playbackUrl} source={stream.playbackUrl} />
          ) : (
            <div className="video-empty">
              <span className="empty-icon" aria-hidden="true">
                ▷
              </span>
              <h2>
                {query.isPending
                  ? "Finding your signal…"
                  : query.isError
                    ? "Unable to check this stream"
                    : stream?.status === "offline"
                      ? "Waiting for a broadcaster"
                      : stream?.status === "starting"
                        ? "Your source is warming up"
                        : "The origin could not be reached"}
              </h2>
              <p>
                {stream?.status === "offline"
                  ? "Start OBS or the bounded FFmpeg test publisher. This page checks for source availability automatically."
                  : "Publisher availability and HLS delivery must both be verified before loading video."}
              </p>
              <button
                className="button secondary"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
              >
                {query.isFetching ? "Checking…" : "Check source again"}
              </button>
            </div>
          )}
          {query.isError && stream && (
            <p className="observation-warning" role="status">
              Current source status is unknown. Any ongoing playback is
              independent of this failed metadata check.
            </p>
          )}
          <div className="media-evidence panel">
            <span className="eyebrow">LATEST SOURCE OBSERVATION</span>
            <dl>
              <div>
                <dt>Publisher</dt>
                <dd>
                  {query.isError ? "unknown" : stream?.publisher || "checking"}
                </dd>
              </div>
              <div>
                <dt>HLS manifest</dt>
                <dd>
                  {query.isError
                    ? "unknown"
                    : stream?.hls.replace("_", " ") || "checking"}
                </dd>
              </div>
              <div>
                <dt>Tracks</dt>
                <dd>{stream?.tracks.join(" · ") || "Not observed"}</dd>
              </div>
              <div>
                <dt>Observed at</dt>
                <dd>
                  {stream
                    ? new Date(stream.checkedAt).toLocaleTimeString()
                    : "Pending"}
                </dd>
              </div>
            </dl>
            <p>
              A verified playlist confirms availability, not successful playback
              on every device. No viewer counts or recovery metrics are
              estimated.
            </p>
          </div>
        </section>
        <aside className="broadcast-guide panel">
          <span className="eyebrow">BRING YOUR OWN SIGNAL</span>
          <h2>Make it live.</h2>
          <ol>
            <li>
              <strong>Start the media origin</strong>
              <p>
                Prepare local credentials, then start the Docker services using
                the README.
              </p>
            </li>
            <li>
              <strong>Connect your broadcaster</strong>
              <p>
                Use OBS with H.264 / AAC, or run{" "}
                <code>npm run broadcast:test</code> for an explicitly labelled
                test pattern.
              </p>
            </li>
            <li>
              <strong>Watch the real result</strong>
              <p>
                Source availability and browser playback are reported
                independently. Allow a few seconds for HLS buffering.
              </p>
            </li>
          </ol>
          <div className="guide-footnote">
            Publishing credentials stay in your local environment. They are
            never returned by this API.
          </div>
        </aside>
      </div>
      <section className="planned panel">
        <span className="tag">CLEAR BOUNDARIES</span>
        <h2>Live streaming, without invented resilience.</h2>
        <p>
          Bounded player reconnection can reopen an available source. It cannot
          restart an origin or restore a broadcaster. Redundancy, incident
          tracking and automatic infrastructure healing come in later phases.
        </p>
      </section>
    </>
  );
}
