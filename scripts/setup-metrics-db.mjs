import { Pool } from "pg";
const db = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  statement_timeout: 5000,
});
const password = process.env.OBS_PG_PASSWORD;
if (!/^[\w-]{43}$/.test(password || ""))
  throw new Error("Invalid metrics credential");
try {
  const exists = await db.query(
    "SELECT 1 FROM pg_roles WHERE rolname='streamshield_metrics'",
  );
  if (!exists.rowCount)
    await db.query("CREATE ROLE streamshield_metrics LOGIN");
  const command = (
    await db.query(
      "SELECT format('ALTER ROLE streamshield_metrics PASSWORD %L', $1::text) AS sql",
      [password],
    )
  ).rows[0].sql;
  await db.query(command);
  await db.query("GRANT pg_monitor TO streamshield_metrics");
  const observerPassword = process.env.OBS_DB_PASSWORD;
  if (!/^[\w-]{43}$/.test(observerPassword || ""))
    throw new Error("Invalid observer credential");
  if (
    !(
      await db.query(
        "SELECT 1 FROM pg_roles WHERE rolname='streamshield_observer'",
      )
    ).rowCount
  )
    await db.query("CREATE ROLE streamshield_observer LOGIN");
  await db.query(
    (
      await db.query(
        "SELECT format('ALTER ROLE streamshield_observer PASSWORD %L', $1::text) AS sql",
        [observerPassword],
      )
    ).rows[0].sql,
  );
  await db.query("GRANT USAGE ON SCHEMA public TO streamshield_observer");
  await db.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON monitoring_state,monitoring_components,monitoring_incidents,monitoring_incident_events TO streamshield_observer",
  );
  await db.query(
    "GRANT USAGE,SELECT ON SEQUENCE monitoring_incident_events_seq_seq TO streamshield_observer",
  );
  if (
    (await db.query("SELECT to_regclass('healing_attempts') AS name")).rows[0]
      .name
  )
    await db.query("GRANT SELECT ON healing_attempts TO streamshield_observer");
  if (
    (await db.query("SELECT to_regclass('chaos_experiments') AS name")).rows[0]
      .name
  )
    await db.query(
      "GRANT SELECT ON chaos_experiments TO streamshield_observer",
    );
  console.log(
    "Restricted pg_monitor exporter identity prepared; no application table grants.",
  );
} finally {
  await db.end();
}
