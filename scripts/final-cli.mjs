// final:up / final:status / final:demo. Local loopback development only.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const node = process.execPath;
const run = (args, opts = {}) =>
  execFileSync(node, args, { stdio: "inherit", ...opts });
const command = process.argv[2];
if (command === "up") {
  // Never removes volumes; setup is idempotent and keeps existing secrets.
  run([
    "scripts/setup-dynamic.mjs",
    "--enable-local-chaos",
    ...process.argv.slice(3),
  ]);
  run(["infrastructure/dynamic/compose.mjs", "up", "--build", "--wait"]);
  // The spare API exists but stays stopped; only the Healer's scale-out starts it.
  run([
    "infrastructure/dynamic/compose.mjs",
    "--profile",
    "spare",
    "create",
    "api-3",
  ]);
  run(["scripts/chaos-probe.mjs"]);
  console.log(
    "\nReady. Presentation: http://127.0.0.1:" +
      (process.env.WEB_PORT || 5173) +
      "/control/presentation  ·  terminal proof: npm run final:watch",
  );
} else if (command === "status") {
  run(["infrastructure/dynamic/compose.mjs", "ps"]);
  run(["scripts/final-watch.mjs", "--once"]);
  run(["scripts/chaos-probe.mjs"]);
} else if (command === "demo") {
  if (!existsSync(".env")) throw Error("Run npm run final:up first.");
  process.loadEnvFile(".env");
  const base = process.env.E2E_BASE_URL || "http://127.0.0.1:5173";
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
    throw Error("final:demo only publishes to the local loopback deployment.");
  const jar = new Map();
  const call = async (path, { method = "GET", body, csrf } = {}) => {
    const r = await fetch(base + "/api/v1" + path, {
      method,
      headers: {
        Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
        Origin: new URL(base).origin,
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(";")[0];
      jar.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1));
    }
    const json = await r.json().catch(() => null);
    if (!r.ok) throw Error(path + " -> HTTP " + r.status);
    return json;
  };
  // A disposable demo broadcaster owned by this local deployment.
  const name = "demo_" + randomUUID().slice(0, 8);
  const password = randomBytes(12).toString("base64url") + "A1";
  let csrf = (await call("/auth/me")).csrf;
  await call("/auth/register", {
    method: "POST",
    csrf,
    body: { username: name, email: name + "@example.test", password },
  });
  csrf = (await call("/auth/me")).csrf;
  await call("/channels", {
    method: "POST",
    csrf,
    body: {
      slug: name.replace("_", "-"),
      displayName: "Demo test pattern",
      description: "Bounded 10-minute test publisher",
    },
  });
  const channel = (await call("/studio/channel")).channel;
  const stream = await call("/studio/streams", {
    method: "POST",
    csrf,
    body: {
      channelId: channel.id,
      title: "Self-healing demo (test pattern)",
      description: "Bounded 10-minute FFmpeg source",
    },
  });
  const key = await call("/studio/streams/" + stream.id + "/publishing", {
    method: "POST",
    csrf,
  });
  console.log(
    `Publishing a bounded 10-minute test pattern as ${name} (password ${password}, local only).\n` +
      `Watch:        ${base}/watch/${stream.id}\nPresentation: ${base}/control/presentation\n` +
      "Ctrl+C stops the publisher.",
  );
  const child = spawn(node, ["scripts/test-publisher.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      MEDIA_STREAM_PATH: key.path,
      MEDIA_PUBLISH_USER: key.user,
      MEDIA_PUBLISH_PASSWORD: key.key,
      TEST_PUBLISH_DURATION_SECONDS: "600",
    },
  });
  child.on("exit", (code) => (process.exitCode = code ?? 0));
} else {
  console.error("Usage: node scripts/final-cli.mjs up|status|demo");
  process.exitCode = 1;
}
