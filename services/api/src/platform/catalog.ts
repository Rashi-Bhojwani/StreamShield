import { z } from "zod";
import { observeBroadcast } from "./dynamic.js";
import type { Config } from "../config.js";
import { createMediaService } from "../media.js";
import type { Resources } from "./resources.js";
import type { PlatformConfig } from "./config.js";
import { PlatformError } from "./security.js";
import {
  MediaControlError,
  mediaControlHeaders,
  publisherConnections,
} from "./media-control.js";
const rowSchema = z
  .object({
    id: z.string(),
    channel_id: z.string(),
    title: z.string(),
    description: z.string(),
    media_path: z.string(),
    lifecycle: z.enum(["draft", "ready", "ended"]),
    channel_slug: z.string(),
    channel_name: z.string(),
    owner_username: z.string(),
    started_at: z.date().nullable(),
    ended_at: z.date().nullable(),
  })
  .passthrough();
export const streamSelect =
  "SELECT s.*,c.slug AS channel_slug,c.display_name AS channel_name,c.owner_id,u.avatar_color,u.username AS owner_username FROM streams s JOIN channels c ON c.id=s.channel_id JOIN users u ON u.id=c.owner_id";
export function createCatalog(
  r: Resources,
  c: PlatformConfig,
  mediaConfig: Config,
) {
  let notify = (_event: {
    version: 1;
    streamId: string;
    state: string;
    at: string;
  }) => {};
  let moderationNotify = (_event: {
    streamId: string;
    messageId?: string;
  }) => {};
  const observers = new Map<string, ReturnType<typeof createMediaService>>();
  const legacy = createMediaService(mediaConfig);
  const observe = async (input: unknown) => {
    const row = rowSchema.parse(input);
    let source = observers.get(row.media_path);
    if (!source) {
      if (observers.size >= c.MEDIA_OBSERVER_LIMIT)
        observers.delete(observers.keys().next().value!);
      source = createMediaService({
        ...mediaConfig,
        MEDIA_STREAM_PATH: row.media_path,
        MEDIA_STREAM_TITLE: row.title,
      });
      observers.set(row.media_path, source);
    }
    const evidence = await source.getStream();
    const dynamic = c.DYNAMIC_ENABLED
      ? await observeBroadcast(
          r,
          c,
          mediaConfig,
          row.id,
          row.media_path,
          evidence,
        )
      : null;
    if (dynamic?.changed)
      notify({
        version: 1,
        streamId: row.id,
        state: dynamic.state,
        at: new Date().toISOString(),
      });
    if (c.DEMO_ENABLED)
      await r.db.query(
        `WITH changed AS (
      UPDATE demo_channels SET last_status=$2 WHERE stream_id=$1 AND last_status IS DISTINCT FROM $2 RETURNING stream_id
    ) INSERT INTO demo_broadcast_history(stream_id,status) SELECT stream_id,$2 FROM changed`,
        [row.id, evidence.status],
      );
    if (
      !c.DYNAMIC_ENABLED &&
      row.lifecycle === "ready" &&
      evidence.status === "live"
    ) {
      await r.db.query(
        "UPDATE streams SET started_at=COALESCE(started_at,now()),last_live_at=now(),ended_at=NULL WHERE id=$1 AND lifecycle='ready'",
        [row.id],
      );
    } else if (
      !c.DYNAMIC_ENABLED &&
      evidence.status === "offline" &&
      row.lifecycle === "ready" &&
      row.started_at
    ) {
      await r.db.query(
        "UPDATE streams SET ended_at=COALESCE(ended_at,now()) WHERE id=$1 AND lifecycle='ready'",
        [row.id],
      );
    }
    return {
      ...evidence,
      ...(dynamic
        ? { status: dynamic.status, broadcastState: dynamic.state }
        : {}),
      category: String(row.category || "Other"),
      avatarColor: String(row.avatar_color || "#52d7c7"),
      id: row.id,
      title: row.title,
      description: row.description,
      channelId: row.channel_id,
      channelSlug: row.channel_slug,
      channelName: row.channel_name,
      ownerUsername: row.owner_username,
      lifecycle: row.lifecycle,
      startedAt: row.started_at?.toISOString() || null,
      endedAt: row.ended_at?.toISOString() || null,
    };
  };
  return {
    setNotify: (fn: typeof notify) => {
      notify = fn;
    },
    notifyDiscovery: (event: Parameters<typeof notify>[0]) => notify(event),
    setModerationNotify: (fn: typeof moderationNotify) => {
      moderationNotify = fn;
    },
    notifyModeration: (event: Parameters<typeof moderationNotify>[0]) =>
      moderationNotify(event),
    invalidate: (path: string) => observers.delete(path),
    observe,
    async get(id: string) {
      if (
        !c.DEMO_ENABLED &&
        c.ENABLE_LEGACY_STREAM &&
        id === mediaConfig.MEDIA_STREAM_PATH
      )
        return legacy.getStream();
      if (
        !z.uuid().safeParse(id).success &&
        !(c.DEMO_ENABLED && /^streamer-[123]$/.test(id))
      )
        throw new PlatformError(404, "STREAM_NOT_FOUND", "Stream not found.");
      const result = await r.db.query(
        streamSelect +
          (c.DEMO_ENABLED
            ? " WHERE s.id IN (SELECT stream_id FROM demo_channels) AND (s.id::text=$1 OR c.slug=$1)"
            : " WHERE s.id::text=$1"),
        [id],
      );
      if (!result.rows[0])
        throw new PlatformError(404, "STREAM_NOT_FOUND", "Stream not found.");
      return observe(result.rows[0]);
    },
    async list(
      search: string,
      limit: number,
      offset: number,
      channel?: string,
    ) {
      const result = await r.db.query(
        streamSelect +
          (c.DEMO_ENABLED
            ? " WHERE s.id IN (SELECT stream_id FROM demo_channels) AND "
            : " WHERE ") +
          "($1::text IS NULL OR c.id::text=$1) AND ($2='' OR s.title ILIKE $3 OR c.display_name ILIKE $3 OR c.slug ILIKE $3) ORDER BY s.created_at DESC,s.id DESC LIMIT $4 OFFSET $5",
        [
          channel || null,
          search,
          "%" + search.replace(/[%_\\]/g, "\\$&") + "%",
          limit + 1,
          offset,
        ],
      );
      const rows = result.rows.slice(0, limit);
      const streams = await Promise.all(rows.map(observe));
      if (
        !c.DEMO_ENABLED &&
        c.ENABLE_LEGACY_STREAM &&
        offset === 0 &&
        !channel &&
        (!search ||
          (mediaConfig.MEDIA_STREAM_TITLE + " " + mediaConfig.MEDIA_STREAM_PATH)
            .toLowerCase()
            .includes(search.toLowerCase()))
      )
        streams.unshift((await legacy.getStream()) as (typeof streams)[number]);
      return {
        streams,
        nextOffset: result.rows.length > limit ? offset + limit : null,
      };
    },
    async owned(id: string, userId: string) {
      const result = await r.db.query(
        streamSelect +
          " WHERE s.id=$1 AND c.owner_id=$2 AND u.role IN ('broadcaster','administrator')",
        [id, userId],
      );
      if (!result.rows[0])
        throw new PlatformError(
          404,
          "STREAM_NOT_FOUND",
          "Owned stream not found.",
        );
      return result.rows[0];
    },
  };
}
export type Catalog = ReturnType<typeof createCatalog>;
export async function kickPublisher(
  c: Config,
  path: string,
  includeWebrtc = false,
) {
  const headers = mediaControlHeaders(c);
  const signal = AbortSignal.timeout(c.MEDIA_CONTROL_TIMEOUT_MS);
  try {
    const connections = await publisherConnections(c, includeWebrtc, signal);
    for (const { protocol, items } of connections) {
      for (const conn of items.filter(
        (conn) => conn.path === path && conn.state === "publish",
      )) {
        const result = await fetch(
          c.MEDIA_API_BASE_URL + "/v3/" + protocol + "/kick/" + conn.id,
          { method: "POST", headers, signal, redirect: "error" },
        );
        if (!result.ok && result.status !== 404) throw new Error("Kick failed");
      }
    }
  } catch (error) {
    const reason =
      error instanceof MediaControlError
        ? error.code
        : signal.aborted
          ? "media_control_timeout"
          : "media_control_kick_unconfirmed";
    throw new PlatformError(
      503,
      "PUBLISHER_STOP_UNCONFIRMED",
      "Publishing access is revoked, but publisher disconnection is unconfirmed (" +
        reason +
        "). Check media control before retrying.",
    );
  }
}
