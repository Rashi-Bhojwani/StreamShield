// Fixed scope: this entry point cannot select edge/network or arbitrary targets.
process.argv.push("--only-crashes");
await import("./four-scenario-live.mjs");
