import { z } from "zod";
export const categories = [
  "Technology",
  "Gaming",
  "Music",
  "Education",
  "Creative",
  "Just chatting",
  "Other",
] as const;
export const categorySchema = z.enum(categories);
export const broadcastStates = [
  "CREATED",
  "PREPARING",
  "PUBLISHING",
  "LIVE",
  "CONNECTION_LOST",
  "RECONNECTING",
  "ENDING",
  "ENDED",
  "FAILED",
] as const;
export type BroadcastState = (typeof broadcastStates)[number];
export const discoveryEventSchema = z.object({
  version: z.literal(1),
  streamId: z.uuid(),
  state: z.enum(broadcastStates),
  at: z.iso.datetime(),
});
export const avatarColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
