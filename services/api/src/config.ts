import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);
const duration = z.coerce.number().int().min(100).max(120000);
const origin = z
  .string()
  .url()
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  }, "Must be an HTTP(S) origin without path or trailing slash");
const schema = z.object({
  MEDIA_STREAM_PATH: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  MEDIA_STREAM_TITLE: z.string().min(1).max(120),
  MEDIA_API_BASE_URL: z.url().refine((v) => {
    const u = new URL(v);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }),
  MEDIA_HLS_BASE_URL: z.url().refine((v) => {
    const u = new URL(v);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }),
  MEDIA_PUBLIC_HLS_BASE_URL: z
    .string()
    .min(1)
    .refine((v) => {
      if (v.startsWith("/") && !v.startsWith("//")) return !/[?#\\]/.test(v);
      try {
        const u = new URL(v);
        return (
          ["http:", "https:"].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      } catch {
        return false;
      }
    }),
  MEDIA_API_USER: z
    .string()
    .min(1)
    .refine((v) => v !== "any"),
  MEDIA_API_PASSWORD: z.string().min(24),
  MEDIA_PROBE_TIMEOUT_MS: duration,
  MEDIA_STATUS_CACHE_MS: z.coerce.number().int().min(0).max(10000),
  NODE_ENV: z.enum(["development", "test", "production"]),
  API_HOST: z
    .string()
    .min(1)
    .refine((v) => /^[a-zA-Z0-9.:-]+$/.test(v), "Invalid bind host"),
  API_PORT: port,
  CORS_ORIGINS: z
    .string()
    .transform((v) => v.split(",").map((s) => s.trim()))
    .pipe(z.array(origin).min(1)),
  REQUEST_TIMEOUT_MS: duration,
  SHUTDOWN_TIMEOUT_MS: duration,
  LOG_LEVEL: z.enum([
    "silent",
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
  ]),
});
export function parseConfig(input: Record<string, unknown>) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid API configuration: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}
export type Config = ReturnType<typeof parseConfig>;
