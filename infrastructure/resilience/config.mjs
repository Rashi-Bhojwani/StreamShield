import { z } from "zod";
const integer = (min, max) => z.coerce.number().int().min(min).max(max);
const host = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/);
const schema = z.object({
  RESILIENCE_MEDIA_PROBE_TIMEOUT_MS: integer(100, 5000),
  VITE_API_TIMEOUT_MS: integer(1000, 120000),
  MEDIA_PUBLIC_HLS_BASE_URL: z.string().regex(/^\/[a-zA-Z0-9/_-]+$/),
  API_PORT: integer(1, 65535),
  API_INTERNAL_PORT: integer(1, 65535),
  MEDIA_API_PORT: integer(1, 65535),
  MEDIA_HLS_PORT: integer(1, 65535),
  MEDIA_CONTAINER_HOST: host,
  CORS_ORIGINS: z.string().refine((v) => {
    try {
      return v.split(",").every((s) => {
        const u = new URL(s.trim());
        return (
          u.origin === s.trim() && ["http:", "https:"].includes(u.protocol)
        );
      });
    } catch {
      return false;
    }
  }),
  RESILIENCE_DNS_RESOLVER: z.ipv4(),
  RESILIENCE_DNS_VALID_SECONDS: integer(1, 60),
  RESILIENCE_KEEPALIVE: integer(1, 128),
  RESILIENCE_NGINX_IMAGE: z.string().regex(/^nginx:[0-9.]+-alpine$/),
  RESILIENCE_API1_HOST: host,
  RESILIENCE_API2_HOST: host,
  RESILIENCE_API_GATEWAY_HOST: host,
  RESILIENCE_VIDEO_GATEWAY_HOST: host,
  RESILIENCE_EDGE1_HOST: host,
  RESILIENCE_EDGE2_HOST: host,
  RESILIENCE_PRIMARY_HOST: host,
  RESILIENCE_STANDBY_HOST: host,
  RESILIENCE_HTTP_PORT: integer(1024, 65535),
  RESILIENCE_AUTH_PORT: integer(1024, 65535),
  RESILIENCE_RTSP_PORT: integer(1024, 65535),
  RESILIENCE_DB_POOL_MAX: integer(1, 30),
  RESILIENCE_MAX_FAILS: integer(1, 10),
  RESILIENCE_FAIL_TIMEOUT_SECONDS: integer(1, 60),
  RESILIENCE_CONNECT_TIMEOUT_SECONDS: integer(1, 10),
  RESILIENCE_READ_TIMEOUT_SECONDS: integer(1, 60),
  RESILIENCE_SOCKET_TIMEOUT_SECONDS: integer(30, 300),
  RESILIENCE_UPSTREAM_TRIES: integer(1, 2),
  RESILIENCE_WORKER_CONNECTIONS: integer(32, 4096),
  RESILIENCE_CACHE_MAX_MB: integer(8, 1024),
  RESILIENCE_CACHE_INACTIVE_SECONDS: integer(1, 300),
  RESILIENCE_SEGMENT_CACHE_SECONDS: integer(1, 60),
  RESILIENCE_WARM_INTERVAL_SECONDS: integer(1, 30),
  RESILIENCE_WARM_TIMEOUT_SECONDS: integer(1, 15),
  RESILIENCE_SAMPLE_INTERVAL_MS: integer(100, 1000),
  RESILIENCE_STALL_THRESHOLD_MS: integer(500, 10000),
  RESILIENCE_TEST_TIMEOUT_MS: integer(10000, 180000),
  RESILIENCE_HLS_SECRET: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
  RESILIENCE_REPLICATION_SECRET: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
});
export function parseResilience(input) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      "Invalid resilience configuration: " +
        result.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  const c = result.data;
  if (
    c.RESILIENCE_API1_HOST === c.RESILIENCE_API2_HOST ||
    c.RESILIENCE_EDGE1_HOST === c.RESILIENCE_EDGE2_HOST ||
    c.RESILIENCE_PRIMARY_HOST === c.RESILIENCE_STANDBY_HOST
  )
    throw new Error("Redundant peers must have distinct hostnames");
  if (c.RESILIENCE_HTTP_PORT === c.RESILIENCE_AUTH_PORT)
    throw new Error("Public and private gateway listeners must differ");
  const identities = [
    ["api", c.RESILIENCE_API1_HOST],
    ["api-2", c.RESILIENCE_API2_HOST],
    ["api-gateway", c.RESILIENCE_API_GATEWAY_HOST],
    ["video-gateway", c.RESILIENCE_VIDEO_GATEWAY_HOST],
    ["edge-1", c.RESILIENCE_EDGE1_HOST],
    ["edge-2", c.RESILIENCE_EDGE2_HOST],
    ["origin-primary", c.RESILIENCE_PRIMARY_HOST],
    ["origin-standby", c.RESILIENCE_STANDBY_HOST],
    ["mediamtx", c.MEDIA_CONTAINER_HOST],
  ];
  if (
    new Set(identities.map(([, host]) => host)).size !== identities.length ||
    identities.some(([, host]) =>
      ["postgres", "redis", "web", "migrate"].includes(host),
    ) ||
    identities.some(([service, host]) =>
      identities.some(([other]) => other === host && other !== service),
    )
  )
    throw new Error(
      "Topology aliases must be unique and cannot shadow another service",
    );
  if (c.RESILIENCE_MEDIA_PROBE_TIMEOUT_MS * 2 >= c.VITE_API_TIMEOUT_MS)
    throw new Error(
      "Media probe budget must fit within the browser API deadline",
    );
  return c;
}
