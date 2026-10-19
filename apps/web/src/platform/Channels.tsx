import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { type Channel, type Stream } from "@streamshield/shared";
import { platformRequest } from "./request";
import { StatusBadge } from "../ui/StatusBadge";
import { Icon } from "../ui/Icon";
import { config } from "../config";
export function ChannelStreamCard({ stream }: { stream: Stream }) {
  return (
    <Link
      className="stream-card"
      to={"/watch/" + stream.id}
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
            : stream.lifecycle === "ended"
              ? "Broadcast ended"
              : "Waiting for a broadcast"}
        </span>
        <StatusBadge status={stream.status} />
      </div>
      <div className="stream-card-info">
        <span className="channel-symbol">
          <Icon name="studio" />
        </span>
        <div>
          <h3>{stream.title}</h3>
          <p>{stream.channelName || "StreamShield Live"}</p>
        </div>
        <Icon name="chevron" />
      </div>
    </Link>
  );
}
export function Channels() {
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ["channels", offset],
    queryFn: () =>
      platformRequest<{ channels: Channel[]; nextOffset: number | null }>(
        "/channels?offset=" + offset,
      ),
  });
  return (
    <div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Browse channels</p>
          <h1>Find a voice to tune in to.</h1>
          <p className="page-subtitle">
            Real channels, created by the people behind the broadcasts.
          </p>
        </div>
      </div>
      {query.isPending ? (
        <p role="status">Finding channels…</p>
      ) : query.isError ? (
        <p role="alert" className="form-error">
          Channels are unavailable.{" "}
          <button className="text-link" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : !query.data?.channels.length ? (
        <div className="quiet-state">
          <Icon name="studio" />
          <div>
            <h2>The first channel could be yours.</h2>
            <p>
              Create your channel in{" "}
              <Link className="inline-link" to="/studio">
                Broadcaster Studio
              </Link>
              .
            </p>
          </div>
        </div>
      ) : (
        <div className="channel-grid">
          {query.data.channels.map((channel) => (
            <Link
              className="panel channel-card"
              key={channel.id}
              to={"/channels/" + channel.slug}
            >
              <span className="channel-symbol large">
                <Icon name="studio" />
              </span>
              <h2>{channel.displayName}</h2>
              <p className="muted">@{channel.ownerUsername}</p>
              <p>{channel.description || "A channel on StreamShield Live."}</p>
              <span className="text-link">
                Visit channel <Icon name="arrow" />
              </span>
            </Link>
          ))}
        </div>
      )}
      <div className="pagination">
        {offset > 0 && (
          <button
            className="button secondary"
            onClick={() => setOffset(Math.max(0, offset - 24))}
          >
            Previous channels
          </button>
        )}
        {query.data?.nextOffset !== null &&
          query.data?.nextOffset !== undefined && (
            <button
              className="button secondary"
              onClick={() => setOffset(query.data!.nextOffset!)}
            >
              More channels
            </button>
          )}
      </div>
    </div>
  );
}
export function ChannelPage() {
  const { slug } = useParams();
  const [paging, setPaging] = useState({ slug: "", offset: 0 });
  const offset = paging.slug === slug ? paging.offset : 0;
  const query = useQuery({
    queryKey: ["channel", slug, offset],
    queryFn: () =>
      platformRequest<{
        channel: Channel;
        streams: Stream[];
        nextOffset: number | null;
      }>("/channels/" + encodeURIComponent(slug || "")),
    refetchInterval: config.VITE_STREAM_POLL_MS,
  });
  if (query.isPending) return <p role="status">Loading channel…</p>;
  if (query.isError || !query.data)
    return (
      <div className="quiet-state">
        <div>
          <h1>Channel unavailable.</h1>
          <p>Check the address or try again shortly.</p>
          <Link className="text-link" to="/channels">
            Browse channels
          </Link>
        </div>
      </div>
    );
  const { channel, streams } = query.data;
  return (
    <div className="public-channel">
      <div className="channel-banner">
        <div className="signal-art" aria-hidden="true">
          <span />
          <span />
          <Icon name="studio" />
        </div>
        <p>A channel on StreamShield Live</p>
      </div>
      <section className="public-channel-info">
        <span className="channel-symbol large">
          <Icon name="studio" />
        </span>
        <div>
          <p className="eyebrow">@{channel.ownerUsername}</p>
          <h1>{channel.displayName}</h1>
          <p>{channel.description || "Welcome to this channel."}</p>
        </div>
        <Link className="button secondary" to="/channels">
          Browse channels
        </Link>
      </section>
      <div className="section-heading">
        <h2>Channel broadcasts</h2>
        <span className="muted">
          {streams.filter((s) => s.status === "live").length} live now
        </span>
      </div>
      {streams.length ? (
        <div className="stream-grid">
          {streams.map((stream) => (
            <ChannelStreamCard key={stream.id} stream={stream} />
          ))}
        </div>
      ) : (
        <div className="quiet-state">
          <Icon name="live" />
          <div>
            <h3>Quiet before the next live moment.</h3>
            <p>This channel hasn’t created a broadcast yet.</p>
          </div>
        </div>
      )}
      <div className="pagination">
        {offset > 0 && (
          <button
            className="button secondary"
            onClick={() =>
              setPaging({ slug: slug!, offset: Math.max(0, offset - 24) })
            }
          >
            Previous broadcasts
          </button>
        )}
        {query.data?.nextOffset != null && (
          <button
            className="button secondary"
            onClick={() =>
              setPaging({ slug: slug!, offset: query.data!.nextOffset! })
            }
          >
            More broadcasts
          </button>
        )}
      </div>
    </div>
  );
}
