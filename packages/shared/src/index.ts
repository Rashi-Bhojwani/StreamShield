import { z } from "zod";

export const healthSchema = z.object({
  status: z.enum(["alive", "ready", "not_ready"]),
  service: z.literal("streamshield-api"),
});
export const systemInfoSchema = z.object({
  name: z.literal("StreamShield"),
  version: z.string(),
  phase: z.union([
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
  ]),
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
  playbackSources: z
    .array(z.object({ id: z.enum(["primary", "standby"]), url: z.string() }))
    .max(2)
    .optional(),
  tracks: z.array(z.string()),
  description: z.string().optional(),
  channelId: z.string().optional(),
  channelSlug: z.string().optional(),
  channelName: z.string().optional(),
  ownerUsername: z.string().optional(),
  lifecycle: z.enum(["draft", "ready", "ended"]).optional(),
  startedAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
});
export const streamListSchema = z.object({
  streams: z.array(streamSchema),
  nextOffset: z.number().nullable().optional(),
});
export type Stream = z.infer<typeof streamSchema>;

/** Browser observations, distinct from backend publisher/HLS availability. */
export type PlaybackEventKind =
  | "player_initialized"
  | "manifest_loaded"
  | "native_media_ready"
  | "manifest_failure"
  | "segment_failure"
  | "playback_started"
  | "playback_stalled"
  | "playback_resumed"
  | "playback_paused"
  | "playback_ended"
  | "source_unavailable"
  | "fatal_player_error"
  | "autoplay_blocked"
  | "retry_scheduled"
  | "source_released"
  | "source_selected"
  | "source_failure_detected"
  | "alternate_source_selected"
  | "playback_reinitialized"
  | "recovery_failed";
export interface PlaybackFailure {
  code: string;
  message: string;
  fatal: boolean;
}
export interface PlaybackEvent {
  kind: PlaybackEventKind;
  sourceId: string;
  at: string;
  elapsedMs: number;
  error?: PlaybackFailure;
  deliverySource?: "primary" | "standby";
}
export interface PlaybackMetrics {
  sourceId: string;
  /** Time from initialization to first advancing, unpaused media time; null until observed. */
  startupMs: number | null;
  /** Waiting/stalled episodes after startup, deduplicated until progress or pause. */
  stallCount: number;
  /** Monotonic duration observed at the event timestamp, including any active stall. */
  stallDurationMs: number;
  lastError: PlaybackFailure | null;
}
export interface PlaybackObservation {
  event: PlaybackEvent;
  metrics: PlaybackMetrics;
}

export * from "./platform";

export * from "./monitoring";
export * from "./healing";
