// One shared actual-service topology, four sequential independent recovery trials.
if (process.argv.includes("--interactive")) {
  process.env.OBS_INTERVAL_MS ??= "4000";
  process.env.OBS_TIMEOUT_MS ??= "3000";
  process.env.OBS_STALE_MS ??= "20000";
  process.env.HEALER_PROBE_TIMEOUT_MS ??= "3000";
}
process.argv.push("--lightweight");
await import("./four-scenario-live.mjs");
