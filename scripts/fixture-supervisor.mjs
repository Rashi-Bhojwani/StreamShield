async function supervise(spec) {
  const { spawn, execFileSync } = await import("node:child_process");
  const { readFileSync, mkdirSync, writeFileSync } = await import("node:fs");
  const roles = JSON.parse(readFileSync("/fixture/roles.json", "utf8"));
  for (const path of ["/data/chaos", "/data/healer"])
    mkdirSync(path, { recursive: true });
  if (process.argv[2] === "init") {
    for (const name of spec.jobs) {
      const s = roles[name];
      console.log(
        JSON.stringify({
          fixtureStage: "migration:" + name,
          status: "STARTING",
        }),
      );
      execFileSync(s.command[0], s.command.slice(1), {
        env: { ...process.env, ...s.env },
        stdio: "inherit",
      });
    }
    return;
  }
  let closing = false;
  const children = [];
  function shutdown() {
    if (closing) return;
    closing = true;
    for (const child of children) child.kill("SIGTERM");
    setTimeout(() => process.exit(process.exitCode || 0), 2000);
  }
  function start(name) {
    const s = roles[name];
    const identity =
      spec.staged && name === "api-2" ? { uid: 65534, gid: 65534 } : {};
    if (spec.staged && name === "api-2") {
      const denied = `const http=require('node:http');const r=http.request({socketPath:'/var/run/docker.sock',path:'/_ping',timeout:1000},()=>process.exit(9));r.on('error',e=>process.exit(['EACCES','EPERM'].includes(e.code)?0:2));r.on('timeout',()=>process.exit(3));r.end();`;
      execFileSync(process.execPath, ["-e", denied], {
        ...identity,
        timeout: 3000,
        stdio: "pipe",
      });
      writeFileSync("/data/api-peer-isolated", "socket-permission-denied");
    }
    const child = spawn(s.command[0], s.command.slice(1), {
      env: { ...process.env, ...s.env },
      stdio: "inherit",
      ...identity,
    });
    children.push(child);
    child.on("exit", (code) => {
      if (!closing) {
        console.error("fixture role exited", name, code);
        process.exitCode = 1;
        shutdown();
      }
    });
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  async function healthy(
    name,
    port,
    path = "/health",
    secret,
    verify = () => true,
  ) {
    const started = performance.now();
    let lastEvidence, lastError;
    while (!closing && performance.now() - started < 90000) {
      try {
        const r = await fetch("http://127.0.0.1:" + port + path, {
          headers: secret ? { Authorization: "Bearer " + secret } : {},
          signal: AbortSignal.timeout(1500),
        });
        if (r.ok) {
          const body = await r.json();
          lastEvidence = {
            status: body.status,
            available: body.available,
            leader: body.leader,
            persistence: body.persistence,
            mediaAvailable: body.mediaAvailable,
            components: body.components?.map((c) => ({
              id: c.id,
              state: c.state,
              code: c.code,
            })),
            media: body.media?.map((p) => ({
              publisher: p.publisher,
              sources: p.sources?.map((s) => ({
                id: s.id,
                segment: s.segment,
                fresh: s.fresh,
                code: s.code,
              })),
            })),
          };
          if (verify(body)) return;
        } else lastError = { code: "http_" + r.status };
      } catch (error) {
        lastError = {
          type: error.name,
          code: error.cause?.code || error.code || "request_failed",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.error(
      JSON.stringify({ fixtureStage: name, lastEvidence, lastError }),
    );
    throw Error("fixture_startup_not_ready_" + name);
  }
  try {
    if (!spec.staged) {
      for (const name of spec.roles) start(name);
      return;
    }
    if (spec.roles.includes("api-2")) {
      start("api-2");
      await healthy(
        "api-2",
        roles["api-2"].env.API_PORT,
        "/api/v1/health/ready",
        undefined,
        (body) => body.status === "ready",
      );
    }
    start("dependency-demo");
    await healthy(
      "dependency-demo",
      roles["dependency-demo"].env.HEALER_DEMO_PORT,
      "/status",
    );
    start("healing-control");
    await healthy("healing-control", roles["healing-control"].env.CONTROL_PORT);
    start("observer");
    const observer = roles.observer.env;
    await healthy(
      "observer",
      observer.OBS_PORT,
      "/observations",
      observer.OBS_SECRET,
      (body) =>
        body.persistence &&
        body.components?.length > 0 &&
        body.components.every(
          (c) =>
            c.state === "HEALTHY" ||
            c.code === "spare_standby" ||
            c.code === "metrics_no_requests",
        ) &&
        body.mediaAvailable &&
        body.media?.some(
          (p) => p.publisher && p.sources.every((s) => s.segment && s.fresh),
        ),
    );
    start("healer");
    const healer = roles.healer.env;
    await healthy(
      "healer",
      healer.HEALER_PORT,
      "/state",
      healer.HEALER_SECRET,
      (body) => body.available && body.leader && body.databaseAvailable,
    );
    start("chaos-fault-adapter");
    await healthy(
      "chaos-fault-adapter",
      roles["chaos-fault-adapter"].env.CHAOS_CONTROL_PORT,
    );
    start("chaos-controller");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    shutdown();
  }
}
export function fixtureSupervisor(spec) {
  return (
    "void (" +
    supervise.toString() +
    ")(" +
    JSON.stringify(spec) +
    ").catch(error=>{console.error(error.message);process.exitCode=1;});\n"
  );
}
