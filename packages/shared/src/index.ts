import { z } from "zod";

export const healthSchema = z.object({
  status: z.enum(["alive", "ready", "not_ready"]),
  service: z.literal("streamshield-api"),
});
export const systemInfoSchema = z.object({
  name: z.literal("StreamShield"),
  version: z.string(),
  phase: z.literal(1),
  capabilities: z.array(z.string()),
});
export type Health = z.infer<typeof healthSchema>;
export type SystemInfo = z.infer<typeof systemInfoSchema>;
export interface ApiError {
  error: { code: string; message: string; requestId: string };
}
