import type { Router } from "express";
import type { Resources } from "../platform/resources.js";
import type { RecoveryAttempt, HealingSnapshot } from "@streamshield/shared";
/** Mounted only after the existing fresh-session administrator authorization/admission middleware. */
export function recoveryRoutes(router: Router, r: Resources) {
  router.get("/healing", async (_req, res, next) => {
    try {
      if (process.env.HEALER_URL && process.env.HEALER_SECRET) {
        try {
          const response = await fetch(process.env.HEALER_URL + "/state", {
            headers: { Authorization: "Bearer " + process.env.HEALER_SECRET },
            redirect: "error",
            signal: AbortSignal.timeout(2000),
          });
          if (!response.ok) throw new Error("healer_unavailable");
          res.json(await response.json());
          return;
        } catch {
          /* Durable audit remains available; activity is explicitly unconfirmed. */
        }
      }
      const attempts = (
        await r.db.query(
          "SELECT body FROM healing_attempts ORDER BY updated_at DESC LIMIT 100",
        )
      ).rows.map((row) => row.body) as RecoveryAttempt[];
      const snapshot: HealingSnapshot = {
        version: 1,
        available: false,
        enabled: false,
        leader: false,
        observedAt: null,
        databaseAvailable: true,
        attempts,
        counts: {
          active: attempts.filter(
            (a) => !["VERIFIED", "ESCALATED"].includes(a.state),
          ).length,
          verified: attempts.filter((a) => a.state === "VERIFIED").length,
          escalated: attempts.filter((a) => a.state === "ESCALATED").length,
          averageRecoveryMs: null,
        },
        circuit: {
          state: "OPEN",
          failures: 0,
          rejected: 0,
          requests: 0,
          lastSuccessAt: null,
        },
      };
      res.json(snapshot);
    } catch (e) {
      next(e);
    }
  });
  router.get("/dependency-demo", async (_req, res) => {
    try {
      if (!process.env.HEALER_URL || !process.env.HEALER_SECRET)
        throw new Error("disabled");
      const r = await fetch(process.env.HEALER_URL + "/dependency", {
        headers: { Authorization: "Bearer " + process.env.HEALER_SECRET },
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      });
      res.status(r.status).json(await r.json());
    } catch {
      res
        .status(503)
        .json({ status: "unavailable", simulated: true, recommendations: [] });
    }
  });
}
