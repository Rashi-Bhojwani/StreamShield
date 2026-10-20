import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { RecoveryAttempt } from "@streamshield/shared";
export function database(file: string) {
  if (file !== ":memory:")
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;",
  );
  if (file !== ":memory:") chmodSync(file, 0o600);
  return db;
}
export class Journal {
  db: DatabaseSync;
  constructor(file: string) {
    this.db = database(file);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,episode TEXT NOT NULL UNIQUE,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY,body TEXT NOT NULL);",
    );
  }
  all(limit = 100): RecoveryAttempt[] {
    return (
      this.db
        .prepare("SELECT body FROM attempts ORDER BY rowid DESC LIMIT ?")
        .all(limit) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  /** Prioritize unfinished and unsynchronized work independently of the latest-100 UI. */
  work(limit = 100): RecoveryAttempt[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM attempts WHERE json_extract(body, '$.state') != 'VERIFIED' OR json_extract(body, '$.databasePersisted')=0 ORDER BY CASE WHEN json_extract(body, '$.state') NOT IN ('VERIFIED','ESCALATED') THEN 0 WHEN json_extract(body, '$.databasePersisted')=0 THEN 1 ELSE 2 END,rowid ASC LIMIT ?",
        )
        .all(limit) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  get(id: string): RecoveryAttempt | undefined {
    const row = this.db
      .prepare("SELECT body FROM attempts WHERE id=?")
      .get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  insert(a: RecoveryAttempt) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO attempts VALUES(?,?,?)")
        .run(a.id, a.episode, JSON.stringify(a)).changes === 1
    );
  }
  save(a: RecoveryAttempt, expectedEpoch: number) {
    return (
      this.db
        .prepare(
          "UPDATE attempts SET body=? WHERE id=? AND json_extract(body,'$.epoch')=?",
        )
        .run(JSON.stringify(a), a.id, expectedEpoch).changes === 1
    );
  }
  adopt(a: RecoveryAttempt, epoch: number) {
    const old = a.epoch;
    a.epoch = epoch;
    a.databasePersisted = false;
    return this.save(a, old);
  }
  source(path: string, body: object) {
    this.db
      .prepare(
        "INSERT INTO sources VALUES(?,?) ON CONFLICT(path) DO UPDATE SET body=excluded.body",
      )
      .run(path, JSON.stringify(body));
  }
  sources(): { path: string; lastSeen: number; missingAt: number | null }[] {
    return (
      this.db.prepare("SELECT body FROM sources LIMIT 100").all() as {
        body: string;
      }[]
    ).map((x) => JSON.parse(x.body));
  }
  prune() {
    this.db
      .prepare(
        "DELETE FROM attempts WHERE rowid IN (SELECT rowid FROM attempts WHERE json_extract(body,'$.databasePersisted')=1 AND json_extract(body,'$.state') = 'VERIFIED' AND json_extract(body,'$.finishedAt') < ? ORDER BY rowid LIMIT 100)",
      )
      .run(new Date(Date.now() - 90 * 86400000).toISOString());
  }
}
