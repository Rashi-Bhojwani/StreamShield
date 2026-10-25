import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import {
  fixtureSourcePath,
  linkFixtureDependencies,
  prepareFixtureWorkspace,
  crashTestSelection,
} from "./fixture-workspace.mjs";
it("uses an absolute ordinary Windows junction without copying dependencies", () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-junction-"));
  try {
    mkdirSync(join(dir, "node_modules"));
    const link = vi.fn();
    expect(
      linkFixtureDependencies(dir, join(dir, "fixture"), "win32", link),
    ).toEqual({ type: "junction", copiedDependencyFiles: 0 });
    expect(link).toHaveBeenCalledWith(
      resolve(dir, "node_modules"),
      join(dir, "fixture", "node_modules"),
      "junction",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it.each([
  ".env",
  ".env.local",
  "services/api/.env.production",
  ".local/config.yml",
  "node_modules/pkg/x.js",
  "../escape",
  "E:\\private\\file",
  "scripts/../../secret",
  "docs/image.png",
])("does not copy sensitive or unnecessary path %s", (name) =>
  expect(fixtureSourcePath(name)).toBe(false),
);
it("copies dirty runtime files without tar, resolves installed modules, and never removes original dependencies", () => {
  const parent = mkdtempSync(join(tmpdir(), "ss-source-")),
    root = join(parent, "repo"),
    fixture = join(parent, "fixture");
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "node_modules", "fixture-package"), {
      recursive: true,
    });
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(root, "scripts", "config.mjs"),
      'export default "before";',
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "package.json", "scripts/config.mjs"], {
      cwd: root,
    });
    writeFileSync(
      join(root, "scripts", "config.mjs"),
      'export default "user-edit";',
    );
    writeFileSync(join(root, ".env.local"), "NEVER_COPY=secret");
    writeFileSync(
      join(root, "node_modules", "fixture-package", "package.json"),
      '{"type":"module","exports":"./index.js"}',
    );
    writeFileSync(
      join(root, "node_modules", "fixture-package", "index.js"),
      "export default 42;",
    );
    const report = prepareFixtureWorkspace(root, fixture);
    expect(report.archiveUsed).toBe(false);
    expect(report.copiedDependencyFiles).toBe(0);
    expect(
      readFileSync(join(fixture, "scripts", "config.mjs"), "utf8"),
    ).toContain("user-edit");
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import value from 'fixture-package'; console.log(value)",
        ],
        { cwd: fixture, encoding: "utf8" },
      ).trim(),
    ).toBe("42");
    rmSync(fixture, { recursive: true, force: true });
    expect(
      readFileSync(
        join(root, "node_modules", "fixture-package", "index.js"),
        "utf8",
      ),
    ).toContain("42");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toContain(
      "NEVER_COPY",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
it("selects only the two requested faults, including independent single-scenario runs", () => {
  expect(crashTestSelection([])).toEqual(["crash-api", "crash-video-gateway"]);
  expect(crashTestSelection(["--scenario", "crash-api"])).toEqual([
    "crash-api",
  ]);
  for (const id of ["crash-edge", "network-timeout", "redis", undefined])
    expect(() => crashTestSelection(["--scenario", id])).toThrow();
});
it("generates portable staged startup code without running faults or a shell", async () => {
  const { fixtureSupervisor } = await import("./fixture-supervisor.mjs");
  const dir = mkdtempSync(join(tmpdir(), "ss-supervisor-"));
  try {
    const file = join(dir, "supervisor.mjs");
    writeFileSync(
      file,
      fixtureSupervisor({
        roles: ["observer", "healer"],
        jobs: ["migrate"],
        staged: true,
      }),
    );
    execFileSync(process.execPath, ["--check", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("makes only disposable compiled assets readable by the gateway worker", async () => {
  const { readableFixtureBuild } = await import("./fixture-workspace.mjs");
  const parent = mkdtempSync(join(tmpdir(), "ss-build-mode-"));
  try {
    const dist = join(parent, "apps", "web", "dist");
    mkdirSync(dist, { recursive: true, mode: 0o700 });
    writeFileSync(join(dist, "index.html"), "<html>fixture</html>", {
      mode: 0o600,
    });
    writeFileSync(join(parent, ".env"), "PRIVATE=untouched", { mode: 0o600 });
    readableFixtureBuild(parent);
    expect(readFileSync(join(parent, ".env"), "utf8")).toContain("untouched");
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain("fixture");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
