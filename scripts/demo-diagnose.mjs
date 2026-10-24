// Read-only diagnostics: never starts, restarts, edits or grants access to services.
import { execFileSync } from "node:child_process";
import { dynamicComposeArgs } from "../infrastructure/dynamic/compose.mjs";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 25000,
    maxBuffer: 4 * 1024 * 1024,
  });
const compose = (...args) => docker(...dynamicComposeArgs, ...args);
let config;
try {
  config = JSON.parse(compose("config", "--format", "json"));
} catch {
  console.error(
    "Cannot read the configured dynamic composition. Start Docker Desktop and check existing .local configuration; no setup files were changed.",
  );
  process.exit(1);
}
const configured = { project: config.name, services: {} };
for (const name of [
  "web",
  "api",
  "api-2",
  "api-gateway",
  "observer",
  "healer",
  "chaos-controller",
  "chaos-fault-adapter",
]) {
  const s = config.services[name];
  configured.services[name] = {
    ports: s.ports || [],
    cpuLimit: s.cpus ?? null,
    memoryLimit: s.mem_limit ?? null,
    healthcheck: s.healthcheck
      ? {
          timeout: s.healthcheck.timeout,
          interval: s.healthcheck.interval,
          retries: s.healthcheck.retries,
        }
      : null,
  };
  try {
    const cid = compose("ps", "-aq", name).trim();
    if (!cid) {
      configured.services[name].container = "missing";
      continue;
    }
    const c = JSON.parse(docker("inspect", cid))[0];
    configured.services[name].container = {
      status: c.State.Status,
      health: c.State.Health?.Status || "none",
      oomKilled: c.State.OOMKilled,
      exitCode: c.State.ExitCode,
      startedAt: c.State.StartedAt,
      recentHealth:
        c.State.Health?.Log?.slice(-3).map((x) => ({
          start: x.Start,
          end: x.End,
          exitCode: x.ExitCode,
          exceededTimeout: /timed out|timeout|exceeded/i.test(x.Output),
        })) || [],
    };
  } catch {
    configured.services[name].container = "inspection unavailable";
  }
}
const webPort = config.services.web.ports?.find(
  (p) => p.protocol === "tcp",
)?.published;
configured.browserMonitoringEndpoint = webPort
  ? "http://localhost:" + webPort + "/api/v1/monitoring/chaos"
  : "Read the web port above";
configured.routing =
  "Browser same-origin /api/ -> web Nginx -> api-gateway -> api or api-2. API-2 is internal and normally has no host port. Port 4000 normally belongs to API-1; inspect the configured mapping and its actual container status above.";
console.log(JSON.stringify(configured, null, 2));
const probe = String.raw`
const {Pool}=await import('pg');const {createClient}=await import('redis');
const code=e=>typeof e?.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(e.code)?e.code:'PROBE_FAILED';
async function timed(fn){const t=performance.now();try{return {...await fn(),ok:true,elapsedMs:Math.round(performance.now()-t)};}catch(e){return {ok:false,code:code(e),elapsedMs:Math.round(performance.now()-t)};}}
const db=new Pool({host:process.env.POSTGRES_HOST,port:Number(process.env.POSTGRES_PORT),database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,max:1,connectionTimeoutMillis:2000,statement_timeout:2000,query_timeout:2000});db.on('error',()=>{});
const redis=createClient({password:process.env.REDIS_PASSWORD,database:Number(process.env.REDIS_DB||0),disableOfflineQueue:true,commandOptions:{timeout:2000},socket:{host:process.env.REDIS_HOST,port:Number(process.env.REDIS_PORT),connectTimeout:2000,reconnectStrategy:false}});redis.on('error',()=>{});
const paths=['/api/v1/health/live','/api/v1/health/ready','/api/v1/streams'];
const checks=await Promise.all(paths.map(path=>timed(async()=>{const r=await fetch('http://127.0.0.1:'+process.env.API_PORT+path,{signal:AbortSignal.timeout(3000)});const data=await r.json();return {path,httpStatus:r.status,status:data.status||null,streamCount:Array.isArray(data.streams)?data.streams.length:null};})));
const [postgres,redisCheck]=await Promise.all([timed(async()=>{await db.query('SELECT 1');return {query:'SELECT 1'};}),timed(async()=>{await redis.connect();return {ping:await redis.ping()};})]);
await db.end();if(redis.isOpen)redis.destroy();console.log(JSON.stringify({instance:process.env.API_INSTANCE_ID,dependencyBudgetMs:Number(process.env.DEPENDENCY_TIMEOUT_MS),readinessBudgetMs:Number(process.env.READINESS_TIMEOUT_MS||750),checks,postgres,redis:redisCheck}));`;
for (const name of ["api", "api-2"]) {
  try {
    const text = compose(
      "exec",
      "-T",
      name,
      "node",
      "--input-type=module",
      "-e",
      probe,
    );
    console.log(
      JSON.stringify(
        { service: name, probes: JSON.parse(text.trim()) },
        null,
        2,
      ),
    );
  } catch {
    console.log(
      JSON.stringify({
        service: name,
        probes:
          "Container is not running or the bounded diagnostic could not complete. Inspect this service's private logs.",
      }),
    );
  }
}
const admission = String.raw`const r=await fetch('http://127.0.0.1:'+process.env.CHAOS_PORT+'/state',{headers:{Authorization:'Bearer '+process.env.CHAOS_SECRET},signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('private_read_failed');const s=await r.json();console.log(JSON.stringify({available:s.available,enabled:s.enabled,databaseAvailable:s.databaseAvailable,observedAt:s.observedAt,serverTime:s.serverTime,staleAfterMs:s.staleAfterMs,observationWindowMs:s.observationWindowMs??null,unavailableReason:s.unavailableReason,activeId:s.activeId,scenarios:s.scenarios.filter(x=>['crash-api','crash-video-gateway','crash-edge','network-timeout'].includes(x.id)).map(x=>({id:x.id,supported:x.supported,available:x.available,reason:x.reason}))}));`;
try {
  console.log(
    JSON.stringify(
      {
        controllerAdmission: JSON.parse(
          compose(
            "exec",
            "-T",
            "chaos-controller",
            "node",
            "--input-type=module",
            "-e",
            admission,
          ).trim(),
        ),
      },
      null,
      2,
    ),
  );
} catch {
  console.log(
    "Private controller admission could not be read. Browser/admin authentication remains required; no credentials were printed.",
  );
}
