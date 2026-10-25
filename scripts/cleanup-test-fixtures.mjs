import { Pool } from "pg";
let input = "";
for await (const part of process.stdin) input += part;
const ids = JSON.parse(input);
if (
  !Array.isArray(ids) ||
  ids.length > 20 ||
  ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
)
  throw new Error("Invalid disposable fixture IDs");
const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: Number(process.env.DEPENDENCY_TIMEOUT_MS),
});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const users = (
    await client.query(
      "SELECT id,username FROM users WHERE id=ANY($1::uuid[]) FOR UPDATE",
      [ids],
    )
  ).rows;
  if (users.some((user) => !user.username.startsWith("e2e_")))
    throw new Error("Refusing to delete non-test accounts");
  const safe = users.map((user) => user.id);
  await client.query(
    "DELETE FROM chat_messages WHERE sender_id=ANY($1::uuid[]) OR stream_id IN (SELECT s.id FROM streams s JOIN channels c ON c.id=s.channel_id WHERE c.owner_id=ANY($1::uuid[]))",
    [safe],
  );
  await client.query(
    "DELETE FROM streams WHERE channel_id IN (SELECT id FROM channels WHERE owner_id=ANY($1::uuid[]))",
    [safe],
  );
  await client.query("DELETE FROM channels WHERE owner_id=ANY($1::uuid[])", [
    safe,
  ]);
  await client.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [safe]);
  await client.query("COMMIT");
} catch {
  await client.query("ROLLBACK");
  throw new Error(
    "Disposable fixture cleanup failed; no data reset was performed.",
  );
} finally {
  client.release();
  await pool.end();
}
