import { z } from "zod";
const port = z.coerce.number().int().min(1).max(65535);
const http = z.url().refine((v) => {
  const u = new URL(v);
  return (
    ["http:", "https:"].includes(u.protocol) &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash
  );
});
export const mediaEnvSchema = z.object({
  NODE_ENV: z.literal("development"),
  MEDIA_STREAM_PATH: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  MEDIA_PUBLISH_USER: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .refine((v) => v !== "any", "Anonymous users are forbidden"),
  MEDIA_PUBLISH_PASSWORD: z.string().regex(/^[a-zA-Z0-9_-]{24,}$/),
  MEDIA_API_USER: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .refine((v) => v !== "any", "Anonymous users are forbidden"),
  MEDIA_API_PASSWORD: z.string().regex(/^[a-zA-Z0-9_-]{24,}$/),
  MEDIA_RTMP_PORT: port,
  MEDIA_HLS_PORT: port,
  MEDIA_API_PORT: port,
  MEDIA_RTMP_BASE_URL: z.url().refine((v) => {
    const u = new URL(v);
    return (
      u.protocol === "rtmp:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }),
  MEDIA_READ_TIMEOUT: z.string().regex(/^[1-9]\d*(ms|s)$/),
  MEDIA_WRITE_TIMEOUT: z.string().regex(/^[1-9]\d*(ms|s)$/),
  MEDIA_HLS_SEGMENT_DURATION: z.string().regex(/^[1-9]\d*(ms|s)$/),
  MEDIA_HLS_SEGMENT_COUNT: z.coerce.number().int().min(3).max(30),
  MEDIA_HLS_SEGMENT_MAX_SIZE: z.string().regex(/^\d+[MK]$/),
  CORS_ORIGINS: z
    .string()
    .transform((s) => s.split(",").map((v) => v.trim()))
    .pipe(z.array(http).min(1)),
  TEST_PUBLISH_DURATION_SECONDS: z.coerce.number().int().min(5).max(600),
  TEST_PUBLISH_GRACE_MS: z.coerce.number().int().min(100).max(15000),
  TEST_PUBLISH_FPS: z.coerce.number().int().min(10).max(60),
  TEST_PUBLISH_SIZE: z.string().regex(/^[1-9]\d{1,3}x[1-9]\d{1,3}$/),
  TEST_PUBLISH_KEYFRAME_SECONDS: z.coerce.number().int().min(1).max(5),
  TEST_PUBLISH_TONE_HZ: z.coerce.number().int().min(20).max(20000),
});
export function mediaEnv(input) {
  const result = mediaEnvSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      "Invalid media configuration: " +
        result.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  const c = result.data;
  if (c.MEDIA_API_USER === c.MEDIA_PUBLISH_USER)
    throw new Error("Publishing and control usernames must differ");
  if (
    new Set([c.MEDIA_API_PORT, c.MEDIA_RTMP_PORT, c.MEDIA_HLS_PORT]).size !== 3
  )
    throw new Error("Media listener ports must be distinct");
  return c;
}
