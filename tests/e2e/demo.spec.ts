import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import type {
  Publishing,
  ChaosSnapshot,
  ChaosExperiment,
  CapacitySummary,
} from "@streamshield/shared";
import { write } from "./platform-helpers";
test.use({ trace: "off", actionTimeout: 15000, navigationTimeout: 30000 });
const composeArgs = [
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
  "-f",
  ".local/demo/compose.yml",
];
const timeout = 90000,
  origin = new URL(process.env.E2E_BASE_URL!).origin;
const compose = (...args: string[]) =>
  execFileSync("docker", [...composeArgs, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
  });
function operator(body: object) {
  return JSON.parse(
    execFileSync(
      "docker",
      [
        ...composeArgs,
        "exec",
        "-T",
        "api-2",
        "node",
        "--import",
        "tsx",
        "scripts/demo-operator.mjs",
      ],
      {
        input: JSON.stringify(body),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      },
    ),
  );
}
function inside(code: string, input: unknown = {}) {
  return JSON.parse(
    execFileSync(
      "docker",
      [
        ...composeArgs,
        "exec",
        "-T",
        "api-2",
        "node",
        "--input-type=module",
        "-e",
        code,
      ],
      {
        input: JSON.stringify(input),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      },
    ),
  );
}
function db(sql: string, params: unknown[] = []) {
  return inside(
    "const x=JSON.parse((await import('node:fs')).readFileSync(0,'utf8'));const {Pool}=await import('pg');const db=new Pool({host:process.env.POSTGRES_HOST,port:Number(process.env.POSTGRES_PORT),database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD});try{console.log(JSON.stringify((await db.query(x.sql,x.params)).rows));}finally{await db.end();}",
    { sql, params },
  );
}
const publish = (p: Publishing, size: string) =>
  spawn(process.execPath, ["scripts/test-publisher.mjs"], {
    env: {
      ...process.env,
      MEDIA_RTMP_BASE_URL: p.server,
      MEDIA_STREAM_PATH: p.path,
      MEDIA_PUBLISH_USER: p.user,
      MEDIA_PUBLISH_PASSWORD: p.key,
      TEST_PUBLISH_SIZE: size,
      TEST_PUBLISH_DURATION_SECONDS: "600",
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send("stop");
  else child.kill("SIGTERM");
  await expect
    .poll(() => child.exitCode !== null || child.signalCode !== null, {
      timeout: 20000,
    })
    .toBe(true);
}
async function advances(page: Page, width: number) {
  let last = { frames: 0, time: 0 };
  await expect
    .poll(
      async () => {
        const v = await page
          .locator("video")
          .first()
          .evaluate((n) => {
            const v = n as HTMLVideoElement;
            return {
              frames: v.getVideoPlaybackQuality().totalVideoFrames,
              time: v.currentTime,
              width: v.videoWidth,
              playing: !v.paused && v.readyState >= 2,
            };
          })
          .catch(() => null);
        if (!v) return false;
        const good =
          v.width === width &&
          v.playing &&
          v.frames > last.frames &&
          v.time > last.time &&
          last.frames > 0;
        last = v;
        return good;
      },
      { timeout, intervals: [250, 500, 1000] },
    )
    .toBe(true);
}
async function rawSocket(ctx: BrowserContext) {
  const me = await (await ctx.request.get("/api/v1/auth/me")).json();
  const cookie = (await ctx.cookies())
    .map((c) => c.name + "=" + c.value)
    .join("; ");
  const client = io(origin, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 500,
    extraHeaders: { Origin: origin, Cookie: cookie },
    auth: { csrf: me.csrf },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Guest socket connection timeout")),
      15000,
    );
    client.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("connect_error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  return client;
}
function ack(socket: Socket, event: string, data: unknown) {
  return new Promise<{ ok: boolean; data?: unknown; error?: { code: string } }>(
    (resolve) =>
      socket
        .timeout(6000)
        .emit(event, data, (e: Error | null, r: { ok: boolean }) =>
          resolve(e ? { ok: false, error: { code: "ACK_TIMEOUT" } } : r),
        ),
  );
}
function capacity(
  profile: string,
  clients: number,
  duration = 8,
  extra: string[] = [],
) {
  let stdout = "",
    stderr = "";
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/capacity/run.mjs",
      "--profile",
      profile,
      "--clients",
      String(clients),
      "--duration",
      String(duration),
      "--ramp",
      "2",
      "--think-ms",
      "200",
      "--authorize-owned-target",
      ...extra,
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  child.stdout!.on("data", (x) => (stdout += x));
  child.stderr!.on("data", (x) => (stderr += x));
  return {
    child,
    output: () => ({ stdout, stderr }),
    result: async () => {
      await expect
        .poll(() => child.exitCode !== null || child.signalCode !== null, {
          timeout: Math.max(120000, (duration + 20) * 1000),
        })
        .toBe(true);
      if (child.exitCode !== 0)
        throw Error(
          `Capacity ${profile} failed: ${stderr.slice(-2000)} ${stdout.slice(-1000)}`,
        );
      const rows = stdout
        .trim()
        .split("\n")
        .filter((x) => x.startsWith("{"))
        .map((x) => JSON.parse(x));
      const final = rows.findLast((x) => x.resultFile);
      expect(final).toBeTruthy();
      return JSON.parse(readFileSync(final.resultFile, "utf8"));
    },
  };
}
async function screenshot(page: Page, path: string) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    (document.activeElement as HTMLElement | null)?.blur();
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}

test("three real channels, guest isolation, measured capacity and independent healing under load", async ({
  browser,
  request,
}) => {
  test.setTimeout(1500000);
  mkdirSync("test-results/demo", { recursive: true });
  const evidence: {
    status: string;
    capacity50000: string;
    checks: Record<string, unknown>;
    runs: unknown[];
    faults: ChaosExperiment[];
    screenshots: string[];
  } = {
    status: "RUNNING",
    capacity50000: "UNVERIFIED",
    checks: {},
    runs: [],
    faults: [],
    screenshots: [],
  };
  const contexts: BrowserContext[] = [],
    publishers: ChildProcess[] = [],
    sockets: Socket[] = [],
    loadChildren: ChildProcess[] = [];
  try {
    const baseline = await (await request.get("/api/v1/demo/channels")).json();
    expect(baseline.channels).toHaveLength(3);
    expect(
      baseline.channels.every(
        (c: { publisher: string }) => c.publisher !== "online",
      ),
    ).toBe(true);
    const mapping = db(
      "SELECT slot,user_id,channel_id,stream_id FROM demo_channels ORDER BY slot",
    );
    expect(operator({ action: "seed" }).created).toHaveLength(0);
    expect(
      db(
        "SELECT slot,user_id,channel_id,stream_id FROM demo_channels ORDER BY slot",
      ),
    ).toEqual(mapping);
    const keys = [1, 2, 3].map(
      (i) =>
        JSON.parse(
          readFileSync(`.local/demo/streamer-${i}.json`, "utf8"),
        ) as Publishing,
    );
    expect(new Set(keys.map((k) => k.path)).size).toBe(3);
    expect(new Set(keys.map((k) => k.key)).size).toBe(3);
    const publicBody = JSON.stringify(baseline);
    expect(keys.every((k) => !publicBody.includes(k.key))).toBe(true);
    const admin = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL,
    });
    contexts.push(admin);
    const me = await (await admin.request.get("/api/v1/auth/me")).json();
    expect(me.demoMode).toBe(true);
    expect(me.user).toBeNull();
    expect(
      (
        await write(admin.request, me.csrf, "/auth/register", {
          username: "should_not_exist",
          email: "nobody@example.test",
          password: "No-public-signup-42",
        })
      ).status(),
    ).toBe(403);
    expect(
      (await admin.request.get("/api/v1/monitoring/capacity")).status(),
    ).toBe(401);
    const adminPage = await admin.newPage(),
      capability = operator({ action: "admin" });
    await adminPage.goto("/local-access#ticket=" + capability.ticket);
    await expect(
      adminPage.getByRole("heading", {
        name: "Live. Under pressure. Recovering.",
      }),
    ).toBeVisible({ timeout: 30000 });
    expect(adminPage.url()).not.toContain("ticket");
    let adminMe = await (await admin.request.get("/api/v1/auth/me")).json();
    expect(adminMe.user.role).toBe("administrator");
    expect(
      (
        await write(admin.request, adminMe.csrf, "/demo/local-access", {
          ticket: capability.ticket,
        })
      ).status(),
    ).toBe(403);
    const invalid = operator({ action: "admin" });
    db(
      "UPDATE demo_local_tickets SET expires_at=now()-interval '1 second' WHERE consumed_at IS NULL",
    );
    expect(
      (
        await write(admin.request, adminMe.csrf, "/demo/local-access", {
          ticket: invalid.ticket,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await admin.request.post("/api/v1/demo/local-access", {
          headers: { Origin: origin },
          data: { ticket: invalid.ticket },
        })
      ).status(),
    ).toBe(403);
    evidence.checks.privateLocalAccess = {
      oneUse: true,
      expiredDenied: true,
      csrfDenied: true,
      guestAdminDenied: true,
      publicSignupDenied: true,
    };
    const wrong = publish({ ...keys[0]!, path: keys[1]!.path }, "320x180");
    publishers.push(wrong);
    await expect.poll(() => wrong.exitCode, { timeout }).not.toBeNull();
    expect(wrong.exitCode).not.toBe(0);
    for (let i = 0; i < 3; i++)
      publishers.push(publish(keys[i]!, ["640x360", "480x270", "320x180"][i]!));
    for (let i = 0; i < 3; i++)
      await expect
        .poll(
          async () =>
            (
              await (
                await request.get(`/api/v1/streams/streamer-${i + 1}`)
              ).json()
            ).status,
          { timeout },
        )
        .toBe("live");
    const pages: Page[] = [];
    for (let i = 0; i < 4; i++) {
      const ctx = await browser.newContext({
        baseURL: process.env.E2E_BASE_URL,
      });
      contexts.push(ctx);
      const page = await ctx.newPage();
      pages.push(page);
      await page.goto("/watch/streamer-" + (i < 3 ? i + 1 : 1));
      await advances(page, [640, 480, 320, 640][i]!);
      await expect(
        page.getByRole("textbox", { name: "Your message" }),
      ).toBeEnabled({ timeout: 15000 });
    }
    const firstGuest = await (
      await contexts[1]!.request.get("/api/v1/auth/me")
    ).json();
    await pages[0]!.reload();
    expect(
      (await (await contexts[1]!.request.get("/api/v1/auth/me")).json()).guest
        .id,
    ).toBe(firstGuest.guest.id);
    const message = "Independent guest hello " + randomUUID().slice(0, 8);
    await pages[0]!
      .getByRole("textbox", { name: "Your message" })
      .fill(message);
    await pages[0]!.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pages[3]!.getByRole("log")).toContainText(message, {
      timeout: 15000,
    });
    await expect(pages[1]!.getByRole("log")).not.toContainText(message);
    await expect(pages[2]!.getByRole("log")).not.toContainText(message);
    const durable = await (
      await contexts[4]!.request.get(`/api/v1/streams/${keys[0]!.user}/chat`)
    ).json();
    expect(
      durable.messages.some((m: { content: string }) => m.content === message),
    ).toBe(true);
    const crossSender = await rawSocket(contexts[1]!);
    sockets.push(crossSender);
    let crossReceiver = await rawSocket(contexts[4]!);
    sockets.push(crossReceiver);
    const owner = (socket: Socket) =>
      inside(
        `const id=JSON.parse((await import('node:fs')).readFileSync(0,'utf8')).id;const headers={Authorization:'Basic '+Buffer.from('mediamtx:'+process.env.MEDIA_AUTH_SECRET).toString('base64')};let owner=null;for(const host of ['api','api-2']){const r=await fetch('http://'+host+':'+process.env.API_INTERNAL_PORT+'/internal/instance',{headers,signal:AbortSignal.timeout(2000)});const d=await r.json();if(d.socketIds.includes(id))owner=d.instanceId;}console.log(JSON.stringify({owner}));`,
        { id: socket.id },
      ).owner as string | null;
    for (
      let attempt = 0;
      attempt < 8 && owner(crossSender) === owner(crossReceiver);
      attempt++
    ) {
      crossReceiver.disconnect();
      await request.get("/api/v1/health/live");
      crossReceiver = await rawSocket(contexts[4]!);
      sockets.push(crossReceiver);
    }
    expect(owner(crossSender)).toBeTruthy();
    expect(owner(crossReceiver)).not.toBe(owner(crossSender));
    expect(
      (await ack(crossSender, "join", { streamId: keys[0]!.user })).ok,
    ).toBe(true);
    expect(
      (await ack(crossReceiver, "join", { streamId: keys[0]!.user })).ok,
    ).toBe(true);
    const sendAcross = async (content: string) => {
      const received = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          crossReceiver.off("message", listener);
          reject(Error("Cross-API guest delivery missing"));
        }, 10000);
        const listener = (m: { content: string }) => {
          if (m.content === content) {
            clearTimeout(timer);
            crossReceiver.off("message", listener);
            resolve();
          }
        };
        crossReceiver.on("message", listener);
      });
      expect(
        (
          await ack(crossSender, "message", {
            streamId: keys[0]!.user,
            content,
          })
        ).ok,
      ).toBe(true);
      await received;
    };
    await sendAcross(
      "Actual cross-API guest delivery " + randomUUID().slice(0, 8),
    );
    evidence.checks.crossApiGuestDelivery = {
      sender: owner(crossSender),
      receiver: owner(crossReceiver),
      delivered: true,
    };
    const raw = await rawSocket(contexts[2]!);
    sockets.push(raw);
    expect((await ack(raw, "join", { streamId: keys[1]!.user })).ok).toBe(true);
    expect(
      (
        await ack(raw, "message", {
          streamId: keys[0]!.user,
          content: "Cross-room denial",
        })
      ).error?.code,
    ).toBe("ROOM_REQUIRED");
    expect(
      (
        await ack(raw, "message", {
          streamId: keys[1]!.user,
          content: "x".repeat(1001),
        })
      ).error?.code,
    ).toBe("INVALID_MESSAGE");
    const literal = "<img src=x onerror=alert(1)>";
    expect(
      (await ack(raw, "message", { streamId: keys[1]!.user, content: literal }))
        .ok,
    ).toBe(true);
    await expect(pages[1]!.getByRole("log")).toContainText(literal);
    expect(await pages[1]!.getByRole("log").locator("img").count()).toBe(0);
    const attempts = [];
    for (let i = 0; i < 12; i++)
      attempts.push(
        await ack(raw, "message", {
          streamId: keys[1]!.user,
          content: "Guest throttle verification " + i,
        }),
      );
    expect(attempts.some((a) => a.error?.code === "RATE_LIMITED")).toBe(true);
    const home = pages[3]!;
    await home.goto("/");
    await expect(home.locator(".three-channel-card")).toHaveCount(3);
    await expect(home.getByText(/Sign In|Sign Up|Login|Register/i)).toHaveCount(
      0,
    );
    await home.goto("/login");
    await expect(home).toHaveURL(origin + "/");
    await expect(home.locator("form")).toHaveCount(0);
    evidence.checks.threeChannels = {
      idempotent: true,
      uniquePaths: true,
      uniqueCredentials: true,
      guestContinuity: true,
      wrongPublishingKeyDenied: true,
      decodedWidths: [640, 480, 320],
      roomIsolation: true,
      guestChatDurable: true,
      plainTextEncoding: true,
      guestThrottling: true,
      noPublicLogin: true,
    };
    for (const [profile, clients] of [
      ["api", 20],
      ["socket", 100],
      ["chat", 12],
      ["hls", 6],
      ["browser", 3],
    ] as const) {
      const run = capacity(profile, clients, profile === "browser" ? 12 : 10);
      loadChildren.push(run.child);
      const result = await run.result();
      evidence.runs.push(result);
      expect(result.measurements.stopReason).toBe("deadline");
      expect(result.measurements.peak).toBeGreaterThan(0);
      if (profile === "api" || profile === "hls") {
        expect(result.measurements.requests).toBeGreaterThan(0);
        expect(result.measurements.bytes).toBeGreaterThan(0);
        expect(
          result.measurements.errors / result.measurements.requests,
        ).toBeLessThan(0.05);
      }
      if (profile === "socket") expect(result.measurements.peak).toBe(100);
      if (profile === "chat") {
        expect(result.measurements.delivered).toBeGreaterThan(0);
        expect(result.measurements.messages).toBeGreaterThan(0);
      }
      if (profile === "browser")
        expect(result.measurements.verifiedBrowsers).toBe(3);
      const server = (
        await (await admin.request.get("/api/v1/monitoring/capacity")).json()
      ).runs.find((r: CapacitySummary) => r.id === result.runId);
      expect(server.requests).toBe(result.measurements.requests);
      expect(server.targetClients).toBe(clients);
      expect(server.state).toBe("COMPLETED");
    }
    expect(
      db(
        "SELECT count(*) AS n FROM chat_messages WHERE content LIKE '[SYNTHETIC]%' ",
      )[0].n,
    ).toBe("0");
    // A finite grant is scoped to one worker allocation and report-only authority.
    const grant = operator({
        action: "capacity-create",
        authorizedDistributed: false,
        config: {
          profile: "api",
          clients: 2,
          duration: 5,
          ramp: 1,
          distributed: false,
          chatPerSecond: 0,
          target: origin,
        },
      }),
      headers = { Origin: origin, Authorization: "Bearer " + grant.token };
    const worker = randomUUID();
    expect(
      (
        await request.post("/api/v1/capacity/agent/register", {
          headers,
          data: { id: worker, clients: 2 },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await request.post("/api/v1/capacity/agent/register", {
          headers,
          data: { id: randomUUID(), clients: 1 },
        })
      ).status(),
    ).toBe(409);
    expect(
      (await request.get("/api/v1/monitoring/capacity", { headers })).status(),
    ).toBe(401);
    const report = {
      seq: 1,
      active: 2,
      peak: 2,
      requests: 1,
      errors: 0,
      bytes: 12,
      connections: 0,
      connectionFailures: 0,
      joinFailures: 0,
      disconnects: 0,
      reconnects: 0,
      messages: 0,
      delivered: 0,
      deliveryFailures: 0,
      verifiedBrowsers: 0,
      stalls: 0,
      startupMs: null,
      requestHistogram: [1, ...Array(16).fill(0)],
      deliveryHistogram: Array(17).fill(0),
      generatorCpuPercent: 1,
      generatorRssBytes: 1000,
      finished: false,
      stopReason: "running",
    };
    expect(
      (
        await request.post(`/api/v1/capacity/agent/${worker}/report`, {
          headers,
          data: { ...report, active: 3 },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await request.post(`/api/v1/capacity/agent/${worker}/report`, {
          headers,
          data: report,
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await request.post(`/api/v1/capacity/agent/${worker}/report`, {
          headers,
          data: report,
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await request.post(`/api/v1/capacity/agent/${worker}/report`, {
          headers,
          data: {
            ...report,
            seq: 1,
            requests: 2,
            requestHistogram: [2, ...Array(16).fill(0)],
          },
        })
      ).status(),
    ).toBe(409);
    operator({ action: "capacity-stop", id: grant.id });
    expect(
      (
        await request.post(`/api/v1/capacity/agent/${worker}/report`, {
          headers,
          data: { ...report, seq: 2 },
        })
      ).status(),
    ).toBe(403);
    evidence.checks.capacitySecurity = {
      allocationCap: true,
      reportIdentity: true,
      duplicateReportIdempotent: true,
      conflictingSequenceDenied: true,
      grantCannotAdminister: true,
      stoppedGrantRejected: true,
      syntheticNotPersisted: true,
    };
    const continuous = capacity("api", 20, 240, ["--think-ms", "500"]);
    loadChildren.push(continuous.child);
    await expect
      .poll(
        async () =>
          (
            (
              await (
                await admin.request.get("/api/v1/monitoring/capacity")
              ).json()
            ).runs as CapacitySummary[]
          ).some(
            (r) =>
              r.state === "RUNNING" &&
              r.actualActive !== null &&
              r.freshWorkers > 0 &&
              r.requests > 0,
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    const state = async () => {
      const response = await admin.request.get("/api/v1/monitoring/chaos");
      return response.ok() ? ((await response.json()) as ChaosSnapshot) : null;
    };
    const restarted: Record<string, unknown>[] = [];
    for (const scenario of [
      "crash-api",
      "crash-edge",
      "crash-primary",
      "crash-redis",
      "network-timeout",
    ]) {
      await expect
        .poll(
          async () => {
            const s = await state();
            return s?.scenarios.find((x) => x.id === scenario)?.available;
          },
          { timeout: 150000, intervals: [1000, 2000] },
        )
        .toBe(true);
      const s = (await state())!,
        policy = s.scenarios.find((x) => x.id === scenario)!,
        id = randomUUID();
      adminMe = await (await admin.request.get("/api/v1/auth/me")).json();
      const service = (
        {
          "crash-api": "api",
          "crash-edge": "edge-1",
          "crash-primary": "origin-primary",
          "crash-redis": "redis",
        } as Record<string, string>
      )[scenario];
      const containerId = service
        ? compose("ps", "-a", "-q", service).trim()
        : null;
      const before = containerId
        ? execFileSync(
            "docker",
            ["inspect", "--format", "{{.State.StartedAt}}", containerId],
            { encoding: "utf8" },
          ).trim()
        : null;
      const created = await write(
        admin.request,
        adminMe.csrf,
        "/monitoring/chaos/experiments",
        { id, scenario, confirmation: policy.target },
      );
      expect(
        created.status(),
        "Real fault must be admitted through the same API as confirmation",
      ).toBe(201);
      await expect
        .poll(
          async () => {
            const snap = await state(),
              e = snap?.experiments.find((x) => x.id === id);
            return e && ["COMPLETED", "FAILED", "TIMED_OUT"].includes(e.state)
              ? e.state
              : "pending";
          },
          { timeout: 200000, intervals: [1000, 2000] },
        )
        .toBe("COMPLETED");
      const e = (await state())!.experiments.find((x) => x.id === id)!;
      expect(e.incidentId).toBeTruthy();
      if (containerId) {
        const after = JSON.parse(
          execFileSync(
            "docker",
            ["inspect", "--format", "{{json .State}}", containerId],
            { encoding: "utf8" },
          ),
        );
        expect(after.Running).toBe(true);
        expect(after.StartedAt).not.toBe(before);
        restarted.push({ service, before, after: after.StartedAt });
      }
      evidence.faults.push(e);
      if (scenario === "crash-redis") {
        await expect
          .poll(() => crossSender.connected && crossReceiver.connected, {
            timeout: 30000,
          })
          .toBe(true);
        await sendAcross(
          "Guest delivery after Redis recovery " + randomUUID().slice(0, 8),
        );
        evidence.checks.guestRedisReconnection = true;
      }
      for (let i = 0; i < 3; i++)
        await advances(pages[i]!, [640, 480, 320][i]!);
      const run = (
        await (await admin.request.get("/api/v1/monitoring/capacity")).json()
      ).runs.find((r: CapacitySummary) => r.state === "RUNNING");
      expect(run?.requests).toBeGreaterThan(0);
    }
    evidence.checks.actualContainerRestarts = restarted;
    await stop(continuous.child);
    const continuousResult = await continuous.result();
    evidence.runs.push(continuousResult);
    expect(continuousResult.measurements.stopReason).toBe("signal");
    // Stop only our test-owned third publisher; the other two sources must remain live.
    await stop(publishers[3]!);
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/streams/streamer-3")).json())
            .status,
        { timeout },
      )
      .toBe("offline");
    for (const slot of [1, 2])
      expect(
        (await (await request.get("/api/v1/streams/streamer-" + slot)).json())
          .status,
      ).toBe("live");
    evidence.checks.independentSourceStop = true;
    // Key rotation affects only one owned source, then its new publisher returns.
    const rotated = operator({ action: "rotate", slot: 3 });
    expect(rotated.key === keys[2]!.key).toBe(false);
    const oldKeyAttempt = publish(keys[2]!, "320x180");
    publishers.push(oldKeyAttempt);
    await expect.poll(() => oldKeyAttempt.exitCode, { timeout }).not.toBeNull();
    expect(oldKeyAttempt.exitCode).not.toBe(0);
    const returning = publish({ ...keys[2]!, ...rotated }, "320x180");
    publishers.push(returning);
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/streams/streamer-3")).json())
            .status,
        { timeout },
      )
      .toBe("live");
    await advances(pages[2]!, 320);
    const visible = await (await request.get("/api/v1/demo/channels")).json();
    expect(
      visible.channels.filter((c: { status: string }) => c.status === "live"),
    ).toHaveLength(3);
    // Update only this test's private generated credential file after explicit rotation.
    writeFileSync(
      ".local/demo/streamer-3.json",
      JSON.stringify({ ...keys[2]!, ...rotated, server: keys[2]!.server }),
      { mode: 0o600 },
    );
    evidence.checks.keyRotation = {
      previousKeyRevoked: true,
      otherChannelsUnaffected: true,
    };
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await home.setViewportSize({ width, height: 1100 });
      await home.goto("/");
      await expect(home.locator(".three-channel-card")).toHaveCount(3);
      const homePath = `test-results/demo/home-${width}.png`;
      await screenshot(home, homePath);
      evidence.screenshots.push(homePath);
      await adminPage.setViewportSize({ width, height: 1100 });
      await adminPage.goto("/control/three-stream-demo");
      await expect(adminPage.locator(".three-preview")).toHaveCount(3);
      await expect
        .poll(async () => adminPage.locator(".three-preview video").count(), {
          timeout,
        })
        .toBe(3);
      const demoPath = `test-results/demo/presentation-${width}.png`;
      await screenshot(adminPage, demoPath);
      evidence.screenshots.push(demoPath);
      await adminPage.goto("/control/capacity");
      await expect(
        adminPage.getByRole("heading", {
          name: "Measure the load. Know the limit.",
        }),
      ).toBeVisible();
      await expect(adminPage.locator(".capacity-run").first()).toBeVisible();
      const capacityPath = `test-results/demo/capacity-${width}.png`;
      await screenshot(adminPage, capacityPath);
      evidence.screenshots.push(capacityPath);
    }
    evidence.checks.history = db(
      "SELECT d.slot,count(h.id)::int AS observations FROM demo_channels d LEFT JOIN demo_broadcast_history h ON h.stream_id=d.stream_id GROUP BY d.slot ORDER BY d.slot",
    );
    evidence.checks.preservedRows = db(
      "SELECT (SELECT count(*) FROM demo_channels)::int AS demo_channels,(SELECT count(*) FROM users)::int AS retained_users,(SELECT count(*) FROM chat_messages WHERE guest_id IS NOT NULL)::int AS actual_guest_messages",
    );
    evidence.checks.physicalDevices =
      "Three independent genuine FFmpeg publishers verified on Linux; three separate physical laptops/Windows firewall were not available for execution.";
    evidence.status = "PASS";
  } finally {
    writeFileSync(
      "test-results/demo/measurements.json",
      JSON.stringify(
        {
          ...evidence,
          measuredAt: new Date().toISOString(),
          measurementDefinitions: {
            capacity:
              "Requested allocation differs from actual generator concurrency; no 50k verification",
            http: "Completed HTTP requests; generator-controlled shutdown aborts excluded",
            browser:
              "Actual advancing decoded frames in Chromium; 2s gap threshold in smaller browser profile",
            chat: "First independent same-room recipient, explicitly labelled synthetic traffic; ephemeral load messages",
            faults:
              "Original observer/Healer clocks and independent Chaos verification while API workload remains active",
          },
        },
        null,
        2,
      ),
    );
    for (const child of loadChildren) await stop(child);
    for (const s of sockets) s.disconnect();
    for (const p of publishers) await stop(p);
    for (const c of contexts) await c.close();
  }
});
