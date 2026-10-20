import assert from "node:assert/strict";
import { RecoveryStore } from "../services/api/src/healing/store.ts";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runner } from "node-pg-migrate";
import pino from "pino";
import { io as clientIo } from "socket.io-client";
import { parseConfig } from "../services/api/src/config.ts";
import { parsePlatformConfig } from "../services/api/src/platform/config.ts";
import { createResources } from "../services/api/src/platform/resources.ts";
import { createPlatform } from "../services/api/src/platform/routes.ts";
import { createApp } from "../services/api/src/app.ts";
import {
  createRealtime,
  presenceCount,
  presenceKey,
} from "../services/api/src/platform/realtime.ts";
import { createMediaAuth } from "../services/api/src/platform/media-auth.ts";
import { digest } from "../services/api/src/platform/security.ts";
import supertest from "supertest";

const c = parsePlatformConfig(process.env),
  media = parseConfig(process.env);
const database = "streamshield_test_" + randomUUID().replaceAll("-", "");
assert.match(database, /^streamshield_test_[a-f0-9]+$/);
const dbConfig = {
  host: c.POSTGRES_HOST,
  port: c.POSTGRES_PORT,
  database: c.POSTGRES_DB,
  user: c.POSTGRES_USER,
  password: c.POSTGRES_PASSWORD,
};
const admin = new Pool({
  ...dbConfig,
  connectionTimeoutMillis: c.DEPENDENCY_TIMEOUT_MS,
});
const logger = pino({ level: "silent" });
const resources = [],
  servers = [],
  sockets = [];
let checks = 0;
const check = (name) => {
  checks++;
  console.log("PASS " + name);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn) {
  const end = Date.now() + c.DEPENDENCY_TIMEOUT_MS;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(50);
  }
  assert.fail("Timed condition did not complete");
}
async function start(overrides = {}) {
  const cfg = {
    ...c,
    POSTGRES_DB: database,
    CHAT_RATE_LIMIT: 2,
    AUTH_RATE_LIMIT: 100,
    ENABLE_LEGACY_STREAM: false,
    REDIS_DB: 1,
    ...overrides,
  };
  const r = createResources(cfg, logger);
  resources.push(r);
  await r.start();
  const platform = await createPlatform(r, cfg, media, logger);
  const app = createApp(media, { ready: true }, logger, undefined, platform);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const io = createRealtime(server, r, cfg, media, platform);
  servers.push({ server, io });
  return {
    r,
    cfg,
    platform,
    origin: "http://127.0.0.1:" + server.address().port,
  };
}
function browser(base) {
  const jar = new Map();
  let csrf = "";
  return {
    get cookie() {
      return [...jar].map(([k, v]) => k + "=" + v).join("; ");
    },
    get csrf() {
      return csrf;
    },
    async request(path, method = "GET", body, overrides = {}) {
      const response = await fetch(base + "/api/v1" + path, {
        method,
        headers: {
          Origin: media.CORS_ORIGINS[0],
          Cookie: this.cookie,
          "Content-Type": "application/json",
          ...(method === "GET" ? {} : { "X-CSRF-Token": csrf }),
          ...overrides,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const part = cookie.split(";")[0];
        const at = part.indexOf("=");
        jar.set(part.slice(0, at), part.slice(at + 1));
      }
      const data = await response.json();
      if (data.csrf) csrf = data.csrf;
      return { status: response.status, data, headers: response.headers };
    },
  };
}
async function connect(base, browser) {
  const socket = clientIo(base, {
    transports: ["websocket"],
    extraHeaders: { Origin: media.CORS_ORIGINS[0], Cookie: browser.cookie },
    auth: { csrf: browser.csrf },
    reconnection: false,
    timeout: c.DEPENDENCY_TIMEOUT_MS,
  });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}
function emit(socket, event, data) {
  return new Promise((resolve, reject) =>
    socket
      .timeout(c.DEPENDENCY_TIMEOUT_MS)
      .emit(event, data, (error, reply) =>
        error ? reject(error) : resolve(reply),
      ),
  );
}
try {
  await admin.query('CREATE DATABASE "' + database + '"');
  await runner({
    databaseUrl: { ...dbConfig, database },
    dir: "migrations",
    ignorePattern: "^platform[.]sql$",
    direction: "up",
    migrationsTable: "schema_migrations",
    count: Infinity,
    log: () => {},
  });
  await runner({
    databaseUrl: { ...dbConfig, database },
    dir: "migrations",
    ignorePattern: "^platform[.]sql$",
    direction: "up",
    migrationsTable: "schema_migrations",
    count: Infinity,
    log: () => {},
  });
  const a = await start(),
    b = await start();
  assert.equal(
    Number(
      (await a.r.db.query("SELECT count(*) FROM schema_migrations")).rows[0]
        .count,
    ),
    3,
  );
  assert.deepEqual(
    (
      await a.r.db.query("SELECT name FROM schema_migrations ORDER BY name")
    ).rows.map((row) => row.name),
    [
      "1761000000000_platform",
      "1761100000000_observability",
      "1761190000000_healing",
      "1761280000000_chaos",
    ],
  );
  check("migrations apply and repeat without destructive resets");
  // Explicit synthetic fixtures live only in this isolated, disposable integration database.
  const incidentId = randomUUID(),
    attemptId = randomUUID(),
    observed = "2026-01-01T00:00:00Z",
    recurrence = "2026-01-01T00:00:10Z";
  await a.r.db.query(
    "INSERT INTO monitoring_incidents(id,component,severity,state,first_observed_at,detected_at,evidence,correlation_id) VALUES($1,'api-1','critical','DIAGNOSED',$2,$2,$3,$1)",
    [incidentId, observed, { syntheticTest: true }],
  );
  const audit = new RecoveryStore();
  await audit.db.end();
  audit.db = a.r.db;
  const attempt = {
    id: attemptId,
    incidentId: null,
    component: "api-1",
    episode: "synthetic-api-1-recurrence",
    playbook: "api-start",
    version: 1,
    actor: "streamshield-healer",
    diagnosis: "isolated synthetic fixture",
    action: "start_stopped_service",
    state: "VERIFYING",
    number: 1,
    epoch: 1,
    createdAt: recurrence,
    detectedAt: recurrence,
    actionStartedAt: null,
    actionFinishedAt: null,
    verificationStartedAt: recurrence,
    finishedAt: null,
    nextAt: 0,
    deadline: 0,
    reason: "test",
    evidence: { syntheticTest: true },
    events: [
      { state: "SCHEDULED", at: recurrence, reason: "isolated test" },
      { state: "VERIFYING", at: recurrence, reason: "isolated test" },
    ],
  };
  assert.equal(await audit.sync(attempt), true);
  assert.equal(attempt.incidentId, incidentId);
  assert.equal(await audit.sync(attempt), true);
  assert.equal(
    (
      await a.r.db.query(
        "SELECT count(*)::int AS n FROM healing_events WHERE attempt_id=$1",
        [attemptId],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await a.r.db.query(
        "SELECT first_observed_at FROM monitoring_incidents WHERE id=$1",
        [incidentId],
      )
    ).rows[0].first_observed_at.toISOString(),
    new Date(observed).toISOString(),
  );
  assert.equal(
    await audit.sync({ ...attempt, epoch: 0, state: "ESCALATED" }),
    false,
  );
  assert.equal(
    (
      await a.r.db.query("SELECT state FROM healing_attempts WHERE id=$1", [
        attemptId,
      ])
    ).rows[0].state,
    "VERIFYING",
  );
  check(
    "isolated recovery audit correlates recurrence, deduplicates events and fences stale writers",
  );
  const alice = browser(a.origin),
    bob = browser(b.origin),
    guest = browser(a.origin);
  for (const account of [alice, bob, guest])
    assert.equal((await account.request("/auth/me")).status, 200);
  const suffix = randomUUID().slice(0, 8);
  const password = "Test-only-strong-password-42";
  assert.equal(
    (
      await alice.request("/auth/register", "POST", {
        username: "alice_" + suffix,
        email: "a" + suffix + "@example.test",
        password,
        role: "administrator",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await alice.request("/auth/register", "POST", {
        username: "a",
        email: "bad",
        password: "short",
      })
    ).status,
    400,
  );
  check("invalid registration and client-supplied roles rejected");
  let result = await alice.request("/auth/register", "POST", {
    username: "alice_" + suffix,
    email: "a" + suffix + "@example.test",
    password,
  });
  assert.equal(result.status, 200);
  assert.match(result.headers.getSetCookie().join(";"), /HttpOnly/);
  assert.match(result.headers.getSetCookie().join(";"), /SameSite=Lax/);
  assert.equal(
    (
      await bob.request("/auth/register", "POST", {
        username: "bob_" + suffix,
        email: "b" + suffix + "@example.test",
        password,
      })
    ).status,
    200,
  );
  const aliceMe = (await alice.request("/auth/me")).data.user,
    bobMe = (await bob.request("/auth/me")).data.user;
  assert.equal(bobMe.role, "viewer");
  assert.equal(aliceMe.role, "viewer");
  assert.ok(!("password_hash" in aliceMe));
  const dbUser = (
    await a.r.db.query("SELECT password_hash FROM users WHERE id=$1", [
      aliceMe.id,
    ])
  ).rows[0];
  assert.match(dbUser.password_hash, /^\$argon2id\$/);
  assert.notEqual(dbUser.password_hash, password);
  check(
    "real registration, Argon2id hashes, HttpOnly cookies and restored sessions",
  );
  const duplicate = browser(a.origin);
  await duplicate.request("/auth/me");
  assert.equal(
    (
      await duplicate.request("/auth/register", "POST", {
        username: "alice_" + suffix,
        email: "unique" + suffix + "@example.test",
        password,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await duplicate.request("/auth/register", "POST", {
        username: "unique_" + suffix,
        email: "a" + suffix + "@example.test",
        password,
      })
    ).status,
    409,
  );
  check("database uniqueness rejects duplicate username and email");
  assert.equal((await guest.request("/studio/streams")).status, 401);
  assert.equal(
    (
      await guest.request("/auth/login", "POST", {
        identifier: aliceMe.username,
        password: "wrong",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await guest.request(
        "/auth/login",
        "POST",
        { identifier: aliceMe.username, password },
        { "X-CSRF-Token": "forged" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await guest.request(
        "/auth/login",
        "POST",
        { identifier: aliceMe.username, password },
        { Origin: "https://untrusted.invalid", "X-Forwarded-For": "127.0.0.1" },
      )
    ).status,
    403,
  );
  check(
    "unauthorized access, invalid login, CSRF and forged-origin bypass rejected",
  );
  assert.equal(
    (
      await guest.request("/auth/login", "POST", {
        identifier: aliceMe.username,
        password,
      })
    ).status,
    200,
  );
  assert.equal((await guest.request("/auth/me")).data.user.id, aliceMe.id);
  check("valid login creates a separately revocable browser session");
  await a.r.db.query(
    "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [digest(guest.cookie.split("ss_session=")[1].split(";")[0])],
  );
  assert.equal((await guest.request("/studio/streams")).status, 401);
  check("expired sessions rejected server-side");
  assert.equal(
    (
      await alice.request("/channels", "POST", {
        slug: "alice-" + suffix,
        displayName: "Alice channel",
        description: "Real integration channel",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await bob.request("/channels", "POST", {
        slug: "bob-" + suffix,
        displayName: "Bob channel",
        description: "Another real channel",
      })
    ).status,
    201,
  );
  const channelA = (await alice.request("/studio/channel")).data.channel,
    channelB = (await bob.request("/studio/channel")).data.channel;
  assert.equal((await alice.request("/auth/me")).data.user.role, "broadcaster");
  assert.equal(
    (
      await bob.request("/channels/" + channelA.id, "PATCH", {
        displayName: "Hijack",
        description: "Denied",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await alice.request("/channels/" + channelA.id, "PATCH", {
        displayName: "Alice updated",
        description: "Owner updated",
      })
    ).status,
    200,
  );
  assert.equal(
    (await guest.request("/channels/" + channelA.slug)).data.channel
      .displayName,
    "Alice updated",
  );
  check(
    "owned channel creation/update, public channel retrieval and cross-user rejection",
  );
  const conflict = browser(a.origin);
  await conflict.request("/auth/me");
  await conflict.request("/auth/register", "POST", {
    username: "other_" + suffix,
    email: "o" + suffix + "@example.test",
    password,
  });
  assert.equal(
    (
      await conflict.request("/channels", "POST", {
        slug: channelA.slug,
        displayName: "Conflict",
        description: "",
      })
    ).status,
    409,
  );
  assert.equal((await conflict.request("/auth/me")).data.user.role, "viewer");
  check("channel uniqueness failure rolls back role promotion transaction");
  assert.equal(
    (
      await bob.request("/studio/streams", "POST", {
        channelId: channelA.id,
        title: "Stolen",
        description: "",
      })
    ).status,
    404,
  );
  const streamA = (
    await alice.request("/studio/streams", "POST", {
      channelId: channelA.id,
      title: "First stream",
      description: "A",
    })
  ).data.id;
  const streamB = (
    await bob.request("/studio/streams", "POST", {
      channelId: channelB.id,
      title: "Second stream",
      description: "B",
    })
  ).data.id;
  assert.ok(streamA && streamB && streamA !== streamB);
  assert.equal(
    (
      await bob.request("/studio/streams/" + streamA, "PATCH", {
        title: "Hijack",
        description: "",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await alice.request("/studio/streams/" + streamA, "PATCH", {
        title: "First updated",
        description: "Updated",
      })
    ).status,
    200,
  );
  assert.equal(
    (await bob.request("/studio/streams/" + streamA + "/publishing", "POST"))
      .status,
    404,
  );
  const paths = (await a.r.db.query("SELECT media_path FROM streams")).rows.map(
    (row) => row.media_path,
  );
  assert.equal(new Set(paths).size, 2);
  check(
    "independent stream identities, unique media paths and strict ownership",
  );
  const firstKey = await alice.request(
    "/studio/streams/" + streamA + "/publishing",
    "POST",
  );
  assert.equal(firstKey.status, 200);
  const internal = supertest(
    createMediaAuth(a.r, a.cfg, media, {
      user: "disabled",
      password: "disabled",
    }),
  );
  const authorization =
    "Basic " +
    Buffer.from("mediamtx:" + c.MEDIA_AUTH_SECRET).toString("base64");
  const payload = {
    action: "publish",
    protocol: "rtmp",
    path: firstKey.data.path,
    user: firstKey.data.user,
    password: firstKey.data.key,
  };
  assert.equal(
    (
      await internal
        .post("/internal/media/auth")
        .send(payload)
        .set("X-Forwarded-For", "127.0.0.1")
    ).status,
    401,
  );
  assert.equal(
    (
      await internal
        .post("/internal/media/auth")
        .set("Authorization", authorization)
        .send(payload)
    ).status,
    204,
  );
  assert.equal(
    (
      await internal
        .post("/internal/media/auth")
        .set("Authorization", authorization)
        .send({ ...payload, path: paths.find((path) => path !== payload.path) })
    ).status,
    401,
  );
  assert.equal(
    (
      await internal
        .post("/internal/media/auth")
        .set("Authorization", authorization)
        .send({ ...payload, password: "invalid" })
    ).status,
    401,
  );
  await a.r.db.query("UPDATE users SET role='viewer' WHERE id=$1", [
    aliceMe.id,
  ]);
  assert.equal(
    (
      await internal
        .post("/internal/media/auth")
        .set("Authorization", authorization)
        .send(payload)
    ).status,
    401,
  );
  await a.r.db.query("UPDATE users SET role='broadcaster' WHERE id=$1", [
    aliceMe.id,
  ]);
  const newKey = await alice.request(
    "/studio/streams/" + streamA + "/publishing",
    "POST",
  );
  assert.equal(newKey.status, 200);
  assert.notEqual(firstKey.data.key, newKey.data.key);
  assert.equal(
    (
      await internal
        .post("/internal/media/auth")
        .set("Authorization", authorization)
        .send(payload)
    ).status,
    401,
  );
  assert.equal(
    (
      await internal
        .post("/internal/media/auth")
        .set("Authorization", authorization)
        .send({ ...payload, password: newKey.data.key })
    ).status,
    204,
  );
  const publicStream = (await guest.request("/streams/" + streamA)).data;
  assert.ok(!JSON.stringify(publicStream).includes(newKey.data.key));
  assert.ok(!("publish_hash" in publicStream));
  check(
    "private callback auth, path-bound publishing, rotation/revocation and public key secrecy",
  );
  const rows = await a.r.db.query(
    "SELECT publish_hash FROM streams WHERE id=$1",
    [streamA],
  );
  assert.equal(rows.rows[0].publish_hash, digest(newKey.data.key));
  await assert.rejects(
    a.r.db.query(
      "INSERT INTO streams(id,channel_id,title,media_path) VALUES($1,$2,'invalid',$3)",
      [randomUUID(), randomUUID(), "s-" + randomUUID().replaceAll("-", "")],
    ),
  );
  check("publish credentials stored only as hashes and foreign keys enforced");
  assert.ok(
    (await alice.request("/streams?q=Alice%20updated")).data.streams.some(
      (stream) => stream.id === streamA,
    ),
  );
  check(
    "bounded database discovery searches stream titles and channel metadata",
  );
  const socketA = await connect(a.origin, alice),
    socketB = await connect(b.origin, bob),
    socketOther = await connect(b.origin, bob),
    socketGuest = await connect(a.origin, guest);
  assert.equal(
    (await emit(socketA, "join", { streamId: "invalid" })).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (
      await emit(socketA, "heartbeat", {
        streamId: "invalid",
        playing: "wrong",
      })
    ).error.code,
    "INVALID_INPUT",
  );
  for (const socket of [socketA, socketB, socketGuest])
    assert.equal((await emit(socket, "join", { streamId: streamA })).ok, true);
  assert.equal(
    (await emit(socketOther, "join", { streamId: streamB })).ok,
    true,
  );
  let received = 0,
    leaked = 0;
  socketB.on("message", () => received++);
  socketOther.on("message", () => leaked++);
  assert.equal(
    (
      await emit(socketA, "message", {
        streamId: streamA,
        content: "Hello across Redis",
      })
    ).ok,
    true,
  );
  await eventually(() => received === 1);
  assert.equal(leaked, 0);
  check(
    "two authenticated users exchange messages across distinct API instances via Redis adapter",
  );
  assert.equal(
    (
      await emit(socketGuest, "message", {
        streamId: streamA,
        content: "Unauthorized",
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await emit(socketA, "message", {
        streamId: streamB,
        content: "Wrong room",
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await emit(socketA, "message", {
        streamId: streamA,
        content: " ".repeat(3),
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await emit(socketA, "message", {
        streamId: streamA,
        content: "x".repeat(1001),
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await emit(socketA, "message", {
        streamId: streamA,
        content: "<script>literal text</script>",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await emit(socketA, "message", {
        streamId: streamA,
        content: "Rate rejected",
      })
    ).error.code,
    "RATE_LIMITED",
  );
  check(
    "unauthenticated chat, room crossover, invalid length and spam rejected",
  );
  const history = (await alice.request("/streams/" + streamA + "/chat")).data
    .messages;
  assert.equal(history.length, 2);
  assert.equal(history[1].content, "<script>literal text</script>");
  assert.ok(BigInt(history[1].seq) > BigInt(history[0].seq));
  assert.equal(
    (
      await alice.request(
        "/streams/" + streamA + "/chat?after=" + history[0].seq,
      )
    ).data.messages.length,
    1,
  );
  assert.equal(
    (
      await alice.request(
        "/streams/" + streamA + "/chat?before=" + history[1].seq,
      )
    ).data.messages.length,
    1,
  );
  const reconnect = await connect(b.origin, bob);
  const joined = await emit(reconnect, "join", { streamId: streamA });
  assert.equal(joined.data.messages.length, 2);
  check("durable ordered chat, cursor pagination and reconnect catch-up");
  const duplicateTab = await connect(a.origin, alice);
  await emit(duplicateTab, "join", { streamId: streamA });
  await emit(socketA, "heartbeat", { streamId: streamA, playing: true });
  await emit(duplicateTab, "heartbeat", { streamId: streamA, playing: true });
  assert.equal(await presenceCount(a.r, streamA), 1);
  await emit(socketB, "heartbeat", { streamId: streamA, playing: true });
  assert.equal(await presenceCount(a.r, streamA), 2);
  await emit(socketA, "heartbeat", { streamId: streamA, playing: false });
  assert.equal(await presenceCount(a.r, streamA), 2);
  duplicateTab.disconnect();
  await eventually(async () => (await presenceCount(a.r, streamA)) === 1);
  await a.r.redis.zAdd(presenceKey(streamA), {
    score: Date.now() - 1,
    value: "stale-session:test",
  });
  assert.equal(await presenceCount(a.r, streamA), 1);
  socketB.disconnect();
  await eventually(async () => (await presenceCount(a.r, streamA)) === 0);
  assert.ok(
    (await a.r.redis.ttl(presenceKey(streamA))) <= c.PRESENCE_TTL_SECONDS * 2,
  );
  check(
    "active leases, duplicate-tab deduplication, pause, disconnect and stale-presence expiry",
  );
  const remoteAlice = await connect(b.origin, alice);
  assert.equal((await alice.request("/auth/logout", "POST")).status, 200);
  await eventually(() => !socketA.connected && !remoteAlice.connected);
  assert.equal((await alice.request("/studio/streams")).status, 401);
  check(
    "logout revokes server session and disconnects associated chat sockets",
  );
  // Redis failure must reject writes explicitly; durable history is still queryable.
  await b.r.redis.close();
  const degraded = await emit(reconnect, "message", {
    streamId: streamA,
    content: "Must not silently succeed",
  });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.error.code, "REDIS_UNAVAILABLE");
  assert.equal(
    (await bob.request("/streams/" + streamA + "/chat")).status,
    200,
  );
  await b.r.redis.connect();
  check(
    "Redis failure fails closed for writes while PostgreSQL history remains readable",
  );
  const before = (await a.r.db.query("SELECT count(*) FROM chat_messages"))
    .rows[0].count;
  const temporary = new Pool({ ...dbConfig, database });
  assert.equal(
    (await temporary.query("SELECT count(*) FROM chat_messages")).rows[0].count,
    before,
  );
  await temporary.end();
  check("durable records survive independent database connection recreation");
  assert.equal(
    (await bob.request("/studio/streams/" + streamB + "/end", "POST")).status,
    200,
  );
  assert.equal(
    (await bob.request("/studio/streams/" + streamB + "/publishing", "POST"))
      .status,
    409,
  );
  check("ending a stream revokes publishing and prohibits reuse");
  await a.r.redis.del("rate:" + digest("login-ip:127.0.0.1"));
  const limited = await start({ AUTH_RATE_LIMIT: 2 });
  const limitedBrowser = browser(limited.origin);
  await limitedBrowser.request("/auth/me");
  const invalid = {
    identifier: "not-an-account-" + suffix,
    password: "invalid",
  };
  assert.equal(
    (await limitedBrowser.request("/auth/login", "POST", invalid)).status,
    401,
  );
  assert.equal(
    (await limitedBrowser.request("/auth/login", "POST", invalid)).status,
    401,
  );
  assert.equal(
    (await limitedBrowser.request("/auth/login", "POST", invalid)).status,
    429,
  );
  check(
    "shared Redis login rate limits reject excessive authentication attempts",
  );

  console.log(
    "Platform integration complete: " +
      checks +
      " named checks passed on an isolated migrated database.",
  );
} finally {
  for (const socket of sockets) socket.disconnect();
  for (const { io } of servers)
    await new Promise((resolve) => io.close(resolve));
  for (const r of resources) await r.close();
  await admin.query('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
  await admin.end();
}
