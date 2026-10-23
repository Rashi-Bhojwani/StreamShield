import { z } from "zod";

export const webConfigSchema = z.object({
  VITE_DYNAMIC_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Served-by badges and stream-health overlay (demo/development builds). */
  VITE_SHOW_SERVING_INSTANCE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  VITE_DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  VITE_CHAT_WINDOW_LIMIT: z.coerce
    .number()
    .int()
    .min(50)
    .max(1000)
    .default(200),
  VITE_CHAT_RECONNECT_LIMIT: z.coerce.number().int().min(0).max(60).default(30),
  VITE_CHAT_RECONNECT_DELAY_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10000)
    .default(1000),
  VITE_STREAM_POLL_MS: z.coerce.number().int().min(1000).max(300000),
  VITE_PLAYER_LOAD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000),
  VITE_PLAYER_STALL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000),
  VITE_PLAYER_RETRY_LIMIT: z.coerce.number().int().min(0).max(30),
  VITE_PLAYER_RETRY_BASE_MS: z.coerce.number().int().min(100).max(30000),
  VITE_PLAYER_RETRY_MAX_MS: z.coerce.number().int().min(100).max(60000),
  VITE_API_BASE_URL: z
    .string()
    .min(1)
    .refine((v) => {
      if (v.startsWith("/") && !v.startsWith("//"))
        return !v.includes("?") && !v.includes("#");
      try {
        const url = new URL(v);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "Use a relative path or HTTP(S) API URL without credentials, query or fragment"),
  VITE_API_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000),
  VITE_STATUS_POLL_MS: z.coerce.number().int().min(1000).max(300000),
});
export const config = webConfigSchema.parse(import.meta.env);
