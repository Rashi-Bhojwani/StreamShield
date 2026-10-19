import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/server.ts", "src/monitoring/observer.ts"],
  format: ["esm"],
  clean: true,
  noExternal: ["@streamshield/shared"],
});
