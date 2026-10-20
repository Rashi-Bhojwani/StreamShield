import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  ComponentObservation,
  MediaObservation,
  MonitoringSnapshot,
} from "@streamshield/shared";
import { duration } from "./policy.js";
export async function persist(
  db: Pool,
  components: ComponentObservation[],
  media: MediaObservation[],
  mediaAvailable: boolean,
  policy: { failures: number; successes: number },
  staleAfterMs: number,
  retentionDays: number,
  pendingEvidence: Map<string, ComponentObservation> = new Map(),
) {
  const client = await db.connect();
  const now = new Date().toISOString();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(52005001)");
    for (const observed of components) {
      const c = pendingEvidence.get(observed.id) || observed;
      await client.query(
        "INSERT INTO monitoring_components(id,observation) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET observation=EXCLUDED.observation",
        [observed.id, observed],
      );
      let active = (
        await client.query(
          "SELECT * FROM monitoring_incidents WHERE component=$1 AND resolved_at IS NULL FOR UPDATE",
          [c.id],
        )
      ).rows[0];
      const event = async (
        id: string,
        state: string,
        evidence: unknown,
        at = now,
      ) =>
        client.query(
          "INSERT INTO monitoring_incident_events(incident_id,state,at,evidence) VALUES($1,$2,$3,$4)",
          [id, state, at, evidence],
        );
      const evidence = {
        code: c.code,
        failureCode:
          c.failureCode ||
          active?.evidence?.failureCode ||
          active?.evidence?.code ||
          null,
        latencyMs: c.latencyMs,
        consecutiveFailures: c.failures,
        consecutiveSuccesses: c.successes,
        probeAt: c.observedAt,
        playbackVerified: false,
      };
      if (!active && c.confirmedAt && c.firstFailureAt) {
        const id = randomUUID();
        const failureEvidence = {
          ...evidence,
          code: c.failureCode || c.code,
          persistedAt: now,
          confirmationAt: c.confirmedAt,
          observationPersistenceDelayed:
            Date.parse(now) - Date.parse(c.confirmedAt) > 5000,
        };
        active = (
          await client.query(
            "INSERT INTO monitoring_incidents(id,component,severity,state,first_observed_at,detected_at,detection_ms,evidence,correlation_id) VALUES($1,$2,$3,'DIAGNOSED',$4,$5,$6,$7,$1) RETURNING *",
            [
              id,
              c.id,
              c.failureState === "DEGRADED" ? "warning" : "critical",
              c.firstFailureAt,
              c.confirmedAt,
              c.detectionMs,
              failureEvidence,
            ],
          )
        ).rows[0];
        await event(id, "DETECTED", failureEvidence, c.confirmedAt);
        await event(id, "DIAGNOSED", {
          ...failureEvidence,
          diagnosis:
            "Configured availability probe failed; root cause unverified.",
        });
      }
      if (
        active &&
        c.failures >= policy.failures &&
        ["UNHEALTHY", "DEGRADED"].includes(c.state)
      ) {
        if (active.restored_at)
          await event(active.id, "DIAGNOSED", {
            ...evidence,
            reason: "Failed again before verification",
          });
        await client.query(
          "UPDATE monitoring_incidents SET state='DIAGNOSED',restored_at=NULL,evidence=$2,updated_at=$3,severity=CASE WHEN severity='critical' OR $4='UNHEALTHY' THEN 'critical' ELSE 'warning' END WHERE id=$1",
          [active.id, evidence, now, c.state],
        );
      } else if (active && c.successes > 0 && c.code === "probe_ok") {
        const first =
          active.restored_at || c.firstSuccessAt || c.lastSuccessAt || now;
        if (!active.restored_at) {
          await event(active.id, "SERVICE_RESTORED", evidence);
          await client.query(
            "UPDATE monitoring_incidents SET state='SERVICE_RESTORED',restored_at=$2,evidence=$3,updated_at=$4 WHERE id=$1",
            [active.id, first, evidence, now],
          );
        }
        const repair = (
          await client.query(
            "SELECT state FROM healing_attempts WHERE incident_id=$1 ORDER BY updated_at DESC LIMIT 1",
            [active.id],
          )
        ).rows[0];
        if (
          c.successes >= policy.successes &&
          (!repair || repair.state === "VERIFIED")
        ) {
          await event(active.id, "RECOVERY_VERIFIED", {
            ...evidence,
            verification:
              "Consecutive successful component probes; browser playback not inferred",
          });
          await event(active.id, "RESOLVED", evidence);
          await client.query(
            "UPDATE monitoring_incidents SET state='RESOLVED',verified_at=$2,resolved_at=$2,duration_ms=$3,evidence=$4,updated_at=$2 WHERE id=$1",
            [
              active.id,
              now,
              duration(
                active.first_observed_at.toISOString(),
                new Date(first).toISOString(),
              ),
              evidence,
            ],
          );
        }
      }
    }
    const snapshot = { components, media, mediaAvailable, staleAfterMs };
    const row = (
      await client.query(
        "INSERT INTO monitoring_state(id,sequence,observed_at,snapshot) VALUES('observer',1,$1,$2) ON CONFLICT(id) DO UPDATE SET sequence=monitoring_state.sequence+1,observed_at=$1,snapshot=$2 RETURNING sequence::text",
        [now, snapshot],
      )
    ).rows[0];
    // Bounded maintenance; never remove open incidents. Events cascade only with resolved parent.
    await client.query(
      "DELETE FROM monitoring_incidents WHERE id IN (SELECT id FROM monitoring_incidents WHERE resolved_at<now()-($1*interval '1 day') LIMIT 100)",
      [retentionDays],
    );
    await client.query("COMMIT");
    return row.sequence as string;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
export async function durableSnapshot(db: Pool): Promise<MonitoringSnapshot> {
  const state = (
    await db.query(
      "SELECT sequence::text,observed_at,snapshot FROM monitoring_state WHERE id='observer'",
    )
  ).rows[0];
  const incidents = (
    await db.query(
      "SELECT * FROM monitoring_incidents ORDER BY (resolved_at IS NULL) DESC,detected_at DESC LIMIT 8",
    )
  ).rows;
  const counts = (
    await db.query(
      "SELECT count(*) FILTER(WHERE resolved_at IS NULL)::int AS open,count(*) FILTER(WHERE verified_at IS NOT NULL)::int AS verified FROM monitoring_incidents",
    )
  ).rows[0];
  const s = state?.snapshot;
  return {
    version: 1,
    sequence: state?.sequence || "0",
    observedAt: state?.observed_at?.toISOString() || null,
    staleAfterMs: s?.staleAfterMs || 12000,
    stale:
      !state ||
      Date.now() - state.observed_at.getTime() > (s?.staleAfterMs || 12000),
    persistence: true,
    components: s?.components || [],
    incidents,
    openCount: counts.open,
    verifiedCount: counts.verified,
    media: s?.media || [],
    mediaAvailable: s?.mediaAvailable || false,
    playback: {
      reports: 0,
      advancing: 0,
      standby: 0,
      checkedAt: null,
      label: "No recent browser observations",
    },
  };
}
