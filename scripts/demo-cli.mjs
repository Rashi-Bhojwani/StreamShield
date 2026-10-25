import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { demoComposeArgs } from "../infrastructure/demo/compose.mjs";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
export function operator(body) {
  return JSON.parse(
    execFileSync(
      "docker",
      [
        ...demoComposeArgs,
        "exec",
        "-T",
        "api-2",
        "node",
        "--import",
        "tsx",
        "scripts/demo-operator.mjs",
      ],
      {
        input: JSON.stringify(body),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      },
    ),
  );
}
export function savePrivate(path, value) {
  mkdirSync(".local/demo", { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
export function provisioning(p) {
  const env = parseEnv(readFileSync(".env", "utf8"));
  return {
    ...p,
    server: env.MEDIA_RTMP_PUBLIC_URL,
    streamKey: p.path + "?user=" + p.user + "&pass=" + p.key,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, arg, ...flags] = process.argv.slice(2);
  if (action === "up") {
    execFileSync("docker", [...demoComposeArgs, "up", "--build", "--wait"], {
      stdio: "inherit",
    });
    const result = operator({ action: "seed" });
    for (const p of result.created)
      savePrivate(`.local/demo/streamer-${p.slot}.json`, provisioning(p));
    console.log(
      "Three-channel topology ready. Private credentials are under .local/demo/streamer-N.json.",
    );
  } else if (action === "seed") {
    const result = operator({ action: "seed" });
    for (const p of result.created)
      savePrivate(`.local/demo/streamer-${p.slot}.json`, provisioning(p));
    console.log(
      `Idempotent seed complete; ${result.created.length} new identities. Existing data preserved.`,
    );
  } else if (action === "admin") {
    const { ticket } = operator({ action: "admin" }),
      env = parseEnv(readFileSync(".env", "utf8")),
      origin = new URL(env.E2E_BASE_URL).origin;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
      throw Error("Administrator browser must be loopback");
    console.log(
      `Private, one use, expires in 90 seconds:\n${origin}/local-access#ticket=${ticket}`,
    );
  } else if (action === "provision") {
    const slot = Number(arg);
    if (![1, 2, 3].includes(slot)) throw Error("Choose streamer 1, 2 or 3");
    const path = `.local/demo/streamer-${slot}.json`;
    if (flags.includes("--rotate"))
      savePrivate(path, provisioning(operator({ action: "rotate", slot })));
    const p = provisioning(JSON.parse(readFileSync(path, "utf8")));
    savePrivate(path, p);
    console.log(
      `PRIVATE: share only with Streamer ${slot}'s operator.\nServer: ${p.server}\nStream Key: ${p.streamKey}\nStored in ${path}`,
    );
  } else
    throw Error(
      "Use demo:up, demo:seed, demo:admin or demo:provision -- 1 [--rotate]",
    );
}
