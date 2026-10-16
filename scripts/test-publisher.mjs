import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mediaEnv } from "./media-env.mjs";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile(".env");
const c = mediaEnv(process.env);
const target = new URL(
  c.MEDIA_RTMP_BASE_URL.replace(/\/$/, "") + "/" + c.MEDIA_STREAM_PATH,
);
target.searchParams.set("user", c.MEDIA_PUBLISH_USER);
target.searchParams.set("pass", c.MEDIA_PUBLISH_PASSWORD);
const args = [
  "-hide_banner",
  "-loglevel",
  "quiet",
  "-nostdin",
  "-re",
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=${c.TEST_PUBLISH_SIZE}:rate=${c.TEST_PUBLISH_FPS}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=${c.TEST_PUBLISH_TONE_HZ}:sample_rate=48000`,
  "-t",
  String(c.TEST_PUBLISH_DURATION_SECONDS),
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-tune",
  "zerolatency",
  "-pix_fmt",
  "yuv420p",
  "-profile:v",
  "baseline",
  "-g",
  String(c.TEST_PUBLISH_FPS * c.TEST_PUBLISH_KEYFRAME_SECONDS),
  "-keyint_min",
  String(c.TEST_PUBLISH_FPS * c.TEST_PUBLISH_KEYFRAME_SECONDS),
  "-sc_threshold",
  "0",
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  "-f",
  "flv",
  target.toString(),
];
console.log(
  `Publishing a synthetic test pattern with tone for at most ${c.TEST_PUBLISH_DURATION_SECONDS}s. This is real encoded media, not viewer telemetry. Ctrl+C stops it.`,
);
// The destination contains local credentials. Never echo arguments or FFmpeg errors containing URLs.
const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, {
  stdio: ["ignore", "ignore", "ignore"],
});
let interrupted = false;
let forced;
const finish = () => {
  clearTimeout(wallDeadline);
  if (forced) clearTimeout(forced);
  if (process.connected) process.disconnect();
};
const stop = (signal = "SIGTERM") => {
  if (interrupted) return;
  interrupted = true;
  child.kill(signal);
  forced = setTimeout(() => child.kill("SIGKILL"), c.TEST_PUBLISH_GRACE_MS);
};
const wallDeadline = setTimeout(
  () => stop(),
  c.TEST_PUBLISH_DURATION_SECONDS * 1000 + c.TEST_PUBLISH_GRACE_MS,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => stop(signal));
// IPC makes test-owned publisher shutdown portable to Windows, where killing a
// wrapper process with SIGTERM does not run POSIX-style shutdown handlers.
process.on("message", (message) => {
  if (message === "stop") stop();
});
child.on("error", () => {
  finish();
  console.error(
    "FFmpeg could not start. Install FFmpeg or set FFMPEG_PATH to its executable.",
  );
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  finish();
  if (code && !signal && !interrupted)
    console.error(
      "Publisher failed. Check media service, credentials, path and competing publishers; destination is redacted.",
    );
  process.exitCode = interrupted || signal ? 0 : (code ?? 1);
});
