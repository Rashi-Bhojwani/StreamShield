import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const choice = process.argv[2] || "all";
if (!["all", "1", "2", "3"].includes(choice))
  throw Error("broadcast:demo -- all|1|2|3");
const slots = choice === "all" ? [1, 2, 3] : [Number(choice)],
  children = [];
for (const slot of slots) {
  const key = JSON.parse(
    readFileSync(`.local/demo/streamer-${slot}.json`, "utf8"),
  );
  const child = spawn(process.execPath, ["scripts/test-publisher.mjs"], {
    env: {
      ...process.env,
      MEDIA_RTMP_BASE_URL: key.server,
      MEDIA_STREAM_PATH: key.path,
      MEDIA_PUBLISH_USER: key.user,
      MEDIA_PUBLISH_PASSWORD: key.key,
      TEST_PUBLISH_SIZE: ["640x360", "480x270", "320x180"][slot - 1],
      TEST_PUBLISH_TONE_HZ: String([440, 660, 880][slot - 1]),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  children.push(child);
  child.on("error", () => {
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    if (code) process.exitCode = 1;
    console.log(`Streamer ${slot} test source stopped.`);
  });
}
const stop = () => {
  for (const child of children)
    if (child.exitCode === null) {
      if (child.connected) child.send("stop");
      else child.kill("SIGTERM");
    }
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
