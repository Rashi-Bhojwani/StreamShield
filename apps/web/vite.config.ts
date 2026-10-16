import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { z } from "zod";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, "../..", ""), ...process.env };
  const config = z
    .object({
      WEB_HOST: z.string().min(1),
      WEB_PORT: z.coerce.number().int().min(1).max(65535),
      API_PROXY_TARGET: z
        .url()
        .refine((v) => ["http:", "https:"].includes(new URL(v).protocol)),
    })
    .parse(env);
  return {
    plugins: [react(), tailwindcss()],
    envDir: "../..",
    server: {
      host: config.WEB_HOST,
      port: config.WEB_PORT,
      strictPort: true,
      proxy: {
        "/api": { target: config.API_PROXY_TARGET, changeOrigin: true },
      },
    },
  };
});
