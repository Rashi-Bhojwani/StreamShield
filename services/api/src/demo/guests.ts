import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { Resources } from "../platform/resources.js";
import type { PlatformConfig } from "../platform/config.js";
import {
  cookies,
  secret,
  digest,
  rate,
  cookieOptions,
  PlatformError,
} from "../platform/security.js";
export async function findGuest(r: Resources, raw: string | undefined) {
  const token = cookies(raw).ss_guest;
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const row = (
    await r.db.query(
      "SELECT id,name FROM demo_guests WHERE token_hash=$1 AND expires_at>now()",
      [digest(token)],
    )
  ).rows[0];
  return row ? { id: String(row.id), name: String(row.name) } : null;
}
export async function ensureGuest(
  r: Resources,
  c: PlatformConfig,
  req: Request,
  res: Response,
) {
  const existing = await findGuest(r, req.headers.cookie);
  if (existing) return existing;
  await rate(r, "guest-create:" + req.ip, c.DEMO_GUEST_CREATE_LIMIT, 60000);
  const token = secret(),
    id = randomUUID(),
    name = "Guest-" + id.slice(0, 8);
  await r.db.query(
    "INSERT INTO demo_guests(id,token_hash,name,expires_at) VALUES($1,$2,$3,now()+($4*interval '1 second'))",
    [id, digest(token), name, c.DEMO_GUEST_TTL_SECONDS],
  );
  res.cookie("ss_guest", token, cookieOptions(c)); // Session cookie, never a privilege-bearing account.
  return { id, name };
}
export async function consumeLocalTicket(
  r: Resources,
  c: PlatformConfig,
  req: Request,
  res: Response,
  ticket: string,
) {
  if (
    !c.DEMO_ENABLED ||
    !["localhost", "127.0.0.1", "[::1]"].includes(req.hostname)
  )
    throw new PlatformError(
      403,
      "LOCAL_ONLY",
      "Use the trusted local browser.",
    );
  const token = secret();
  const row = (
    await r.db.query(
      `WITH consumed AS (
    UPDATE demo_local_tickets t SET consumed_at=now() FROM users u
    WHERE t.token_hash=$1 AND t.user_id=u.id AND u.role='administrator'
    AND t.consumed_at IS NULL AND t.expires_at>now() RETURNING t.user_id
  ) INSERT INTO auth_sessions(token_hash,user_id,expires_at)
    SELECT $2,user_id,now()+interval '15 minutes' FROM consumed RETURNING user_id`,
      [digest(ticket), digest(token)],
    )
  ).rows[0];
  if (!row)
    throw new PlatformError(
      403,
      "TICKET_INVALID",
      "This local capability expired or has already been used. Issue another from the trusted terminal.",
    );
  res.cookie("ss_session", token, { ...cookieOptions(c), maxAge: 900000 });
}
