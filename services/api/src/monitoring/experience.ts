import express from "express";
import { z } from "zod";
import {
  experienceSchema,
  observationFreshness,
  parseChaosSnapshot,
  type ChaosSnapshot,
  type Experience,
} from "@streamshield/shared";
import type { Resources } from "../platform/resources.js";
import { requireUser } from "../platform/security.js";
import { localAdmission } from "./admission.js";

const impactCopy = {
  "crash-api":
    "An API server is recovering. Your requests can switch to the backup; video delivery is independent.",
  "crash-video-gateway":
    "The video gateway is recovering. Playback may buffer until fresh video segments return.",
  "crash-edge":
    "A delivery edge is recovering. The backup edge can keep your stream playing.",
  "network-timeout":
    "Recommendations are reconnecting after a network delay. Live video uses a separate connection.",
  "media-authority-loss":
    "Video delivery is blocked because media authorization is unavailable. An authorized operator must restore the simulated external signing authority; automatic recovery cannot recreate a missing private key or permission.",
} as const;

const dependencySchema = z.object({
  status: z.enum(["available", "degraded"]),
  simulated: z.literal(true),
  recommendations: z.array(z.string()).optional(),
});

export function experienceSummary(
  snapshot: ChaosSnapshot,
  dependency: z.infer<typeof dependencySchema> | null,
  now = Date.now(),
): Experience {
  const fresh =
    snapshot.available &&
    observationFreshness(snapshot.observedAt, now, snapshot.staleAfterMs) ===
      "fresh";
  const experiment = snapshot.experiments.find(
    (e) => e.injectedAt && e.scenario in impactCopy,
  );
  const scenario = (experiment?.scenario as Experience["scenario"]) || null;
  const terminal =
    experiment &&
    ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(
      experiment.state,
    );
  const restored =
    !!experiment?.verifiedAt ||
    !!experiment?.events.some((e) => e.kind === "BASELINE_REVERIFIED");
  const recent =
    experiment?.finishedAt && now - Date.parse(experiment.finishedAt) < 30000;
  const state = !fresh
    ? "unavailable"
    : experiment?.state === "AWAITING_OPERATOR"
      ? "human_required"
      : experiment && !terminal
        ? "recovering"
        : experiment && terminal && !restored
          ? "failed"
          : restored && recent
            ? "recovered"
            : "healthy";
  const apiHealth = (id: string): NonNullable<Experience["api"]>["primary"] => {
    const c = snapshot.componentHealth?.find((c) => c.id === id);
    if (
      !fresh ||
      !c ||
      observationFreshness(c.observedAt, now, snapshot.staleAfterMs) !== "fresh"
    )
      return "unknown";
    if (
      id === "api-1" &&
      experiment?.scenario === "crash-api" &&
      experiment.faultConfirmedAt &&
      !terminal &&
      !experiment.verifiedAt &&
      c.state === "HEALTHY"
    )
      return "recovering";
    return c.state.toLowerCase() as NonNullable<Experience["api"]>["primary"];
  };
  return experienceSchema.parse({
    enabled: true,
    available: fresh,
    observedAt: fresh ? snapshot.observedAt : null,
    state,
    api: snapshot.componentHealth
      ? {
          primary: apiHealth("api-1"),
          backup: apiHealth("api-2"),
          servedBy: null,
        }
      : undefined,
    scenario: state === "healthy" || state === "unavailable" ? null : scenario,
    message:
      state === "unavailable"
        ? "Live recovery status is unavailable. Your video connection is checked separately."
        : state === "human_required"
          ? impactCopy["media-authority-loss"]
          : state === "failed"
            ? "Recovery has not been verified. Keep the stream open while the operator investigates."
            : state === "recovered"
              ? scenario === "media-authority-loss"
                ? "An operator restored media authorization and video recovery was independently verified. This was human intervention, not automatic healing."
                : "Service recovery verified. Your live session can continue."
              : scenario && state === "recovering"
                ? impactCopy[scenario]
                : "No failure experiment is active. Keep this tab open for live recovery updates.",
    recommendations: {
      available: dependency ? dependency.status === "available" : null,
      items:
        dependency?.status === "available"
          ? (dependency.recommendations || [])
              .slice(0, 4)
              .map((s) => s.slice(0, 120))
          : [],
      simulated: true,
    },
  });
}

// Read-only, development-only projection for signed-in broadcasters/viewers.
// Administrator controls remain behind the existing administrator middleware.
// Never return actor IDs, publishing keys, internal URLs, receipts or credentials.
export function experienceRouter(r: Resources) {
  const router = express.Router();
  const admission = localAdmission();
  let cached: { until: number; value: Experience } | null = null;
  let pending: Promise<Experience> | null = null;
  router.get("/experience", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (process.env.NODE_ENV !== "development") {
      res.sendStatus(404);
      return;
    }
    try {
      const auth = await requireUser(r, req);
      if (!admission(auth.user.id)) {
        res.sendStatus(429);
        return;
      }
      if (!process.env.CHAOS_URL || !process.env.CHAOS_SECRET) {
        res.json({ enabled: false });
        return;
      }
      const read = async () => {
        const readService = async (
          url: string,
          secret: string,
          allowDegraded = false,
        ) => {
          const response = await fetch(url, {
            headers: { Authorization: "Bearer " + secret },
            signal: AbortSignal.timeout(4000),
            redirect: "error",
          });
          const value = await response.json();
          if (
            !response.ok &&
            !(
              allowDegraded &&
              response.status === 503 &&
              value?.status === "degraded"
            )
          )
            throw Error("service unavailable");
          return value;
        };
        const [chaos, dependency] = await Promise.all([
          readService(
            process.env.CHAOS_URL + "/state",
            process.env.CHAOS_SECRET!,
          ),
          process.env.HEALER_URL && process.env.HEALER_SECRET
            ? readService(
                process.env.HEALER_URL + "/dependency",
                process.env.HEALER_SECRET,
                true,
              )
                .then((v) => dependencySchema.parse(v))
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        return experienceSummary(parseChaosSnapshot(chaos), dependency);
      };
      if (!cached || cached.until < Date.now()) {
        pending ??= read().finally(() => {
          pending = null;
        });
        const value = await pending;
        cached = { until: Date.now() + 1500, value };
      }
      const instance = process.env.API_INSTANCE_ID;
      res.json({
        ...cached.value,
        api: cached.value.api
          ? {
              ...cached.value.api,
              servedBy: ["api-1", "api-2", "api-3"].includes(instance || "")
                ? instance
                : null,
            }
          : undefined,
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
