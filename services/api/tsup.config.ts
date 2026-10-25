import { defineConfig } from "tsup";
export default defineConfig({
  entry: [
    "src/server.ts",
    "src/monitoring/observer.ts",
    "src/healing/server.ts",
    "src/chaos/server.ts",
    "src/chaos/adapter.ts",
    "src/healing/adapter-server.ts",
    "src/healing/dependency-demo.ts",
  ],
  format: ["esm"],
  clean: true,
  noExternal: ["@streamshield/shared"],
});
