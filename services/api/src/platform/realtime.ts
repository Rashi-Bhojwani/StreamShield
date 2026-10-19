import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { z } from "zod";
import { messageInput, type RealtimeReply } from "@streamshield/shared";
import type { Resources } from "./resources.js";
import type { Platform } from "./routes.js";
import type { PlatformConfig } from "./config.js";
import type { Config } from "../config.js";
import {
  PlatformError,
  checkCsrf,
  session,
  cookies,
  digest,
  rate,
  publicError,
} from "./security.js";
export async function history(
  r: Resources,
  streamId: string,
  limit: number,
  before?: string,
  after?: string,
) {
  const rows = await r.db.query(
    "SELECT m.id,m.seq::text,m.stream_id,m.content,m.created_at,u.username FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE m.stream_id=$1 AND m.deleted_at IS NULL AND ($2::bigint IS NULL OR m.seq<$2) AND ($3::bigint IS NULL OR m.seq>$3) ORDER BY m.seq DESC LIMIT $4",
    [streamId, before || null, after || null, limit],
  );
  return rows.rows.reverse().map((row) => ({
    id: row.id,
    seq: row.seq,
    streamId: row.stream_id,
    username: row.username,
    content: row.content,
    createdAt: row.created_at.toISOString(),
  }));
}
export const presenceKey = (streamId: string) => "presence:" + streamId;
export async function presenceCount(r: Resources, streamId: string) {
  if (!r.redis.isReady)
    throw new PlatformError(
      503,
      "PRESENCE_UNAVAILABLE",
      "Viewer estimate unavailable.",
    );
  const key = presenceKey(streamId),
    now = Date.now();
  const members = (await r.redis.eval(
    "redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); return redis.call('ZRANGE',KEYS[1],0,-1)",
    { keys: [key], arguments: [String(now)] },
  )) as string[];
  return new Set(members.map((member) => member.split(":")[0])).size;
}
export function createRealtime(
  server: HttpServer,
  r: Resources,
  c: PlatformConfig,
  media: Config,
  platform: Platform,
) {
  const io = new Server(server, {
    transports: ["websocket"],
    cors: { origin: media.CORS_ORIGINS, credentials: true },
    maxHttpBufferSize: 16384,
    pingTimeout: c.DEPENDENCY_TIMEOUT_MS,
    pingInterval: c.PRESENCE_HEARTBEAT_MS,
    allowRequest: (req, cb) =>
      cb(
        null,
        !!req.headers.origin && media.CORS_ORIGINS.includes(req.headers.origin),
      ),
  });
  // The maintained adapter intentionally does not await publish promises.
  // Observe failures locally instead of allowing an unhandled rejection to stop playback/API.
  const adapterPub = new Proxy(r.pub, {
    get(target, property) {
      if (property === "publish")
        return (channel: string, message: string | Buffer) =>
          target.publish(channel, message).catch(() => {
            io.local.emit("transport-status", { available: false });
            return 0;
          });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  io.adapter(
    createAdapter(adapterPub, r.sub, {
      requestsTimeout: c.DEPENDENCY_TIMEOUT_MS,
      key: "streamshield:" + c.REDIS_DB,
    }),
  );
  const transport = () =>
    io.local.emit("transport-status", {
      available: r.redis.isReady && r.pub.isReady && r.sub.isReady,
    });
  for (const client of [r.redis, r.pub, r.sub]) {
    client.on("error", transport);
    client.on("ready", transport);
    client.on("end", transport);
  }
  io.of("/").adapter.on("error", () =>
    io.local.emit("transport-status", { available: false }),
  );
  io.on("close", () => {
    for (const client of [r.redis, r.pub, r.sub]) {
      client.off("error", transport);
      client.off("ready", transport);
      client.off("end", transport);
    }
  });
  platform.setRevokeSockets((hash) => {
    io.local.in("session:" + hash).disconnectSockets(true);
    if (r.pub.isReady && r.sub.isReady)
      io.in("session:" + hash).disconnectSockets(true);
  });
  io.use(async (socket, next) => {
    try {
      checkCsrf(
        socket.handshake.headers.origin,
        socket.handshake.auth.csrf,
        socket.handshake.headers.cookie,
        media.CORS_ORIGINS,
        c,
      );
      if (!r.pub.isReady || !r.sub.isReady)
        throw new PlatformError(
          503,
          "CHAT_UNAVAILABLE",
          "Chat transport is unavailable.",
        );
      await rate(
        r,
        "socket:" + socket.handshake.address,
        c.SOCKET_CONNECT_LIMIT,
        c.AUTH_RATE_WINDOW_MS,
      );
      const auth = await session(r, socket.handshake.headers.cookie);
      socket.data.identity =
        auth?.tokenHash ||
        digest(cookies(socket.handshake.headers.cookie).ss_csrf || "");
      socket.data.sessionHash = auth?.tokenHash;
      next();
    } catch (error) {
      const safe = publicError(error);
      const e = new Error(safe.message) as Error & { data: unknown };
      e.data = { code: safe.code };
      next(e);
    }
  });
  io.on("connection", (socket) => {
    let streamId: string | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastHeartbeat = 0;
    if (socket.data.sessionHash) {
      void r.db
        .query("SELECT expires_at FROM auth_sessions WHERE token_hash=$1", [
          socket.data.sessionHash,
        ])
        .then((result) => {
          const expires = result.rows[0]?.expires_at as Date | undefined;
          if (!expires || !socket.connected) return;
          expiryTimer = setTimeout(
            () => socket.disconnect(true),
            Math.max(0, expires.getTime() - Date.now()),
          );
          expiryTimer.unref();
        })
        .catch(() => socket.disconnect(true));
      void socket.join("session:" + String(socket.data.sessionHash));
    }
    const ackError = (ack: unknown, error: unknown) => {
      if (typeof ack === "function") {
        const safe = publicError(error);
        ack({ ok: false, error: { code: safe.code, message: safe.message } });
      }
    };
    const leavePresence = async () => {
      if (r.redis.isReady)
        for (const source of ["primary", "standby", "single"])
          await r.redis.zRem("monitoring:playback:" + source, socket.id);
      if (streamId && r.redis.isReady)
        await r.redis.zRem(
          presenceKey(streamId),
          String(socket.data.identity) + ":" + socket.id,
        );
    };
    socket.on(
      "join",
      async (raw: unknown, ack: (reply: RealtimeReply) => void) => {
        try {
          const parsed = z
            .object({ streamId: z.uuid() })
            .strict()
            .safeParse(raw);
          if (!parsed.success)
            throw new PlatformError(
              400,
              "INVALID_INPUT",
              "Use a valid stream identity.",
            );
          const value = parsed.data;
          await rate(
            r,
            "join:" + socket.id,
            c.WRITE_RATE_LIMIT,
            c.AUTH_RATE_WINDOW_MS,
          );
          const found = await r.db.query("SELECT id FROM streams WHERE id=$1", [
            value.streamId,
          ]);
          if (!found.rowCount)
            throw new PlatformError(
              404,
              "STREAM_NOT_FOUND",
              "Stream not found.",
            );
          if (streamId) {
            await leavePresence();
            await socket.leave("stream:" + streamId);
          }
          streamId = value.streamId;
          await socket.join("stream:" + streamId);
          if (typeof ack === "function")
            ack({
              ok: true,
              data: await (async () => {
                const messages = await history(
                  r,
                  streamId,
                  c.CHAT_HISTORY_LIMIT,
                );
                return {
                  messages,
                  nextBefore:
                    messages.length === c.CHAT_HISTORY_LIMIT
                      ? messages[0]?.seq
                      : null,
                };
              })(),
            });
        } catch (error) {
          ackError(ack, error);
        }
      },
    );
    socket.on(
      "message",
      async (raw: unknown, ack: (reply: RealtimeReply) => void) => {
        try {
          if (!r.pub.isReady || !r.sub.isReady)
            throw new PlatformError(
              503,
              "CHAT_UNAVAILABLE",
              "Chat transport is unavailable.",
            );
          const auth = await session(r, socket.handshake.headers.cookie);
          if (!auth)
            throw new PlatformError(
              401,
              "AUTH_REQUIRED",
              "Sign in to send messages.",
            );
          const parsed = messageInput.safeParse(raw);
          if (!parsed.success)
            throw new PlatformError(
              400,
              "INVALID_MESSAGE",
              "Messages must contain 1–1000 plain-text characters.",
            );
          const body = parsed.data;
          if (streamId !== body.streamId)
            throw new PlatformError(
              403,
              "ROOM_REQUIRED",
              "Join this stream before sending.",
            );
          await rate(
            r,
            "chat:" + auth.user.id,
            c.CHAT_RATE_LIMIT,
            c.CHAT_RATE_WINDOW_MS,
          );
          const row = (
            await r.db.query(
              "INSERT INTO chat_messages(id,stream_id,sender_id,content) SELECT $1,s.id,$2,$3 FROM streams s WHERE s.id=$4 AND s.lifecycle!='ended' RETURNING id,seq::text,created_at",
              [randomUUID(), auth.user.id, body.content, streamId],
            )
          ).rows[0];
          if (!row)
            throw new PlatformError(
              409,
              "STREAM_ENDED",
              "This stream has ended.",
            );
          const message = {
            id: row.id,
            seq: row.seq,
            streamId,
            username: auth.user.username,
            content: body.content,
            createdAt: row.created_at.toISOString(),
          };
          io.to("stream:" + streamId).emit("message", message);
          if (typeof ack === "function") ack({ ok: true, data: message });
        } catch (error) {
          ackError(ack, error);
        }
      },
    );
    socket.on(
      "heartbeat",
      async (raw: unknown, ack: (reply: RealtimeReply) => void) => {
        try {
          const parsed = z
            .object({
              streamId: z.uuid(),
              playing: z.boolean(),
              source: z.enum(["primary", "standby", "single"]).optional(),
            })
            .strict()
            .safeParse(raw);
          if (!parsed.success)
            throw new PlatformError(
              400,
              "INVALID_INPUT",
              "Use a valid player heartbeat.",
            );
          const body = parsed.data;
          if (streamId !== body.streamId)
            throw new PlatformError(
              403,
              "ROOM_REQUIRED",
              "Join the stream first.",
            );
          await rate(
            r,
            "heartbeat:" + socket.id,
            Math.ceil(
              (c.PRESENCE_TTL_SECONDS * 1000) / c.PRESENCE_HEARTBEAT_MS,
            ) * 2,
            c.PRESENCE_TTL_SECONDS * 1000,
          );
          if (!body.playing) {
            await leavePresence();
            if (typeof ack === "function")
              ack({
                ok: true,
                data: { chatAvailable: await platform.ready() },
              });
            return;
          }
          if (Date.now() - lastHeartbeat < c.PRESENCE_HEARTBEAT_MS / 2)
            throw new PlatformError(
              429,
              "RATE_LIMITED",
              "Heartbeat too frequent.",
            );
          lastHeartbeat = Date.now();
          for (const source of ["primary", "standby", "single"]) {
            const key = "monitoring:playback:" + source;
            await r.redis.zRemRangeByScore(key, "-inf", Date.now());
            await r.redis.zRem(key, socket.id);
          }
          const playbackKey =
            "monitoring:playback:" + (body.source || "single");
          await r.redis.zAdd(playbackKey, {
            score: Date.now() + c.PRESENCE_TTL_SECONDS * 1000,
            value: socket.id,
          });
          await r.redis.expire(playbackKey, c.PRESENCE_TTL_SECONDS * 2);

          if (
            socket.data.sessionHash &&
            !(await session(r, socket.handshake.headers.cookie))
          )
            throw new PlatformError(
              401,
              "AUTH_REQUIRED",
              "Your session expired.",
            );
          const key = presenceKey(streamId),
            member = String(socket.data.identity) + ":" + socket.id;
          await r.redis
            .multi()
            .zAdd(key, {
              score: Date.now() + c.PRESENCE_TTL_SECONDS * 1000,
              value: member,
            })
            .expire(key, c.PRESENCE_TTL_SECONDS * 2)
            .exec();
          if (typeof ack === "function")
            ack({
              ok: true,
              data: {
                count: await presenceCount(r, streamId),
                chatAvailable: await platform.ready(),
              },
            });
        } catch (error) {
          ackError(ack, error);
        }
      },
    );
    socket.on("disconnect", () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      void leavePresence().catch(() => {});
    });
  });
  return io;
}
