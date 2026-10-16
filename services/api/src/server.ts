import pino from "pino";
import { parseConfig } from "./config.js";
import { createApp } from "./app.js";

async function main() {
  const config = parseConfig(process.env);
  const logger = pino({ level: config.LOG_LEVEL });
  const lifecycle = { ready: false };
  const app = createApp(config, lifecycle, logger);
  const server = app.listen(config.API_PORT, config.API_HOST, () => {
    lifecycle.ready = true;
    logger.info(
      { host: config.API_HOST, port: config.API_PORT },
      "API listening",
    );
  });
  server.requestTimeout = config.REQUEST_TIMEOUT_MS;
  server.headersTimeout = config.REQUEST_TIMEOUT_MS;
  server.on("error", (error) => {
    logger.fatal(
      { errorType: error.name, message: error.message },
      "Server failed",
    );
    process.exitCode = 1;
  });
  let draining = false;
  const shutdown = (signal: string) => {
    if (draining) return;
    draining = true;
    lifecycle.ready = false;
    logger.info({ signal }, "Draining API");
    const deadline = setTimeout(() => {
      logger.error("Shutdown deadline exceeded");
      server.closeAllConnections();
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      logger.info("API stopped");
      process.exitCode = error ? 1 : 0;
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
main().catch((error: unknown) => {
  // Configuration errors name invalid fields, without echoing environment values.
  pino().fatal(
    {
      message: error instanceof Error ? error.message : "Unknown startup error",
    },
    "Startup failed",
  );
  process.exitCode = 1;
});
