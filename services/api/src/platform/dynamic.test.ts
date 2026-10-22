import { describe, it, expect } from "vitest";
import { nextBroadcastState } from "./dynamic.js";
const base = {
  lifecycle: "ready",
  prior: "PREPARING" as const,
  status: "offline" as const,
  progressed: false,
  recentProgress: false,
  hadMedia: false,
  graceExpired: false,
};
describe("authoritative broadcast lifecycle", () => {
  it("never treats start intent or a manifest without progressing media as LIVE", () => {
    expect(nextBroadcastState(base)).toBe("PREPARING");
    expect(nextBroadcastState({ ...base, status: "live" })).toBe("PUBLISHING");
    expect(
      nextBroadcastState({ ...base, status: "live", progressed: true }),
    ).toBe("LIVE");
  });
  it("requires new evidence once prior media progress expires", () => {
    expect(
      nextBroadcastState({
        ...base,
        status: "live",
        prior: "LIVE",
        hadMedia: true,
        recentProgress: false,
      }),
    ).toBe("RECONNECTING");
    expect(
      nextBroadcastState({
        ...base,
        status: "live",
        prior: "RECONNECTING",
        hadMedia: true,
        progressed: true,
      }),
    ).toBe("LIVE");
  });
  it("has a bounded source-loss grace and terminal ownership-safe ending", () => {
    expect(nextBroadcastState({ ...base, prior: "LIVE", hadMedia: true })).toBe(
      "CONNECTION_LOST",
    );
    expect(
      nextBroadcastState({
        ...base,
        prior: "CONNECTION_LOST",
        hadMedia: true,
        graceExpired: true,
      }),
    ).toBe("ENDED");
    expect(
      nextBroadcastState({
        ...base,
        lifecycle: "ended",
        status: "live",
        progressed: true,
      }),
    ).toBe("ENDED");
  });
  it("does not turn a control outage into verified restoration or a source stop", () => {
    expect(
      nextBroadcastState({ ...base, prior: "LIVE", status: "unavailable" }),
    ).toBe("LIVE");
    expect(
      nextBroadcastState({ ...base, status: "starting", startupExpired: true }),
    ).toBe("FAILED");
  });
});
