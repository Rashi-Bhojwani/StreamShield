import { randomUUID } from "node:crypto";
import express, {
  type Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { hash, verify, Algorithm } from "@node-rs/argon2";
import { z } from "zod";
import {
  registerSchema,
  loginSchema,
  channelInput,
  channelUpdate,
  streamInput,
  streamUpdate,
} from "@streamshield/shared";
import type { Config } from "../config.js";
import type { PlatformConfig } from "./config.js";
import type { Resources } from "./resources.js";
import { createCatalog, kickPublisher } from "./catalog.js";
import {
  PlatformError,
  csrf,
  checkCsrf,
  requireUser,
  session,
  rate,
  secret,
  digest,
  cookieOptions,
  publicError,
} from "./security.js";
import { history, presenceCount } from "./realtime.js";
import type { Logger } from "pino";
const idSchema = z.uuid();
export const channelDto = (row: Record<string, unknown>) => ({
  id: row.id,
  slug: row.slug,
  displayName: row.display_name,
  description: row.description,
  ownerUsername: row.username,
  createdAt: (row.created_at as Date).toISOString(),
});
export async function createPlatform(
  r: Resources,
  c: PlatformConfig,
  media: Config,
  logger: Logger,
) {
  const catalog = createCatalog(r, c, media);
  const router = express.Router();
  const dummy = await hash(secret(), {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  let revokeSockets = (_hash: string) => {};
  const route = (
    method: "get" | "post" | "patch",
    path: string,
    fn: (req: Request, res: Response) => Promise<unknown>,
  ) => {
    router[method](path, async (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        if (method !== "get")
          checkCsrf(
            req.headers.origin,
            req.headers["x-csrf-token"],
            req.headers.cookie,
            media.CORS_ORIGINS,
            c,
          );
        await fn(req, res);
      } catch (error) {
        next(error);
      }
    });
  };
  const input = <T>(schema: z.ZodType<T>, data: unknown) => {
    const result = schema.safeParse(data);
    if (!result.success)
      throw new PlatformError(
        400,
        "INVALID_INPUT",
        "Check the form fields and try again.",
      );
    return result.data;
  };
  const id = (value: unknown) => input(idSchema, value);
  const writeLimit = async (_req: Request, userId: string) =>
    rate(r, "write:" + userId, c.WRITE_RATE_LIMIT, c.AUTH_RATE_WINDOW_MS);
  const issueSession = async (req: Request, res: Response, userId: string) => {
    const old = await session(r, req.headers.cookie);
    const token = secret();
    const client = await r.db.connect();
    try {
      await client.query("BEGIN");
      if (old)
        await client.query(
          "UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1",
          [old.tokenHash],
        );
      await client.query(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3 * interval '1 second'))",
        [digest(token), userId, c.SESSION_TTL_SECONDS],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (old) revokeSockets(old.tokenHash);
    res.cookie("ss_session", token, {
      ...cookieOptions(c),
      maxAge: c.SESSION_TTL_SECONDS * 1000,
    });
    res.status(200).json({ ok: true });
  };
  route("get", "/auth/me", async (req, res) => {
    const token = csrf(req, res, c);
    const auth = await session(r, req.headers.cookie);
    res.json({
      user: auth?.user || null,
      csrf: token,
      presenceHeartbeatMs: c.PRESENCE_HEARTBEAT_MS,
    });
  });
  route("post", "/auth/register", async (req, res) => {
    await rate(
      r,
      "register:" + req.ip,
      c.AUTH_RATE_LIMIT,
      c.AUTH_RATE_WINDOW_MS,
    );
    const body = input(registerSchema, req.body);
    const passwordHash = await hash(body.password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const userId = randomUUID();
    await r.db.query(
      "INSERT INTO users(id,username,email,password_hash,display_name) VALUES($1,$2,$3,$4,$2)",
      [userId, body.username, body.email, passwordHash],
    );
    await issueSession(req, res, userId);
  });
  route("post", "/auth/login", async (req, res) => {
    const body = input(loginSchema, req.body);
    await rate(
      r,
      "login-ip:" + req.ip,
      c.AUTH_RATE_LIMIT,
      c.AUTH_RATE_WINDOW_MS,
    );
    await rate(
      r,
      "login-account:" + body.identifier,
      c.AUTH_RATE_LIMIT,
      c.AUTH_RATE_WINDOW_MS,
    );
    const result = await r.db.query(
      "SELECT id,password_hash FROM users WHERE username=$1 OR email=$1",
      [body.identifier],
    );
    const row = result.rows[0];
    const valid = await verify(row?.password_hash || dummy, body.password);
    if (!row || !valid)
      throw new PlatformError(
        401,
        "INVALID_CREDENTIALS",
        "Invalid account or password.",
      );
    await issueSession(req, res, row.id);
  });
  route("post", "/auth/logout", async (req, res) => {
    const auth = await session(r, req.headers.cookie);
    if (auth) {
      await r.db.query(
        "UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1",
        [auth.tokenHash],
      );
      revokeSockets(auth.tokenHash);
    }
    res.clearCookie("ss_session", cookieOptions(c));
    res.json({ ok: true });
  });
  route("patch", "/auth/profile", async (req, res) => {
    const auth = await requireUser(r, req);
    await writeLimit(req, auth.user.id);
    const body = input(
      z.object({ displayName: z.string().trim().min(1).max(100) }).strict(),
      req.body,
    );
    await r.db.query(
      "UPDATE users SET display_name=$1,updated_at=now() WHERE id=$2",
      [body.displayName, auth.user.id],
    );
    res.json({ ok: true });
  });
  route("get", "/channels", async (req, res) => {
    const q = input(
      z.object({
        q: z.string().max(120).default(""),
        limit: z.coerce.number().int().min(1).max(100).default(24),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      }),
      req.query,
    );
    const rows = await r.db.query(
      "SELECT c.*,u.username FROM channels c JOIN users u ON u.id=c.owner_id WHERE c.display_name ILIKE $1 OR c.slug ILIKE $1 ORDER BY c.created_at DESC,c.id LIMIT $2 OFFSET $3",
      ["%" + q.q.replace(/[%_\\]/g, "\\$&") + "%", q.limit + 1, q.offset],
    );
    res.json({
      channels: rows.rows.slice(0, q.limit).map(channelDto),
      nextOffset: rows.rows.length > q.limit ? q.offset + q.limit : null,
    });
  });
  route("get", "/channels/:slug", async (req, res) => {
    const slug = input(
      z.string().regex(/^[a-z0-9][a-z0-9_-]{2,39}$/),
      req.params.slug,
    );
    const result = await r.db.query(
      "SELECT c.*,u.username FROM channels c JOIN users u ON u.id=c.owner_id WHERE c.slug=$1",
      [slug],
    );
    if (!result.rows[0])
      throw new PlatformError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
    const q = input(
      z.object({
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      }),
      req.query,
    );
    res.json({
      channel: channelDto(result.rows[0]),
      ...(await catalog.list("", 24, q.offset, result.rows[0].id)),
    });
  });
  route("get", "/studio/channel", async (req, res) => {
    const auth = await requireUser(r, req);
    const result = await r.db.query(
      "SELECT c.*,u.username FROM channels c JOIN users u ON u.id=c.owner_id WHERE owner_id=$1",
      [auth.user.id],
    );
    res.json({ channel: result.rows[0] ? channelDto(result.rows[0]) : null });
  });
  route("post", "/channels", async (req, res) => {
    const auth = await requireUser(r, req);
    await writeLimit(req, auth.user.id);
    const body = input(channelInput, req.body);
    const client = await r.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO channels(id,owner_id,slug,display_name,description) VALUES($1,$2,$3,$4,$5)",
        [
          randomUUID(),
          auth.user.id,
          body.slug,
          body.displayName,
          body.description,
        ],
      );
      await client.query(
        "UPDATE users SET role=CASE WHEN role='viewer' THEN 'broadcaster' ELSE role END,updated_at=now() WHERE id=$1",
        [auth.user.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.status(201).json({ ok: true });
  });
  route("patch", "/channels/:id", async (req, res) => {
    const auth = await requireUser(r, req);
    await writeLimit(req, auth.user.id);
    const body = input(channelUpdate, req.body);
    const result = await r.db.query(
      "UPDATE channels SET display_name=$1,description=$2,updated_at=now() WHERE id=$3 AND owner_id=$4 RETURNING id",
      [body.displayName, body.description, id(req.params.id), auth.user.id],
    );
    if (!result.rowCount)
      throw new PlatformError(
        404,
        "CHANNEL_NOT_FOUND",
        "Owned channel not found.",
      );
    res.json({ ok: true });
  });
  route("get", "/streams", async (req, res) => {
    const q = input(
      z.object({
        q: z.string().max(120).default(""),
        limit: z.coerce.number().int().min(1).max(100).default(24),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      }),
      req.query,
    );
    res.json(await catalog.list(q.q, q.limit, q.offset));
  });
  route("get", "/streams/:id", async (req, res) =>
    res.json(await catalog.get(String(req.params.id))),
  );
  route("get", "/streams/:id/status", async (req, res) =>
    res.json(await catalog.get(String(req.params.id))),
  );
  route("get", "/studio/streams", async (req, res) => {
    const auth = await requireUser(r, req);
    const result = await r.db.query(
      "SELECT c.id FROM channels c WHERE owner_id=$1",
      [auth.user.id],
    );
    const q = input(
      z.object({
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      }),
      req.query,
    );
    res.json(
      result.rows[0]
        ? await catalog.list("", 24, q.offset, result.rows[0].id)
        : { streams: [], nextOffset: null },
    );
  });
  route("post", "/studio/streams", async (req, res) => {
    const auth = await requireUser(r, req);
    await writeLimit(req, auth.user.id);
    if (!["broadcaster", "administrator"].includes(auth.user.role))
      throw new PlatformError(
        403,
        "BROADCASTER_REQUIRED",
        "Create your channel first.",
      );
    const body = input(streamInput, req.body);
    const streamId = randomUUID();
    const result = await r.db.query(
      "INSERT INTO streams(id,channel_id,title,description,media_path) SELECT $1,c.id,$2,$3,$4 FROM channels c WHERE c.id=$5 AND c.owner_id=$6 RETURNING id",
      [
        streamId,
        body.title,
        body.description,
        "s-" + randomUUID().replaceAll("-", ""),
        body.channelId,
        auth.user.id,
      ],
    );
    if (!result.rowCount)
      throw new PlatformError(
        404,
        "CHANNEL_NOT_FOUND",
        "Owned channel not found.",
      );
    res.status(201).json({ id: streamId });
  });
  route("patch", "/studio/streams/:id", async (req, res) => {
    const auth = await requireUser(r, req);
    await writeLimit(req, auth.user.id);
    const body = input(streamUpdate, req.body);
    await catalog.owned(id(req.params.id), auth.user.id);
    await r.db.query(
      "UPDATE streams SET title=$1,description=$2,updated_at=now() WHERE id=$3",
      [body.title, body.description, req.params.id],
    );
    res.json({ ok: true });
  });
  route("post", "/studio/streams/:id/publishing", async (req, res) => {
    const auth = await requireUser(r, req);
    await writeLimit(req, auth.user.id);
    const row = await catalog.owned(id(req.params.id), auth.user.id);
    if (row.lifecycle === "ended")
      throw new PlatformError(
        409,
        "STREAM_ENDED",
        "Create a new stream for your next broadcast.",
      );
    // Revoke before disconnect; no previous credential is ever returned or recovered.
    await r.db.query(
      "UPDATE streams SET publish_hash=NULL,updated_at=now() WHERE id=$1",
      [row.id],
    );
    catalog.invalidate(row.media_path);
    await kickPublisher(media, row.media_path);
    const key = secret();
    const installed = await r.db.query(
      "UPDATE streams SET publish_hash=$1,lifecycle='ready',updated_at=now() WHERE id=$2 AND lifecycle!='ended'",
      [digest(key), row.id],
    );
    if (!installed.rowCount)
      throw new PlatformError(
        409,
        "STREAM_ENDED",
        "The stream ended while the key was being rotated.",
      );
    res.json({
      server: c.MEDIA_RTMP_PUBLIC_URL,
      path: row.media_path,
      user: row.id,
      key,
      streamKey: row.media_path + "?user=" + row.id + "&pass=" + key,
    });
  });
  route("post", "/studio/streams/:id/end", async (req, res) => {
    const auth = await requireUser(r, req);
    await writeLimit(req, auth.user.id);
    const row = await catalog.owned(id(req.params.id), auth.user.id);
    await r.db.query(
      "UPDATE streams SET publish_hash=NULL,lifecycle='ended',ended_at=now(),updated_at=now() WHERE id=$1",
      [row.id],
    );
    catalog.invalidate(row.media_path);
    await kickPublisher(media, row.media_path);
    res.json({ ok: true });
  });
  route("get", "/streams/:id/chat", async (req, res) => {
    const streamId = id(req.params.id);
    await catalog.get(streamId);
    const q = input(
      z.object({
        before: z
          .string()
          .regex(/^[0-9]{1,19}$/)
          .optional(),
        after: z
          .string()
          .regex(/^[0-9]{1,19}$/)
          .optional(),
      }),
      req.query,
    );
    const messages = await history(
      r,
      streamId,
      c.CHAT_HISTORY_LIMIT,
      q.before,
      q.after,
    );
    res.json({
      messages,
      nextBefore:
        messages.length === c.CHAT_HISTORY_LIMIT ? messages[0]?.seq : null,
    });
  });
  route("get", "/streams/:id/presence", async (req, res) => {
    const streamId = id(req.params.id);
    const row = await r.db.query("SELECT id FROM streams WHERE id=$1", [
      streamId,
    ]);
    if (!row.rowCount)
      throw new PlatformError(404, "STREAM_NOT_FOUND", "Stream not found.");
    res.json({
      count: await presenceCount(r, streamId),
      label: "Approximate active players",
    });
  });
  const errors = (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const safe = publicError(error);
    logger.warn(
      { code: safe.code, status: safe.status, requestId: res.locals.requestId },
      "Platform request failed",
    );
    res.status(safe.status).json({
      error: {
        code: safe.code,
        message: safe.message,
        requestId: res.locals.requestId,
      },
    });
  };
  return {
    ready: async () => {
      try {
        if (!r.redis.isReady || !r.pub.isReady || !r.sub.isReady) return false;
        await r.db.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    router,
    errors,
    catalog,
    setRevokeSockets: (fn: typeof revokeSockets) => {
      revokeSockets = fn;
    },
  };
}
export type Platform = Awaited<ReturnType<typeof createPlatform>>;
export type PlatformRouter = Router;
