// Optional VFS-only cloud disk workaround. Normal Docker Desktop/overlay2 needs no flattening.
// Preserve public IMAGE configuration, never container runtime environment/credentials.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const image = process.argv[2];
if (!image || !/^[-a-zA-Z0-9_./:]+$/.test(image))
  throw new Error("Usage: node infrastructure/docker/flatten-image.mjs IMAGE");
const docker = (args, extra = {}) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...extra,
  });
if (docker(["info", "--format", "{{.Driver}}"]).trim() !== "vfs") {
  console.log("Image flattening unnecessary for this Docker storage driver.");
  process.exit(0);
}
const original = JSON.parse(docker(["image", "inspect", image]))[0];
// Already flattened image metadata is idempotent; avoid an unnecessary full copy.
if (original.Config.Labels?.["streamshield.cloud.flattened"] === "true") {
  console.log("VFS image already flattened.");
  process.exit(0);
}
const directory = mkdtempSync(join(tmpdir(), "streamshield-image-"));
let container;
try {
  container = docker(["create", image]).trim();
  docker(["export", "-o", join(directory, "rootfs.tar"), container]);
  docker(["rm", container]);
  container = undefined;
  const c = original.Config,
    changes = [];
  const add = (value) => changes.push("--change", value);
  if (c.WorkingDir) add("WORKDIR " + c.WorkingDir);
  if (c.User) add("USER " + c.User);
  for (const env of c.Env || []) add("ENV " + env);
  if (c.Entrypoint) add("ENTRYPOINT " + JSON.stringify(c.Entrypoint));
  if (c.Cmd) add("CMD " + JSON.stringify(c.Cmd));
  if (c.StopSignal) add("STOPSIGNAL " + c.StopSignal);
  for (const port of Object.keys(c.ExposedPorts || {})) add("EXPOSE " + port);
  for (const [key, value] of Object.entries(c.Labels || {}))
    add("LABEL " + key + "=" + JSON.stringify(value));
  add("LABEL streamshield.cloud.flattened=true");
  docker(["import", ...changes, join(directory, "rootfs.tar"), image]);
  console.log(
    "Verified image filesystem/configuration flattened locally for VFS; upstream image version unchanged.",
  );
  // Removal fails safely when an existing running container still references the old image.
  try {
    docker(["image", "rm", original.Id]);
  } catch {
    console.log(
      "Previous image retained while existing containers still reference it.",
    );
  }
} finally {
  if (container)
    try {
      docker(["rm", container]);
    } catch {
      /* retain original error */
    }
  rmSync(directory, { recursive: true, force: true });
}
