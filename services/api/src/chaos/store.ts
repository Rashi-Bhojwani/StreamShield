import { Pool } from "pg";
import type { ChaosExperiment } from "@streamshield/shared";
export class ChaosStore {
  available = false;
  db = new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 2,
    connectionTimeoutMillis: 1000,
    query_timeout: 2000,
    statement_timeout: 2000,
  });
  constructor() {
    this.db.on("error", () => {
      this.available = false;
    });
  }
  async check() {
    await this.db.query("SELECT 1 FROM chaos_experiments LIMIT 1");
    this.available = true;
  }
  async get(id: string): Promise<ChaosExperiment | undefined> {
    return (
      await this.db.query("SELECT body FROM chaos_experiments WHERE id=$1", [
        id,
      ])
    ).rows[0]?.body;
  }
  async sync(e: ChaosExperiment) {
    await this.db.query(
      "INSERT INTO chaos_experiments(id,actor,scenario,state,body,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body,updated_at=excluded.updated_at",
      [
        e.id,
        e.actor,
        e.scenario,
        e.state,
        { ...e, databasePersisted: true },
        e.createdAt,
        e.updatedAt,
      ],
    );
    this.available = true;
  }
  async incident(id: string) {
    return (
      await this.db.query(
        "SELECT detected_at,resolved_at FROM monitoring_incidents WHERE id=$1",
        [id],
      )
    ).rows[0] as { detected_at: Date; resolved_at: Date | null } | undefined;
  }
}
