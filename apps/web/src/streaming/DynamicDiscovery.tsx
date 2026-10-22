import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { io } from "socket.io-client";
import {
  categories,
  discoveryEventSchema,
  streamListSchema,
  type Stream,
} from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import { request } from "../api";
import { config } from "../config";
import { LivePlayer } from "./LivePlayer";
import { Icon } from "../ui/Icon";
import "./dynamic.css";

function useLiveFeed(search: string, category: string, offset: number) {
  const auth = useAuth(),
    cache = useQueryClient();
  const query = useQuery({
    queryKey: ["live-feed", search, category, offset],
    queryFn: ({ signal }) =>
      request(
        "/live?q=" +
          encodeURIComponent(search) +
          "&offset=" +
          offset +
          (category ? "&category=" + encodeURIComponent(category) : ""),
        streamListSchema,
        signal,
      ),
    refetchInterval: Math.min(config.VITE_STREAM_POLL_MS, 5000),
  });
  useEffect(() => {
    if (!auth.csrf) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void cache.invalidateQueries({ queryKey: ["live-feed"] });
        void cache.invalidateQueries({ queryKey: ["streams"] });
      }, 250);
    };
    const socket = io({
      transports: ["websocket"],
      withCredentials: true,
      auth: { csrf: auth.csrf },
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });
    socket.on("connect", refresh);
    socket.on("discovery:v1", (raw: unknown) => {
      if (discoveryEventSchema.safeParse(raw).success) refresh();
    });
    socket.on("transport-status", refresh);
    return () => {
      if (timer) clearTimeout(timer);
      socket.disconnect();
    };
  }, [auth.csrf, cache]);
  return query;
}
function DynamicCard({ stream }: { stream: Stream }) {
  return (
    <article className="dynamic-card" data-stream-id={stream.id}>
      <Link
        to={"/watch/" + stream.id}
        className="dynamic-poster"
        aria-label={"Watch " + stream.title}
        style={
          {
            "--poster-color": stream.avatarColor || "#52d7c7",
          } as React.CSSProperties
        }
      >
        <span className="dynamic-live">● LIVE</span>
        <span className="poster-monogram">
          {(stream.channelName || stream.ownerUsername || "Live")
            .slice(0, 2)
            .toUpperCase()}
        </span>
        <span className="poster-play">
          <Icon name="play" />
        </span>
        <small>Channel artwork</small>
      </Link>
      <div className="dynamic-card-copy">
        <span className="dynamic-avatar" style={{ color: stream.avatarColor }}>
          {stream.ownerUsername?.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <Link to={"/watch/" + stream.id}>
            <h3>{stream.title}</h3>
          </Link>
          <Link to={"/channels/" + stream.channelSlug}>
            {stream.channelName} · @{stream.ownerUsername}
          </Link>
          <p>
            {stream.category}{" "}
            <span>
              ·{" "}
              {stream.viewers === null || stream.viewers === undefined
                ? "Player estimate unavailable"
                : `${stream.viewers} active player ${stream.viewers === 1 ? "session" : "sessions"}`}
            </span>
          </p>
        </div>
      </div>
      <Link to={"/watch/" + stream.id} className="dynamic-watch">
        Watch now <Icon name="arrow" />
      </Link>
    </article>
  );
}
export function DynamicDiscovery({
  view = "home",
}: {
  view?: "home" | "live" | "search" | "explore";
}) {
  const [params, setParams] = useSearchParams(),
    [offset, setOffset] = useState(0);
  const search = params.get("q") || "",
    category = params.get("category") || "";
  const validCategory = categories.includes(
    category as (typeof categories)[number],
  )
    ? category
    : "";
  const query = useLiveFeed(search, validCategory, offset);
  const streams = query.isError ? [] : query.data?.streams || [];
  const featured = streams[0];
  const auth = useAuth();
  const filter = (value: string) => {
    setOffset(0);
    setParams({ ...Object.fromEntries(params), category: value });
  };
  return (
    <div className="dynamic-discovery">
      {view === "home" && !search && !category && (
        <section className="dynamic-hero">
          <div className="dynamic-hero-copy">
            <p className="eyebrow">Independent voices. Shared moments.</p>
            <h1>
              Your world.
              <br />
              <em>Happening live.</em>
            </h1>
            <p>
              Find something worth tuning in to. Share what you love. Be part of
              the conversation.
            </p>
            <div className="studio-actions">
              <Link className="button primary" to="/live">
                Explore live <Icon name="arrow" />
              </Link>
              <Link
                className="button secondary"
                to={auth.user ? "/studio" : "/signup"}
              >
                Start your channel
              </Link>
            </div>
            <p className="fine-print">
              Real people. Real broadcasts. A place for your voice.
            </p>
          </div>
          <div className="dynamic-hero-stage">
            {featured ? (
              <>
                <LivePlayer
                  source={featured.playbackUrl}
                  alternateSources={featured.playbackSources}
                  sourceId={featured.id}
                />
                <Link to={"/watch/" + featured.id} className="hero-caption">
                  <span className="dynamic-live">● LIVE</span>
                  <strong>{featured.title}</strong>
                  <span>
                    @{featured.ownerUsername} <Icon name="arrow" />
                  </span>
                </Link>
              </>
            ) : (
              <div className="dynamic-stage-empty">
                <span className="orbital-play">
                  <Icon name="play" />
                </span>
                <span className="subtle-chip">The stage is yours</span>
                <h2>
                  Your next live moment
                  <br />
                  starts with you.
                </h2>
                <p>
                  No one is on air yet. Create your channel and be the first.
                </p>
                <Link className="text-link" to="/studio">
                  Go to Studio <Icon name="arrow" />
                </Link>
              </div>
            )}
          </div>
        </section>
      )}
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            {view === "explore" ? "Find your community" : "On air"}
          </p>
          <h1 className="feed-heading">
            {view === "search"
              ? `Live results${search ? " for “" + search + "”" : ""}`
              : view === "explore"
                ? "A world of live."
                : "Live, right now."}
          </h1>
        </div>
        <span className="subtle-chip">
          {query.isPending
            ? "Checking broadcasts"
            : query.isError
              ? "Status unavailable"
              : `${streams.length} live on this page`}
        </span>
      </div>
      <div className="dynamic-filters" aria-label="Categories">
        <button
          className={!validCategory ? "selected" : ""}
          onClick={() => filter("")}
        >
          All live
        </button>
        {categories.map((c) => (
          <button
            key={c}
            className={validCategory === c ? "selected" : ""}
            onClick={() => filter(c)}
          >
            {c}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <div className="loading-surface" role="status">
          Finding live broadcasts…
        </div>
      ) : query.isError ? (
        <div className="panel dynamic-empty">
          <Icon name="refresh" />
          <h2>We couldn’t check who’s live.</h2>
          <p>Stream availability is unknown. Try again in a moment.</p>
          <button
            className="button secondary"
            onClick={() => void query.refetch()}
          >
            Retry live feed
          </button>
        </div>
      ) : streams.length ? (
        <div className="dynamic-grid">
          {streams.map((s) => (
            <DynamicCard key={s.id} stream={s} />
          ))}
        </div>
      ) : (
        <div className="panel dynamic-empty">
          <Icon name="live" />
          <h2>
            {search || category
              ? "No live broadcasts match yet."
              : "A little quiet, for now."}
          </h2>
          <p>
            {search || category
              ? "Try another category or search."
              : "When someone starts broadcasting, their stream appears here automatically."}
          </p>
          <Link className="button secondary" to="/studio">
            Go Live
          </Link>
        </div>
      )}
      <div className="pagination">
        {offset > 0 && (
          <button
            className="button secondary"
            onClick={() => setOffset(Math.max(0, offset - 24))}
          >
            Previous
          </button>
        )}
        {query.data?.nextOffset != null && (
          <button
            className="button secondary"
            onClick={() => setOffset(query.data!.nextOffset!)}
          >
            More live streams
          </button>
        )}
      </div>
      {view === "home" && (
        <section className="dynamic-creator-banner">
          <span className="dynamic-avatar">
            <Icon name="studio" />
          </span>
          <div>
            <p className="eyebrow">Make it your own</p>
            <h2>One channel. Endless possibilities.</h2>
            <p>
              Broadcast from your browser or bring OBS. Your audience is one
              link away.
            </p>
          </div>
          <Link className="button primary" to="/studio">
            Open Studio <Icon name="arrow" />
          </Link>
        </section>
      )}
    </div>
  );
}
