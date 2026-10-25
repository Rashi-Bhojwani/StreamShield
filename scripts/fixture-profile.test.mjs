import { expect, it } from "vitest";
import { fixtureProfile, demoBackupEdge } from "./fixture-profile.mjs";

it("preserves the optional full VFS guard and separate evidence namespace", () => {
  const full = fixtureProfile([]),
    light = fixtureProfile(["--lightweight"]);
  expect(full.minimumGB("vfs")).toBe(8);
  expect(light.minimumGB("vfs")).toBe(4);
  expect(full.minimumGB("overlay2")).toBe(4);
  expect(light.crashOnly).toBe(false);
  expect(light.compact).toBe(true);
  expect(light.output).not.toBe(full.output);
  expect(light.label).not.toBe(full.label);
});
it("sets a real Nginx backup only for the exact generated peer and fails closed on drift", () => {
  const config = "server edge-1:8080 resolve; server edge-2:8080 resolve;";
  expect(demoBackupEdge(config, "edge-2", 8080)).toBe(
    "server edge-1:8080 resolve; server edge-2:8080 backup resolve;",
  );
  expect(() => demoBackupEdge(config, "missing", 8080)).toThrow();
  expect(() => demoBackupEdge(config + config, "edge-2", 8080)).toThrow();
});
it("cannot silently apply compact infrastructure to the full runner or interactive mode to two faults", () => {
  expect(fixtureProfile([]).compact).toBe(false);
  expect(() => fixtureProfile(["--interactive"])).toThrow(
    "invalid_demo_profile",
  );
  expect(() => fixtureProfile(["--lightweight", "--only-crashes"])).toThrow(
    "invalid_demo_profile",
  );
  expect(() => fixtureProfile(["--smoke"])).toThrow("invalid_demo_profile");
});
