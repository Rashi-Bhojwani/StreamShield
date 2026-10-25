import type { PlaybackObservation } from "@streamshield/shared";
import { Chat } from "../platform/Chat";
import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchStream } from "../api";
import { config } from "../config";
import { LivePlayer } from "./LivePlayer";
import {
  readHealthPreference,
  writeHealthPreference,
} from "./health-preference";
import { Icon } from "../ui/Icon";
import { StatusBadge } from "../ui/StatusBadge";
import { ConnectionStatus } from "../ui/ConnectionStatus";

export default function Watch() {
  const playerContainer = useRef<HTMLElement>(null);
  const { id = "" } = useParams();
  const [diagnostics, setDiagnostics] = useState(false);
  const [observation, setObservation] = useState<PlaybackObservation | null>(
    null,
  );
  const [shared, setShared] = useState("");
  const query = useQuery({
    queryKey: ["stream", id],
    queryFn: ({ signal }) => fetchStream(id, signal),
    refetchInterval: config.VITE_STREAM_POLL_MS,
    retry: false,
  });
  const stream = query.data;
  const [showHealth, setShowHealth] = useState(readHealthPreference);
  const reconnectingSource = ["CONNECTION_LOST", "RECONNECTING"].includes(
    stream?.broadcastState || "",
  );
  return (
    <div className="watch-page">
      <div className="watch-breadcrumb">
        <Link className="text-link" to="/live">
          <Icon name="chevron" />
          Live streams
        </Link>
        <span>{stream?.title || "Channel"}</span>
      </div>
      <div className="watch-layout">
        <section
          ref={playerContainer}
          className="watch-main"
          aria-label="Video playback"
        >
          {stream?.status === "live" ||
          (config.VITE_DYNAMIC_MODE &&
            stream?.status === "unavailable" &&
            observation?.metrics.sourceId === stream.id) ? (
            <LivePlayer
              key={stream.playbackUrl}
              source={stream.playbackUrl}
              alternateSources={stream.playbackSources}
              sourceId={stream.id}
              onObservation={setObservation}
              showHealth={showHealth && config.VITE_SHOW_SERVING_INSTANCE}
            />
          ) : (
            <div className="video-empty">
              <span className="video-empty-label">
                <Icon name="live" />
                {query.isPending
                  ? "Checking source"
                  : query.isError
                    ? "Status unknown"
                    : reconnectingSource
                      ? "Reconnecting"
                      : stream?.status === "offline"
                        ? "Offline"
                        : stream?.status === "starting"
                          ? "Connecting"
                          : "Origin unavailable"}
              </span>
              <div className="offline-player-art" aria-hidden="true">
                <Icon
                  name={
                    query.isError || stream?.status === "unavailable"
                      ? "refresh"
                      : "studio"
                  }
                />
              </div>
              <h2>
                {query.isPending
                  ? "Finding your signal…"
                  : query.isError
                    ? "Unable to check this stream"
                    : reconnectingSource
                      ? "Broadcaster reconnecting…"
                      : stream?.status === "unavailable"
                        ? "Video service reconnecting…"
                        : stream?.status === "offline"
                          ? "Waiting for a broadcaster"
                          : stream?.status === "starting"
                            ? "Your stream is getting ready"
                            : "The stream is unavailable"}
              </h2>
              <p>
                {reconnectingSource
                  ? "The broadcaster’s connection dropped. Keep this page open — playback returns by itself when their stream reconnects."
                  : stream?.status === "offline"
                    ? "This channel isn’t broadcasting right now. Keep this page open — the player will appear when the source returns."
                    : query.isError
                      ? "We couldn’t check the channel. Try again to see its current availability."
                      : "We’re waiting for a verified video source. Please try again in a moment."}
              </p>
              <button
                className="button secondary"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
              >
                <Icon name="refresh" />
                {query.isFetching ? "Checking…" : "Check source again"}
              </button>
            </div>
          )}
          {config.VITE_SHOW_SERVING_INSTANCE && (
            <button
              className="text-link stream-health-toggle"
              aria-pressed={showHealth}
              onClick={() => {
                writeHealthPreference(!showHealth);
                setShowHealth(!showHealth);
              }}
            >
              Stream health overlay: {showHealth ? "on" : "off"}
            </button>
          )}
          <div className="watch-information">
            <div className="stream-identity">
              <span className="channel-symbol large">
                <Icon name="studio" />
              </span>
              <div>
                <h1>{stream?.title || "Live channel"}</h1>
                <p>
                  {stream?.channelSlug ? (
                    <Link
                      className="inline-link"
                      to={"/channels/" + stream.channelSlug}
                    >
                      {stream.channelName} · @{stream.ownerUsername}
                    </Link>
                  ) : (
                    "Development compatibility channel"
                  )}
                </p>
              </div>
            </div>
            <div className="watch-info-actions">
              <StatusBadge
                status={
                  query.isPending || query.isError
                    ? "unknown"
                    : stream?.status || "unknown"
                }
              />
              <button
                className="button secondary share-button"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(window.location.href)
                    .then(() => setShared("Link copied"))
                    .catch(() =>
                      setShared("Copy the address from your browser to share."),
                    );
                  if (!navigator.clipboard)
                    setShared("Copy the address from your browser to share.");
                }}
              >
                <Icon name="share" />
                Share
              </button>
            </div>
          </div>
          {shared && (
            <p className="share-message" role="status">
              {shared}
            </p>
          )}
          {query.isError && stream && (
            <p className="observation-warning" role="status">
              Current source status is unknown. Ongoing playback is independent
              of this failed channel check.
            </p>
          )}
          <div className="stream-about">
            <h2>About this stream</h2>
            <p>
              {stream?.description ||
                (stream?.status === "live"
                  ? "A live broadcast on StreamShield. Use the player controls for sound, pause and fullscreen."
                  : "The next live moment starts when the broadcaster goes on air.")}
            </p>
          </div>
          <details
            className="advanced-diagnostics"
            onToggle={(event) => setDiagnostics(event.currentTarget.open)}
          >
            <summary>
              <Icon name="pulse" />
              Advanced stream diagnostics
              <Icon name="chevron" />
            </summary>
            {diagnostics && (
              <div className="diagnostics-content">
                {observation && observation.metrics.sourceId === id && (
                  <section aria-label="Measured browser playback">
                    <h3>Measured browser playback</h3>
                    <dl>
                      <div>
                        <dt>Source identifier</dt>
                        <dd>{observation.metrics.sourceId}</dd>
                      </div>
                      <div>
                        <dt>Playback startup</dt>
                        <dd data-testid="startup-metric">
                          {observation.metrics.startupMs === null
                            ? "Not observed"
                            : `${Math.round(observation.metrics.startupMs)} ms`}
                        </dd>
                      </div>
                      <div>
                        <dt>Stall count</dt>
                        <dd>{observation.metrics.stallCount}</dd>
                      </div>
                      <div>
                        <dt>Observed stall duration</dt>
                        <dd>
                          {Math.round(observation.metrics.stallDurationMs)} ms
                        </dd>
                      </div>
                      <div>
                        <dt>Last player event</dt>
                        <dd data-testid="player-event">
                          {observation.event.kind}
                        </dd>
                      </div>
                      <div>
                        <dt>Last playback error</dt>
                        <dd>
                          {observation.metrics.lastError?.code ||
                            "None observed"}
                        </dd>
                      </div>
                    </dl>
                    <p className="fine-print">
                      Local session measurements at the last event. Startup
                      requires advancing media time. Paused time is excluded
                      from stalls. Native HLS does not expose manifest or
                      segment events. These values are not infrastructure
                      recovery metrics.
                    </p>
                  </section>
                )}
                <dl>
                  <div>
                    <dt>Publisher</dt>
                    <dd>
                      {query.isError
                        ? "unknown"
                        : stream?.publisher || "checking"}
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
                    <dt>Observed tracks</dt>
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
                <p className="fine-print">
                  Source availability and decoded playback are independent. A
                  verified playlist does not guarantee playback on every device.
                  Player reconnect does not restart infrastructure.
                </p>
                <ConnectionStatus />
              </div>
            )}
          </details>
        </section>
        {stream?.channelId ? (
          <Chat
            ownerUsername={stream?.ownerUsername}
            key={stream.id}
            streamId={stream.id}
            playerContainer={playerContainer}
          />
        ) : (
          <aside className="chat-panel" aria-label="Live chat">
            <div className="chat-heading">
              <h2>
                <Icon name="chat" />
                Live chat
              </h2>
              <span className="soon-badge">Coming soon</span>
            </div>
            <div className="chat-empty">
              <span className="chat-illustration">
                <Icon name="chat" />
              </span>
              <h3>A place for the conversation.</h3>
              <p>
                Live chat isn’t available yet. For now, settle in and enjoy the
                stream.
              </p>
            </div>
            <div className="chat-unavailable">
              <Icon name="lock" />
              <span>Messaging is not available</span>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
