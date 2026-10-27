import { expect, it } from "vitest";
import {
  fixtureProfile,
  demoBackupEdge,
  demoMediaAuthority,
  demoWithoutSpareApi,
} from "./fixture-profile.mjs";

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
it("omits only the unprovisioned spare without commenting out the upstream suffix or changing auth peers", () => {
  const config =
    "upstream apis { server api:4000 resolve; server api-2:4000 resolve;\nserver api-3:4000 resolve max_fails=1 fail_timeout=5s; keepalive 8; }\nupstream auths { server api:4001 resolve; server api-2:4001 resolve; }";
  const compact = demoWithoutSpareApi(config, 4000);
  expect(compact).not.toContain("api-3");
  expect(compact).toContain("keepalive 8; }");
  expect(compact).toContain(
    "server api:4001 resolve; server api-2:4001 resolve;",
  );
  expect(() => demoWithoutSpareApi(config, 4999)).toThrow();
  expect(() => demoWithoutSpareApi(config + config, 4000)).toThrow();
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
it("gates both real video routes without caching authorization, and fails on generated config drift", () => {
  const config =
    "location = /health { return 200; } location ~ ^/(primary|standby)/ { proxy_pass http://edges; }";
  const gate = demoMediaAuthority(config, 4030);
  expect(gate).toContain("auth_request /_demo_media_authority");
  expect(gate).toContain("set $demo_authority http://chaos-controller:4030");
  expect(gate).toContain("X-Media-Authority unavailable always");
  expect(gate).toContain("location = /health { return 200; }");
  expect(() => demoMediaAuthority("wrong", 4030)).toThrow();
  expect(() => demoMediaAuthority(config + config, 4030)).toThrow();
});
