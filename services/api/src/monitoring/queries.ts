export const metricQueries = [
  {
    id: "throughput",
    label: "API throughput",
    unit: "req/s",
    query: 'sum(rate(streamshield_http_requests_total{job="api"}[1m]))',
  },
  {
    id: "latency",
    label: "API p95 latency",
    unit: "ms",
    query:
      'histogram_quantile(0.95,sum by(le)(rate(streamshield_http_request_duration_seconds_bucket{job="api"}[1m])))*1000',
  },
  {
    id: "errors",
    label: "API server error rate",
    unit: "%",
    query:
      '100*sum(rate(streamshield_http_requests_total{job="api",category="5xx"}[1m]))/clamp_min(sum(rate(streamshield_http_requests_total{job="api"}[1m])),0.000001)',
  },
  {
    id: "memory",
    label: "API process memory",
    unit: "MiB",
    query:
      'sum(streamshield_process_resident_memory_bytes{job="api"})/1024/1024',
  },
  {
    id: "cpu",
    label: "API process CPU",
    unit: "cores",
    query: 'sum(rate(streamshield_process_cpu_seconds_total{job="api"}[1m]))',
  },
  {
    id: "media",
    label: "Media RTMP connections",
    unit: "connections",
    query: 'sum(rtmp_conns{job="media"})',
  },
  {
    id: "nginx",
    label: "Nginx active connections",
    unit: "connections",
    query: "sum(nginx_connections_active)",
  },
  {
    id: "redis",
    label: "Redis used memory",
    unit: "MiB",
    query: "redis_memory_used_bytes/1024/1024",
  },
  {
    id: "postgres",
    label: "PostgreSQL connections",
    unit: "connections",
    query: "sum(pg_stat_database_numbackends)",
  },
] as const;
export function finitePoints(values: unknown): [number, number][] {
  if (!Array.isArray(values)) return [];
  return values
    .flatMap((v) =>
      Array.isArray(v) &&
      Number.isFinite(Number(v[0])) &&
      Number.isFinite(Number(v[1]))
        ? [[Number(v[0]), Number(v[1])] as [number, number]]
        : [],
    )
    .slice(-121);
}
