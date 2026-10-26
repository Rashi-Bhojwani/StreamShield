import { z } from "zod";

export const experienceSchema = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  observedAt: z.string().datetime().nullable(),
  state: z.enum([
    "healthy",
    "recovering",
    "recovered",
    "failed",
    "unavailable",
  ]),
  scenario: z
    .enum(["crash-api", "crash-video-gateway", "crash-edge", "network-timeout"])
    .nullable(),
  message: z.string().max(400),
  recommendations: z.object({
    available: z.boolean().nullable(),
    items: z.array(z.string().max(120)).max(4),
    simulated: z.literal(true),
  }),
});
export type Experience = z.infer<typeof experienceSchema>;
