import { it, expect } from "vitest";
import { parseMonitoring } from "../infrastructure/monitoring/config.mjs";
const env = {
  OBS_SECRET: "a".repeat(43),
  OBS_PG_PASSWORD: "c".repeat(43),
  OBS_DB_PASSWORD: "d".repeat(43),
  OBS_GRAFANA_PASSWORD: "b".repeat(43),
};
it("validates monitoring resource budgets and defaults", () => {
  const c = parseMonitoring(env);
  expect(c.OBS_CONCURRENCY).toBe(4);
  expect(c.OBS_FAILURES).toBe(2);
});
it("rejects short service credentials", () =>
  expect(() => parseMonitoring({ ...env, OBS_SECRET: "password" })).toThrow());
it("rejects deadlines exceeding cycle interval", () =>
  expect(() => parseMonitoring({ ...env, OBS_TIMEOUT_MS: "2000" })).toThrow());
it("rejects stale threshold that cannot accommodate cycles", () =>
  expect(() =>
    parseMonitoring({ ...env, OBS_INTERVAL_MS: "5000", OBS_STALE_MS: "6000" }),
  ).toThrow());
it("rejects duplicate internal ports", () =>
  expect(() =>
    parseMonitoring({ ...env, OBS_NGINX_STATUS_PORT: "4010" }),
  ).toThrow());

it("rejects reusing service secrets", () =>
  expect(() =>
    parseMonitoring({ ...env, OBS_DB_PASSWORD: env.OBS_SECRET }),
  ).toThrow());
it("rejects Grafana host port conflicting with Live", () =>
  expect(() => parseMonitoring({ ...env, WEB_PORT: "3000" })).toThrow());
it("rejects MediaMTX metrics colliding with HLS", () =>
  expect(() => parseMonitoring({ ...env, MEDIA_HLS_PORT: "9998" })).toThrow());
it("rejects Nginx status conflicting with proxy listeners", () =>
  expect(() =>
    parseMonitoring({ ...env, RESILIENCE_HTTP_PORT: "8090" }),
  ).toThrow());
