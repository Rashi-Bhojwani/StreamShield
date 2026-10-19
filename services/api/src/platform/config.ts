import { z } from "zod";
const int = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const schema = z.object({
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: int(1, 65535),
  POSTGRES_DB: z.string().regex(/^[a-zA-Z0-9_]+$/),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(24),
  DB_POOL_MAX: int(1, 100),
  DEPENDENCY_TIMEOUT_MS: int(100, 30000),
  REDIS_DB: int(0, 15).default(0),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: int(1, 65535),
  REDIS_PASSWORD: z.string().min(24),
  REDIS_RECONNECT_LIMIT: int(0, 20),
  SESSION_TTL_SECONDS: int(60, 2592000),
  COOKIE_SECURE: bool,
  CSRF_SECRET: z.string().min(32),
  AUTH_RATE_WINDOW_MS: int(1000, 3600000),
  AUTH_RATE_LIMIT: int(1, 1000),
  WRITE_RATE_LIMIT: int(1, 10000),
  CHAT_RATE_WINDOW_MS: int(1000, 60000),
  CHAT_RATE_LIMIT: int(1, 100),
  CHAT_HISTORY_LIMIT: int(1, 100),
  PRESENCE_TTL_SECONDS: int(10, 300),
  PRESENCE_HEARTBEAT_MS: int(1000, 60000),
  SOCKET_CONNECT_LIMIT: int(1, 1000),
  API_INTERNAL_HOST: z.string().min(1),
  API_INTERNAL_PORT: int(1, 65535),
  MEDIA_AUTH_SECRET: z.string().regex(/^[a-zA-Z0-9_-]{32,}$/),
  MEDIA_AUTH_BASE_URL: z.url().refine((v) => {
    const u = new URL(v);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/"
    );
  }),
  MEDIA_RTMP_PUBLIC_URL: z.url().refine((v) => {
    const u = new URL(v);
    return (
      ["rtmp:", "rtmps:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }),
  ENABLE_LEGACY_STREAM: bool,
  MEDIA_OBSERVER_LIMIT: int(10, 5000),
});
export function parsePlatformConfig(input: Record<string, unknown>) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      "Invalid platform configuration: " +
        result.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  const c = result.data;
  if (c.PRESENCE_HEARTBEAT_MS * 2 >= c.PRESENCE_TTL_SECONDS * 1000)
    throw new Error("Presence TTL must exceed two heartbeat intervals");
  if (
    input.NODE_ENV === "production" &&
    (!c.COOKIE_SECURE || c.ENABLE_LEGACY_STREAM)
  )
    throw new Error(
      "Production requires secure cookies and disabled legacy publisher",
    );
  return c;
}
export type PlatformConfig = ReturnType<typeof parsePlatformConfig>;
