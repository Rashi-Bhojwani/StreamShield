import { z } from "zod";
import type { ChaosScenario, ChaosScenarioId } from "@streamshield/shared";
const integer = (min: number, max: number, value: number) =>
  z.coerce.number().int().min(min).max(max).default(value);
export const supported = [
  "crash-api",
  "crash-edge",
  "crash-primary",
  "crash-redis",
  "network-timeout",
  "external-api",
] as const;
export const scenarios: ChaosScenario[] = [
  {
    id: "crash-api",
    name: "Crash API-1",
    target: "api-1",
    risk: "moderate",
    failure:
      "Terminate API-1 with SIGKILL. Its current requests may disconnect.",
    recovery:
      "API-2 serves surviving requests; the independent Healer starts and verifies API-1.",
    prerequisites:
      "Both APIs, PostgreSQL, Redis and fresh monitoring must be healthy.",
    supported: true,
    available: false,
    reason: null,
  },
  {
    id: "crash-edge",
    name: "Crash Edge-1",
    target: "edge-1",
    risk: "moderate",
    failure: "Terminate the selected HLS edge. Viewers may briefly buffer.",
    recovery:
      "Existing routing uses Edge-2; the Healer verifies restored HLS segments.",
    prerequisites:
      "A genuine live source, healthy peer/origins and progressing media.",
    supported: true,
    available: false,
    reason: null,
  },
  {
    id: "crash-primary",
    name: "Crash primary origin",
    target: "origin-primary",
    risk: "high",
    failure:
      "Terminate primary MediaMTX. The player may reinitialize on standby.",
    recovery:
      "Standby preserves the source; the Healer restores primary without forced failback.",
    prerequisites:
      "Live publishing and independently verified healthy standby media.",
    supported: true,
    available: false,
    reason: null,
  },
  {
    id: "crash-redis",
    name: "Interrupt Redis",
    target: "redis",
    risk: "high",
    failure:
      "Terminate Redis. Live messaging/presence can degrade temporarily.",
    recovery:
      "The Healer starts Redis; application clients reconnect. PostgreSQL history remains durable.",
    prerequisites:
      "Healthy database and both APIs. Pub/Sub outage delivery is not guaranteed.",
    supported: true,
    available: false,
    reason: null,
  },
  {
    id: "network-timeout",
    name: "Introduce network latency",
    target: "demo-dependency",
    risk: "moderate",
    failure:
      "Add real downstream latency to the private recommendation connection.",
    recovery:
      "The owned fault expires; bounded safe-read probes verify real reconnection.",
    prerequisites:
      "Healthy simulated dependency, closed circuit and functioning expiry adapter.",
    supported: true,
    available: false,
    reason: null,
  },
  {
    id: "external-api",
    name: "Interrupt external API demo",
    target: "demo-dependency",
    risk: "moderate",
    failure:
      "Reset connections to the explicitly simulated read-only recommendation API.",
    recovery:
      "Real circuit opens and rejects calls, then probes after timed fault cleanup.",
    prerequisites:
      "Closed circuit and healthy simulated upstream. No payments or writes.",
    supported: true,
    available: false,
    reason: null,
  },
  {
    id: "database-outage",
    name: "Database outage",
    target: "postgres",
    risk: "high",
    failure: "Would interrupt database-dependent authorization and writes.",
    recovery: "Current policy escalates storage faults for operator review.",
    prerequisites:
      "A separate disposable database fault/cleanup authority is required.",
    supported: false,
    available: false,
    reason:
      "Disabled: no database fault or automatic database restoration authority is granted.",
  },
  {
    id: "broadcast-interruption",
    name: "Interrupt test broadcaster",
    target: "publisher-source",
    risk: "moderate",
    failure: "Would stop a publisher owned by the test environment.",
    recovery: "Only an authorized broadcaster can return the original source.",
    prerequisites:
      "A controller-owned disposable publisher lifecycle is required.",
    supported: false,
    available: false,
    reason:
      "Disabled: the controller does not own your OBS, camera or FFmpeg process.",
  },
];
export function chaosConfig(env: Record<string, string | undefined>) {
  const c = z
    .object({
      CHAOS_ENABLED: z.enum(["true", "false"]).default("false"),
      CHAOS_ENVIRONMENT: z
        .enum(["disabled", "local-development"])
        .default("disabled"),
      NODE_ENV: z.string().default("development"),
      BIND_ADDRESS: z.string().default("127.0.0.1"),
      CHAOS_PROBE_TIMEOUT_MS: integer(200, 3000, 1000),
      CHAOS_PORT: integer(1024, 65535, 4030),
      CHAOS_CONTROL_PORT: integer(1024, 65535, 4031),
      CHAOS_FAULT_DURATION_MS: integer(8000, 30000, 15000),
      CHAOS_TIMEOUT_MS: integer(30000, 300000, 180000),
      CHAOS_CONCURRENCY: integer(1, 1, 1),
      CHAOS_COOLDOWN_MS: integer(5000, 600000, 30000),
      CHAOS_RATE_LIMIT: integer(1, 20, 12),
      CHAOS_RATE_WINDOW_MS: integer(60000, 3600000, 600000),
      CHAOS_RETENTION_DAYS: integer(7, 365, 90),
      CHAOS_ALLOWED_SCENARIOS: z.string().default(supported.join(",")),
      CHAOS_SECRET: z.string().regex(/^[\w-]{43}$/),
      CHAOS_CONTROL_SECRET: z.string().regex(/^[\w-]{43}$/),
    })
    .parse(env);
  const allowed = c.CHAOS_ALLOWED_SCENARIOS.split(",").filter(Boolean);
  if (
    allowed.some((s) => !(supported as readonly string[]).includes(s)) ||
    new Set(allowed).size !== allowed.length ||
    c.CHAOS_SECRET === c.CHAOS_CONTROL_SECRET ||
    c.CHAOS_PORT === c.CHAOS_CONTROL_PORT ||
    c.CHAOS_TIMEOUT_MS < c.CHAOS_FAULT_DURATION_MS + 15000
  )
    throw Error("Invalid chaos policy or authority");
  const enabled =
    c.CHAOS_ENABLED === "true" &&
    c.CHAOS_ENVIRONMENT === "local-development" &&
    c.NODE_ENV === "development" &&
    ["127.0.0.1", "::1"].includes(c.BIND_ADDRESS);
  return { ...c, allowed, enabled };
}
export type ChaosConfig = ReturnType<typeof chaosConfig>;
export const scenarioFor = (id: ChaosScenarioId) =>
  scenarios.find((s) => s.id === id)!;
export const temporary = (id: ChaosScenarioId) =>
  id === "network-timeout" || id === "external-api";
export const terminal = (state: string) =>
  ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(state);
