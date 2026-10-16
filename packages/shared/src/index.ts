import { z } from "zod";

export const healthSchema = z.object({
  status: z.enum(["alive", "ready", "not_ready"]),
  service: z.literal("streamshield-api"),
});
export const systemInfoSchema = z.object({
  name: z.literal("StreamShield"),
  version: z.string(),
  phase: z.literal(2),
  capabilities: z.array(z.string()),
});
export type Health = z.infer<typeof healthSchema>;
export type SystemInfo = z.infer<typeof systemInfoSchema>;
export interface ApiError {
  error: { code: string; message: string; requestId: string };
}

export const streamSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  title: z.string(),
  status: z.enum(["offline", "starting", "live", "unavailable"]),
  publisher: z.enum(["online", "offline", "unknown"]),
  hls: z.enum(["available", "unavailable", "not_checked"]),
  reason: z.enum([
    "publisher_absent",
    "verified_manifest",
    "hls_pending",
    "origin_unreachable",
    "origin_rejected",
    "invalid_origin_response",
  ]),
  checkedAt: z.iso.datetime(),
  playbackUrl: z.string(),
  tracks: z.array(z.string()),
});
export const streamListSchema = z.object({ streams: z.array(streamSchema) });
export type Stream = z.infer<typeof streamSchema>;
