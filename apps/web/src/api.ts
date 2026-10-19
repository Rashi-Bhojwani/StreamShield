import {
  healthSchema,
  systemInfoSchema,
  streamListSchema,
  streamSchema,
} from "@streamshield/shared";
import { config } from "./config";
import type { z } from "zod";

export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(config.VITE_API_TIMEOUT_MS);
  const response = await fetch(
    `${config.VITE_API_BASE_URL.replace(/\/$/, "")}${path}`,
    {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
  return schema.parse(await response.json());
}
export async function fetchFoundation(signal?: AbortSignal) {
  const [health, info] = await Promise.all([
    request("/health/ready", healthSchema, signal),
    request("/system/info", systemInfoSchema, signal),
  ]);
  if (health.status !== "ready") throw new Error("API is not ready");
  return { health, info };
}

export async function fetchStreams(
  signal?: AbortSignal,
  search = "",
  offset = 0,
) {
  return request(
    "/streams?q=" + encodeURIComponent(search) + "&offset=" + offset,
    streamListSchema,
    signal,
  );
}
export async function fetchStream(id: string, signal?: AbortSignal) {
  return request("/streams/" + encodeURIComponent(id), streamSchema, signal);
}
