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
    "human_required",
  ]),
  scenario: z
    .enum([
      "crash-api",
      "crash-video-gateway",
      "crash-edge",
      "network-timeout",
      "media-authority-loss",
    ])
    .nullable(),
  message: z.string().max(400),
  api: z
    .object({
      primary: z.enum([
        "healthy",
        "degraded",
        "unhealthy",
        "unknown",
        "recovering",
      ]),
      backup: z.enum([
        "healthy",
        "degraded",
        "unhealthy",
        "unknown",
        "recovering",
      ]),
      servedBy: z.enum(["api-1", "api-2", "api-3"]).nullable(),
    })
    .optional(),
  recommendations: z.object({
    available: z.boolean().nullable(),
    items: z.array(z.string().max(120)).max(4),
    simulated: z.literal(true),
  }),
});
export type Experience = z.infer<typeof experienceSchema>;
