import { defineConfig, loadEnv, type ProxyOptions } from "vite";
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
  const media = z
    .object({
      MEDIA_HLS_PROXY_TARGET: z.url(),
      MEDIA_PUBLIC_HLS_BASE_URL: z.union([
        z.string().regex(/^\/[a-zA-Z0-9/_-]+$/),
        z.url().refine((v) => {
          const u = new URL(v);
          return (
            ["http:", "https:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash
          );
        }),
      ]),
    })
    .parse(env);
  const mediaProxy: Record<string, ProxyOptions> = {};
  if (media.MEDIA_PUBLIC_HLS_BASE_URL.startsWith("/")) {
    mediaProxy[media.MEDIA_PUBLIC_HLS_BASE_URL] = {
      target: media.MEDIA_HLS_PROXY_TARGET,
      changeOrigin: true,
      rewrite: (path) => path.slice(media.MEDIA_PUBLIC_HLS_BASE_URL.length),
      configure: (proxy) => {
        proxy.on("proxyRes", (response) => {
          const location = response.headers.location;
          if (location?.startsWith("/") && !location.startsWith("//"))
            response.headers.location =
              media.MEDIA_PUBLIC_HLS_BASE_URL + location;
        });
      },
    };
  }
  return {
    plugins: [react(), tailwindcss()],
    envDir: "../..",
    server: {
      host: config.WEB_HOST,
      port: config.WEB_PORT,
      strictPort: true,
      proxy: {
        "/api": { target: config.API_PROXY_TARGET, changeOrigin: true },
        ...mediaProxy,
      },
    },
  };
});
