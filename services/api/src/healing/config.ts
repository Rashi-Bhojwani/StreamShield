import { z } from "zod";
const integer = (min: number, max: number, value: number) =>
  z.coerce.number().int().min(min).max(max).default(value);
export const managed = [
  "api-1",
  "api-2",
  "edge-1",
  "edge-2",
  "origin-primary",
  "redis",
] as const;
export const serviceNames: Record<(typeof managed)[number], string> = {
  "api-1": "api",
  "api-2": "api-2",
  "edge-1": "edge-1",
  "edge-2": "edge-2",
  "origin-primary": "origin-primary",
  redis: "redis",
};
export function healingConfig(env: Record<string, string | undefined>) {
  const c = z
    .object({
      HEALER_ENABLED: z.enum(["true", "false"]).default("false"),
      HEALER_PORT: integer(1024, 65535, 4020),
      CONTROL_PORT: integer(1024, 65535, 4021),
      HEALER_DEMO_PORT: integer(1024, 65535, 4024),
      HEALER_DEPENDENCY_PORT: integer(1024, 65535, 4025),
      HEALER_INTERVAL_MS: integer(500, 10000, 1000),
      HEALER_PROBE_TIMEOUT_MS: integer(200, 3000, 1000),
      HEALER_ACTION_TIMEOUT_MS: integer(500, 10000, 5000),
      HEALER_VERIFY_MS: integer(10000, 120000, 60000),
      HEALER_STABILITY_MS: integer(2000, 20000, 3000),
      HEALER_COOLDOWN_MS: integer(5000, 600000, 30000),
      HEALER_BUDGET_WINDOW_MS: integer(30000, 3600000, 600000),
      HEALER_MAX_STARTS: integer(1, 3, 2),
      HEALER_MAX_ATTEMPTS: integer(1, 3, 2),
      HEALER_BACKOFF_MS: integer(500, 10000, 1000),
      HEALER_LEASE_MS: integer(20000, 60000, 30000),
      HEALER_SOURCE_GRACE_MS: integer(5000, 60000, 15000),
      HEALER_CIRCUIT_FAILURES: integer(2, 10, 3),
      HEALER_CIRCUIT_RESET_MS: integer(2000, 60000, 5000),
      HEALER_ALLOWED_SERVICES: z.string().default(managed.join(",")),
      HEALER_DISABLED_PLAYBOOKS: z.string().default(""),
      HEALER_SECRET: z.string().regex(/^[\w-]{43}$/),
      CONTROL_SECRET: z.string().regex(/^[\w-]{43}$/),
    })
    .parse(env);
  const allowed = c.HEALER_ALLOWED_SERVICES.split(",").filter(Boolean);
  if (
    allowed.some((x) => !(managed as readonly string[]).includes(x)) ||
    new Set(allowed).size !== allowed.length
  )
    throw new Error("Unsupported or repeated managed service");
  if (
    c.HEALER_SECRET === c.CONTROL_SECRET ||
    c.HEALER_STABILITY_MS >= c.HEALER_VERIFY_MS ||
    new Set([
      c.HEALER_PORT,
      c.CONTROL_PORT,
      c.HEALER_DEMO_PORT,
      c.HEALER_DEPENDENCY_PORT,
    ]).size !== 4
  )
    throw new Error(
      "Invalid healing authority, verification or listener configuration",
    );
  return { ...c, allowed, enabled: c.HEALER_ENABLED === "true" };
}
export type HealingConfig = ReturnType<typeof healingConfig>;
