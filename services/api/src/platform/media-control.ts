import { z } from "zod";
import type { Config } from "../config.js";

export type MediaControlCode =
  | "media_control_timeout"
  | "media_control_unreachable"
  | "media_control_auth_denied"
  | "media_control_http_error"
  | "media_control_invalid_response"
  | "media_control_inventory_incomplete";
export class MediaControlError extends Error {
  constructor(public readonly code: MediaControlCode) {
    super(code);
    this.name = "MediaControlError";
  }
}
const listSchema = z.object({
  pageCount: z.number().int().nonnegative().optional(),
  items: z
    .array(z.object({ id: z.uuid(), path: z.string(), state: z.string() }))
    .max(1000),
});
export function mediaControlHeaders(c: Config) {
  return {
    Authorization:
      "Basic " +
      Buffer.from(c.MEDIA_API_USER + ":" + c.MEDIA_API_PASSWORD).toString(
        "base64",
      ),
  };
}
/** Independent inventories share one bounded deadline but run concurrently.
 * All reads must succeed before a caller can claim control is ready or kick a
 * publisher. No connection identities or credentials leave the private API. */
export async function publisherConnections(
  c: Config,
  includeWebrtc = false,
  signal = AbortSignal.timeout(c.MEDIA_CONTROL_TIMEOUT_MS),
) {
  const protocols = ["rtmpconns", ...(includeWebrtc ? ["webrtcsessions"] : [])];
  const results = await Promise.allSettled(
    protocols.map(async (protocol) => {
      try {
        const response = await fetch(
          c.MEDIA_API_BASE_URL + "/v3/" + protocol + "/list",
          {
            headers: mediaControlHeaders(c),
            signal,
            redirect: "error",
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new MediaControlError(
            [401, 403].includes(response.status)
              ? "media_control_auth_denied"
              : "media_control_http_error",
          );
        }
        let list;
        try {
          list = listSchema.parse(await response.json());
        } catch {
          throw new MediaControlError(
            signal.aborted
              ? "media_control_timeout"
              : "media_control_invalid_response",
          );
        }
        if ((list.pageCount ?? 1) > 1)
          throw new MediaControlError("media_control_inventory_incomplete");
        return { protocol, items: list.items };
      } catch (error) {
        if (error instanceof MediaControlError) throw error;
        throw new MediaControlError(
          signal.aborted
            ? "media_control_timeout"
            : "media_control_unreachable",
        );
      }
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results.map((result) => {
    if (result.status !== "fulfilled")
      throw new MediaControlError("media_control_unreachable");
    return result.value;
  });
}
