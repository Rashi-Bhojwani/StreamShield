// Reuse the exact Phase 4 bounded controls/tests while preserving monitoring overlay configuration.
process.env.STREAMSHIELD_COMPOSE_MODE = "monitoring";
const command = process.argv.splice(2, 1)[0];
if (command === "control") await import("./resilience-control.mjs");
else if (command === "test") await import("./resilience-integration.mjs");
else throw new Error("Unknown monitoring command");
