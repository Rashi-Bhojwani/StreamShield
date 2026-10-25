import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile(".env");
const code =
  "for(const host of process.argv.slice(1)){const r=await fetch('http://'+host+':'+process.env.API_INTERNAL_PORT+'/internal/instance',{headers:{Authorization:'Basic '+Buffer.from('mediamtx:'+process.env.MEDIA_AUTH_SECRET).toString('base64')}});if(!r.ok)process.exitCode=1;else{const v=await r.json();console.log(JSON.stringify({instanceId:v.instanceId,ready:v.ready,socketCount:v.socketIds.length}));}}";
execFileSync(
  "docker",
  [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    ".local/resilience/compose.yml",
    "exec",
    "-T",
    "api-2",
    "node",
    "--input-type=module",
    "-e",
    code,
    process.env.RESILIENCE_API1_HOST,
    process.env.RESILIENCE_API2_HOST,
  ],
  { stdio: "inherit", timeout: Number(process.env.RESILIENCE_TEST_TIMEOUT_MS) },
);
