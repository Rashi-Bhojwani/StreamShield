import { z } from "zod";
export const demoSlots = [1, 2, 3] as const;
export const demoIdentity = (slot: number) => ({
  slot,
  slug: `streamer-${slot}`,
  name: `Streamer ${slot}`,
  userId: `10000000-0000-4000-8000-${String(slot).padStart(12, "0")}`,
  channelId: `20000000-0000-4000-8000-${String(slot).padStart(12, "0")}`,
  streamId: `30000000-0000-4000-8000-${String(slot).padStart(12, "0")}`,
});
export const capacityProfile = z.enum([
  "api",
  "socket",
  "chat",
  "hls",
  "browser",
]);
export const capacityConfig = z
  .object({
    profile: capacityProfile,
    clients: z.number().int().min(1).max(50000),
    duration: z.number().int().min(5).max(900),
    ramp: z.number().int().min(1).max(300),
    distributed: z.boolean(),
    chatPerSecond: z.number().int().min(0).max(100),
    target: z.url(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const u = new URL(c.target);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash
    )
      ctx.addIssue({
        code: "custom",
        message: "Use an origin without credentials/path/query",
      });
    if (
      (!c.distributed && c.clients > 1000) ||
      (c.profile === "browser" && c.clients > 12)
    )
      ctx.addIssue({
        code: "custom",
        message: "Local clients <=1000; decoded browsers <=12",
      });
  });
export const latencyBounds = [
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000, 2000, 4000, 8000, 16000, 32000,
  60000,
];
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const capacityReport = z
  .object({
    seq: count.min(1),
    active: count.max(1000),
    peak: count.max(1000),
    requests: count,
    errors: count,
    bytes: count,
    connections: count,
    connectionFailures: count,
    joinFailures: count,
    disconnects: count,
    reconnects: count,
    messages: count,
    delivered: count,
    deliveryFailures: count,
    verifiedBrowsers: count.max(12),
    stalls: count,
    startupMs: z.number().min(0).max(900000).nullable(),
    requestHistogram: z.array(count).length(latencyBounds.length),
    deliveryHistogram: z.array(count).length(latencyBounds.length),
    generatorCpuPercent: z.number().min(0).max(100000),
    generatorRssBytes: count,
    finished: z.boolean(),
    stopReason: z.enum([
      "deadline",
      "signal",
      "error-budget",
      "resource-pressure",
      "failed",
      "running",
      "grant-revoked",
    ]),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.requestHistogram.reduce((a, b) => a + b, 0) !== r.requests ||
      r.deliveryHistogram.reduce((a, b) => a + b, 0) !== r.delivered
    )
      ctx.addIssue({
        code: "custom",
        message: "Histogram counts must match the cumulative observations",
      });
  });
export type CapacityReport = z.infer<typeof capacityReport>;
export type CapacityConfig = z.infer<typeof capacityConfig>;
export interface CapacitySummary {
  id: string;
  profile: z.infer<typeof capacityProfile>;
  targetClients: number;
  targetOrigin: string;
  state: string;
  createdAt: string;
  expiresAt: string;
  distributed: boolean;
  allocatedClients: number;
  freshWorkers: number;
  staleWorkers: number;
  actualActive: number | null;
  peakReported: number;
  requests: number;
  errors: number;
  bytes: number;
  requestsPerSecond: number | null;
  messagesPerSecond: number | null;
  connections: number;
  connectionFailures: number;
  joinFailures: number;
  connectionsPerSecond: number | null;
  disconnectsPerSecond: number | null;
  disconnects: number;
  reconnects: number;
  messages: number;
  delivered: number;
  deliveryFailures: number;
  verifiedBrowsers: number | null;
  stalls: number;
  startupMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  deliveryP95Ms: number | null;
  generatorCpuPercent: number | null;
  generatorRssBytes: number | null;
  sampledAt: string;
  samples: {
    at: string;
    active: number | null;
    rps: number | null;
    errors: number;
  }[];
}
