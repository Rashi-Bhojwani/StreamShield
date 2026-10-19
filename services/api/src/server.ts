import pino from "pino";
import { parseConfig } from "./config.js";
import { createApp } from "./app.js";
import { parsePlatformConfig } from "./platform/config.js";
import { createResources } from "./platform/resources.js";
import { createPlatform } from "./platform/routes.js";
import { createMediaAuth } from "./platform/media-auth.js";
import { createRealtime } from "./platform/realtime.js";
async function main() {
  const config = parseConfig(process.env),
    c = parsePlatformConfig(process.env);
  const logger = pino({
    level: config.LOG_LEVEL,
    base: { instanceId: config.API_INSTANCE_ID || "api" },
  });
  const r = createResources(c, logger);
  try {
    await r.start();
  } catch {
    await r.close();
    throw new Error("Dependency startup failed");
  }
  const platform = await createPlatform(r, c, config, logger);
  const lifecycle = { ready: false };
  const app = createApp(config, lifecycle, logger, undefined, platform);
  const server = app.listen(config.API_PORT, config.API_HOST, () => {
    lifecycle.ready = true;
    logger.info({ port: config.API_PORT }, "Platform API listening");
  });
  const io = createRealtime(server, r, c, config, platform);
  const auth = createMediaAuth(
    r,
    c,
    config,
    {
      user: process.env.MEDIA_PUBLISH_USER || "",
      password: process.env.MEDIA_PUBLISH_PASSWORD || "",
    },
    async () => ({
      instanceId: config.API_INSTANCE_ID || "api",
      ready: lifecycle.ready && (await platform.ready()),
      socketIds: [...io.sockets.sockets.keys()],
    }),
  );
  const internal = auth.listen(c.API_INTERNAL_PORT, c.API_INTERNAL_HOST);
  for (const current of [server, internal]) {
    current.requestTimeout = config.REQUEST_TIMEOUT_MS;
    current.headersTimeout = config.REQUEST_TIMEOUT_MS;
    current.on("error", (error) => {
      logger.fatal({ errorType: error.name }, "Listener failed");
      process.exitCode = 1;
    });
  }
  let draining = false;
  const shutdown = async (signal: string) => {
    if (draining) return;
    draining = true;
    lifecycle.ready = false;
    logger.info({ signal }, "Draining platform");
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      internal.closeAllConnections();
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => internal.close(() => resolve()));
    await r.close();
    clearTimeout(deadline);
    logger.info("Platform stopped");
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
main().catch(() => {
  pino().fatal(
    "Platform startup failed; verify validated configuration and dependency readiness. No credentials logged.",
  );
  process.exitCode = 1;
});
