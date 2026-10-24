// One shared actual-service topology, four sequential independent recovery trials.
process.argv.push("--lightweight");
await import("./four-scenario-live.mjs");
