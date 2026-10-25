import type { DatabaseSync } from "node:sqlite";
export interface Lease {
  owner: string;
  epoch: number;
  expires: number;
}
export class ControlJournal {
  constructor(public db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS leader(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,epoch INTEGER,expires INTEGER); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, service TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, code TEXT NOT NULL);",
    );
    // An accepted operation interrupted by process loss is ambiguous, never replayed.
    db.exec(
      "UPDATE operations SET state='AMBIGUOUS',code='adapter_interrupted' WHERE state='EXECUTING'",
    );
  }
  lease(owner: string, ttl: number, now = Date.now()): Lease | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT owner,epoch,expires FROM leader WHERE id=1")
        .get() as unknown as Lease | undefined;
      if (old && old.owner !== owner && old.expires > now) {
        this.db.exec("COMMIT");
        return null;
      }
      const epoch = old
        ? old.epoch + (old.owner !== owner || old.expires <= now ? 1 : 0)
        : 1;
      const value = { owner, epoch, expires: now + ttl };
      this.db
        .prepare(
          "INSERT INTO leader VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,epoch=excluded.epoch,expires=excluded.expires",
        )
        .run(owner, epoch, value.expires);
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  valid(owner: string, epoch: number, now = Date.now()) {
    const row = this.db
      .prepare("SELECT owner,epoch,expires FROM leader WHERE id=1")
      .get() as unknown as Lease | undefined;
    return (
      !!row && row.owner === owner && row.epoch === epoch && row.expires > now
    );
  }
  get(id: string) {
    return this.db
      .prepare("SELECT id,service,at,state,code FROM operations WHERE id=?")
      .get(id) as
      | { id: string; service: string; at: number; state: string; code: string }
      | undefined;
  }
  claim(
    id: string,
    service: string,
    cooldown: number,
    max: number,
    window: number,
    now = Date.now(),
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.get(id)) {
        this.db.exec("COMMIT");
        return "duplicate";
      }
      const recent = this.db
        .prepare(
          "SELECT at FROM operations WHERE service=? AND at>? ORDER BY at DESC",
        )
        .all(service, now - window) as { at: number }[];
      const reason =
        recent.length >= max
          ? "budget_exhausted"
          : recent[0] && now - recent[0].at < cooldown
            ? "cooldown"
            : null;
      if (reason) {
        this.db.exec("COMMIT");
        return reason;
      }
      this.db
        .prepare("INSERT INTO operations VALUES(?,?,?,'EXECUTING','accepted')")
        .run(id, service, now);
      this.db.exec("COMMIT");
      return "accepted";
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /** Read-only view of the same rule claim() enforces. */
  budget(
    service: string,
    cooldown: number,
    max: number,
    window: number,
    now = Date.now(),
  ) {
    const recent = (
      this.db
        .prepare(
          "SELECT at FROM operations WHERE service=? AND at>? ORDER BY at ASC",
        )
        .all(service, now - window) as { at: number }[]
    ).map((r) => r.at);
    let next = 0;
    if (recent.length >= max) next = recent[recent.length - max]! + window;
    if (recent.length) next = Math.max(next, recent.at(-1)! + cooldown);
    return {
      used: recent.length,
      max,
      availableAt: next > now ? new Date(next).toISOString() : null,
    };
  }
  finish(id: string, state: string, code: string) {
    this.db
      .prepare("UPDATE operations SET state=?,code=? WHERE id=?")
      .run(state, code, id);
  }
}
