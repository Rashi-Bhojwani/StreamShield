import { z } from "zod";

export const systemLogSchema = z.object({
  id: z.string().max(160),
  at: z.iso.datetime(),
  level: z.enum(["info", "warning", "error", "success"]),
  source: z.enum(["health", "recovery", "experiment", "broadcast"]),
  component: z.string().max(60),
  message: z.string().max(500),
  nextStep: z.string().max(350).nullable(),
  experimentId: z.uuid().nullable(),
});
export const systemLogsSchema = z.object({
  entries: z.array(systemLogSchema).max(500),
  from: z.iso.datetime(),
  observedAt: z.iso.datetime(),
  partial: z.boolean(),
  truncated: z.boolean(),
  unavailableSources: z.array(z.string()).max(4),
});
export type SystemLog = z.infer<typeof systemLogSchema>;
export type SystemLogs = z.infer<typeof systemLogsSchema>;
