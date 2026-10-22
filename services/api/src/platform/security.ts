import { z } from "zod";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response } from "express";
import type { User } from "@streamshield/shared";
import type { Resources } from "./resources.js";
import type { PlatformConfig } from "./config.js";
export class PlatformError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function cookies(raw: string | undefined): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const part of (raw || "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    try {
      result[name] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      /* Ignore malformed cookies. */
    }
  }
  return result;
}
export function csrfToken(nonce: string, c: PlatformConfig) {
  return createHmac("sha256", c.CSRF_SECRET).update(nonce).digest("base64url");
}
export function cookieOptions(c: PlatformConfig) {
  return {
    httpOnly: true,
    secure: c.COOKIE_SECURE,
    sameSite: "lax" as const,
    path: "/",
  };
}
export function csrf(req: Request, res: Response, c: PlatformConfig) {
  let nonce = cookies(req.headers.cookie).ss_csrf;
  if (!nonce || !/^[a-zA-Z0-9_-]{43}$/.test(nonce)) {
    nonce = secret();
    res.cookie("ss_csrf", nonce, {
      ...cookieOptions(c),
      maxAge: c.SESSION_TTL_SECONDS * 1000,
    });
  }
  return csrfToken(nonce, c);
}
export function checkCsrf(
  origin: string | undefined,
  header: unknown,
  rawCookies: string | undefined,
  origins: string[],
  c: PlatformConfig,
) {
  const nonce = cookies(rawCookies).ss_csrf;
  if (
    !origin ||
    !origins.includes(origin) ||
    typeof header !== "string" ||
    !nonce ||
    !equal(header, csrfToken(nonce, c))
  )
    throw new PlatformError(
      403,
      "CSRF_REJECTED",
      "Refresh this page and try again.",
    );
}
export async function session(
  r: Resources,
  rawCookies: string | undefined,
): Promise<{ user: User; tokenHash: string } | null> {
  const token = cookies(rawCookies).ss_session;
  if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
  const hash = digest(token);
  const result = await r.db.query(
    "SELECT u.id,u.username,u.email,u.display_name,u.avatar_color,u.role FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL",
    [hash],
  );
  const row = result.rows[0];
  return row
    ? {
        tokenHash: hash,
        user: {
          id: row.id,
          username: row.username,
          email: row.email,
          displayName: row.display_name,
          avatarColor: row.avatar_color,
          role: row.role,
        },
      }
    : null;
}
export async function requireUser(r: Resources, req: Request) {
  const auth = await session(r, req.headers.cookie);
  if (!auth)
    throw new PlatformError(401, "AUTH_REQUIRED", "Sign in to continue.");
  return auth;
}
export async function rate(
  r: Resources,
  key: string,
  max: number,
  windowMs: number,
) {
  try {
    const count = await r.redis.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n",
      { keys: ["rate:" + digest(key)], arguments: [String(windowMs)] },
    );
    if (Number(count) > max)
      throw new PlatformError(
        429,
        "RATE_LIMITED",
        "Too many requests. Try again shortly.",
      );
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError(
      503,
      "REDIS_UNAVAILABLE",
      "This action is temporarily unavailable.",
    );
  }
}
export function publicError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof z.ZodError)
    return {
      status: 400,
      code: "INVALID_INPUT",
      message: "Invalid request fields.",
    };
  if (error instanceof PlatformError)
    return { status: error.status, code: error.code, message: error.message };
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  )
    return {
      status: 409,
      code: "CONFLICT",
      message: "That account or channel is unavailable.",
    };
  return {
    status: 503,
    code: "DEPENDENCY_UNAVAILABLE",
    message: "The service is temporarily unavailable. Please retry.",
  };
}
