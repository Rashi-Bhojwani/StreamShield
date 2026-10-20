import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Channel,
  type Publishing,
  type Stream,
  publishingSchema,
} from "@streamshield/shared";
import { useAuth } from "./auth-context";
import { StatusBadge } from "../ui/StatusBadge";
import { Icon } from "../ui/Icon";
import { LivePlayer } from "../streaming/LivePlayer";
import { config } from "../config";
function StreamEditor({ stream }: { stream: Stream }) {
  const auth = useAuth(),
    client = useQueryClient();
  const [publishing, setPublishing] = useState<Publishing | null>(null),
    [reveal, setReveal] = useState(false),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(false);
  const action = async (kind: "publishing" | "end") => {
    setBusy(true);
    setNotice("");
    setPublishing(null);
    setReveal(false);
    try {
      const result = await auth.call(
        "/studio/streams/" + stream.id + "/" + kind,
        { method: "POST" },
      );
      if (kind === "publishing") {
        setPublishing(publishingSchema.parse(result));
        setNotice(
          "New key created. Copy it now; it cannot be retrieved later.",
        );
      } else setNotice("Stream ended and publishing revoked.");
      await client.invalidateQueries({ queryKey: ["studio"] });
      await client.invalidateQueries({ queryKey: ["streams"] });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Unable to update stream.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="panel studio-stream">
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            {stream.lifecycle === "ended"
              ? "Past broadcast"
              : stream.lifecycle === "draft"
                ? "Draft livestream"
                : "Broadcast ready"}
          </p>
          <h3>{stream.title}</h3>
        </div>
        <StatusBadge status={stream.status} />
      </div>
      <p className="muted">{stream.description || "No description added."}</p>
      <div className="studio-actions">
        <Link className="button secondary" to={"/watch/" + stream.id}>
          Open watch page <Icon name="arrow" />
        </Link>
        {stream.lifecycle !== "ended" && (
          <>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void action("publishing")}
            >
              {stream.lifecycle === "draft"
                ? "Create publishing key"
                : "Rotate publishing key"}
            </button>
            <button
              className="button secondary danger-button"
              disabled={busy}
              onClick={() => void action("end")}
            >
              End stream
            </button>
          </>
        )}
        {stream.status === "live" && (
          <button className="text-link" onClick={() => setPreview(!preview)}>
            {preview ? "Close preview" : "Preview live video"}
          </button>
        )}
      </div>
      {preview && stream.status === "live" && (
        <LivePlayer source={stream.playbackUrl} sourceId={stream.id} />
      )}
      {publishing && (
        <div className="publishing-panel">
          <div className="section-heading">
            <h4>Connect OBS Studio</h4>
            <button
              className="text-link"
              onClick={() => {
                setPublishing(null);
                setReveal(false);
                setNotice(
                  "Publishing key cleared. Rotate to create a replacement if needed.",
                );
              }}
            >
              Dismiss key
            </button>
          </div>
          <p className="fine-print">
            Rotating revokes the previous key and disconnects its active
            publisher. Keep this key private.
          </p>
          <label>
            RTMP server
            <input readOnly value={publishing.server} />
          </label>
          <label>
            Stream key
            <input
              aria-label="Private stream key"
              type={reveal ? "text" : "password"}
              autoComplete="off"
              readOnly
              value={publishing.streamKey}
            />
          </label>
          <div className="studio-actions">
            <button
              className="button secondary"
              onClick={() => setReveal(!reveal)}
            >
              {reveal ? "Hide key" : "Reveal key"}
            </button>
            <button
              className="button secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(publishing.streamKey);
                  setNotice("Publishing key copied. Keep it private.");
                } catch {
                  setNotice(
                    "Clipboard unavailable. Reveal and copy the key manually.",
                  );
                }
              }}
            >
              Copy stream key
            </button>
          </div>
          <p>
            OBS → Settings → Stream → Custom. Use H.264 video / AAC audio, 30
            fps and a 2-second keyframe interval. Start streaming, then watch
            the verified source status above.
          </p>
        </div>
      )}
      {notice && (
        <p role="status" className="form-notice">
          {notice}
        </p>
      )}
      <details className="studio-edit">
        <summary>Edit title and description</summary>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const data = new FormData(e.currentTarget);
              await auth.call("/studio/streams/" + stream.id, {
                method: "PATCH",
                body: JSON.stringify({
                  title: data.get("title"),
                  description: data.get("description"),
                }),
              });
              await client.invalidateQueries({ queryKey: ["studio"] });
              await client.invalidateQueries({ queryKey: ["streams"] });
              setNotice("Stream details saved.");
            } catch (error) {
              setNotice(
                error instanceof Error ? error.message : "Unable to save.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Stream title
            <input
              name="title"
              required
              maxLength={120}
              defaultValue={stream.title}
            />
          </label>
          <label>
            Description
            <textarea
              name="description"
              maxLength={4000}
              defaultValue={stream.description}
            />
          </label>
          <button className="button secondary" disabled={busy}>
            Save stream details
          </button>
        </form>
      </details>
      <p className="fine-print">
        {stream.startedAt
          ? "First broadcast: " + new Date(stream.startedAt).toLocaleString()
          : "Publishing has not been observed."}
        {stream.endedAt
          ? " · Last ended: " + new Date(stream.endedAt).toLocaleString()
          : ""}
      </p>
    </article>
  );
}
export function Studio() {
  const auth = useAuth(),
    client = useQueryClient(),
    [offset, setOffset] = useState(0),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false);
  const channel = useQuery({
    queryKey: ["studio", "channel", auth.user?.id],
    queryFn: () => auth.call<{ channel: Channel | null }>("/studio/channel"),
  });
  const streams = useQuery({
    queryKey: ["studio", "streams", auth.user?.id, offset],
    queryFn: () =>
      auth.call<{ streams: Stream[]; nextOffset: number | null }>(
        "/studio/streams?offset=" + offset,
      ),
    refetchInterval: config.VITE_STREAM_POLL_MS,
  });
  const owned = channel.data?.channel;
  return (
    <div className="studio-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Broadcaster Studio</p>
          <h1>Your next live moment starts here.</h1>
          <p className="page-subtitle">
            Your channel. Your broadcasts. One clear place to go live.
          </p>
        </div>
        {owned && (
          <button
            className="button primary"
            onClick={() => setCreating(!creating)}
          >
            <Icon name="studio" />
            Create livestream
          </button>
        )}
      </div>
      {(channel.isError || streams.isError) && (
        <p className="form-error" role="alert">
          Studio data is unavailable. Your ongoing media playback is
          independent.{" "}
          <button
            className="text-link"
            onClick={() => {
              void channel.refetch();
              void streams.refetch();
            }}
          >
            Retry Studio
          </button>
        </p>
      )}
      {channel.isPending ? (
        <p role="status">Loading your channel…</p>
      ) : !owned && !channel.isError ? (
        <section className="panel channel-setup">
          <div>
            <span className="state-symbol">
              <Icon name="studio" />
            </span>
            <h2>A channel to call your own.</h2>
            <p className="page-subtitle">
              Choose a name and a public address. Creating your channel enables
              broadcasting on your account.
            </p>
            <p className="fine-print">
              You can watch and chat with this account too.
            </p>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setNotice("");
              try {
                const data = new FormData(e.currentTarget);
                await auth.call("/channels", {
                  method: "POST",
                  body: JSON.stringify({
                    slug: data.get("slug"),
                    displayName: data.get("displayName"),
                    description: data.get("description"),
                  }),
                });
                await auth.refresh();
                await client.invalidateQueries({ queryKey: ["studio"] });
                setNotice("Your channel is ready.");
              } catch (error) {
                setNotice(
                  error instanceof Error
                    ? error.message
                    : "Unable to create channel.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Channel name
              <input
                name="displayName"
                required
                maxLength={100}
                placeholder="A name worth tuning in to"
              />
            </label>
            <label>
              Channel address
              <input
                name="slug"
                required
                minLength={3}
                maxLength={40}
                pattern="[a-z0-9][a-z0-9_-]{2,39}"
                placeholder="your-channel"
              />
            </label>
            <p className="fine-print">
              Lowercase letters, numbers, hyphens and underscores. This address
              stays with your channel.
            </p>
            <label>
              About your channel
              <textarea
                name="description"
                maxLength={2000}
                placeholder="What will you share live?"
              />
            </label>
            <button className="button primary" disabled={busy}>
              Create channel
            </button>
          </form>
        </section>
      ) : (
        owned && (
          <>
            <section className="panel studio-overview">
              <div className="channel-symbol large">
                <Icon name="studio" />
              </div>
              <div>
                <p className="eyebrow">Your channel</p>
                <h2>{owned.displayName}</h2>
                <p className="muted">streamshield / {owned.slug}</p>
              </div>
              <Link className="button secondary" to={"/channels/" + owned.slug}>
                View channel <Icon name="arrow" />
              </Link>
            </section>
            <details className="panel channel-edit">
              <summary>Edit channel information</summary>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  try {
                    const data = new FormData(e.currentTarget);
                    await auth.call("/channels/" + owned.id, {
                      method: "PATCH",
                      body: JSON.stringify({
                        displayName: data.get("displayName"),
                        description: data.get("description"),
                      }),
                    });
                    await channel.refetch();
                    setNotice("Channel updated.");
                  } catch (error) {
                    setNotice(
                      error instanceof Error
                        ? error.message
                        : "Unable to save.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  Channel name
                  <input
                    name="displayName"
                    required
                    maxLength={100}
                    defaultValue={owned.displayName}
                  />
                </label>
                <label>
                  Channel description
                  <textarea
                    name="description"
                    maxLength={2000}
                    defaultValue={owned.description}
                  />
                </label>
                <button className="button secondary" disabled={busy}>
                  Save channel
                </button>
              </form>
            </details>
            {creating && (
              <section className="panel new-stream">
                <div>
                  <p className="eyebrow">Set the stage</p>
                  <h2>Create your livestream</h2>
                  <p className="muted">
                    Each broadcast gets its own private publishing key and
                    independent media path.
                  </p>
                </div>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    try {
                      const data = new FormData(e.currentTarget);
                      await auth.call("/studio/streams", {
                        method: "POST",
                        body: JSON.stringify({
                          channelId: owned.id,
                          title: data.get("title"),
                          description: data.get("description"),
                        }),
                      });
                      setCreating(false);
                      setOffset(0);
                      setOffset(0);
                      await streams.refetch();
                      setNotice("Livestream saved to your channel.");
                    } catch (error) {
                      setNotice(
                        error instanceof Error
                          ? error.message
                          : "Unable to create stream.",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <label>
                    Stream title
                    <input
                      name="title"
                      required
                      maxLength={120}
                      placeholder="Give your live moment a title"
                    />
                  </label>
                  <label>
                    Stream description
                    <textarea
                      name="description"
                      maxLength={4000}
                      placeholder="Let viewers know what to expect."
                    />
                  </label>
                  <button className="button primary" disabled={busy}>
                    Create stream
                  </button>
                </form>
              </section>
            )}
            <div className="section-heading">
              <h2>Your broadcasts</h2>
              <span className="muted">
                {streams.data?.streams.length || 0} streams on this page
              </span>
            </div>
            {!streams.data?.streams.length ? (
              <div className="quiet-state">
                <span className="state-symbol">
                  <Icon name="live" />
                </span>
                <div>
                  <h3>Your first broadcast is ahead of you.</h3>
                  <p>
                    Create a livestream, connect OBS, and share the watch link.
                  </p>
                </div>
              </div>
            ) : (
              <div className="studio-streams">
                {streams.data.streams.map((stream) => (
                  <StreamEditor key={stream.id} stream={stream} />
                ))}
              </div>
            )}
          </>
        )
      )}
      <div className="pagination">
        {offset > 0 && (
          <button
            className="button secondary"
            onClick={() => setOffset(Math.max(0, offset - 24))}
          >
            Previous broadcasts
          </button>
        )}
        {streams.data?.nextOffset != null && (
          <button
            className="button secondary"
            onClick={() => setOffset(streams.data!.nextOffset!)}
          >
            Older broadcasts
          </button>
        )}
      </div>
      {notice && (
        <p role="status" className="form-notice">
          {notice}
        </p>
      )}
    </div>
  );
}
