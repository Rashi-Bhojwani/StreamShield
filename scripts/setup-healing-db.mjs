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
try {
  const password = process.env.HEALER_DB_PASSWORD;
  if (!/^[\w-]{43}$/.test(password || ""))
    throw new Error("Invalid Healer database credential");
  if (
    !(
      await db.query(
        "SELECT 1 FROM pg_roles WHERE rolname='streamshield_healer'",
      )
    ).rowCount
  )
    await db.query("CREATE ROLE streamshield_healer LOGIN");
  await db.query(
    (
      await db.query(
        "SELECT format('ALTER ROLE streamshield_healer PASSWORD %L',$1::text) AS sql",
        [password],
      )
    ).rows[0].sql,
  );
  await db.query("GRANT USAGE ON SCHEMA public TO streamshield_healer");
  await db.query(
    "GRANT SELECT,INSERT,UPDATE ON healing_attempts,healing_events,healing_verification,monitoring_incidents,monitoring_incident_events TO streamshield_healer",
  );
  await db.query(
    "GRANT SELECT ON healing_expected_sources TO streamshield_healer",
  );
  await db.query(
    "GRANT USAGE,SELECT ON SEQUENCE monitoring_incident_events_seq_seq TO streamshield_healer",
  );
  console.log(
    "Restricted recovery audit identity prepared; no account, credential, chat or migration privileges.",
  );
} finally {
  await db.end();
}
