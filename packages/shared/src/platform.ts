import { z } from "zod";
import { categorySchema, avatarColorSchema } from "./dynamic.js";
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,24}$/);
export const registerSchema = z
  .object({
    username: usernameSchema,
    email: z.email().trim().toLowerCase().max(254),
    password: z.string().min(12).max(128),
  })
  .strict();
export const loginSchema = z
  .object({
    identifier: z.string().trim().toLowerCase().min(3).max(254),
    password: z.string().min(1).max(128),
  })
  .strict();
export const userSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  email: z.email(),
  displayName: z.string(),
  avatarColor: avatarColorSchema.optional(),
  role: z.enum(["viewer", "broadcaster", "administrator"]),
});
export type User = z.infer<typeof userSchema>;
export const authSchema = z.object({
  demoMode: z.boolean().default(false),
  guest: z.object({ id: z.uuid(), name: z.string() }).nullable().default(null),
  user: userSchema.nullable(),
  csrf: z.string(),
  presenceHeartbeatMs: z.number(),
});
export const channelInput = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9_-]{2,39}$/),
    displayName: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000),
  })
  .strict();
export const channelUpdate = channelInput.omit({ slug: true });
export const channelSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  ownerUsername: z.string(),
  createdAt: z.string(),
});
export type Channel = z.infer<typeof channelSchema>;
export const streamInput = z
  .object({
    category: categorySchema.default("Other"),
    channelId: z.uuid(),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(4000),
  })
  .strict();
export const streamUpdate = streamInput.omit({ channelId: true });
export const messageInput = z
  .object({
    streamId: z.uuid(),
    content: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine(
        (v) =>
          Array.from(v).every(
            (ch) => ch.charCodeAt(0) >= 32 || ["\n", "\r", "\t"].includes(ch),
          ),
        "Invalid control characters",
      ),
  })
  .strict();
export const chatMessageSchema = z.object({
  synthetic: z.boolean().optional(),
  id: z.uuid(),
  seq: z.string(),
  streamId: z.uuid(),
  username: z.string(),
  content: z.string(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export interface RealtimeReply<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}
export const publishingSchema = z.object({
  whipUrl: z.string().optional(),
  server: z.string(),
  path: z.string(),
  user: z.string(),
  key: z.string(),
  streamKey: z.string(),
});
export type Publishing = z.infer<typeof publishingSchema>;
export const cancelPublishingSchema = z
  .object({
    key: z.string().regex(/^[\w-]{43}$/),
  })
  .strict();
