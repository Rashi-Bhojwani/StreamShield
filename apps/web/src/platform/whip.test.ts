import { describe, it, expect } from "vitest";
import { whipResource } from "./whip";
describe("WHIP session boundary", () => {
  const origin = "http://localhost:5173",
    base = "/ingest/s-12345678901234567890123456789012/whip";
  it("accepts only the exact same-origin publishing resource namespace", () => {
    expect(whipResource(base + "/abc", base, origin)).toBe(
      origin + base + "/abc",
    );
    for (const target of [
      "https://evil.example/x",
      "/api/v1/auth/logout",
      "//evil.example/x",
      base + "/abc?secret=x",
      base + "/abc#x",
      base + "/../other",
    ])
      expect(() => whipResource(target, base, origin)).toThrow();
  });
});
