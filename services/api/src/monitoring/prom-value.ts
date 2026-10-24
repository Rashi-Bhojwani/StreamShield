import { z } from "zod";
/** Missing/NaN metrics cannot be silently substituted with a healthy zero. */
export function promValue(body: unknown) {
  const parsed = z
    .object({
      status: z.literal("success"),
      data: z.object({
        result: z
          .array(
            z.object({
              value: z.tuple([z.number(), z.string().trim().min(1)]),
            }),
          )
          .min(1)
          .max(1),
      }),
    })
    .parse(body);
  const value = Number(parsed.data.result[0]!.value[1]);
  if (!Number.isFinite(value) || value < 0) throw Error("metrics_unavailable");
  return value;
}
