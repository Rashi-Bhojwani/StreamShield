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
const privateUrl = z.url().refine((v) => {
  const u = new URL(v);
  return (
    ["http:", "https:"].includes(u.protocol) &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash
  );
});
const schema = z.object({
  CHAOS_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    privateUrl.optional(),
  ),
  CHAOS_SECRET: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^[\w-]{43}$/)
      .optional(),
  ),
  HEALER_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    privateUrl.optional(),
  ),
  HEALER_SECRET: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^[\w-]{43}$/)
      .optional(),
  ),
  OBS_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    privateUrl.optional(),
  ),
  OBS_SECRET: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^[\w-]{43}$/)
      .optional(),
  ),
  PROMETHEUS_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    privateUrl.optional(),
  ),
  API_INSTANCE_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/)
    .optional(),
  TRUST_GATEWAY_IDS: z.enum(["true", "false"]).optional(),
  /** Adds X-Served-By (the API instance id). Defaults on outside production. */
  EXPOSE_SERVING_INSTANCE: z.enum(["true", "false"]).optional(),
  MEDIA_DELIVERY_API_BASE_URL: privateUrl.optional(),
  MEDIA_STANDBY_API_BASE_URL: privateUrl.optional(),
  MEDIA_STANDBY_HLS_BASE_URL: privateUrl.optional(),
  MEDIA_STANDBY_PUBLIC_HLS_BASE_URL: z
    .string()
    .regex(/^\/[a-zA-Z0-9/_-]+$/)
    .optional(),
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
  MEDIA_CONTROL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(9000)
    .default(5000),
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
  const c = result.data;
  if (
    [c.OBS_URL, c.PROMETHEUS_URL].some(Boolean) &&
    ![c.OBS_URL, c.OBS_SECRET, c.PROMETHEUS_URL].every(Boolean)
  )
    throw new Error("Complete monitoring service configuration required");
  if (Boolean(c.HEALER_URL) !== Boolean(c.HEALER_SECRET))
    throw new Error("Complete healing read service configuration required");
  if (Boolean(c.CHAOS_URL) !== Boolean(c.CHAOS_SECRET))
    throw new Error("Complete chaos read service configuration required");
  const group = [
    c.MEDIA_DELIVERY_API_BASE_URL,
    c.MEDIA_STANDBY_API_BASE_URL,
    c.MEDIA_STANDBY_HLS_BASE_URL,
    c.MEDIA_STANDBY_PUBLIC_HLS_BASE_URL,
  ];
  if (group.some(Boolean) && !group.every(Boolean))
    throw new Error(
      "Complete primary/standby delivery configuration is required",
    );
  return c;
}
export type Config = ReturnType<typeof parseConfig>;
