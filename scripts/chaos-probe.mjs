import { execFileSync } from "node:child_process";
const code =
  "const headers={Authorization:'Bearer '+process.env.CHAOS_SECRET};const r=await fetch(process.env.CHAOS_URL+'/state',{headers,signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('chaos');const s=await r.json();console.log(JSON.stringify({available:s.available,enabled:s.enabled,databaseAvailable:s.databaseAvailable,activeId:s.activeId,implemented:s.scenarios.filter(x=>x.supported).length}));if(!s.available||!s.databaseAvailable)process.exitCode=1;";
let ready = false;
for (let i = 0; i < 30; i++) {
  try {
    execFileSync(
      process.execPath,
      [
        "infrastructure/chaos/compose.mjs",
        "exec",
        "-T",
        "api-2",
        "node",
        "--input-type=module",
        "-e",
        code,
      ],
      {
        stdio: i === 29 ? "inherit" : ["ignore", "pipe", "pipe"],
        timeout: 10000,
      },
    );
    ready = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!ready) process.exitCode = 1;
else
  execFileSync(
    process.execPath,
    [
      "infrastructure/chaos/compose.mjs",
      "exec",
      "-T",
      "api-2",
      "node",
      "--input-type=module",
      "-e",
      code,
    ],
    { stdio: "inherit" },
  );
