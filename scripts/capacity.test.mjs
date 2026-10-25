import { describe, it, expect } from "vitest";
import { resourceGuard } from "./capacity/guards.mjs";
import {
  initialMetrics,
  observe,
  validateOwnedTarget,
} from "./capacity/metrics.mjs";
describe("generator admission and measurements", () => {
  it("requires explicit owned-target authorization", () => {
    expect(() => validateOwnedTarget("https://example.com", false)).toThrow();
    expect(validateOwnedTarget("http://localhost:5173", true)).toBe(
      "http://localhost:5173",
    );
  });
  it("refuses an oversized per-host worker before creating any grant", () => {
    expect(() => resourceGuard(50000, "socket")).toThrow();
    expect(() => resourceGuard(13, "browser")).toThrow();
  });
  it("starts with no fabricated activity or latency and counts real histogram observations", () => {
    const m = initialMetrics();
    expect(m.active).toBe(0);
    expect(m.requests).toBe(0);
    expect(m.verifiedBrowsers).toBe(0);
    expect(m.startupMs).toBeNull();
    observe(m.requestHistogram, 80);
    expect(m.requestHistogram.reduce((a, b) => a + b, 0)).toBe(1);
  });
});
