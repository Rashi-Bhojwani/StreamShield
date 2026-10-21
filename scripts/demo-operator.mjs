// Runs only through a trusted local Docker exec. There is no HTTP issuance route.
import { Pool } from "pg";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { hash, Algorithm } from "@node-rs/argon2";
import {
  capacityConfig,
  demoSlots,
  demoIdentity,
} from "../packages/shared/src/demo.ts";
const token = () => randomBytes(32).toString("base64url"),
  digest = (v) => createHash("sha256").update(v).digest("hex");
if (
  process.env.NODE_ENV !== "development" ||
  process.env.DEMO_ENABLED !== "true"
)
  throw Error("Explicit local demo configuration required");
const body = JSON.parse((await import("node:fs")).readFileSync(0, "utf8"));
const db = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: 5000,
});
try {
  let result;
  if (body.action === "seed") {
    const client = await db.connect(),
      created = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(81373001)");
      for (const slot of demoSlots) {
        const d = demoIdentity(slot),
          username = `ss_demo_streamer_${slot}`;
        const mapped = (
          await client.query("SELECT * FROM demo_channels WHERE slot=$1", [
            slot,
          ])
        ).rows[0];
        if (mapped) {
          if (
            mapped.stream_id !== d.streamId ||
            mapped.user_id !== d.userId ||
            mapped.channel_id !== d.channelId
          )
            throw Error("Conflicting demo mapping; operator review required");
          continue;
        }
        const conflict = await client.query(
          "SELECT id FROM users WHERE id=$1 OR username=$2 OR email=$3 UNION ALL SELECT id FROM channels WHERE id=$4 OR slug=$5 UNION ALL SELECT id FROM streams WHERE id=$6",
          [
            d.userId,
            username,
            `${username}@demo.invalid`,
            d.channelId,
            d.slug,
            d.streamId,
          ],
        );
        if (conflict.rowCount)
          throw Error(
            "Demo identity conflicts with retained data; nothing was adopted or deleted",
          );
        const key = token(),
          path = "s-" + randomBytes(16).toString("hex");
        const passwordHash = await hash(token(), {
          algorithm: Algorithm.Argon2id,
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        });
        await client.query(
          "INSERT INTO users(id,username,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,$5,'broadcaster')",
          [
            d.userId,
            username,
            `${username}@demo.invalid`,
            passwordHash,
            d.name,
          ],
        );
        await client.query(
          "INSERT INTO channels(id,owner_id,slug,display_name,description) VALUES($1,$2,$3,$4,$5)",
          [
            d.channelId,
            d.userId,
            d.slug,
            d.name,
            `Independent live channel ${slot}`,
          ],
        );
        await client.query(
          "INSERT INTO streams(id,channel_id,title,description,media_path,publish_hash,lifecycle) VALUES($1,$2,$3,$4,$5,$6,'ready')",
          [
            d.streamId,
            d.channelId,
            `${d.name} — Live`,
            "Live from an independent broadcaster",
            path,
            digest(key),
          ],
        );
        await client.query(
          "INSERT INTO demo_channels(slot,user_id,channel_id,stream_id) VALUES($1,$2,$3,$4)",
          [slot, d.userId, d.channelId, d.streamId],
        );
        created.push({ slot, path, user: d.streamId, key });
      }
      await client.query("COMMIT");
      result = { created };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else if (body.action === "admin") {
    // A random password is never exposed or used for interactive public login.
    const id = "10000000-0000-4000-8000-000000000099",
      username = "ss_demo_operator";
    const existing = (
      await db.query("SELECT id,role FROM users WHERE id=$1 OR username=$2", [
        id,
        username,
      ])
    ).rows;
    if (
      existing.length &&
      (existing.length !== 1 ||
        existing[0].id !== id ||
        existing[0].role !== "administrator")
    )
      throw Error("Operator identity conflict; manual review required");
    if (!existing.length)
      await db.query(
        "INSERT INTO users(id,username,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,'Local operator','administrator')",
        [
          id,
          username,
          "ss_demo_operator@demo.invalid",
          await hash(token(), {
            algorithm: Algorithm.Argon2id,
            memoryCost: 19456,
            timeCost: 2,
            parallelism: 1,
          }),
        ],
      );
    const ticket = token();
    await db.query("DELETE FROM demo_local_tickets WHERE expires_at<now()");
    await db.query(
      "INSERT INTO demo_local_tickets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '90 seconds')",
      [digest(ticket), id],
    );
    result = { ticket, expiresInSeconds: 90 };
  } else if (body.action === "rotate") {
    if (!demoSlots.includes(body.slot))
      throw Error("Choose broadcaster 1, 2 or 3");
    const row = (
      await db.query(
        "SELECT s.* FROM streams s JOIN demo_channels d ON d.stream_id=s.id WHERE d.slot=$1",
        [body.slot],
      )
    ).rows[0];
    if (!row) throw Error("Run demo:seed first");
    // Revoke first, then kick only this publisher via private MediaMTX authority.
    await db.query("UPDATE streams SET publish_hash=NULL WHERE id=$1", [
      row.id,
    ]);
    const headers = {
      Authorization:
        "Basic " +
        Buffer.from(
          process.env.MEDIA_API_USER + ":" + process.env.MEDIA_API_PASSWORD,
        ).toString("base64"),
    };
    const base = process.env.MEDIA_API_BASE_URL;
    const response = await fetch(base + "/v3/rtmpconns/list", {
      headers,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok)
      throw Error(
        "Key revoked; publisher disconnect unconfirmed. Stop OBS and retry rotation.",
      );
    const conns = await response.json();
    for (const conn of conns.items.filter(
      (x) => x.path === row.media_path && x.state === "publish",
    )) {
      const kicked = await fetch(base + "/v3/rtmpconns/kick/" + conn.id, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!kicked.ok && kicked.status !== 404)
        throw Error("Key revoked; publisher disconnect unconfirmed");
    }
    const key = token();
    await db.query(
      "UPDATE streams SET publish_hash=$1,lifecycle='ready',updated_at=now() WHERE id=$2",
      [digest(key), row.id],
    );
    result = { slot: body.slot, path: row.media_path, user: row.id, key };
  } else if (body.action === "capacity-create") {
    const c = capacityConfig.parse(body.config),
      origin = new URL(c.target).origin;
    const allowed = (
      process.env.CAPACITY_ALLOWED_ORIGINS || "http://localhost:5173"
    ).split(",");
    if (!allowed.includes(origin))
      throw Error("Target is outside explicit CAPACITY_ALLOWED_ORIGINS");
    if (c.distributed && !body.authorizedDistributed)
      throw Error("Explicit distributed target authorization required");
    const client = await db.connect();
    let created;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(81373002)");
      const active = await client.query(
        "SELECT id FROM capacity_runs WHERE state IN ('CREATED','RUNNING') AND expires_at>now()",
      );
      if (active.rowCount)
        throw Error(
          "A capacity run is already active; finish or stop it before another run",
        );
      const key = token(),
        id = randomUUID();
      await client.query(
        "INSERT INTO capacity_runs(id,token_hash,profile,target_origin,target_clients,distributed,duration_seconds,ramp_seconds,chat_per_second,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+($10*interval '1 second'))",
        [
          id,
          digest(key),
          c.profile,
          origin,
          c.clients,
          c.distributed,
          c.duration,
          c.ramp,
          c.chatPerSecond,
          c.duration + c.ramp + 60,
        ],
      );
      created = { id, token: key, ...c, target: origin };
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    result = created;
  } else if (body.action === "capacity-stop") {
    if (!/^[a-f0-9-]{36}$/.test(body.id)) throw Error("Invalid run ID");
    await db.query(
      "UPDATE capacity_runs SET state='STOPPED',stopped_at=now() WHERE id=$1 AND state IN ('CREATED','RUNNING')",
      [body.id],
    );
    result = { ok: true };
  } else throw Error("Unknown fixed operator action");
  process.stdout.write(JSON.stringify(result));
} finally {
  await db.end();
}
