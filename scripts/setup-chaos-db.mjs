import { Pool } from "pg";
const p = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: 3000,
});
try {
  const password = process.env.CHAOS_DB_PASSWORD;
  if (!/^[\w-]{43}$/.test(password || ""))
    throw Error("Invalid chaos database credential");
  if (
    !(
      await p.query("SELECT 1 FROM pg_roles WHERE rolname='streamshield_chaos'")
    ).rowCount
  )
    await p.query("CREATE ROLE streamshield_chaos LOGIN");
  await p.query(
    (
      await p.query(
        "SELECT format('ALTER ROLE streamshield_chaos PASSWORD %L',$1::text) AS sql",
        [password],
      )
    ).rows[0].sql,
  );
  await p.query("GRANT USAGE ON SCHEMA public TO streamshield_chaos");
  await p.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON chaos_experiments TO streamshield_chaos",
  );
  await p.query(
    "GRANT SELECT ON monitoring_incidents,healing_attempts TO streamshield_chaos",
  );
  console.log(
    "Restricted experiment audit identity prepared; no account/session/chat or healing mutation grants.",
  );
} finally {
  await p.end();
}
