import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { io, type Socket } from "socket.io-client";
import type { HealingSnapshot, Publishing } from "@streamshield/shared";
import { account, write } from "./platform-helpers";
test.use({ trace: "off", actionTimeout: 15000, navigationTimeout: 20000 });
const args = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  ".local/resilience/compose.yml",
  "-f",
  ".local/monitoring/compose.yml",
  "-f",
  ".local/healing/compose.yml",
];
const timeout = 90000;
function compose(...rest: string[]) {
  return execFileSync("docker", [...args, ...rest], {
    encoding: "utf8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
function inside(service: string, code: string, input: unknown = {}) {
  return JSON.parse(
    execFileSync(
      "docker",
      [
        ...args,
        "exec",
        "-T",
        service,
        "node",
        "--input-type=module",
        "-e",
        code,
      ],
      {
        input: JSON.stringify(input),
        encoding: "utf8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
}
function privateRequest(
  path: string,
  target = "healer",
  method = "GET",
  body?: object,
  badToken = false,
) {
  return inside(
    "healer",
    `const input=JSON.parse((await import('node:fs')).readFileSync(0,'utf8'));const root=input.target==='control'?process.env.CONTROL_URL:input.target==='toxiproxy'?'http://toxiproxy:8474':'http://127.0.0.1:'+process.env.HEALER_PORT;const key=input.target==='control'?process.env.CONTROL_SECRET:process.env.HEALER_SECRET;const r=await fetch(root+input.path,{method:input.method,headers:{Authorization:'Bearer '+(input.badToken?'invalid':key),'Content-Type':'application/json'},body:input.body?JSON.stringify(input.body):undefined,signal:AbortSignal.timeout(3000)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=null;}console.log(JSON.stringify({status:r.status,data}));`,
    { path, target, method, body, badToken },
  );
}
const state = () => privateRequest("/state").data as HealingSnapshot;
function db(sql: string, params: unknown[] = []) {
  return inside(
    "api-2",
    `const input=JSON.parse((await import('node:fs')).readFileSync(0,'utf8'));const {Pool}=await import('pg');const db=new Pool({host:process.env.POSTGRES_HOST,port:Number(process.env.POSTGRES_PORT),database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,connectionTimeoutMillis:2000});try{console.log(JSON.stringify((await db.query(input.sql,input.params)).rows));}finally{await db.end();}`,
    { sql, params },
  );
}
function diag(host: string) {
  return inside(
    "api-2",
    `const {host}=JSON.parse((await import('node:fs')).readFileSync(0,'utf8'));const r=await fetch('http://'+host+':'+process.env.API_INTERNAL_PORT+'/internal/instance',{headers:{Authorization:'Basic '+Buffer.from('mediamtx:'+process.env.MEDIA_AUTH_SECRET).toString('base64')},signal:AbortSignal.timeout(2000)});console.log(JSON.stringify(await r.json()));`,
    { host },
  ) as { instanceId: string; socketIds: string[] };
}
function container(service: string) {
  const id = compose("ps", "-a", "-q", service).trim();
  return JSON.parse(
    execFileSync("docker", ["inspect", "--format", "{{json .State}}", id], {
      encoding: "utf8",
    }),
  ) as { Status: string; StartedAt: string };
}
const publisher = (key: Publishing, size: string) =>
  spawn(process.execPath, ["scripts/test-publisher.mjs"], {
    env: {
      ...process.env,
      MEDIA_STREAM_PATH: key.path,
      MEDIA_PUBLISH_USER: key.user,
      MEDIA_PUBLISH_PASSWORD: key.key,
      TEST_PUBLISH_SIZE: size,
      TEST_PUBLISH_DURATION_SECONDS: "600",
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
// Browser-local monotonic sampling keeps playback interruption separate from repair time.
async function samplePlayback(page: Page) {
  await page.evaluate(() => {
    const samples: { at: number; frames: number; time: number }[] = [];
    const started = performance.now();
    const handle = setInterval(() => {
      const video = document.querySelector("video");
      if (video && samples.length < 6000)
        samples.push({
          at: performance.now() - started,
          frames: video.getVideoPlaybackQuality().totalVideoFrames,
          time: video.currentTime,
        });
    }, 250);
    (window as unknown as { phase6Sampler: unknown }).phase6Sampler = {
      samples,
      handle,
      started,
    };
  });
  return async () =>
    page.evaluate(() => {
      const w = window as unknown as {
        phase6Sampler?: {
          samples: { at: number; frames: number; time: number }[];
          handle: number;
          started: number;
        };
      };
      const sampler = w.phase6Sampler!;
      clearInterval(sampler.handle);
      delete w.phase6Sampler;
      let lastProgress = 0,
        maxGap = 0,
        interruption = 0,
        stalls = 0;
      let previous = sampler.samples[0];
      for (const row of sampler.samples.slice(1)) {
        if (
          previous &&
          row.frames > 0 &&
          (row.frames > previous.frames || row.time > previous.time)
        ) {
          const gap = row.at - lastProgress;
          maxGap = Math.max(maxGap, gap);
          if (gap >= 2000) {
            interruption += gap;
            stalls++;
          }
          lastProgress = row.at;
        }
        previous = row;
      }
      const elapsed = performance.now() - sampler.started,
        tail = elapsed - lastProgress;
      if (tail >= 2000) {
        interruption += tail;
        stalls++;
        maxGap = Math.max(maxGap, tail);
      }
      return {
        sampleIntervalMs: 250,
        stallThresholdMs: 2000,
        samples: sampler.samples.length,
        observationWindowMs: elapsed,
        maxDecodedProgressGapMs: maxGap,
        playbackInterruptionMs: interruption,
        playbackStallCount: stalls,
      };
    });
}
async function stop(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  if (p.connected) p.send("stop");
  else p.kill("SIGTERM");
  await expect
    .poll(() => p.exitCode !== null || p.signalCode !== null, {
      timeout: 15000,
    })
    .toBe(true);
}
async function advances(page: Page, width: number) {
  const video = page.getByLabel("Live stream video");
  await expect(video).toBeVisible({ timeout });
  const before = await video.evaluate((n) => {
    const v = n as HTMLVideoElement;
    return {
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
      time: v.currentTime,
    };
  });
  await expect
    .poll(
      () =>
        video.evaluate(
          (n, b) => {
            const v = n as HTMLVideoElement;
            return (
              v.videoWidth === b.width &&
              v.currentTime > b.time &&
              v.getVideoPlaybackQuality().totalVideoFrames > b.frames + 8
            );
          },
          { ...before, width },
        ),
      { timeout, intervals: [500] },
    )
    .toBe(true);
}
async function emit(socket: Socket, event: string, body: object) {
  return new Promise<{ ok: boolean; data?: { id?: string } }>(
    (resolve, reject) =>
      socket
        .timeout(10000)
        .emit(event, body, (error: Error | null, result: never) =>
          error ? reject(error) : resolve(result),
        ),
  );
}
test("autonomous real recovery, independent verification, safe escalation and Control audit", async ({
  browser,
  request,
}) => {
  test.setTimeout(900000);
  const suffix = randomUUID().slice(0, 8),
    contexts: BrowserContext[] = [],
    ids: string[] = [],
    publishers: ChildProcess[] = [],
    sockets: Socket[] = [],
    stopped = new Set<string>(),
    report: Record<string, unknown>[] = [];
  let outcome = "FAIL",
    replica = false;
  mkdirSync("test-results/phase6", { recursive: true });
  try {
    await expect
      .poll(
        () => {
          try {
            const s = state();
            return s.enabled && s.available && s.leader && s.databaseAvailable;
          } catch {
            return false;
          }
        },
        { timeout, intervals: [1000] },
      )
      .toBe(true);
    expect((await request.get("/api/v1/monitoring/healing")).status()).toBe(
      401,
    );
    expect(
      privateRequest("/v1/start", "control", "POST", {
        service: "postgres",
        attemptId: randomUUID(),
        owner: randomUUID(),
        epoch: 1,
      }).status,
    ).toBe(400);
    expect(
      privateRequest(
        "/v1/lease",
        "control",
        "POST",
        { owner: randomUUID() },
        true,
      ).status,
    ).toBe(401);
    expect(
      privateRequest("/v1/lease", "control", "POST", { owner: randomUUID() })
        .status,
    ).toBe(409);
    expect(
      inside(
        "api-2",
        `try{await (await import('node:dns/promises')).lookup('healing-control');console.log('true');}catch{console.log('false');}`,
      ),
    ).toBe(false);
    for (let i = 0; i < 2; i++) contexts.push(await browser.newContext());
    const users = await Promise.all(
      contexts.map((c, i) =>
        account(
          c.request,
          "e2e_healing" + i + "_" + suffix,
          "Healing-test-password-42",
        ),
      ),
    );
    ids.push(...users.map((u) => u.user.id));
    expect(
      (await contexts[0]!.request.get("/api/v1/monitoring/healing")).status(),
    ).toBe(403);
    compose(
      "exec",
      "-T",
      "api-2",
      "node",
      "scripts/set-role.mjs",
      "e2e_healing0_" + suffix,
      "administrator",
    );
    const streams: string[] = [],
      keys: Publishing[] = [];
    for (let i = 0; i < 2; i++) {
      const ctx = contexts[i]!,
        csrf = users[i]!.csrf;
      expect(
        (
          await write(ctx.request, csrf, "/channels", {
            slug: "healing-" + i + "-" + suffix,
            displayName: i
              ? "Independent Broadcast"
              : "Autonomous Recovery Live",
            description: "Real Phase 6 media",
          })
        ).status(),
      ).toBe(201);
      const channel = (
        await (await ctx.request.get("/api/v1/studio/channel")).json()
      ).channel;
      const stream = await write(ctx.request, csrf, "/studio/streams", {
        channelId: channel.id,
        title: "Recovery signal " + i,
        description: "Actual independent FFmpeg source",
      });
      expect(stream.status()).toBe(201);
      streams.push((await stream.json()).id);
      const key = await write(
        ctx.request,
        csrf,
        "/studio/streams/" + streams[i] + "/publishing",
      );
      expect(key.ok()).toBe(true);
      keys.push(await key.json());
      publishers.push(publisher(keys[i]!, i ? "320x180" : "640x360"));
    }
    let pages = await Promise.all(contexts.map((c) => c.newPage()));
    for (let i = 0; i < 2; i++) {
      await pages[i]!.goto("/watch/" + streams[i]);
      await advances(pages[i]!, i ? 320 : 640);
    }
    const socketFor = async (index: number, host: string) => {
      const ctx = contexts[index]!,
        cookies = (await ctx.cookies())
          .map((c) => c.name + "=" + c.value)
          .join("; ");
      for (let attempt = 0; attempt < 10; attempt++) {
        const s = io(process.env.E2E_BASE_URL!, {
          transports: ["websocket"],
          extraHeaders: {
            Origin: new URL(process.env.E2E_BASE_URL!).origin,
            Cookie: cookies,
          },
          auth: { csrf: users[index]!.csrf },
          autoConnect: false,
          reconnectionAttempts: 10,
          reconnectionDelay: 1000,
        });
        sockets.push(s);
        await new Promise<void>((resolve, reject) => {
          s.once("connect", resolve);
          s.once("connect_error", reject);
          s.connect();
        });
        if (diag(host).socketIds.includes(s.id!)) {
          s.on("disconnect", (reason) =>
            console.log("Test socket disconnected:", host, reason),
          );
          s.on("connect", () => {
            void emit(s, "join", { streamId: streams[0] }).catch(() =>
              console.log("Test socket room rejoin unavailable:", host),
            );
          });
          expect((await emit(s, "join", { streamId: streams[0] })).ok).toBe(
            true,
          );
          return s;
        }
        s.disconnect();
      }
      throw new Error("No independent instance socket");
    };
    let a = await socketFor(0, process.env.RESILIENCE_API1_HOST!),
      b = await socketFor(1, process.env.RESILIENCE_API2_HOST!);
    let recoveryEvents = 0;
    a.on("monitoring:v1", (e: { kind: string }) => {
      if (e.kind === "recovery_changed") recoveryEvents++;
    });
    const subscribe = () =>
      new Promise<{ ok: boolean }>((resolve) =>
        a.emit("monitoring:subscribe", resolve),
      );
    expect((await subscribe()).ok).toBe(true);
    const durableMessages: string[] = [];
    const chat = async (label: string) => {
      await expect
        .poll(() => a.connected && b.connected, {
          timeout: 30000,
          intervals: [500],
        })
        .toBe(true);
      const received = new Promise<unknown>((resolve) =>
        a.once("message", resolve),
      );
      expect(
        (
          await emit(b, "message", {
            streamId: streams[0],
            content: label + " " + suffix,
          })
        ).ok,
      ).toBe(true);
      await received;
      durableMessages.push(label + " " + suffix);
    };
    await chat("Before autonomous recovery");
    // A second real controller process shares journals but cannot acquire the adapter lease.
    compose(
      "exec",
      "-d",
      "-e",
      "HEALER_PORT=4022",
      "healer",
      "sh",
      "-c",
      "echo $$ > /tmp/healer-replica.pid; exec node --import tsx services/api/src/healing/server.ts",
    );
    replica = true;
    await expect
      .poll(
        () => {
          try {
            return inside(
              "healer",
              `const r=await fetch('http://127.0.0.1:4022/state',{headers:{Authorization:'Bearer '+process.env.HEALER_SECRET}});console.log(JSON.stringify(await r.json()));`,
            ).leader;
          } catch {
            return true;
          }
        },
        { timeout: 15000, intervals: [1000] },
      )
      .toBe(false);
    inside(
      "healer",
      `const n=Number((await import('node:fs')).readFileSync('/tmp/healer-replica.pid','utf8'));if(!Number.isInteger(n)||n<2)throw Error('pid');process.kill(n,'SIGTERM');console.log('true');`,
    );
    replica = false;
    console.log(
      "PASS private control restrictions, fresh administrator authorization and second-controller exclusion",
    );
    for (const [service, component] of [
      ["api", "api-1"],
      ["edge-1", "edge-1"],
      ["origin-primary", "origin-primary"],
      ["redis", "redis"],
    ]) {
      const initial = container(service!),
        peer =
          service === "api"
            ? container("api-2")
            : service === "edge-1"
              ? container("edge-2")
              : service === "origin-primary"
                ? container("origin-standby")
                : null;
      const prior = new Set(state().attempts.map((a) => a.id));
      // The API repair runs with every React page closed.
      if (service === "api") await Promise.all(pages.map((p) => p.close()));
      const playbackSamplers =
        service === "api" ? [] : await Promise.all(pages.map(samplePlayback));
      const injectedAt = new Date().toISOString(),
        start = performance.now();
      compose("kill", "-s", "SIGKILL", service!);
      stopped.add(service!);
      if (service === "api") {
        const r = await contexts[1]!.request.get("/api/v1/auth/me");
        expect((await r.json()).user.id).toBe(users[1]!.user.id);
      }
      await expect
        .poll(
          () =>
            state().attempts.find(
              (a) => a.component === component && !prior.has(a.id),
            ),
          { timeout, intervals: [1000] },
        )
        .toBeTruthy();
      const id = state().attempts.find(
        (a) => a.component === component && !prior.has(a.id),
      )!.id;
      if (service === "edge-1") {
        await expect
          .poll(() => state().attempts.find((a) => a.id === id)?.state, {
            timeout,
            intervals: [500],
          })
          .toBe("VERIFYING");
        compose("restart", "healer");
        compose("restart", "observer");
      }
      await expect
        .poll(
          () => {
            try {
              return state().attempts.find((a) => a.id === id)?.state;
            } catch {
              return "unavailable";
            }
          },
          { timeout: 120000, intervals: [1000] },
        )
        .toBe("VERIFIED");
      const injectionToVerificationObservedMs = performance.now() - start;
      const recovered = state().attempts.find((a) => a.id === id)!;
      stopped.delete(service!);
      expect(recovered.evidence.controlReceipt).toBe("docker_start_accepted");
      expect(recovered.evidence.actionOrigin).toBe("healer_control_adapter");
      expect(recovered.actionStartedAt).not.toBeNull();
      expect(recovered.actionFinishedAt).not.toBeNull();
      expect(Date.parse(container(service!).StartedAt)).toBeGreaterThan(
        Date.parse(initial.StartedAt),
      );
      if (peer)
        expect(
          container(
            service === "api"
              ? "api-2"
              : service === "edge-1"
                ? "edge-2"
                : "origin-standby",
          ).StartedAt,
        ).toBe(peer.StartedAt);
      await expect
        .poll(
          () =>
            db("SELECT state FROM healing_attempts WHERE id=$1", [id])[0]
              ?.state,
          { timeout: 30000, intervals: [1000] },
        )
        .toBe("VERIFIED");
      expect(
        db(
          "SELECT count(*)::int AS n FROM healing_events WHERE attempt_id=$1 AND state='EXECUTING'",
          [id],
        )[0].n,
      ).toBe(1);
      if (service === "api") {
        pages = await Promise.all(contexts.map((c) => c.newPage()));
        for (let i = 0; i < 2; i++)
          await pages[i]!.goto("/watch/" + streams[i]);
        a = await socketFor(0, process.env.RESILIENCE_API1_HOST!);
        b.disconnect();
        b = await socketFor(1, process.env.RESILIENCE_API2_HOST!);
        a.on("monitoring:v1", (e: { kind: string }) => {
          if (e.kind === "recovery_changed") recoveryEvents++;
        });
        expect((await subscribe()).ok).toBe(true);
      }
      for (let i = 0; i < 2; i++) await advances(pages[i]!, i ? 320 : 640);
      if (service === "api" || service === "redis")
        await chat("Chat after " + service);
      if (service === "redis") {
        const rows = db(
          "SELECT content FROM chat_messages WHERE stream_id=$1 AND content=ANY($2::text[])",
          [streams[0], durableMessages],
        );
        expect(rows.map((r: { content: string }) => r.content).sort()).toEqual(
          [...durableMessages].sort(),
        );
      }
      if (service === "edge-1" || service === "origin-primary") {
        expect(recovered.evidence.livePaths).toBe(2);
        expect(recovered.evidence.progressingPaths).toBe(2);
      }
      await expect
        .poll(
          () =>
            db(
              "SELECT resolved_at IS NOT NULL AS resolved FROM monitoring_incidents WHERE id=$1",
              [recovered.incidentId],
            )[0]?.resolved,
          { timeout: 30000, intervals: [1000] },
        )
        .toBe(true);
      report.push({
        scenario: service,
        component,
        attemptId: id,
        incidentId: recovered.incidentId,
        injectedAt,
        firstObservedAt: recovered.detectedAt,
        actionStartedAt: recovered.actionStartedAt,
        actionFinishedAt: recovered.actionFinishedAt,
        verificationStartedAt: recovered.verificationStartedAt,
        verifiedAt: recovered.finishedAt,
        injectionToVerificationObservedMs,
        injectionToAllAssertionsMs: performance.now() - start,
        actionMs:
          Date.parse(recovered.actionFinishedAt!) -
          Date.parse(recovered.actionStartedAt!),
        verificationMs:
          Date.parse(recovered.finishedAt!) -
          Date.parse(recovered.verificationStartedAt!),
        actionOrigin: recovered.evidence.actionOrigin,
        manualRestoreUsed: false,
        evidence: recovered.evidence,
        decodedStreamsVerified: 2,
        playback: await Promise.all(playbackSamplers.map((stop) => stop())),
        playbackScope:
          service === "api"
            ? "No viewers during action: browser-independent repair assertion"
            : "Two decoded Chromium viewers; 250 ms sampling, 2 s stall threshold; routing/player continuity separate from component restoration",
      });
      console.log(
        "PASS autonomous restoration and independent behavior:",
        component,
      );
    }
    await expect
      .poll(() => recoveryEvents, { timeout: 15000, intervals: [1000] })
      .toBeGreaterThan(0);
    // Actual network fault: removal restores the external network, not a managed service.
    for (const scenario of ["network-latency", "external-service-failure"]) {
      const prior = new Set(state().attempts.map((a) => a.id)),
        injectedAt = new Date().toISOString(),
        start = performance.now();
      if (scenario === "network-latency")
        expect(
          privateRequest(
            "/proxies/recommendation-demo/toxics",
            "toxiproxy",
            "POST",
            {
              name: "phase6-latency",
              type: "latency",
              stream: "downstream",
              toxicity: 1,
              attributes: { latency: 3500, jitter: 0 },
            },
          ).status,
        ).toBe(200);
      else {
        compose("stop", "dependency-demo");
        stopped.add("dependency-demo");
      }
      await expect
        .poll(() => state().circuit.state, { timeout: 30000, intervals: [500] })
        .toBe("OPEN");
      const openedAfterMs = performance.now() - start,
        rejectedBefore = state().circuit.rejected;
      for (let i = 0; i < 3; i++)
        expect(privateRequest("/dependency").status).toBe(503);
      expect(state().circuit.rejected).toBeGreaterThan(rejectedBefore);
      await expect
        .poll(
          () =>
            state().attempts.find(
              (a) => a.component === "demo-dependency" && !prior.has(a.id),
            ),
          { timeout: 30000, intervals: [1000] },
        )
        .toBeTruthy();
      const attempt = state().attempts.find(
        (a) => a.component === "demo-dependency" && !prior.has(a.id),
      )!;
      await expect
        .poll(() => state().attempts.find((a) => a.id === attempt.id)?.state, {
          timeout: 30000,
          intervals: [500],
        })
        .toBe("VERIFYING");
      const networkReturnedAt = new Date().toISOString();
      if (scenario === "network-latency")
        expect(
          privateRequest(
            "/proxies/recommendation-demo/toxics/phase6-latency",
            "toxiproxy",
            "DELETE",
          ).status,
        ).toBe(204);
      else {
        compose("up", "-d", "--no-deps", "dependency-demo");
        stopped.delete("dependency-demo");
      }
      await expect
        .poll(() => state().circuit.state, { timeout: 30000, intervals: [250] })
        .toBe("HALF_OPEN");
      await expect
        .poll(() => state().circuit.state, { timeout: 30000, intervals: [500] })
        .toBe("CLOSED");
      await expect
        .poll(() => state().attempts.find((a) => a.id === attempt.id)?.state, {
          timeout,
          intervals: [1000],
        })
        .toBe("VERIFIED");
      report.push({
        scenario,
        injectedAt,
        openedAfterMs,
        networkReturnedAt,
        verifiedAt: state().attempts.find((a) => a.id === attempt.id)!
          .finishedAt,
        attemptId: attempt.id,
        mechanism:
          "bounded safe GET/circuit probes; upstream fault removed externally",
        rejectedRequests: state().circuit.rejected,
      });
      console.log(
        "PASS real dependency circuit and autonomous reconnection:",
        scenario,
      );
    }
    // Storage failure is explicitly not an eligible restart. This is an escalation test.
    const apiStarts = [
        container("api").StartedAt,
        container("api-2").StartedAt,
      ],
      beforePG = new Set(state().attempts.map((a) => a.id)),
      pgInjectedAt = new Date().toISOString();
    compose("stop", "postgres");
    stopped.add("postgres");
    await expect
      .poll(
        () =>
          state().attempts.find(
            (a) => a.component === "postgres" && !beforePG.has(a.id),
          )?.state,
        { timeout: 30000, intervals: [1000] },
      )
      .toBe("ESCALATED");
    const pg = state().attempts.find(
      (a) => a.component === "postgres" && !beforePG.has(a.id),
    )!;
    expect(pg.actionStartedAt).toBeNull();
    expect(pg.databasePersisted).toBe(false);
    for (let i = 0; i < 2; i++) await advances(pages[i]!, i ? 320 : 640);
    expect([container("api").StartedAt, container("api-2").StartedAt]).toEqual(
      apiStarts,
    );
    console.log(
      "PASS PostgreSQL safe escalation; operator restoration follows only to clean up this unrecoverable fault",
    );
    compose("up", "-d", "--no-deps", "--wait", "postgres");
    stopped.delete("postgres");
    await expect
      .poll(
        () => {
          try {
            return state().attempts.find((a) => a.id === pg.id)?.state;
          } catch {
            return "unavailable";
          }
        },
        { timeout, intervals: [1000] },
      )
      .toBe("VERIFIED");
    await expect
      .poll(
        () => db("SELECT id FROM healing_attempts WHERE id=$1", [pg.id]).length,
        { timeout: 30000, intervals: [1000] },
      )
      .toBe(1);
    expect(
      (await (await contexts[0]!.request.get("/api/v1/auth/me")).json()).user
        .id,
    ).toBe(users[0]!.user.id);
    report.push({
      scenario: "postgres",
      injectedAt: pgInjectedAt,
      attemptId: pg.id,
      outcome: "SAFE_ESCALATION",
      automaticDatabaseAction: false,
      operatorRestorationWasCleanup: true,
      delayedDatabaseAuditVerified: true,
    });
    // Missing camera input is not an origin fault. Only the broadcaster can return it.
    const originStarts = [
        container("origin-primary").StartedAt,
        container("origin-standby").StartedAt,
      ],
      sourceInjectedAt = new Date().toISOString();
    await stop(publishers[0]!);
    await expect
      .poll(
        () =>
          state().attempts.find(
            (a) =>
              a.component === "publisher-source" &&
              a.evidence.sourcePath === keys[0]!.path,
          )?.state,
        { timeout: 60000, intervals: [1000] },
      )
      .toBe("ESCALATED");
    const source = state().attempts.find(
      (a) =>
        a.component === "publisher-source" &&
        a.evidence.sourcePath === keys[0]!.path,
    )!;
    expect(source.actionStartedAt).toBeNull();
    await advances(pages[1]!, 320);
    expect([
      container("origin-primary").StartedAt,
      container("origin-standby").StartedAt,
    ]).toEqual(originStarts);
    const control = await contexts[0]!.newPage();
    await control.goto("/control/recoveries");
    await expect(
      control.getByRole("heading", {
        name: "Autonomous recovery",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      control.locator('[data-attempt="' + source.id + '"]'),
    ).toContainText("ESCALATED");
    await control.setViewportSize({ width: 1440, height: 1100 });
    await control.screenshot({
      path: "test-results/phase6/source-escalation.png",
      fullPage: true,
      animations: "disabled",
    });
    const reconnectAt = new Date().toISOString();
    publishers[0] = publisher(keys[0]!, "640x360");
    await expect
      .poll(() => state().attempts.find((a) => a.id === source.id)?.state, {
        timeout,
        intervals: [1000],
      })
      .toBe("VERIFIED");
    await advances(pages[0]!, 640);
    expect(
      state().attempts.find((a) => a.id === source.id)!.evidence
        .sourceRecreatedByHealer,
    ).toBe(false);
    report.push({
      scenario: "source-interruption",
      injectedAt: sourceInjectedAt,
      reconnectAt,
      attemptId: source.id,
      sourceRecreatedByHealer: false,
      originRestarts: 0,
      decodedPlaybackResumed: true,
      verifiedAt: state().attempts.find((a) => a.id === source.id)!.finishedAt,
    });
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await control.setViewportSize({ width, height: 1100 });
      await control.goto("/control/recoveries");
      await expect(
        control.getByRole("heading", {
          name: "Autonomous recovery",
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await control.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await control.screenshot({
        path: "test-results/phase6/recoveries-" + width + ".png",
        fullPage: true,
        animations: "disabled",
      });
    }
    const last = state().attempts.find(
      (a) => a.component === "origin-primary",
    )!;
    await control.goto("/control/incidents/" + last.incidentId);
    await expect(
      control.getByRole("heading", { name: "Correlated recovery attempts" }),
    ).toBeVisible();
    await control
      .locator('[data-attempt="' + last.id + '"] details')
      .evaluate((n) => ((n as HTMLDetailsElement).open = true));
    await control.screenshot({
      path: "test-results/phase6/incident-recovery.png",
      fullPage: true,
      animations: "disabled",
    });
    const metrics = inside(
      "healer",
      `const r=await fetch('http://127.0.0.1:'+process.env.HEALER_PORT+'/metrics',{headers:{Authorization:'Bearer '+process.env.HEALER_SECRET}});console.log(JSON.stringify(await r.text()));`,
    ) as string;
    expect(metrics).toContain("streamshield_recovery_outcomes_total");
    expect(metrics).toContain("streamshield_dependency_circuit_state 0");
    expect(metrics).not.toContain(keys[0]!.key);
    expect(
      db(
        "SELECT attempt_id FROM healing_events GROUP BY attempt_id,ordinal HAVING count(*)>1",
      ).length,
    ).toBe(0);
    console.log(
      "PASS unrecoverable source, genuine reconnection, audit UI, responsive widths, metrics and event delivery",
    );
    outcome = "PASS";
  } finally {
    for (const s of sockets) s.disconnect();
    for (const p of publishers) await stop(p);
    if (replica)
      try {
        inside(
          "healer",
          `const p=Number((await import('node:fs')).readFileSync('/tmp/healer-replica.pid','utf8'));process.kill(p,'SIGTERM');console.log('true');`,
        );
      } catch {
        /* Container may have exited. */
      }
    try {
      privateRequest(
        "/proxies/recommendation-demo/toxics/phase6-latency",
        "toxiproxy",
        "DELETE",
      );
    } catch {
      /* No fault remained. */
    }
    for (const service of stopped) {
      console.log("Cleanup only: restoring", service);
      compose("up", "-d", "--no-deps", "--wait", service);
    }
    if (ids.length)
      execFileSync(
        "docker",
        [
          ...args,
          "exec",
          "-T",
          "api-2",
          "node",
          "scripts/cleanup-test-fixtures.mjs",
        ],
        {
          input: JSON.stringify(ids),
          stdio: ["pipe", "ignore", "pipe"],
          timeout: 30000,
        },
      );
    for (const c of contexts) await c.close();
    writeFileSync(
      "test-results/phase6/measurements.json",
      JSON.stringify(
        {
          outcome,
          measuredAt: new Date().toISOString(),
          clock:
            "UTC action/audit clocks plus separate harness monotonic observations; polling resolution is explicit",
          experiments: report,
        },
        null,
        2,
      ) + "\n",
    );
  }
});
