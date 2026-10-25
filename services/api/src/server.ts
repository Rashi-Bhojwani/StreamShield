import { createServer } from "node:http";
import { startupStep, startupDiagnostic, listenReady } from "./startup.js";
import { startDiscoveryObserver } from "./platform/discovery.js";
import { attachMonitoring } from "./monitoring/realtime.js";
import { createMetrics } from "./monitoring/metrics.js";
import pino from "pino";
import { parseConfig } from "./config.js";
import { createApp } from "./app.js";
import { parsePlatformConfig } from "./platform/config.js";
import { createResources } from "./platform/resources.js";
import { createPlatform } from "./platform/routes.js";
import { createMediaAuth } from "./platform/media-auth.js";
import { createRealtime } from "./platform/realtime.js";
async function main() {
  const config = await startupStep("api_configuration", () =>
      parseConfig(process.env),
    ),
    c = await startupStep("platform_configuration", () =>
      parsePlatformConfig(process.env),
    );
  const logger = pino({
    level: config.LOG_LEVEL,
    base: { instanceId: config.API_INSTANCE_ID || "api" },
  });
  const r = await startupStep("resources", () => createResources(c, logger));
  const cleanup: (() => Promise<unknown> | void)[] = [() => r.close()];
  try {
    await r.start();
    const platform = await startupStep("platform_routes", () =>
      createPlatform(r, c, config, logger),
    );
    const lifecycle = { ready: false };
    const metrics = createMetrics();
    const app = createApp(
      config,
      lifecycle,
      logger,
      undefined,
      platform,
      metrics,
    );
    const server = createServer(app);
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const io = await startupStep("realtime", () =>
      createRealtime(server, r, c, config, platform, metrics),
    );
    cleanup.push(
      () => new Promise<void>((resolve) => io.close(() => resolve())),
    );
    const stopDiscovery = c.DYNAMIC_ENABLED
      ? startDiscoveryObserver(r, platform.catalog, io)
      : () => {};
    cleanup.push(stopDiscovery);
    if (process.env.OBS_URL) attachMonitoring(io, r);
    io.on("connection", (socket) => {
      metrics.sockets.inc();
      socket.once("disconnect", () => metrics.sockets.dec());
    });
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
      metrics,
    );
    const internal = createServer(auth);
    cleanup.push(
      () => new Promise<void>((resolve) => internal.close(() => resolve())),
    );
    await startupStep("public_listener", () =>
      listenReady(server, config.API_PORT, config.API_HOST),
    );
    await startupStep("media_auth_listener", () =>
      listenReady(internal, c.API_INTERNAL_PORT, c.API_INTERNAL_HOST),
    );
    lifecycle.ready = true;
    logger.info({ port: config.API_PORT }, "Platform API listening");
    for (const current of [server, internal]) {
      current.requestTimeout = config.REQUEST_TIMEOUT_MS;
      current.headersTimeout = config.REQUEST_TIMEOUT_MS;
      current.on("error", (error) => {
        lifecycle.ready = false;
        logger.fatal(startupDiagnostic(error, process.env), "Listener failed");
        process.exitCode = 1;
      });
    }
    let draining = false;
    const shutdown = async (signal: string) => {
      if (draining) return;
      draining = true;
      lifecycle.ready = false;
      stopDiscovery();
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
  } catch (error) {
    // Close partially initialized listeners/clients, retaining the original cause.
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch {
        // Preserve the startup cause; keep closing the remaining owned resources.
      }
    }
    throw error;
  }
}
main().catch((error) => {
  pino().fatal(
    startupDiagnostic(error, process.env),
    "Platform startup failed",
  );
  process.exitCode = 1;
});
