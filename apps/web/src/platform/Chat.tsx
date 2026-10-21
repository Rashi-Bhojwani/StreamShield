import { useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import {
  chatMessageSchema,
  type ChatMessage,
  type RealtimeReply,
} from "@streamshield/shared";
import { useQuery } from "@tanstack/react-query";
import { platformRequest } from "./request";
import { useAuth } from "./auth-context";
import { config } from "../config";
import { Icon } from "../ui/Icon";
export function Chat({
  streamId,
  playerContainer,
}: {
  streamId: string;
  playerContainer: RefObject<HTMLElement | null>;
}) {
  const auth = useAuth(),
    [messages, setMessages] = useState<ChatMessage[]>([]),
    [status, setStatus] = useState("Connecting"),
    [error, setError] = useState(""),
    [draft, setDraft] = useState(""),
    [sending, setSending] = useState(false),
    [hasOlder, setHasOlder] = useState(false);
  const refreshAuth = auth.refresh;
  const socket = useRef<Socket | null>(null),
    list = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const presence = useQuery({
    queryKey: ["presence", streamId],
    queryFn: () =>
      platformRequest<{ count: number; label: string }>(
        "/streams/" + streamId + "/presence",
      ),
    refetchInterval: auth.heartbeatMs || config.VITE_STATUS_POLL_MS,
    retry: false,
  });
  const merge = (incoming: ChatMessage[]) =>
    setMessages((previous) => {
      const map = new Map(previous.map((m) => [m.id, m]));
      for (const message of incoming) map.set(message.id, message);
      return [...map.values()]
        .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
        .slice(-config.VITE_CHAT_WINDOW_LIMIT);
    });
  useEffect(() => {
    if (!auth.csrf) return;
    let disposed = false,
      heartbeatFailed = false,
      lastTime = 0;
    const client = io({
      transports: ["websocket"],
      withCredentials: true,
      auth: { csrf: auth.csrf },
      reconnectionAttempts: config.VITE_CHAT_RECONNECT_LIMIT,
      reconnectionDelay: config.VITE_CHAT_RECONNECT_DELAY_MS,
      timeout: config.VITE_API_TIMEOUT_MS,
    });
    socket.current = client;
    client.on("connect", () => {
      setStatus("Connecting");
      client.timeout(config.VITE_API_TIMEOUT_MS).emit(
        "join",
        { streamId },
        (
          err: Error | null,
          reply: RealtimeReply<{
            messages: ChatMessage[];
            nextBefore: string | null;
          }>,
        ) => {
          if (disposed) return;
          if (err || !reply?.ok) {
            setStatus("Unavailable");
            setError(
              reply?.error?.message || "Could not join chat. Try reconnecting.",
            );
            return;
          }
          setStatus("Connected");
          setError("");
          merge(reply.data!.messages.map((m) => chatMessageSchema.parse(m)));
          setHasOlder(reply.data!.nextBefore !== null);
        },
      );
    });
    client.on("message", (raw: unknown) => {
      const message = chatMessageSchema.safeParse(raw);
      if (message.success && message.data.streamId === streamId)
        merge([message.data]);
    });
    client.on("disconnect", (reason) => {
      if (!disposed) {
        setStatus("Disconnected");
        if (reason === "io server disconnect") void refreshAuth();
      }
    });
    client.on("connect_error", () => {
      if (!disposed) {
        setStatus("Unavailable");
        setError("Chat connection unavailable. You can keep watching.");
      }
    });
    client.on("transport-status", (value: { available: boolean }) => {
      if (!disposed) {
        setStatus(value.available ? "Connected" : "Degraded");
        if (!value.available)
          setError(
            "Chat distribution is unavailable. Messages remain in durable history.",
          );
        else {
          setError("");
          void platformRequest<{ messages: ChatMessage[] }>(
            "/streams/" + streamId + "/chat",
          )
            .then((data) => {
              if (!disposed) merge(data.messages);
            })
            .catch(() => setError("Chat history could not be refreshed."));
        }
      }
    });
    const beat = () => {
      if (!client.connected) return;
      const video = playerContainer.current?.querySelector("video");
      const time = video?.currentTime || 0;
      const playing =
        !!video &&
        !video.paused &&
        !video.ended &&
        video.readyState >= 2 &&
        time > lastTime &&
        document.visibilityState === "visible";
      lastTime = time;
      client.timeout(config.VITE_API_TIMEOUT_MS).emit(
        "heartbeat",
        {
          streamId,
          playing,
          source:
            video?.closest(".player")?.getAttribute("data-delivery-source") ||
            "single",
        },
        (
          err: Error | null,
          reply: RealtimeReply<{ chatAvailable: boolean }>,
        ) => {
          if (disposed) return;
          if (err || !reply?.ok || !reply.data?.chatAvailable) {
            heartbeatFailed = true;
            setError(
              reply?.error?.message ||
                "Chat or viewer heartbeat is temporarily unavailable.",
            );
            setStatus("Degraded");
          } else if (heartbeatFailed) {
            heartbeatFailed = false;
            setError("");
            setStatus("Connected");
          }
        },
      );
    };
    const interval = setInterval(
      beat,
      auth.heartbeatMs || config.VITE_STATUS_POLL_MS,
    );
    const visibility = () => {
      if (document.visibilityState !== "visible") {
        lastTime = 0;
        client.emit("heartbeat", { streamId, playing: false });
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      client.removeAllListeners();
      client.disconnect();
      socket.current = null;
    };
  }, [
    streamId,
    auth.csrf,
    auth.user?.id,
    auth.guest?.id,
    auth.heartbeatMs,
    playerContainer,
    refreshAuth,
  ]);
  useEffect(() => {
    if (follow.current && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [messages]);
  const send = () => {
    if (!draft.trim() || !socket.current || sending) return;
    setSending(true);
    setError("");
    socket.current
      .timeout(config.VITE_API_TIMEOUT_MS)
      .emit(
        "message",
        { streamId, content: draft },
        (err: Error | null, reply: RealtimeReply<ChatMessage>) => {
          setSending(false);
          if (err || !reply?.ok) {
            if (reply?.error?.code === "AUTH_REQUIRED") void refreshAuth();
            setError(
              reply?.error?.message ||
                "Message not confirmed. Check history before retrying.",
            );
            return;
          }
          setDraft("");
          follow.current = true;
          if (reply.data) merge([reply.data]);
        },
      );
  };
  return (
    <aside className="chat-panel real-chat" aria-label="Live chat">
      <div className="chat-heading">
        <h2>
          <Icon name="chat" />
          Live chat
        </h2>
        <span
          className={
            "chat-connection " + (status === "Connected" ? "is-connected" : "")
          }
        >
          {status}
        </span>
      </div>
      <p className="viewer-estimate">
        {presence.isError || presence.isPending
          ? "Viewer estimate unavailable"
          : presence.data.count +
            " approximate active " +
            (presence.data.count === 1 ? "player" : "players")}
      </p>
      <div
        className="chat-messages"
        ref={list}
        onScroll={() => {
          const node = list.current;
          if (node)
            follow.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 60;
        }}
        aria-live="polite"
        aria-relevant="additions"
        role="log"
        aria-label="Chat messages"
      >
        {messages.length > 0 && (
          <button
            className="text-link history-button"
            onClick={async () => {
              try {
                const data = await platformRequest<{
                  messages: ChatMessage[];
                  nextBefore: string | null;
                }>("/streams/" + streamId + "/chat");
                follow.current = true;
                setMessages(data.messages);
                setHasOlder(data.nextBefore !== null);
              } catch {
                setError("Latest messages could not be loaded.");
              }
            }}
          >
            Latest messages
          </button>
        )}
        {hasOlder && messages.length > 0 && (
          <button
            className="text-link history-button"
            onClick={async () => {
              try {
                const data = await platformRequest<{
                  messages: ChatMessage[];
                  nextBefore: string | null;
                }>("/streams/" + streamId + "/chat?before=" + messages[0]!.seq);
                follow.current = false;
                if (data.messages.length) setMessages(data.messages);
                setHasOlder(data.nextBefore !== null);
              } catch {
                setError("Earlier messages could not be loaded.");
              }
            }}
          >
            Load earlier messages
          </button>
        )}
        {!messages.length ? (
          <div className="chat-empty">
            <span className="chat-illustration">
              <Icon name="chat" />
            </span>
            <h3>The conversation starts here.</h3>
            <p>No messages yet. Say hello when you’re ready.</p>
          </div>
        ) : (
          messages.map((message) => (
            <article className="chat-message" key={message.id}>
              <div>
                <strong>{message.username}</strong>
                <time dateTime={message.createdAt}>
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p>{message.content}</p>
            </article>
          ))
        )}
      </div>
      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
      {status !== "Connected" && (
        <button
          className="text-link reconnect-chat"
          onClick={() => {
            setError("");
            socket.current?.disconnect();
            socket.current?.connect();
          }}
        >
          Reconnect chat
        </button>
      )}
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {auth.user || auth.guest ? (
          <>
            <label className="sr-only" htmlFor="chat-message">
              Your message
            </label>
            <textarea
              id="chat-message"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={1000}
              rows={2}
              placeholder="Send a message…"
              disabled={status !== "Connected"}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div>
              <span className="fine-print">
                Chatting as {auth.guest?.name || auth.user?.username}
              </span>
              <button
                className="button primary"
                disabled={!draft.trim() || sending || status !== "Connected"}
              >
                Send
              </button>
            </div>
          </>
        ) : (
          <p>
            <Link
              className="inline-link"
              to={"/login?next=" + encodeURIComponent("/watch/" + streamId)}
            >
              Sign in
            </Link>{" "}
            to join the conversation.
          </p>
        )}
      </form>
    </aside>
  );
}
