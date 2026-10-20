import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
const components = JSON.parse(
  readFileSync(".local/healing/targets.json", "utf8"),
).length;
const scrapes = parse(
  readFileSync(".local/healing/prometheus.yml", "utf8"),
).scrape_configs.reduce(
  (n, job) =>
    n +
    job.static_configs.reduce((sum, group) => sum + group.targets.length, 0),
  0,
);
const code = `
const headers={Authorization:'Bearer '+process.env.HEALER_SECRET};
let result;
for(let attempt=0;attempt<30;attempt++) {
 try {
  const read=async(url,headers)=>{const r=await fetch(url,{headers,signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('probe_unavailable');return r.json();};
  const [state,snapshot,targets]=await Promise.all([
   read(process.env.HEALER_URL+'/state',headers),
   read(process.env.OBS_URL+'/snapshot',{Authorization:'Bearer '+process.env.OBS_SECRET}),
   read(process.env.PROMETHEUS_URL+'/api/v1/targets')
  ]);
  const active=targets.data.activeTargets;
  result={available:state.available,enabled:state.enabled,leader:state.leader,databaseAvailable:state.databaseAvailable,components:snapshot.components.length,healthy:snapshot.components.filter(c=>c.state==='HEALTHY').length,scrapes:active.length,up:active.filter(t=>t.health==='up').length,circuit:state.circuit.state};
  if(result.available&&result.leader&&result.databaseAvailable&&result.components===${components}&&result.healthy===${components}&&result.scrapes===${scrapes}&&result.up===${scrapes}){console.log(JSON.stringify(result));process.exit(0);}
 }catch{result={available:false,reason:'private_probe_unavailable'};}
 await new Promise(r=>setTimeout(r,2000));
}
console.log(JSON.stringify(result));process.exitCode=1;
`;
execFileSync(
  process.execPath,
  [
    "infrastructure/healing/compose.mjs",
    "exec",
    "-T",
    "api-2",
    "node",
    "--input-type=module",
    "-e",
    code,
  ],
  { stdio: "inherit", timeout: 120000 },
);
