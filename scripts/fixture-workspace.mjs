import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
const roots = new Set([
  "apps",
  "packages",
  "services",
  "scripts",
  "infrastructure",
  "migrations",
  "tests",
]);
const files = new Set([
  "package.json",
  "package-lock.json",
  "docker-compose.yml",
  ".env.example",
  ".gitignore",
  "tsconfig.json",
  "tsconfig.base.json",
]);
export function fixtureSourcePath(name) {
  const normalized = name.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    isAbsolute(name) ||
    /^[a-z]:/i.test(name) ||
    parts.some(
      (p) =>
        p === ".." ||
        !p ||
        [
          "node_modules",
          ".git",
          ".local",
          "dist",
          "test-results",
          "uploads",
        ].includes(p),
    )
  )
    return false;
  if (
    parts.some(
      (p) => p === ".env" || (p.startsWith(".env.") && p !== ".env.example"),
    )
  )
    return false;
  return (
    roots.has(parts[0]) ||
    files.has(normalized) ||
    /^tsconfig[^/]*\.json$/.test(normalized)
  );
}
export function linkFixtureDependencies(
  root,
  fixture,
  platform = process.platform,
  link = symlinkSync,
) {
  const source = realpathSync(join(root, "node_modules"));
  link(
    source,
    join(fixture, "node_modules"),
    platform === "win32" ? "junction" : "dir",
  );
  return {
    type: platform === "win32" ? "junction" : "dir",
    copiedDependencyFiles: 0,
  };
}
export function prepareFixtureWorkspace(root, fixture) {
  root = resolve(root);
  fixture = resolve(fixture);
  const relation = relative(root, fixture);
  if (!relation || (!relation.startsWith(".." + sep) && !isAbsolute(relation)))
    throw Error("fixture_must_be_outside_repository");
  mkdirSync(fixture, { recursive: true });
  const names = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  let copied = 0;
  for (const name of new Set(names)) {
    if (!fixtureSourcePath(name)) continue;
    const source = join(root, name);
    if (!existsSync(source)) continue; // A user deletion stays deleted in the fixture.
    const info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink())
      throw Error("fixture_source_must_be_regular_file");
    const target = join(fixture, name);
    mkdirSync(dirname(target), { recursive: true });
    for (
      let parent = dirname(target);
      parent !== fixture;
      parent = dirname(parent)
    )
      chmodSync(parent, 0o755);
    copyFileSync(source, target);
    chmodSync(target, 0o644); // Only whitelisted non-secret fixture source, never the original file.
    copied++;
  }
  if (!existsSync(join(fixture, "package.json")))
    throw Error("fixture_package_missing");
  return {
    sourceFiles: copied,
    ...linkFixtureDependencies(root, fixture),
    archiveUsed: false,
  };
}
export function crashTestSelection(args) {
  const allowed = ["crash-api", "crash-video-gateway"];
  const at = args.indexOf("--scenario");
  const selected = at < 0 ? allowed : [args[at + 1]];
  if (selected.some((s) => !allowed.includes(s)))
    throw Error("two_scenario_runner_rejects_other_faults");
  return selected;
}
/** Vite honors the host umask; only disposable public build assets are relaxed
 * so the Nginx worker can read them. Never touch original sources or secrets. */
export function readableFixtureBuild(fixture) {
  const root = join(resolve(fixture), "apps", "web", "dist");
  const visit = (path) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw Error("fixture_build_symlink_not_permitted");
    if (info.isDirectory()) {
      chmodSync(path, 0o755);
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (info.isFile()) chmodSync(path, 0o644);
    else throw Error("fixture_build_regular_files_only");
  };
  visit(root);
}
