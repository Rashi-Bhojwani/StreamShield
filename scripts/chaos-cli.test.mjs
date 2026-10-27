import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
const launch = (...args) =>
  spawnSync(process.execPath, ["scripts/chaos.mjs", ...args], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, PATH: "" },
  });
it("provides help with no Docker access and no implicit fault execution", () => {
  for (const args of [[], ["--help"]]) {
    const result = launch(...args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--verify");
    expect(result.stdout).toContain(
      "No arbitrary host, project or service target",
    );
    expect(result.stdout).not.toContain('"stage":"start:');
  }
});
it.each([
  ["--verify", "--target", "streamshield-main"],
  ["--interactive", "--verify"],
  ["--unknown"],
])(
  "rejects unsupported or ambiguous arguments before touching Docker: %j",
  (...args) => {
    const result = launch(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Arbitrary targets are not supported");
    expect(result.stdout).toBe("");
  },
);
