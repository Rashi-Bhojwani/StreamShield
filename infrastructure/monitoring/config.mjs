import { z } from "zod";
const integer = (min, max, value) =>
  z.coerce.number().int().min(min).max(max).default(value);
export function parseMonitoring(env) {
  const c = z
    .object({
      OBS_INTERVAL_MS: integer(1000, 60000, 2000),
      OBS_TIMEOUT_MS: integer(200, 5000, 1000),
      OBS_FAILURES: integer(2, 10, 2),
      OBS_SUCCESSES: integer(2, 10, 2),
      OBS_CONCURRENCY: integer(1, 8, 4),
      OBS_STALE_MS: integer(6000, 120000, 12000),
      OBS_MEDIA_INTERVAL_MS: integer(5000, 60000, 10000),
      OBS_RETENTION_DAYS: integer(7, 365, 90),
      OBS_PORT: integer(1024, 65535, 4010),
      OBS_METRICS_PORT: integer(1024, 65535, 9998),
      OBS_NGINX_STATUS_PORT: integer(1024, 65535, 8090),
      OBS_GRAFANA_PORT: integer(1024, 65535, 3000),
      OBS_PROMETHEUS_RETENTION: z
        .string()
        .regex(/^([1-9]|[12][0-9]|30)d$/)
        .default("7d"),
      OBS_SECRET: z.string().regex(/^[\w-]{43}$/),
      OBS_PG_PASSWORD: z.string().regex(/^[\w-]{43}$/),
      OBS_DB_PASSWORD: z.string().regex(/^[\w-]{43}$/),
      OBS_GRAFANA_PASSWORD: z.string().regex(/^[\w-]{43}$/),
    })
    .parse(env);
  if (
    c.OBS_TIMEOUT_MS >= c.OBS_INTERVAL_MS ||
    c.OBS_STALE_MS < c.OBS_INTERVAL_MS * 3 ||
    new Set([
      c.OBS_PORT,
      c.OBS_METRICS_PORT,
      c.OBS_NGINX_STATUS_PORT,
      c.OBS_GRAFANA_PORT,
    ]).size !== 4
  )
    throw new Error("Invalid monitoring interval/staleness/port budget");
  if (
    new Set([
      c.OBS_SECRET,
      c.OBS_PG_PASSWORD,
      c.OBS_DB_PASSWORD,
      c.OBS_GRAFANA_PASSWORD,
    ]).size !== 4
  )
    throw new Error("Monitoring credentials must be independent");
  if (
    [env.WEB_PORT, env.API_PORT, env.MEDIA_RTMP_PORT, env.MEDIA_HLS_PORT]
      .map(Number)
      .includes(c.OBS_GRAFANA_PORT)
  )
    throw new Error("Grafana host port conflicts with existing listener");
  if (
    [
      env.MEDIA_API_PORT,
      env.MEDIA_HLS_PORT,
      env.MEDIA_RTMP_PORT,
      env.RESILIENCE_RTSP_PORT,
    ]
      .map(Number)
      .includes(c.OBS_METRICS_PORT)
  )
    throw new Error("Media metrics listener conflict");
  if (
    [env.RESILIENCE_HTTP_PORT, env.RESILIENCE_AUTH_PORT]
      .map(Number)
      .includes(c.OBS_NGINX_STATUS_PORT)
  )
    throw new Error("Nginx status listener conflict");
  return c;
}
