import { Pool } from "pg";
import { createClient } from "redis";
import type { Logger } from "pino";
import type { PlatformConfig } from "./config.js";
export function createResources(c: PlatformConfig, logger: Logger) {
  const db = new Pool({
    host: c.POSTGRES_HOST,
    port: c.POSTGRES_PORT,
    database: c.POSTGRES_DB,
    user: c.POSTGRES_USER,
    password: c.POSTGRES_PASSWORD,
    max: c.DB_POOL_MAX,
    connectionTimeoutMillis: c.DEPENDENCY_TIMEOUT_MS,
    idleTimeoutMillis: c.DEPENDENCY_TIMEOUT_MS,
    statement_timeout: c.DEPENDENCY_TIMEOUT_MS,
    query_timeout: c.DEPENDENCY_TIMEOUT_MS,
  });
  db.on("error", () =>
    logger.error({ dependency: "postgres" }, "Database connection lost"),
  );
  const makeRedis = () => {
    const client = createClient({
      password: c.REDIS_PASSWORD,
      database: c.REDIS_DB,
      commandOptions: { timeout: c.DEPENDENCY_TIMEOUT_MS },
      disableOfflineQueue: true,
      commandsQueueMaxLength: c.WRITE_RATE_LIMIT * 10,
      socket: {
        host: c.REDIS_HOST,
        port: c.REDIS_PORT,
        connectTimeout: c.DEPENDENCY_TIMEOUT_MS,
        reconnectStrategy: (retries) =>
          retries >= c.REDIS_RECONNECT_LIMIT
            ? false
            : Math.min(100 * 2 ** retries, c.DEPENDENCY_TIMEOUT_MS),
      },
    });
    client.on("error", () =>
      logger.warn({ dependency: "redis" }, "Redis operation/connection failed"),
    );
    client.on("ready", () =>
      logger.info({ dependency: "redis" }, "Redis connected"),
    );
    return client;
  };
  const redis = makeRedis(),
    pub = makeRedis(),
    sub = makeRedis();
  return {
    db,
    redis,
    pub,
    sub,
    async start() {
      await db.query("SELECT 1");
      await Promise.all([redis.connect(), pub.connect(), sub.connect()]);
    },
    async close() {
      await Promise.allSettled([
        db.end(),
        ...[redis, pub, sub].map((client) =>
          client.isOpen ? client.close() : Promise.resolve(),
        ),
      ]);
    },
  };
}
export type Resources = ReturnType<typeof createResources>;
