import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
if (existsSync(".env")) process.loadEnvFile(".env");
const value = (k) => {
  if (!process.env[k]) throw new Error("Missing " + k);
  return process.env[k];
};
try {
  await runner({
    databaseUrl: {
      host: value("POSTGRES_HOST"),
      port: Number(value("POSTGRES_PORT")),
      database: value("POSTGRES_DB"),
      user: value("POSTGRES_USER"),
      password: value("POSTGRES_PASSWORD"),
      connectionTimeoutMillis: Number(value("DEPENDENCY_TIMEOUT_MS")),
    },
    dir: "migrations",
    ignorePattern: "^platform[.]sql$",
    direction: "up",
    migrationsTable: "schema_migrations",
    count: Infinity,
    checkOrder: true,
    log: () => {},
  });
  console.log("Database migrations applied without resetting existing data.");
} catch (error) {
  console.error(
    "Migration failed: " +
      String(error?.message || "Unknown error").replaceAll(
        value("POSTGRES_PASSWORD"),
        "[redacted]",
      ),
  );
  process.exitCode = 1;
}
