import { database } from "../healing/journal.js";
import type { ChaosExperiment } from "@streamshield/shared";
import { terminal } from "./config.js";
export class ChaosJournal {
  db: ReturnType<typeof database>;
  constructor(file: string) {
    this.db = database(file);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS experiments(id TEXT PRIMARY KEY,actor TEXT NOT NULL,active INTEGER NOT NULL,body TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_active ON experiments(active) WHERE active=1;",
    );
  }
  get(id: string): ChaosExperiment | undefined {
    const r = this.db
      .prepare("SELECT body FROM experiments WHERE id=?")
      .get(id) as { body: string } | undefined;
    return r ? JSON.parse(r.body) : undefined;
  }
  all(limit = 100): ChaosExperiment[] {
    return (
      this.db
        .prepare("SELECT body FROM experiments ORDER BY rowid DESC LIMIT ?")
        .all(limit) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  work(): ChaosExperiment[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM experiments WHERE active=1 OR json_extract(body,'$.databasePersisted')=0 OR json_extract(body,'$.cleanup') IN ('PENDING','FAILED') ORDER BY active DESC,rowid LIMIT 100",
        )
        .all() as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  cooldownRemaining(target: string, cooldown: number) {
    const row = this.db
      .prepare(
        "SELECT json_extract(body,'$.createdAt') AS created FROM experiments WHERE json_extract(body,'$.target')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(target) as { created: string } | undefined;
    return row
      ? Math.max(0, Date.parse(row.created) + cooldown - Date.now())
      : 0;
  }
  create(e: ChaosExperiment, max: number, windowMs: number, cooldown: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.get(e.id);
      if (old) {
        if (old.actor !== e.actor) throw Error("identity_conflict");
        this.db.exec("COMMIT");
        return old;
      }
      if (this.db.prepare("SELECT id FROM experiments WHERE active=1").get())
        throw Error("experiment_active");
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM experiments WHERE actor=? AND json_extract(body,'$.createdAt')>?",
        )
        .get(e.actor, new Date(Date.now() - windowMs).toISOString()) as {
        n: number;
      };
      if (count.n >= max) throw Error("experiment_rate_limit");
      if (
        this.db
          .prepare(
            "SELECT id FROM experiments WHERE json_extract(body,'$.target')=? AND json_extract(body,'$.createdAt')>? LIMIT 1",
          )
          .get(e.target, new Date(Date.now() - cooldown).toISOString())
      )
        throw Error("target_cooldown");
      this.db
        .prepare("INSERT INTO experiments VALUES(?,?,1,?)")
        .run(e.id, e.actor, JSON.stringify(e));
      this.db.exec("COMMIT");
      return e;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  save(e: ChaosExperiment) {
    // A cancellation HTTP request can arrive while the background loop awaits I/O.
    // Preserve that durable intent when the older in-flight snapshot is saved.
    const current = this.get(e.id);
    if (current?.evidence.operatorResetRequestedAt) {
      e.evidence.operatorResetRequestedAt =
        current.evidence.operatorResetRequestedAt;
      e.evidence.operatorResetRequestedBy =
        current.evidence.operatorResetRequestedBy ?? null;
      for (const event of current.events.filter(
        (x) => x.kind === "OPERATOR_RESET_REQUESTED",
      ))
        if (!e.events.some((x) => x.kind === event.kind && x.at === event.at))
          e.events.push(event);
    }
    if (current?.cancelRequestedBy) {
      e.cancelRequestedBy = current.cancelRequestedBy;
      for (const event of current.events.filter(
        (x) => x.kind === "CANCEL_REQUESTED",
      ))
        if (
          !e.events.some(
            (x) =>
              x.kind === event.kind &&
              x.at === event.at &&
              x.detail === event.detail,
          )
        )
          e.events.push(event);
    }
    e.updatedAt = new Date().toISOString();
    e.databasePersisted = false;
    this.db
      .prepare("UPDATE experiments SET active=?,body=? WHERE id=?")
      .run(terminal(e.state) ? 0 : 1, JSON.stringify(e), e.id);
  }
  synced(e: ChaosExperiment) {
    const current = this.get(e.id);
    if (
      !current ||
      JSON.stringify({ ...current, databasePersisted: false }) !==
        JSON.stringify({ ...e, databasePersisted: false })
    )
      return false;
    e.databasePersisted = true;
    this.db
      .prepare("UPDATE experiments SET body=? WHERE id=?")
      .run(JSON.stringify(e), e.id);
    return true;
  }
  prune(days: number) {
    this.db
      .prepare(
        "DELETE FROM experiments WHERE rowid IN (SELECT rowid FROM experiments WHERE active=0 AND json_extract(body,'$.databasePersisted')=1 AND json_extract(body,'$.cleanup') IN ('NOT_REQUIRED','COMPLETED') AND json_extract(body,'$.finishedAt')<? LIMIT 100)",
      )
      .run(new Date(Date.now() - days * 86400000).toISOString());
  }
}
