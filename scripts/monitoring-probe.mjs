import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const args = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  ".local/resilience/compose.yml",
  "-f",
  ".local/monitoring/compose.yml",
];
const code = `const deadline=AbortSignal.timeout(2000);const [o,p]=await Promise.all([fetch(process.env.OBS_URL+'/snapshot',{headers:{Authorization:'Bearer '+process.env.OBS_SECRET},signal:deadline}),fetch(process.env.PROMETHEUS_URL+'/api/v1/targets',{signal:deadline})]);if(!o.ok||!p.ok)throw new Error('Private telemetry unavailable');const snapshot=await o.json(),prometheus=await p.json();const targets=prometheus.data.activeTargets;console.log(JSON.stringify({ready:!snapshot.stale&&snapshot.persistence&&snapshot.components.length===14&&snapshot.components.every(c=>c.state==='HEALTHY')&&targets.length===12&&targets.every(t=>t.health==='up'),observedAt:snapshot.observedAt,healthyComponents:snapshot.components.filter(c=>c.state==='HEALTHY').length,monitoredComponents:snapshot.components.length,scrapeTargets:targets.length,healthyScrapes:targets.filter(t=>t.health==='up').length,mediaPathsSampled:snapshot.media.length}));`;
let last = { ready: false };
const deadline = performance.now() + 45000;
while (performance.now() < deadline) {
  try {
    last = JSON.parse(
      execFileSync(
        "docker",
        [
          ...args,
          "exec",
          "-T",
          "api-2",
          "node",
          "--input-type=module",
          "-e",
          code,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
      ),
    );
    if (last.ready) {
      console.log(JSON.stringify(last));
      process.exit(0);
    }
  } catch {
    /* Bounded startup retries. Never print credential-bearing diagnostics. */
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.error(
  "Monitoring readiness not verified within 45 seconds. Inspect selected service logs without dumping private configs.",
);
console.error(JSON.stringify(last));
process.exitCode = 1;
