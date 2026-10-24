import { z } from "zod";
import type { ChaosScenario, ChaosScenarioId } from "@streamshield/shared";
const integer = (min: number, max: number, value: number) =>
  z.coerce.number().int().min(min).max(max).default(value);
export const supported = [
  "crash-redis",
  "crash-video-gateway",
  "crash-api-tier",
  "crash-relay",
  "hang-api",
  "traffic-surge",
  "crash-api",
  "crash-edge",
  "crash-primary",
  "network-timeout",
  "external-api",
] as const;
type Draft = Omit<ChaosScenario, "available" | "reason"> & {
  reason?: string | null;
};
const healer = (s: Omit<Draft, "kind" | "supported">): Draft => ({
  ...s,
  kind: "healer",
  supported: true,
});
const drafts: Draft[] = [
  healer({
    id: "crash-redis",
    order: 1,
    name: "Redis Service Failure (substitute)",
    target: "redis",
    targets: ["redis"],
    expectedReceipt: "docker_start_accepted",
    risk: "high",
    failure:
      "SIGKILL Redis. Chat fan-out, presence and viewer counts lose their shared bus.",
    recovery:
      "The Healer starts Redis; both APIs reconnect. PostgreSQL chat history stays intact.",
    prerequisites:
      "Use an isolated demo with a healthy database and both APIs. Redis persistence is disabled: volatile keys and Pub/Sub deliveries can be lost; PostgreSQL history stays intact.",
    audienceSees:
      "Chat shows Reconnecting and messages stop crossing between windows; video keeps playing.",
    realWorldCause: "Memory exhaustion, host restart or a bad Redis upgrade.",
  }),
  healer({
    id: "crash-video-gateway",
    order: 2,
    name: "Video Gateway Crash",
    target: "video-gateway",
    targets: ["video-gateway"],
    expectedReceipt: "docker_start_accepted",
    risk: "high",
    failure:
      "SIGKILL the single HLS entry point. Every viewer's playlist and segment requests fail.",
    recovery:
      "The Healer starts the gateway and verifies advancing segments fetched through it.",
    prerequisites:
      "Healthy edges and origins. A live stream makes the freeze visible.",
    audienceSees:
      "Every viewer's video freezes and the stall timer counts up, then resumes by itself.",
    realWorldCause: "Connection exhaustion or a bad configuration reload.",
  }),
  healer({
    id: "crash-api-tier",
    order: 3,
    name: "Crash the whole API tier (website down, video survives)",
    target: "api-tier",
    targets: ["api-1", "api-2"],
    expectedReceipt: "docker_start_accepted",
    risk: "high",
    failure:
      "SIGKILL API-1 and API-2 in one experiment. No application server is left.",
    recovery:
      "The Healer starts API-1, then API-2 (one operation at a time); both are verified serving.",
    prerequisites:
      "Both APIs, PostgreSQL and Redis healthy; Healer budget available for both APIs.",
    audienceSees:
      "The site shows Can't reach the server, retrying; chat disconnects; live video keeps playing.",
    realWorldCause: "A bad deployment, a memory leak or an unhandled crash.",
  }),
  healer({
    id: "crash-relay",
    order: 4,
    name: "Crash ingest relay (broadcaster drops)",
    target: "relay",
    targets: ["relay"],
    expectedReceipt: "docker_start_accepted",
    risk: "high",
    failure:
      "SIGKILL the MediaMTX ingest relay. Browser WHIP and OBS RTMP publishers are disconnected.",
    recovery:
      "The Healer starts the relay. The broadcaster client reconnects itself; that is recorded separately.",
    prerequisites:
      "Healthy origins. A live broadcaster makes the drop and the return visible.",
    audienceSees:
      "Studio shows Reconnecting, viewers see Broadcaster reconnecting, then the stream is LIVE again.",
    realWorldCause: "A malformed incoming stream or ingest overload.",
  }),
  healer({
    id: "hang-api",
    order: 5,
    name: "Freeze API-2 (hung, not crashed)",
    target: "api-2",
    targets: ["api-2"],
    expectedReceipt: "docker_restart_accepted",
    risk: "moderate",
    failure:
      "SIGTSTP the API-2 Node process: the container stays running but stops answering.",
    recovery:
      "The Observer sees timeouts, the Healer corroborates the hang and restarts API-2 (not start).",
    prerequisites:
      "API-1 must be healthy so restarting API-2 never removes the last serving instance.",
    audienceSees:
      "Pages and chat sends become slow (up to the 10 s gateway timeout), then return to normal.",
    realWorldCause: "A deadlock, an infinite loop or a stuck query.",
  }),
  healer({
    id: "traffic-surge",
    order: 6,
    name: "Traffic Surge / Overload",
    target: "api-tier",
    targets: ["api-tier"],
    expectedReceipt: "docker_start_accepted",
    risk: "moderate",
    failure:
      "A bounded load generator floods the API tier with simulated viewers for a bounded time.",
    recovery:
      "The Healer adds the pre-provisioned spare API-3 (scale-out) and removes it again after load stays normal.",
    prerequisites:
      "Healthy tier, the spare API-3 created but stopped, and Healer budget for API-3.",
    audienceSees:
      "Load meter and latency climb, pages slow down, then Served by API-3 appears and latency drops while load continues.",
    realWorldCause: "A flash crowd, bots or a retry storm.",
  }),
  healer({
    id: "crash-api",
    order: 7,
    name: "API Server Crash",
    target: "api-1",
    targets: ["api-1"],
    expectedReceipt: "docker_start_accepted",
    risk: "moderate",
    failure:
      "Terminate API-1 with SIGKILL. Its current requests may disconnect.",
    recovery:
      "API-2 serves surviving requests; the independent Healer starts and verifies API-1.",
    prerequisites:
      "Both APIs, PostgreSQL, Redis and fresh monitoring must be healthy.",
    audienceSees:
      "Nothing breaks; the Served by badge shows API-2 only, then API-1 again.",
    realWorldCause: "An unhandled crash on one instance.",
  }),
  healer({
    id: "crash-edge",
    order: 8,
    name: "Crash video Edge-1 (invisible failover)",
    target: "edge-1",
    targets: ["edge-1"],
    expectedReceipt: "docker_start_accepted",
    risk: "moderate",
    failure: "Terminate the selected HLS edge. Viewers may briefly buffer.",
    recovery:
      "Existing routing uses Edge-2; the Healer verifies restored HLS segments.",
    prerequisites:
      "A genuine live source, healthy peer/origins and progressing media.",
    audienceSees:
      "Video keeps playing; the overlay flips Served by Edge-1 to Edge-2, later Edge-1 again.",
    realWorldCause: "Cache node crash or disk/memory pressure on one edge.",
  }),
  healer({
    id: "crash-primary",
    order: 9,
    name: "Kill primary origin",
    target: "origin-primary",
    targets: ["origin-primary"],
    expectedReceipt: "docker_start_accepted",
    risk: "high",
    failure:
      "Terminate primary MediaMTX. The player may reinitialize on standby.",
    recovery:
      "Standby preserves the source; the Healer restores primary without forced failback.",
    prerequisites:
      "Live publishing and independently verified healthy standby media.",
    audienceSees:
      "The overlay shows Source: Primary to Standby, possibly with a short reinit.",
    realWorldCause: "Origin process crash or a failed media host.",
  }),
  {
    id: "network-timeout",
    order: 20,
    kind: "resilience",
    name: "Network Latency / Connection Disruption",
    target: "demo-dependency",
    targets: ["demo-dependency"],
    expectedReceipt: null,
    risk: "moderate",
    failure:
      "Add real downstream latency to the private recommendation connection.",
    recovery:
      "The owned fault expires; bounded safe-read probes verify real reconnection.",
    prerequisites:
      "Healthy simulated dependency, closed circuit and functioning expiry adapter.",
    audienceSees:
      "Recommendations slow down, then the circuit protects callers until latency ends.",
    realWorldCause: "A congested or degraded network path to a partner API.",
    supported: true,
  },
  {
    id: "external-api",
    order: 21,
    kind: "resilience",
    name: "Interrupt external API demo",
    target: "demo-dependency",
    targets: ["demo-dependency"],
    expectedReceipt: null,
    risk: "moderate",
    failure:
      "Reset connections to the explicitly simulated read-only recommendation API.",
    recovery:
      "Real circuit opens and rejects calls, then probes after timed fault cleanup.",
    prerequisites:
      "Closed circuit and healthy simulated upstream. No payments or writes.",
    audienceSees:
      "Recommendations show an explicit unavailable fallback instead of hanging.",
    realWorldCause: "A third-party outage.",
    supported: true,
  },
  {
    id: "database-outage",
    order: 30,
    kind: "disabled",
    name: "Database outage",
    target: "postgres",
    targets: ["postgres"],
    expectedReceipt: null,
    risk: "high",
    failure: "Would interrupt database-dependent authorization and writes.",
    recovery: "Current policy escalates storage faults for operator review.",
    prerequisites:
      "A separate disposable database fault/cleanup authority is required.",
    audienceSees: "Sign-in and writes would fail until an operator acts.",
    realWorldCause: "Disk failure, corruption or a bad migration.",
    supported: false,
    reason:
      "Disabled: no database fault or automatic database restoration authority is granted.",
  },
  {
    id: "broadcast-interruption",
    order: 31,
    kind: "disabled",
    name: "Interrupt test broadcaster",
    target: "publisher-source",
    targets: ["publisher-source"],
    expectedReceipt: null,
    risk: "moderate",
    failure: "Would stop a publisher owned by the test environment.",
    recovery: "Only an authorized broadcaster can return the original source.",
    prerequisites:
      "A controller-owned disposable publisher lifecycle is required.",
    audienceSees: "The stream would go offline until the broadcaster returns.",
    realWorldCause: "Camera unplugged, laptop asleep or home internet loss.",
    supported: false,
    reason:
      "Disabled: the controller does not own your OBS, camera or FFmpeg process.",
  },
];
export const scenarios: ChaosScenario[] = drafts
  .map((d) => ({ ...d, available: false, reason: d.reason ?? null }))
  .sort((a, b) => a.order - b.order);
export function chaosConfig(env: Record<string, string | undefined>) {
  const c = z
    .object({
      CHAOS_ENABLED: z.enum(["true", "false"]).default("false"),
      CHAOS_ENVIRONMENT: z
        .enum(["disabled", "local-development"])
        .default("disabled"),
      NODE_ENV: z.string().default("development"),
      BIND_ADDRESS: z.string().default("127.0.0.1"),
      OBS_STALE_MS: integer(6000, 120000, 12000),
      CHAOS_PROBE_TIMEOUT_MS: integer(200, 3000, 1000),
      CHAOS_PORT: integer(1024, 65535, 4030),
      CHAOS_CONTROL_PORT: integer(1024, 65535, 4031),
      CHAOS_FAULT_DURATION_MS: integer(8000, 30000, 15000),
      CHAOS_TIMEOUT_MS: integer(30000, 300000, 180000),
      CHAOS_BROADCASTER_WAIT_MS: integer(5000, 120000, 60000),
      CHAOS_SURGE_USERS: integer(1, 1000, 8),
      CHAOS_SURGE_MAX_USERS: integer(1, 1000, 1000),
      CHAOS_SURGE_DURATION_MS: integer(10000, 120000, 60000),
      CHAOS_SURGE_RPS: integer(1, 1000, 50),
      CHAOS_SURGE_MAX_REQUESTS: integer(1, 100000, 3000),
      CHAOS_SURGE_THINK_MS: integer(0, 5000, 0),
      CHAOS_SURGE_SCALE_IN_WAIT_MS: integer(10000, 300000, 120000),
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
    c.CHAOS_TIMEOUT_MS < c.CHAOS_FAULT_DURATION_MS + 15000 ||
    c.CHAOS_SURGE_USERS > c.CHAOS_SURGE_MAX_USERS
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
/** Faults the controller generates itself (no Docker or Toxiproxy authority). */
export const generated = (id: ChaosScenarioId) => id === "traffic-surge";
/** The Healer budget/allowlist identity behind a scenario target. */
export const authorityFor = (target: string) =>
  target === "api-tier" ? "api-3" : target;
export const terminal = (state: string) =>
  ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(state);
