// Optional helper for this proxy-managed cloud; normal development uses Compose build.
import { lookup } from "node:dns/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = [
  "build",
  "--build-arg",
  "HTTP_PROXY",
  "--build-arg",
  "HTTPS_PROXY",
  "--build-arg",
  "NO_PROXY",
];
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxy) {
  const hostname = new URL(proxy).hostname;
  const { address } = await lookup(hostname, { family: 4 });
  args.push("--add-host", `${hostname}:${address}`);
}
if (process.env.NODE_EXTRA_CA_CERTS) {
  args.push("--secret", `id=npm_ca,src=${process.env.NODE_EXTRA_CA_CERTS}`);
}
args.push(
  "-t",
  "streamshield-development",
  "-f",
  "infrastructure/docker/development.Dockerfile",
  ".",
);
const child = spawn("docker", args, {
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  stdio: "inherit",
});
child.on("error", () => {
  console.error("Could not start Docker");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
