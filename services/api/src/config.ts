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
