import { z } from "zod";
import type { Config } from "../config.js";
import { createMediaService } from "../media.js";
import type { Resources } from "./resources.js";
import type { PlatformConfig } from "./config.js";
import { PlatformError } from "./security.js";
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
  "SELECT s.*,c.slug AS channel_slug,c.display_name AS channel_name,c.owner_id,u.username AS owner_username FROM streams s JOIN channels c ON c.id=s.channel_id JOIN users u ON u.id=c.owner_id";
export function createCatalog(
  r: Resources,
  c: PlatformConfig,
  mediaConfig: Config,
) {
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
    if (row.lifecycle === "ready" && evidence.status === "live") {
      await r.db.query(
        "UPDATE streams SET started_at=COALESCE(started_at,now()),last_live_at=now(),ended_at=NULL WHERE id=$1 AND lifecycle='ready'",
        [row.id],
      );
    } else if (
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
    invalidate: (path: string) => observers.delete(path),
    observe,
    async get(id: string) {
      if (c.ENABLE_LEGACY_STREAM && id === mediaConfig.MEDIA_STREAM_PATH)
        return legacy.getStream();
      if (!z.uuid().safeParse(id).success)
        throw new PlatformError(404, "STREAM_NOT_FOUND", "Stream not found.");
      const result = await r.db.query(streamSelect + " WHERE s.id=$1", [id]);
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
          " WHERE ($1::text IS NULL OR c.id::text=$1) AND ($2='' OR s.title ILIKE $3 OR c.display_name ILIKE $3 OR c.slug ILIKE $3) ORDER BY s.created_at DESC,s.id DESC LIMIT $4 OFFSET $5",
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
export async function kickPublisher(c: Config, path: string) {
  const headers = {
    Authorization:
      "Basic " +
      Buffer.from(c.MEDIA_API_USER + ":" + c.MEDIA_API_PASSWORD).toString(
        "base64",
      ),
  };
  const signal = AbortSignal.timeout(c.MEDIA_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(c.MEDIA_API_BASE_URL + "/v3/rtmpconns/list", {
      headers,
      signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error("Control unavailable");
    const list = z
      .object({
        items: z.array(
          z.object({ id: z.uuid(), path: z.string(), state: z.string() }),
        ),
      })
      .parse(await response.json());
    for (const conn of list.items.filter(
      (conn) => conn.path === path && conn.state === "publish",
    )) {
      const result = await fetch(
        c.MEDIA_API_BASE_URL + "/v3/rtmpconns/kick/" + conn.id,
        { method: "POST", headers, signal, redirect: "error" },
      );
      if (!result.ok && result.status !== 404) throw new Error("Kick failed");
    }
  } catch {
    throw new PlatformError(
      503,
      "PUBLISHER_STOP_UNCONFIRMED",
      "The key was revoked, but publisher disconnection could not be confirmed. Stop OBS and retry.",
    );
  }
}
