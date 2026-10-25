import { Pool } from "pg";
import type { RecoveryAttempt } from "@streamshield/shared";
export class RecoveryStore {
  db: Pool;
  available = false;
  constructor() {
    this.db = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      max: 2,
      connectionTimeoutMillis: 1000,
      query_timeout: 2000,
      statement_timeout: 2000,
      idleTimeoutMillis: 5000,
    });
    this.db.on("error", () => {
      this.available = false;
    });
  }
  async check() {
    const id = "00000000-0000-4000-8000-000000000006";
    await this.db.query(
      "INSERT INTO healing_verification VALUES($1,now()) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at",
      [id],
    );
    const result = await this.db.query(
      "SELECT checked_at FROM healing_verification WHERE id=$1",
      [id],
    );
    if (!result.rows[0]) throw new Error("database_verification_failed");
    this.available = true;
  }
  async sync(a: RecoveryAttempt) {
    const db = await this.db.connect();
    try {
      await db.query("BEGIN");
      if (!a.incidentId)
        a.incidentId =
          (
            await db.query(
              "SELECT id FROM monitoring_incidents WHERE component=$1 AND source<>'healer-capacity-v1' AND (first_observed_at=$2 OR (resolved_at IS NULL AND first_observed_at<=$2)) ORDER BY (first_observed_at=$2) DESC,detected_at DESC LIMIT 1",
              [a.component, a.detectedAt],
            )
          ).rows[0]?.id || null;
      if (a.component === "publisher-source") {
        const existing = (
          await db.query(
            "SELECT id FROM monitoring_incidents WHERE component='publisher-source' AND failure_identity=$1 AND first_observed_at=$2",
            [a.episode.split(":")[1], a.detectedAt],
          )
        ).rows[0];
        if (existing) a.incidentId = existing.id;
        await db.query(
          "INSERT INTO monitoring_incidents(id,component,failure_identity,severity,state,first_observed_at,detected_at,evidence,correlation_id,source) VALUES($1,'publisher-source',$2,'warning','DIAGNOSED',$3,$3,$4,$1,'source-observer-v1') ON CONFLICT(id) DO NOTHING",
          [
            a.incidentId,
            a.episode.split(":")[1],
            a.detectedAt,
            { code: "publisher_disconnected", playbackVerified: false },
          ],
        );
      }
      if (a.playbook === "api-scale-in" && a.incidentId) {
        // Scale-in answers sustained normal load, not a failure: the Healer
        // records its own capacity-change incident so the audit stays complete.
        await db.query(
          "INSERT INTO monitoring_incidents(id,component,failure_identity,severity,state,first_observed_at,detected_at,evidence,correlation_id,source) VALUES($1,'api-tier','scale-in','warning','DIAGNOSED',$2,$2,$3,$1,'healer-capacity-v1') ON CONFLICT DO NOTHING",
          [
            a.incidentId,
            a.detectedAt,
            { code: "scale_in", reason: a.diagnosis, playbackVerified: false },
          ],
        );
        // One open capacity incident at a time: an earlier escalated scale-in
        // leaves it open, and this attempt joins it (and resolves it if verified).
        a.incidentId =
          (
            await db.query(
              "SELECT id FROM monitoring_incidents WHERE id=$1 OR (component='api-tier' AND failure_identity='scale-in' AND resolved_at IS NULL AND source='healer-capacity-v1') ORDER BY (id=$1) DESC LIMIT 1",
              [a.incidentId],
            )
          ).rows[0]?.id || a.incidentId;
      }
      if (!a.incidentId) {
        await db.query("ROLLBACK");
        return false;
      }
      if (a.playbook === "api-scale-in" && a.state === "VERIFIED")
        await db.query(
          "UPDATE monitoring_incidents SET state='RESOLVED',verified_at=$2,resolved_at=$2,updated_at=$2 WHERE id=$1 AND resolved_at IS NULL",
          [a.incidentId, a.finishedAt],
        );
      const body = { ...a, databasePersisted: true };
      const accepted = await db.query(
        "INSERT INTO healing_attempts(id,incident_id,component,episode,playbook,state,epoch,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET incident_id=excluded.incident_id,state=excluded.state,epoch=excluded.epoch,body=excluded.body,updated_at=now() WHERE excluded.epoch>=healing_attempts.epoch RETURNING id",
        [
          a.id,
          a.incidentId,
          a.component,
          a.episode,
          a.playbook,
          a.state,
          a.epoch,
          body,
        ],
      );
      if (!accepted.rowCount) {
        await db.query("ROLLBACK");
        return false;
      }
      for (let i = 0; i < a.events.length; i++) {
        const e = a.events[i]!;
        const inserted = await db.query(
          "INSERT INTO healing_events VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING ordinal",
          [a.id, i, e.state, e.at, e.reason],
        );
        if (inserted.rowCount)
          await db.query(
            "INSERT INTO monitoring_incident_events(incident_id,state,at,evidence) VALUES($1,$2,$3,$4)",
            [
              a.incidentId,
              "HEALING_" + e.state,
              e.at,
              {
                attemptId: a.id,
                playbook: a.playbook,
                actor: a.actor,
                reason: e.reason,
              },
            ],
          );
      }
      if (a.component === "publisher-source" && a.state === "VERIFIED")
        await db.query(
          "UPDATE monitoring_incidents SET state='RESOLVED',restored_at=$2,verified_at=$2,resolved_at=$2,duration_ms=EXTRACT(EPOCH FROM ($2::timestamptz-first_observed_at))*1000,evidence=$3,updated_at=$2 WHERE id=$1",
          [
            a.incidentId,
            a.finishedAt,
            {
              code: "authorized_source_reconnected",
              playbackVerified: false,
              sourceRecreatedByHealer: false,
            },
          ],
        );
      await db.query("COMMIT");
      this.available = true;
      return true;
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      this.available = false;
      throw e;
    } finally {
      db.release();
    }
  }
}
