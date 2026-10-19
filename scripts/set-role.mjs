import { Pool } from "pg";
const [username, role] = process.argv.slice(2);
if (
  !/^[a-z0-9_]{3,24}$/.test(username || "") ||
  !["viewer", "broadcaster", "administrator"].includes(role)
)
  throw new Error(
    "Usage: account:role -- username viewer|broadcaster|administrator (trusted database access only)",
  );
const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: Number(process.env.DEPENDENCY_TIMEOUT_MS),
});
try {
  const result = await pool.query(
    "UPDATE users SET role=$1,updated_at=now() WHERE username=$2 RETURNING id",
    [role, username],
  );
  if (!result.rowCount) throw new Error("Account not found");
  console.log("Account role updated using trusted local database access.");
} finally {
  await pool.end();
}
