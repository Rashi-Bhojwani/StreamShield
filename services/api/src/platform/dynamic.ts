import { z } from "zod";
import type { Stream, BroadcastState } from "@streamshield/shared";
import type { Config } from "../config.js";
import type { PlatformConfig } from "./config.js";
import type { Resources } from "./resources.js";

export function nextBroadcastState(input: {
  lifecycle: string;
  prior: BroadcastState;
  status: Stream["status"];
  progressed: boolean;
  recentProgress: boolean;
  hadMedia: boolean;
  graceExpired: boolean;
  startupExpired?: boolean;
}): BroadcastState {
  if (input.lifecycle === "ended") return "ENDED";
  if (input.lifecycle === "draft") return "CREATED";
  if (input.status === "unavailable") return input.prior;
  if (input.status === "live" && (input.progressed || input.recentProgress))
    return "LIVE";
  if (input.startupExpired && !input.hadMedia && input.status !== "offline")
    return "FAILED";
  if (input.status === "offline" && input.hadMedia)
    return input.graceExpired ? "ENDED" : "CONNECTION_LOST";
  if (input.status === "starting" || input.status === "live")
    return input.hadMedia ? "RECONNECTING" : "PUBLISHING";
  return "PREPARING";
}

export async function observeBroadcast(
  r: Resources,
  c: PlatformConfig,
  media: Config,
  streamId: string,
  path: string,
  evidence: Stream,
) {
  let bytes: number | null = null;
  if (evidence.publisher !== "offline") {
    try {
      const response = await fetch(
        media.MEDIA_API_BASE_URL + "/v3/paths/get/" + path,
        {
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(
                media.MEDIA_API_USER + ":" + media.MEDIA_API_PASSWORD,
              ).toString("base64"),
          },
          signal: AbortSignal.timeout(media.MEDIA_PROBE_TIMEOUT_MS),
          redirect: "error",
        },
      );
      if (response.ok) {
        const body = z
          .object({
            name: z.string(),
            inboundBytes: z.number().nonnegative().optional(),
            bytesReceived: z.number().nonnegative().optional(),
          })
          .parse(await response.json());
        if (body.name === path)
          bytes = body.inboundBytes ?? body.bytesReceived ?? null;
      }
    } catch {
      /* Unknown progress is not evidence of LIVE. */
    }
  }
  const db = await r.db.connect();
  try {
    await db.query("BEGIN");
    const row = (
      await db.query(
        "SELECT *,now() AS observed_now FROM streams WHERE id=$1 FOR UPDATE",
        [streamId],
      )
    ).rows[0];
    const now = (row.observed_now as Date).getTime();
    const progressed =
      bytes !== null &&
      Number(row.media_bytes) > 0 &&
      bytes > 0 &&
      bytes !== Number(row.media_bytes);
    const recentProgress =
      !!row.media_progress_at &&
      now - row.media_progress_at.getTime() < c.DYNAMIC_PROGRESS_TTL_MS;
    const hadMedia = !!row.media_progress_at;
    const lost =
      evidence.status === "offline" && hadMedia
        ? row.source_lost_at || new Date(now)
        : null;
    const state = nextBroadcastState({
      lifecycle: row.lifecycle,
      prior: row.broadcast_state,
      status: evidence.status,
      progressed,
      recentProgress,
      hadMedia,
      startupExpired: now - row.state_changed_at.getTime() > 30000,
      graceExpired: !!lost && now - lost.getTime() >= c.DYNAMIC_SOURCE_GRACE_MS,
    });
    const changed = state !== row.broadcast_state;
    await db.query(
      `UPDATE streams SET broadcast_state=$2, media_bytes=COALESCE($3,media_bytes), media_progress_at=CASE WHEN $4 THEN now() ELSE media_progress_at END,
      source_lost_at=$5,dynamic_checked_at=now(),state_changed_at=CASE WHEN $6 THEN now() ELSE state_changed_at END,
      lifecycle=CASE WHEN $2='ENDED' THEN 'ended' ELSE lifecycle END,publish_hash=CASE WHEN $2='ENDED' THEN NULL ELSE publish_hash END,
      started_at=CASE WHEN $2='LIVE' THEN COALESCE(started_at,now()) ELSE started_at END,
      ended_at=CASE WHEN $2='ENDED' THEN COALESCE(ended_at,now()) ELSE ended_at END WHERE id=$1`,
      [streamId, state, bytes, progressed, lost, changed],
    );
    if (changed)
      await db.query(
        "INSERT INTO broadcast_events(stream_id,state,reason) VALUES($1,$2,$3)",
        [streamId, state, evidence.reason],
      );
    await db.query("COMMIT");
    return {
      state,
      changed,
      status:
        row.lifecycle === "ended" || state === "ENDED"
          ? ("offline" as const)
          : evidence.status === "unavailable"
            ? ("unavailable" as const)
            : state === "LIVE"
              ? ("live" as const)
              : evidence.status === "live"
                ? ("starting" as const)
                : evidence.status,
    };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
