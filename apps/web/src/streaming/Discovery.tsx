import { lazy, Suspense } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Stream } from "@streamshield/shared";
import { useStreams } from "./useStreams";
import { Icon } from "../ui/Icon";
import { StatusBadge } from "../ui/StatusBadge";
const Preview = lazy(() =>
  import("./LivePlayer").then((module) => ({ default: module.LivePlayer })),
);

function StreamCard({ stream }: { stream: Stream }) {
  return (
    <Link
      className="stream-card"
      to={"/watch/" + encodeURIComponent(stream.id)}
      aria-label={"Watch " + stream.title}
    >
      <div className="stream-cover">
        <span className="cover-lines" aria-hidden="true" />
        <span className="cover-play">
          <Icon name="play" />
        </span>
        <span className="cover-caption">
          {stream.status === "live"
            ? "Open live video"
            : "Channel preview unavailable"}
        </span>
        <StatusBadge status={stream.status} />
      </div>
      <div className="stream-card-info">
        <span className="channel-symbol">
          <Icon name="studio" />
        </span>
        <div>
          <h3>{stream.title}</h3>
          <p>
            {stream.status === "live"
              ? "Ready to watch"
              : stream.status === "offline"
                ? "Waiting for the next broadcast"
                : stream.status === "starting"
                  ? "Preparing the stream"
                  : "Availability could not be verified"}
          </p>
        </div>
        <Icon name="chevron" />
      </div>
    </Link>
  );
}
function QuietState({
  title = "A little quiet, for now.",
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="quiet-state">
      <span className="state-symbol">
        <Icon name="live" />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </div>
  );
}
export function Discovery({
  view = "home",
}: {
  view?: "home" | "live" | "search";
}) {
  const query = useStreams();
  const [params] = useSearchParams();
  const term = params.get("q")?.trim() || "";
  const streams = query.isError ? [] : query.data?.streams || [];
  const live = streams.filter((stream) => stream.status === "live");
  const featured = live[0] || streams[0];
  const results = streams.filter((stream) =>
    `${stream.title} ${stream.id}`
      .toLocaleLowerCase()
      .includes(term.toLocaleLowerCase()),
  );
  const heading =
    view === "search"
      ? "Find your next stream."
      : view === "live"
        ? "Live, right now."
        : "A good place to tune in.";
  return (
    <div className="discovery-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            {view === "search"
              ? "Search"
              : view === "live"
                ? "On air"
                : "Welcome to StreamShield Live"}
          </p>
          <h1>{heading}</h1>
          <p className="page-subtitle">
            {view === "search"
              ? "Search the available channels by title or channel name."
              : view === "live"
                ? "Real broadcasts. Happening in the moment."
                : "Discover a live moment worth staying for."}
          </p>
        </div>
        <span className="subtle-chip">
          <Icon name="live" />
          {query.isPending
            ? "Checking streams"
            : query.isError
              ? "Status unavailable"
              : live.length
                ? `${live.length} live ${live.length === 1 ? "stream" : "streams"}`
                : "No streams live right now"}
        </span>
      </div>
      {view === "home" && (
        <section className="featured" aria-label="Featured stream">
          <div className="featured-media">
            {featured?.status === "live" ? (
              <Suspense fallback={<p role="status">Loading live preview…</p>}>
                <Preview source={featured.playbackUrl} sourceId={featured.id} />
              </Suspense>
            ) : (
              <div className="featured-offline">
                <div className="signal-art" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <Icon name="live" />
                </div>
                <div className="stage-label">
                  <span className="channel-dot offline" />
                  {query.isPending
                    ? "Finding the next broadcast"
                    : query.isError
                      ? "Stream status unavailable"
                      : "No broadcast on air"}
                </div>
                <p>There’s room for your next live moment.</p>
                <span className="stage-wordmark">
                  StreamShield<span>Live</span>
                </span>
              </div>
            )}
          </div>
          <div className="featured-info">
            <span className="feature-kicker">
              <Icon name={featured?.status === "live" ? "live" : "clock"} />
              {featured?.status === "live"
                ? "Featured live stream"
                : "Between live moments"}
            </span>
            <h2>
              {featured?.status === "live"
                ? featured.title
                : "Great things happen live."}
            </h2>
            <p>
              {featured?.status === "live"
                ? "The source is available. Join the stream and see what’s happening."
                : query.isError
                  ? "We couldn’t check the channels just now. Try again in a moment."
                  : "No broadcaster is live right now. Explore the available channel, and drop in when the next broadcast begins."}
            </p>
            <div className="featured-actions">
              {featured && (
                <Link
                  className="button primary"
                  to={"/watch/" + encodeURIComponent(featured.id)}
                >
                  {featured.status === "live" ? "Watch live" : "Visit channel"}
                  <Icon name="arrow" />
                </Link>
              )}
              <Link className="text-link" to="/live">
                Browse live streams
                <Icon name="chevron" />
              </Link>
            </div>
            <div className="feature-bottom">
              <Icon name="shield" />
              <span>Your stream. A stronger connection.</span>
            </div>
          </div>
        </section>
      )}
      {query.isPending ? (
        <div className="loading-surface" role="status">
          <Icon name="refresh" />
          Finding available streams…
        </div>
      ) : query.isError ? (
        <section className="panel error-surface">
          <QuietState title="We couldn’t load the streams.">
            Your connection or the streaming service may be unavailable. No
            cached channel is shown as live.
          </QuietState>
          <button
            className="button secondary"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <Icon name="refresh" />
            Retry discovery
          </button>
        </section>
      ) : view === "search" ? (
        <section>
          <div className="section-heading">
            <h2>
              {term ? `Results for “${term}”` : "Search available channels"}
            </h2>
            <span className="muted">
              {term
                ? `${results.length} ${results.length === 1 ? "result" : "results"}`
                : "Enter a title above"}
            </span>
          </div>
          {!term ? (
            <QuietState title="What would you like to watch?">
              Use the search field to find a channel by its real title or name.
            </QuietState>
          ) : results.length ? (
            <div className="stream-grid">
              {results.map((stream) => (
                <StreamCard key={stream.id} stream={stream} />
              ))}
            </div>
          ) : (
            <QuietState title="No matching channels.">
              Try a different title, or{" "}
              <Link className="inline-link" to="/live">
                browse live streams
              </Link>
              .
            </QuietState>
          )}
        </section>
      ) : (
        <>
          <section className="live-section">
            <div className="section-heading">
              <h2>
                <span className="live-heading-dot" />
                Live now
              </h2>
              <span className="muted">
                {live.length
                  ? `${live.length} available`
                  : "The next moment is still to come"}
              </span>
            </div>
            {live.length ? (
              <div className="stream-grid">
                {live.map((stream) => (
                  <StreamCard key={stream.id} stream={stream} />
                ))}
              </div>
            ) : (
              <QuietState>
                No streams are live right now. When a broadcaster goes on air,
                you’ll find them here.
              </QuietState>
            )}
          </section>
          {streams.filter((stream) => stream.status !== "live").length > 0 && (
            <section>
              <div className="section-heading">
                <h2>Available channels</h2>
                <span className="muted">Find a channel to return to</span>
              </div>
              <div className="stream-grid">
                {streams
                  .filter((stream) => stream.status !== "live")
                  .map((stream) => (
                    <StreamCard key={stream.id} stream={stream} />
                  ))}
              </div>
            </section>
          )}
        </>
      )}
      {view === "home" && (
        <section className="explore-banner">
          <span className="explore-symbol">
            <Icon name="grid" />
          </span>
          <div>
            <div className="inline-heading">
              <h2>More ways to discover.</h2>
              <span className="soon-badge">Coming soon</span>
            </div>
            <p>
              Explore by category as creator tools become available. For now,
              every available channel is right here.
            </p>
          </div>
          <Link className="button secondary" to="/explore">
            Explore
            <Icon name="arrow" />
          </Link>
        </section>
      )}
    </div>
  );
}
export function Explore() {
  return (
    <div className="explore-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Explore</p>
          <h1>Find your kind of live.</h1>
          <p className="page-subtitle">
            More paths to the streams you’ll love.
          </p>
        </div>
        <span className="soon-badge">Coming soon</span>
      </div>
      <section className="category-empty">
        <div className="category-art" aria-hidden="true">
          <span>
            <Icon name="grid" />
          </span>
          <span>
            <Icon name="live" />
          </span>
          <span>
            <Icon name="spark" />
          </span>
        </div>
        <h2>Categories are on the way.</h2>
        <p>
          Channels don’t publish category information yet. You can still browse
          real streams and search available channel titles.
        </p>
        <Link className="button primary" to="/live">
          Browse live streams
          <Icon name="arrow" />
        </Link>
      </section>
    </div>
  );
}
