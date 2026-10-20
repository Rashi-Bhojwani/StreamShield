import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { io, type Socket } from "socket.io-client";
import type {
  ChaosSnapshot,
  ChaosExperiment,
  ChaosScenarioId,
  Publishing,
} from "@streamshield/shared";
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
  "-f",
  ".local/chaos/compose.yml",
  ...(existsSync(".local/chaos/cloud-vfs.yml")
    ? ["-f", ".local/chaos/cloud-vfs.yml"]
    : []),
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
    (window as unknown as { chaosSampler: unknown }).chaosSampler = {
      samples,
      handle,
      started,
    };
  });
  return async () =>
    page.evaluate(() => {
      const w = window as unknown as {
        chaosSampler?: {
          samples: { at: number; frames: number; time: number }[];
          handle: number;
          started: number;
        };
      };
      const sampler = w.chaosSampler!;
      clearInterval(sampler.handle);
      delete w.chaosSampler;
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
test("authenticated real Chaos Lab experiments, durable evidence, live media and responsive demo", async ({
  browser,
  request,
}) => {
  test.setTimeout(900000);
  const suffix = randomUUID().slice(0, 8),
    contexts: BrowserContext[] = [],
    ids: string[] = [],
    publishers: ChildProcess[] = [],
    report: Record<string, unknown>[] = [],
    sockets: Socket[] = [];
  const guarded = new Set<string>();
  const controlReadOutages: {
    startedAt: string;
    durationMs: number;
    statuses: number[];
  }[] = [];
  let lastSnapshot: ChaosSnapshot | undefined;
  let outcome = "FAIL";
  mkdirSync("test-results/phase7", { recursive: true });
  try {
    expect((await request.get("/api/v1/monitoring/chaos")).status()).toBe(401);
    for (let i = 0; i < 2; i++) contexts.push(await browser.newContext());
    const users = await Promise.all(
      contexts.map((c, i) =>
        account(
          c.request,
          "e2e_chaos" + i + "_" + suffix,
          "Chaos-test-password-42",
        ),
      ),
    );
    ids.push(...users.map((u) => u.user.id));
    expect(
      (await contexts[0]!.request.get("/api/v1/monitoring/chaos")).status(),
    ).toBe(403);
    compose(
      "exec",
      "-T",
      "api-2",
      "node",
      "scripts/set-role.mjs",
      "e2e_chaos0_" + suffix,
      "administrator",
    );
    const admin = contexts[0]!,
      csrf = users[0]!.csrf;
    const state = async () => {
      const startedAt = new Date().toISOString(),
        start = performance.now(),
        statuses: number[] = [];
      let value: ChaosSnapshot | undefined;
      await expect
        .poll(
          async () => {
            let response;
            try {
              response = await admin.request.get("/api/v1/monitoring/chaos", {
                timeout: 5000,
              });
            } catch {
              statuses.push(0);
              return false;
            }
            if ([401, 403].includes(response.status()))
              throw Error(
                "Current administrator authorization denied: " +
                  response.status(),
              );
            if (response.status() !== 200) {
              statuses.push(response.status());
              return false;
            }
            value = (await response.json()) as ChaosSnapshot;
            return true;
          },
          { timeout: 30000, intervals: [250, 500, 1000] },
        )
        .toBe(true);
      if (statuses.length)
        controlReadOutages.push({
          startedAt,
          durationMs: performance.now() - start,
          statuses,
        });
      lastSnapshot = value;
      return value!;
    };
    const find = async (id: string) =>
      (await state()).experiments.find((e) => e.id === id)!;
    const post = (data: object) =>
      write(admin.request, csrf, "/monitoring/chaos/experiments", data);
    const valid = {
      id: randomUUID(),
      scenario: "crash-api",
      confirmation: "api-1",
    };
    expect(
      (
        await admin.request.post("/api/v1/monitoring/chaos/experiments", {
          data: valid,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await admin.request.post("/api/v1/monitoring/chaos/experiments", {
          headers: { Origin: "http://attacker.test", "X-CSRF-Token": csrf },
          data: valid,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await post({ ...valid, command: "arbitrary", containerId: "postgres" })
      ).status(),
    ).toBe(400);
    expect((await post({ ...valid, scenario: "arbitrary" })).status()).toBe(
      400,
    );
    expect(
      (
        await post({
          ...valid,
          scenario: "database-outage",
          confirmation: "postgres",
        })
      ).status(),
    ).toBe(400);
    expect((await post({ ...valid, confirmation: "api-2" })).status()).toBe(
      400,
    );
    expect(
      inside(
        "api-2",
        `try{await (await import('node:dns/promises')).lookup('chaos-fault-adapter');console.log('true');}catch{console.log('false');}`,
      ),
    ).toBe(false);
    expect(
      inside(
        "chaos-controller",
        `console.log(JSON.stringify({control:!!process.env.CONTROL_SECRET,session:!!process.env.CSRF_SECRET,socket:(await import('node:fs')).existsSync('/var/run/docker.sock')}));`,
      ),
    ).toEqual({ control: false, session: false, socket: false });
    const streams: string[] = [];
    for (let i = 0; i < 2; i++) {
      const ctx = contexts[i]!,
        token = users[i]!.csrf;
      expect(
        (
          await write(ctx.request, token, "/channels", {
            slug: "chaos-" + i + "-" + suffix,
            displayName: i
              ? "Independent Live Signal"
              : "Resilience Demonstration",
            description: "Real Phase 7 source",
          })
        ).status(),
      ).toBe(201);
      const channel = (
        await (await ctx.request.get("/api/v1/studio/channel")).json()
      ).channel;
      const r = await write(ctx.request, token, "/studio/streams", {
        channelId: channel.id,
        title: i ? "Independent Broadcast" : "Chaos Control Live",
        description: "Genuine FFmpeg stream",
      });
      expect(r.status()).toBe(201);
      streams.push((await r.json()).id);
      const key = await write(
        ctx.request,
        token,
        "/studio/streams/" + streams[i] + "/publishing",
      );
      expect(key.ok()).toBe(true);
      publishers.push(publisher(await key.json(), i ? "320x180" : "640x360"));
    }
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    for (let i = 0; i < 2; i++) {
      await pages[i]!.goto("/watch/" + streams[i]);
      await advances(pages[i]!, i ? 320 : 640);
    }
    await expect
      .poll(
        async () => {
          const s = await state();
          return (
            s.available &&
            s.enabled &&
            s.databaseAvailable &&
            s.scenarios.filter((x) => x.supported).every((x) => x.available)
          );
        },
        { timeout, intervals: [1000] },
      )
      .toBe(true);
    for (const service of ["observer", "healer"]) {
      compose("stop", service);
      guarded.add(service);
      await expect
        .poll(async () => (await state()).available, {
          timeout: 20000,
          intervals: [500],
        })
        .toBe(false);
      expect((await post({ ...valid, id: randomUUID() })).status()).toBe(409);
      // Negative admission test only: no experiment was accepted or service fault injected.
      compose("start", service);
      guarded.delete(service);
      await expect
        .poll(
          async () =>
            (await state()).scenarios.find((s) => s.id === "crash-api")
              ?.available,
          { timeout, intervals: [1000] },
        )
        .toBe(true);
    }
    expect(
      inside(
        "chaos-controller",
        `const headers={Authorization:'Bearer '+process.env.CHAOS_CONTROL_SECRET};const url=process.env.CHAOS_CONTROL_URL;const r=await fetch(url+'/v1/start',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});const denied=await fetch(url+'/v1/status');console.log(JSON.stringify({noRepair:r.status,noToken:denied.status}));`,
      ),
    ).toEqual({ noRepair: 404, noToken: 401 });
    expect(
      inside(
        "chaos-controller",
        `const {Pool}=await import('pg');const db=new Pool({host:process.env.POSTGRES_HOST,port:Number(process.env.POSTGRES_PORT),database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD});try{console.log(JSON.stringify((await db.query("SELECT has_table_privilege(current_user,'users','select') AS users,has_table_privilege(current_user,'healing_attempts','update') AS heal_write,has_table_privilege(current_user,'chaos_experiments','insert') AS audit_write")).rows[0]));}finally{await db.end();}`,
      ),
    ).toEqual({ users: false, heal_write: false, audit_write: true });
    const socketFor = async (index: number, host: string) => {
      const cookies = (await contexts[index]!.cookies())
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
          reconnectionDelay: 500,
        });
        sockets.push(s);
        await new Promise<void>((resolve, reject) => {
          s.once("connect", resolve);
          s.once("connect_error", reject);
          s.connect();
        });
        if (diag(host).socketIds.includes(s.id!)) {
          s.on("connect", () => {
            void emit(s, "join", { streamId: streams[0] }).catch(() => {});
          });
          expect((await emit(s, "join", { streamId: streams[0] })).ok).toBe(
            true,
          );
          return s;
        }
        s.disconnect();
      }
      throw Error("No independent API socket");
    };
    let first = await socketFor(0, process.env.RESILIENCE_API1_HOST!),
      second = await socketFor(1, process.env.RESILIENCE_API2_HOST!);
    const messages: string[] = [];
    const chat = async (label: string) => {
      await expect
        .poll(() => first.connected && second.connected, {
          timeout: 30000,
          intervals: [500],
        })
        .toBe(true);
      const content = label + " " + suffix;
      const received = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Cross-instance message not delivered")),
          12000,
        );
        first.once("message", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(
        (await emit(second, "message", { streamId: streams[0], content })).ok,
      ).toBe(true);
      await received;
      messages.push(content);
    };
    await chat("Before authenticated chaos");
    const control = await admin.newPage();
    await control.setViewportSize({ width: 1440, height: 1100 });
    await control.goto("/control/chaos");
    await expect(
      control.getByRole("heading", { name: "Chaos Laboratory", exact: true }),
    ).toBeVisible();
    const cookie = (await admin.cookies())
      .map((c) => c.name + "=" + c.value)
      .join("; ");
    let chaosEvents = 0;
    const socket = io(process.env.E2E_BASE_URL!, {
      transports: ["websocket"],
      extraHeaders: {
        Origin: new URL(process.env.E2E_BASE_URL!).origin,
        Cookie: cookie,
      },
      auth: { csrf },
      autoConnect: false,
    });
    sockets.push(socket);
    socket.on("monitoring:v1", (e: { kind: string }) => {
      if (e.kind === "chaos_changed") chaosEvents++;
    });
    socket.on("connect", () => socket.emit("monitoring:subscribe", () => {}));
    socket.connect();
    await expect.poll(() => socket.connected, { timeout: 15000 }).toBe(true);
    const matrix: [ChaosScenarioId, string, string | null, string | null][] = [
      ["crash-api", "api-1", "api", "api-2"],
      ["crash-edge", "edge-1", "edge-1", "edge-2"],
      ["crash-primary", "origin-primary", "origin-primary", "origin-standby"],
      ["crash-redis", "redis", "redis", null],
      ["network-timeout", "demo-dependency", null, null],
      ["external-api", "demo-dependency", null, null],
    ];
    for (const [scenario, target, service, peer] of matrix) {
      await expect
        .poll(
          async () =>
            (await state()).scenarios.find((s) => s.id === scenario)?.available,
          { timeout, intervals: [1000] },
        )
        .toBe(true);
      const initial = service ? container(service) : null,
        peerInitial = peer ? container(peer) : null;
      const outageOffset = controlReadOutages.length;
      const samplers = await Promise.all(pages.map(samplePlayback));
      let id: string;
      if (scenario === "crash-api") {
        const card = control.locator('[data-scenario="crash-api"]');
        await card.getByRole("button").click();
        const dialog = control.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "Inject controlled failure" }),
        ).toBeDisabled();
        await dialog.getByRole("textbox").fill(target);
        await dialog.getByRole("checkbox").check();
        const response = control.waitForResponse(
          (r) =>
            r.url().endsWith("/monitoring/chaos/experiments") &&
            r.request().method() === "POST",
        );
        await dialog
          .getByRole("button", { name: "Inject controlled failure" })
          .click();
        const r = await response;
        expect(r.status()).toBe(201);
        id = (await r.json()).id;
      } else {
        id = randomUUID();
        const r = await post({ id, scenario, confirmation: target });
        expect(r.status(), await r.text()).toBe(201);
      }
      const duplicate = await post({ id, scenario, confirmation: target });
      expect(duplicate.status()).toBe(201);
      expect((await duplicate.json()).id).toBe(id);
      expect(
        (
          await post({
            id: randomUUID(),
            scenario: "crash-api",
            confirmation: "api-1",
          })
        ).status(),
      ).toBe(409);
      await expect
        .poll(
          async () => {
            const e = await find(id);
            if (
              ["FAILED", "TIMED_OUT", "CANCELLED"].includes(e.state) &&
              !e.injectedAt
            )
              throw Error(
                JSON.stringify({
                  state: e.state,
                  reason: e.reason,
                  events: e.events,
                }),
              );
            return !!e.injectedAt;
          },
          {
            timeout: 15000,
            intervals: [500],
          },
        )
        .toBe(true);
      if (["network-timeout", "external-api"].includes(scenario)) {
        await expect
          .poll(
            async () =>
              (
                await (
                  await admin.request.get("/api/v1/monitoring/healing")
                ).json()
              ).circuit.state,
            { timeout: 10000, intervals: [500] },
          )
          .toBe("OPEN");
        const fallback = await admin.request.get(
          "/api/v1/monitoring/dependency-demo",
        );
        expect(fallback.status()).toBe(503);
        const body = await fallback.json();
        expect(body.simulated).toBe(true);
        expect(body.recommendations).toEqual([]);
      }
      if (scenario === "crash-api") {
        await control.reload();
        await expect(
          control.locator('[data-experiment="' + id + '"]'),
        ).toBeVisible();
      }
      if (scenario === "network-timeout") {
        // Fault expiry remains independent while the durable experiment process restarts.
        compose("restart", "chaos-controller");
        socket.disconnect();
        socket.connect();
      }
      await expect
        .poll(
          async () => {
            const e = await find(id);
            return ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(
              e.state,
            )
              ? e.state
              : "RUNNING";
          },
          { timeout: 210000, intervals: [1000] },
        )
        .toBe("COMPLETED");
      const e: ChaosExperiment = await find(id);
      expect(e.faultConfirmedAt).toBeTruthy();
      expect(e.incidentId).toBeTruthy();
      expect(e.recoveryIds.length).toBeGreaterThan(0);
      expect(e.verifiedAt).toBeTruthy();
      expect(e.measurements.detectionMs).not.toBeNull();
      expect(e.measurements.restorationMs).toBeGreaterThan(0);
      expect(e.evidence.independentBehaviorVerified).toBe(true);
      expect(e.evidence.browserPlaybackVerified).toBe(false);
      expect(e.events.some((x) => x.kind === "INCIDENT_DETECTED")).toBe(true);
      expect(e.events.some((x) => x.kind === "SERVICE_VERIFIED")).toBe(true);
      if (service) {
        expect(container(service).Status).toBe("running");
        expect(container(service).StartedAt).not.toBe(initial!.StartedAt);
        expect(e.evidence.healerReceipt).toBe("docker_start_accepted");
        expect(e.evidence.stoppedObserved).toBe(true);
      } else {
        expect(e.cleanup).toBe("COMPLETED");
        expect(e.events.some((x) => x.kind === "CIRCUIT_OPEN")).toBe(true);
      }
      if (peer) expect(container(peer).StartedAt).toBe(peerInitial!.StartedAt);
      for (let i = 0; i < 2; i++) await advances(pages[i]!, i ? 320 : 640);
      if (["crash-api", "crash-redis"].includes(scenario)) {
        first.disconnect();
        second.disconnect();
        first = await socketFor(0, process.env.RESILIENCE_API1_HOST!);
        second = await socketFor(1, process.env.RESILIENCE_API2_HOST!);
      }
      await chat("After " + scenario);
      const playback = await Promise.all(samplers.map((s) => s()));
      await expect
        .poll(async () => (await find(id)).databasePersisted, {
          timeout: 20000,
          intervals: [1000],
        })
        .toBe(true);
      expect(
        db("SELECT id FROM chaos_experiments WHERE id=$1 AND actor=$2", [
          id,
          users[0]!.user.id,
        ]),
      ).toHaveLength(1);
      report.push({
        scenario,
        experiment: await find(id),
        playback,
        controlReadOutages: controlReadOutages.slice(outageOffset),
        peerUnchanged: peer ? true : null,
        decodedStreams: 2,
      });
      console.log(
        "PASS authenticated " +
          scenario +
          "; restoration " +
          e.measurements.restorationMs +
          "ms; actual independent recovery " +
          e.recoveryIds.join(","),
      );
    }
    expect(
      db("SELECT content FROM chat_messages WHERE content=ANY($1)", [messages]),
    ).toHaveLength(messages.length);
    const last = (await state()).experiments.find(
      (e) => e.scenario === "external-api",
    )!;
    await control.goto("/control/chaos");
    await control
      .locator('[data-experiment="' + last.id + '"]')
      .getByRole("link", { name: "Inspect correlated incident" })
      .click();
    await expect(
      control.getByRole("heading", { name: "Correlated recovery attempts" }),
    ).toBeVisible();
    await expect.poll(() => chaosEvents, { timeout: 15000 }).toBeGreaterThan(0);
    await control.goto("/control/demo");
    await control.getByLabel("Demonstration stream").selectOption(streams[0]!);
    await advances(control, 640);
    const captures: string[] = [];
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await control.setViewportSize({ width, height: 1100 });
      await control.screenshot({
        path: "test-results/phase7/demo-" + width + ".png",
        fullPage: true,
        animations: "disabled",
      });
      expect(
        await control.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      captures.push("demo-" + width + ".png");
      await control.goto("/control/chaos");
      await expect(
        control.getByRole("heading", { name: "Chaos Laboratory", exact: true }),
      ).toBeVisible();
      await control.screenshot({
        path: "test-results/phase7/lab-" + width + ".png",
        fullPage: true,
        animations: "disabled",
      });
      expect(
        await control.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      captures.push("lab-" + width + ".png");
      await control.goto("/control/demo");
      await control
        .getByLabel("Demonstration stream")
        .selectOption(streams[0]!);
      await advances(control, 640);
    }
    // The exact same session loses mutation authority immediately after durable role revocation.
    compose(
      "exec",
      "-T",
      "api-2",
      "node",
      "scripts/set-role.mjs",
      "e2e_chaos0_" + suffix,
      "viewer",
    );
    expect((await post(valid)).status()).toBe(403);
    outcome = "PASS";
    report.push({
      security:
        "anonymous/non-admin/CSRF/origin/allowlist/confirmation/fresh-role-revocation PASS",
      durableBrowserRefresh: true,
      controllerRestartDuringFault: true,
      chaosRealtimeEvents: chaosEvents,
      captures,
    });
  } finally {
    for (const service of guarded) compose("start", service);
    sockets.forEach((s) => s.disconnect());
    for (const p of publishers) await stop(p).catch(() => p.kill("SIGTERM"));
    for (const c of contexts) await c.close();
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
    writeFileSync(
      "test-results/phase7/measurements.json",
      JSON.stringify(
        {
          outcome,
          measuredAt: new Date().toISOString(),
          clock:
            "UTC durable event clocks; separate 250ms browser monotonic sampling, 2s stall threshold; REST polling 0.5-1s",
          controlReadOutages,
          latestSnapshot: lastSnapshot,
          experiments: report,
        },
        null,
        2,
      ) + "\n",
    );
  }
});
