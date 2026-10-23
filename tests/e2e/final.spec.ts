import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpus, totalmem, platform, release } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { io, type Socket } from "socket.io-client";
import type {
  ChaosExperiment,
  ChaosScenarioId,
  ChaosSnapshot,
  HealingSnapshot,
  Publishing,
  RecoveryAttempt,
} from "@streamshield/shared";
import { account, write } from "./platform-helpers";
// @ts-expect-error -- plain ESM helper shared with the CLI tooling.
import { startViewer } from "../../scripts/final/hls-viewer.mjs";

/**
 * Final self-healing suite. Every fault goes through the real admin API; only
 * the independent Healer repairs. This file never starts, restarts, unpauses or
 * signals a container: `docker` is used read-only (inspect/ps/exec of the
 * role/diagnostic scripts) and for the documented admin-role helper.
 */
test.use({ trace: "off", actionTimeout: 15000, navigationTimeout: 25000 });
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
  "-f",
  ".local/dynamic/compose.yml",
];
const base = process.env.E2E_BASE_URL!;
const out = "test-results/final";
const shots = "docs/screenshots/final";
const rounds = Number(process.env.FINAL_ROUNDS || 2);
const only = (process.env.FINAL_SCENARIOS || "").split(",").filter(Boolean);
function compose(...rest: string[]) {
  return execFileSync("docker", [...args, ...rest], {
    encoding: "utf8",
    timeout: 60000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
/** Read-only Docker facts: proof that a real restart happened (StartedAt). */
function container(service: string) {
  const id = compose("ps", "-a", "-q", service).trim();
  const s = JSON.parse(
    execFileSync("docker", ["inspect", "--format", "{{json .State}}", id], {
      encoding: "utf8",
    }),
  );
  return {
    status: s.Status as string,
    startedAt: s.StartedAt as string,
    exitCode: s.ExitCode as number,
  };
}
const serviceOf: Record<string, string> = {
  "api-1": "api",
  "api-2": "api-2",
  redis: "redis",
  "video-gateway": "video-gateway",
  relay: "mediamtx",
  "edge-1": "edge-1",
  "origin-primary": "origin-primary",
  // The surge's Healer action changes the spare.
  "api-tier": "api-3",
};
function diag(host: string) {
  return JSON.parse(
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
        `const r=await fetch('http://${host}:'+process.env.API_INTERNAL_PORT+'/internal/instance',{headers:{Authorization:'Basic '+Buffer.from('mediamtx:'+process.env.MEDIA_AUTH_SECRET).toString('base64')},signal:AbortSignal.timeout(2000)});console.log(JSON.stringify(await r.json()));`,
      ],
      { encoding: "utf8", timeout: 15000 },
    ),
  ) as { socketIds: string[] };
}
/** RTMP publisher that reconnects by itself, like OBS's auto-reconnect. */
function publisher(key: Publishing, size: string) {
  let child: ChildProcess | undefined,
    stopped = false,
    rotating = false,
    startedAt = 0;
  const reconnects: string[] = [];
  const run = () => {
    startedAt = Date.now();
    child = spawn(process.execPath, ["scripts/test-publisher.mjs"], {
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
    child.on("exit", () => {
      if (stopped || rotating) return;
      reconnects.push(new Date().toISOString());
      setTimeout(run, 1000);
    });
  };
  run();
  return {
    reconnects,
    /**
     * The synthetic publisher is capped at 600 s. Rotate it between experiments,
     * while everything is healthy, so its cap never lands inside a fault window
     * (a republish during an API outage cannot authenticate). Not a reconnect.
     */
    async rotate(maxAgeMs: number) {
      if (stopped || Date.now() - startedAt < maxAgeMs || !child) return false;
      rotating = true;
      const exited = new Promise((r) => child!.once("exit", r));
      if (child.connected) child.send("stop");
      else child.kill("SIGTERM");
      await exited;
      rotating = false;
      run();
      return true;
    },
    async stop() {
      stopped = true;
      if (child && child.exitCode === null) {
        if (child.connected) child.send("stop");
        else child.kill("SIGTERM");
      }
    },
  };
}
async function emit(socket: Socket, event: string, body: object, ms = 8000) {
  return new Promise<{ ok: boolean }>((resolve, reject) =>
    socket
      .timeout(ms)
      .emit(event, body, (error: Error | null, result: { ok: boolean }) =>
        error ? reject(error) : resolve(result),
      ),
  );
}
const iso = () => new Date().toISOString();
test("final: five-plus verified self-healing scenarios with visible user impact", async ({
  browser,
}) => {
  test.setTimeout(Number(process.env.FINAL_TIMEOUT_MS || 5400000));
  mkdirSync(out, { recursive: true });
  mkdirSync(shots, { recursive: true });
  const suffix = randomUUID().slice(0, 6);
  const contexts: BrowserContext[] = [];
  const publishers: ReturnType<typeof publisher>[] = [];
  const sockets: Socket[] = [];
  const viewers: ReturnType<typeof startViewer>[] = [];
  const runs: Record<string, unknown>[] = [];
  const safety: Record<string, unknown> = {};
  const measurements = {
    generatedAt: iso(),
    machine: {
      platform: platform() + " " + release(),
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      docker: execFileSync(
        "docker",
        ["version", "--format", "{{.Server.Version}}"],
        {
          encoding: "utf8",
        },
      ).trim(),
    },
    method:
      "Faults through the real admin API; repairs only by the independent Healer. Timestamps are stored experiment/attempt timestamps; video is decoded by ffprobe from the public HLS path (labelled), chat via Socket.IO pinned to api-1 and api-2, latency via real requests through the web origin.",
    runs,
    safety,
  };
  const save = () =>
    writeFileSync(
      out + "/measurements.json",
      JSON.stringify(measurements, null, 2),
    );
  try {
    // ---------- Accounts: Rashi broadcasts and administers, Lakshita watches ----------
    for (let i = 0; i < 2; i++) contexts.push(await browser.newContext());
    const [rashiCtx, lakshitaCtx] = contexts as [
      BrowserContext,
      BrowserContext,
    ];
    const rashi = await account(
      rashiCtx.request,
      "rashi_" + suffix,
      "Final-demo-password-42",
    );
    const lakshita = await account(
      lakshitaCtx.request,
      "lakshita_" + suffix,
      "Final-demo-password-42",
    );
    // Safety: guests and non-admins are refused before any role change.
    const guest = await browser.newContext();
    contexts.push(guest);
    safety.guestTimeline = (
      await guest.request.get(
        "/api/v1/monitoring/timeline?from=2026-01-01T00:00:00Z&to=2026-01-01T01:00:00Z",
      )
    ).status();
    safety.guestChaos = (
      await guest.request.get("/api/v1/monitoring/chaos")
    ).status();
    safety.nonAdminChaos = (
      await rashiCtx.request.get("/api/v1/monitoring/chaos")
    ).status();
    safety.nonAdminHealing = (
      await lakshitaCtx.request.get("/api/v1/monitoring/healing")
    ).status();
    expect(safety.guestTimeline).toBe(401);
    expect(safety.guestChaos).toBe(401);
    expect(safety.nonAdminChaos).toBe(403);
    expect(safety.nonAdminHealing).toBe(403);
    compose(
      "exec",
      "-T",
      "api-2",
      "node",
      "scripts/set-role.mjs",
      "rashi_" + suffix,
      "administrator",
    );
    const admin = rashiCtx.request,
      csrf = rashi.csrf;
    safety.noCsrf = (
      await admin.post("/api/v1/monitoring/chaos/experiments", {
        data: {
          id: randomUUID(),
          scenario: "crash-redis",
          confirmation: "redis",
        },
      })
    ).status();
    safety.unknownScenario = (
      await write(admin, csrf, "/monitoring/chaos/experiments", {
        id: randomUUID(),
        scenario: "drop-database",
        confirmation: "postgres",
      })
    ).status();
    safety.disabledDatabase = (
      await write(admin, csrf, "/monitoring/chaos/experiments", {
        id: randomUUID(),
        scenario: "database-outage",
        confirmation: "postgres",
      })
    ).status();
    expect(safety.noCsrf).toBe(403);
    expect(safety.unknownScenario).toBe(400);
    expect([400, 409]).toContain(safety.disabledDatabase);
    // ---------- Two real channels and FFmpeg publishers ----------
    const streams: { id: string; key: Publishing }[] = [];
    for (const [i, ctx] of [rashiCtx, lakshitaCtx].entries()) {
      const token = i ? lakshita.csrf : csrf;
      expect(
        (
          await write(ctx.request, token, "/channels", {
            slug: (i ? "lakshita-" : "rashi-") + suffix,
            displayName: i ? "Lakshita Live" : "Rashi Live",
            description: "Final self-healing demonstration source",
          })
        ).status(),
      ).toBe(201);
      const channel = (
        await (await ctx.request.get("/api/v1/studio/channel")).json()
      ).channel;
      const created = await write(ctx.request, token, "/studio/streams", {
        channelId: channel.id,
        title: i ? "Lakshita second source" : "Rashi live studio",
        description: "Real FFmpeg publisher",
      });
      expect(created.status()).toBe(201);
      const id = (await created.json()).id;
      const key = (await (
        await write(ctx.request, token, "/studio/streams/" + id + "/publishing")
      ).json()) as Publishing;
      streams.push({ id, key });
      publishers.push(publisher(key, i ? "320x180" : "640x360"));
    }
    const [main] = streams as [{ id: string; key: Publishing }];
    await expect
      .poll(
        async () =>
          (
            await (
              await lakshitaCtx.request.get("/api/v1/streams/" + main.id)
            ).json()
          ).status,
        {
          timeout: 90000,
          intervals: [1000],
        },
      )
      .toBe("live");
    for (const s of streams) {
      const meta = await (
        await lakshitaCtx.request.get("/api/v1/streams/" + s.id)
      ).json();
      viewers.push(
        startViewer({
          base,
          sources: [
            { id: "primary", url: meta.playbackUrl },
            ...(meta.playbackSources || [])
              .filter((x: { id: string }) => x.id === "standby")
              .map((x: { url: string }) => ({ id: "standby", url: x.url })),
          ],
        }),
      );
    }
    const viewer = viewers[0]!;
    await expect
      .poll(() => viewer.state.frames, { timeout: 60000 })
      .toBeGreaterThan(60);
    // Keys never leak into monitoring evidence.
    const now = Date.now();
    const timelineText = await (
      await admin.get(
        "/api/v1/monitoring/timeline?from=" +
          new Date(now - 3600000).toISOString() +
          "&to=" +
          new Date(now).toISOString(),
      )
    ).text();
    safety.keyInTimeline = streams.some((s) =>
      timelineText.includes(s.key.key),
    );
    expect(safety.keyInTimeline).toBe(false);
    // ---------- Viewer page (Lakshita) and presentation (Rashi) ----------
    const watch = await lakshitaCtx.newPage();
    await watch.setViewportSize({ width: 1280, height: 900 });
    await watch.goto("/watch/" + main.id);
    await expect(watch.getByTestId("chat-status")).toHaveAttribute(
      "data-status",
      "Connected",
      { timeout: 30000 },
    );
    const presentation = await rashiCtx.newPage();
    await presentation.setViewportSize({ width: 1920, height: 1080 });
    await presentation.goto("/control/presentation");
    await expect(
      presentation.getByRole("heading", { name: "Break it. Watch it heal." }),
    ).toBeVisible();
    // Browser codec capability decides whether in-browser decode can be asserted.
    const browserH264 = await watch.evaluate(() =>
      MediaSource.isTypeSupported('video/mp4; codecs="avc1.42c01e"'),
    );
    (measurements as Record<string, unknown>).browserH264 = browserH264;
    // ---------- Chat sockets pinned to api-1 and api-2 ----------
    const socketFor = async (
      ctx: BrowserContext,
      token: string,
      host: string,
    ) => {
      const cookie = (await ctx.cookies())
        .map((c) => c.name + "=" + c.value)
        .join("; ");
      for (let attempt = 0; attempt < 12; attempt++) {
        const s = io(base, {
          transports: ["websocket"],
          extraHeaders: { Origin: new URL(base).origin, Cookie: cookie },
          auth: { csrf: token },
          autoConnect: false,
          reconnectionDelay: 500,
          reconnectionDelayMax: 3000,
        });
        sockets.push(s);
        await new Promise<void>((resolve, reject) => {
          s.once("connect", resolve);
          s.once("connect_error", reject);
          s.connect();
        });
        if (diag(host).socketIds.includes(s.id!)) {
          s.on(
            "connect",
            () => void emit(s, "join", { streamId: main.id }).catch(() => {}),
          );
          expect((await emit(s, "join", { streamId: main.id })).ok).toBe(true);
          return s;
        }
        s.disconnect();
      }
      throw Error("No socket pinned to " + host);
    };
    let first = await socketFor(
      rashiCtx,
      csrf,
      process.env.RESILIENCE_API1_HOST!,
    );
    let second = await socketFor(
      lakshitaCtx,
      lakshita.csrf,
      process.env.RESILIENCE_API2_HOST!,
    );
    const crossChat = async (label: string, timeoutMs = 8000) => {
      const content = label + " " + suffix + " " + Date.now();
      const received = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        const on = (m: { content?: string }) => {
          if (m?.content === content) {
            clearTimeout(timer);
            first.off("message", on);
            resolve(true);
          }
        };
        first.on("message", on);
      });
      const accepted = await emit(
        second,
        "message",
        { streamId: main.id, content },
        timeoutMs,
      ).then(
        (r) => r.ok,
        () => false,
      );
      return { accepted, delivered: accepted && (await received), content };
    };
    expect((await crossChat("baseline")).delivered).toBe(true);
    // ---------- Experiment driver ----------
    /** Admin JSON read that tolerates the brief 502s an experiment itself causes. */
    const getJson = async <T>(path: string): Promise<T> => {
      let last: unknown;
      for (let i = 0; i < 20; i++) {
        try {
          const r = await admin.get("/api/v1" + path, { timeout: 8000 });
          if (r.ok()) return (await r.json()) as T;
          if ([401, 403].includes(r.status()))
            throw Error("admin denied " + r.status());
          last = r.status();
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("admin denied"))
            throw e;
          last = e;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw Error("Admin read unavailable: " + path + " " + String(last));
    };
    const chaos = () => getJson<ChaosSnapshot>("/monitoring/chaos");
    const healing = () => getJson<HealingSnapshot>("/monitoring/healing");
    const waitAdmissible = async (id: ChaosScenarioId) => {
      const started = Date.now();
      let reason: string | null = "unknown";
      while (Date.now() - started < 15 * 60000) {
        try {
          const s = (await chaos()).scenarios.find((x) => x.id === id)!;
          if (s.available) return Date.now() - started;
          reason = s.reason;
        } catch {
          reason = "chaos state unavailable";
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw Error(id + " never became admissible: " + reason);
    };
    const run = async (
      round: number,
      scenario: ChaosScenarioId,
      confirmation: string,
      targets: string[],
      during: (
        e: () => Promise<ChaosExperiment>,
      ) => Promise<Record<string, unknown>>,
      after: () => Promise<Record<string, unknown>>,
    ) => {
      if (only.length && !only.includes(scenario)) return;
      let rotated = false;
      for (const p of publishers) rotated = (await p.rotate(300000)) || rotated;
      if (rotated) {
        const mark = viewer.snapshot();
        await expect
          .poll(() => viewer.state.frames - mark.frames, {
            timeout: 60000,
            intervals: [1000],
          })
          .toBeGreaterThan(30);
      }
      let waitedMs = 0;
      let before: Record<string, ReturnType<typeof container>>;
      let framesBefore: ReturnType<typeof viewer.snapshot>;
      const id = randomUUID();
      // Admission is re-checked server-side at POST time; a component that
      // flaps between the poll and the POST is refused (409) and we wait again.
      for (let tries = 1; ; tries++) {
        waitedMs += await waitAdmissible(scenario);
        before = Object.fromEntries(
          targets.map((t) => [t, container(serviceOf[t]!)]),
        );
        for (const t of targets)
          if (scenario !== "traffic-surge")
            expect(before[t]!.status).toBe("running");
          else expect(before[t]!.status).not.toBe("running");
        framesBefore = viewer.snapshot();
        const r = await write(admin, csrf, "/monitoring/chaos/experiments", {
          id,
          scenario,
          confirmation,
        });
        if (r.status() === 201) break;
        const body = await r.text();
        console.log(scenario, "admission", r.status(), body.slice(0, 300));
        expect(
          r.status() === 409 && tries < 4,
          scenario + " admission " + r.status() + " " + body.slice(0, 300),
        ).toBe(true);
      }
      const find = async () =>
        (await chaos()).experiments.find((x) => x.id === id)!;
      const visible = await during(find);
      let e: ChaosExperiment | undefined;
      await expect
        .poll(
          async () => {
            try {
              e = await find();
            } catch {
              return "running";
            }
            return e &&
              ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(
                e.state,
              )
              ? e.state
              : "running";
          },
          { timeout: 300000, intervals: [1000] },
        )
        .not.toBe("running");
      const attempts = (await healing()).attempts.filter((a) =>
        e!.recoveryIds.includes(a.id),
      );
      const afterState = Object.fromEntries(
        targets.map((t) => [t, container(serviceOf[t]!)]),
      );
      const visibleAfter = await after();
      const record = {
        round,
        scenario,
        experimentId: id,
        state: e!.state,
        reason: e!.reason,
        waitedForAdmissionMs: waitedMs,
        timestamps: {
          created: e!.createdAt,
          injected: e!.injectedAt,
          faultConfirmed: e!.faultConfirmedAt,
          incidentDetected: e!.incidentDetectedAt,
          actionStarted: e!.actionStartedAt,
          actionFinished: e!.actionFinishedAt,
          verified: e!.verifiedAt,
          finished: e!.finishedAt,
        },
        measurements: e!.measurements,
        attempts: attempts.map((a: RecoveryAttempt) => ({
          component: a.component,
          playbook: a.playbook,
          action: a.action,
          diagnosis: a.diagnosis,
          failureCode: a.evidence.failureCode ?? null,
          corroboration: a.evidence.corroboration ?? null,
          containerStateBefore: a.evidence.containerState ?? null,
          receipt: a.evidence.controlReceipt ?? null,
          state: a.state,
          number: a.number,
          detectedAt: a.detectedAt,
          actionStartedAt: a.actionStartedAt,
          actionFinishedAt: a.actionFinishedAt,
          verificationStartedAt: a.verificationStartedAt,
          finishedAt: a.finishedAt,
          verification: Object.fromEntries(
            Object.entries(a.evidence).filter(([k]) =>
              /verif|gateway|progress|livePaths|readiness|Listener|relayApi|authenticated|media/i.test(
                k,
              ),
            ),
          ),
        })),
        docker: { before, after: afterState },
        evidence: e!.evidence,
        visible: { ...visible, ...visibleAfter },
      };
      runs.push(record);
      save();
      expect(e!.state, scenario + ": " + e!.reason).toBe("COMPLETED");
      for (const t of targets) {
        // The spare is scaled in again (stopped) after a surge.
        if (scenario !== "traffic-surge")
          expect(afterState[t]!.status).toBe("running");
        // A real start: Docker reports a new StartedAt, and nobody but the Healer acted.
        expect(afterState[t]!.startedAt).not.toBe(before[t]!.startedAt);
      }
      // One attempt per target (plus the scale-in for a surge).
      expect(attempts.length).toBeGreaterThanOrEqual(targets.length);
      // Decoded video advances after the repair (ffprobe-decoded frames).
      const mark = viewer.snapshot();
      await expect
        .poll(() => viewer.state.frames - mark.frames, {
          timeout: 60000,
          intervals: [1000],
        })
        .toBeGreaterThan(30);
      record.visible = {
        ...record.visible,
        framesDecodedDuringExperiment: mark.frames - framesBefore.frames,
      };
      save();
      return { e: e!, attempts, record };
    };
    const stallsSince = (since: number) =>
      viewer.state.stalls.filter(
        (s: { from: string }) => Date.parse(s.from) >= since - 5000,
      );
    const presentationShot = async (name: string) =>
      presentation
        .screenshot({ path: `${shots}/${name}.png`, fullPage: false })
        .catch(() => undefined);
    for (let round = 1; round <= rounds; round++) {
      // 1. Redis: chat breaks across instances, video keeps playing.
      await run(
        round,
        "crash-redis",
        "redis",
        ["redis"],
        async (find) => {
          await expect
            .poll(async () => (await find())?.faultConfirmedAt ?? null, {
              timeout: 30000,
            })
            .not.toBeNull();
          const at = Date.now();
          const outage = await crossChat("during-redis-outage", 5000);
          let banner: string | null = null;
          await expect
            .poll(
              async () => {
                banner = await watch
                  .getByTestId("chat-status")
                  .getAttribute("data-status");
                return banner !== "Connected";
              },
              { timeout: 20000, intervals: [500] },
            )
            .toBe(true)
            .catch(() => undefined);
          if (round === 1)
            await watch.screenshot({
              path: `${shots}/redis-viewer-chat-reconnecting.png`,
            });
          if (round === 1) await presentationShot("redis-presentation-during");
          return {
            crossInstanceChatDuringOutage: outage.delivered,
            viewerChatStatusDuringOutage: banner,
            outageObservedAt: new Date(at).toISOString(),
          };
        },
        async () => {
          let delivered = false,
            tries = 0;
          const started = Date.now();
          while (!delivered && Date.now() - started < 60000) {
            tries++;
            delivered = (await crossChat("after-redis-repair", 6000)).delivered;
          }
          await expect(watch.getByTestId("chat-status")).toHaveAttribute(
            "data-status",
            "Connected",
            { timeout: 45000 },
          );
          const history = await (
            await lakshitaCtx.request.get(
              "/api/v1/streams/" + main.id + "/chat",
            )
          ).json();
          return {
            crossInstanceChatAfterRepair: delivered,
            chatAttemptsUntilDelivered: tries,
            chatRestoredWithinMs: Date.now() - started,
            historyMessages: history.messages?.length ?? null,
          };
        },
      ).then((x) => {
        if (!x) return;
        expect(x.record.visible.crossInstanceChatDuringOutage).toBe(false);
        expect(x.record.visible.crossInstanceChatAfterRepair).toBe(true);
        expect(
          Number(x.record.visible.framesDecodedDuringExperiment),
        ).toBeGreaterThan(0);
      });
      // 2. Video gateway: the single HLS entry is gone; viewers' requests fail
      // until the Healer restores it. A visible freeze appears when the outage
      // outlasts the player's buffer, so the decoded gap is measured, not assumed.
      let since = Date.now();
      let errorsAtInjection = 0;
      await run(
        round,
        "crash-video-gateway",
        "video-gateway",
        ["video-gateway"],
        async (find) => {
          since = Date.now();
          errorsAtInjection = viewer.state.errors;
          await expect
            .poll(async () => (await find())?.faultConfirmedAt ?? null, {
              timeout: 30000,
            })
            .not.toBeNull();
          await expect
            .poll(() => viewer.state.errors - errorsAtInjection, {
              timeout: 30000,
              intervals: [250],
            })
            .toBeGreaterThan(0);
          if (round === 1)
            await presentationShot("gateway-presentation-during");
          return {
            viewerRequestsFailedWhileDown:
              viewer.state.errors - errorsAtInjection,
          };
        },
        async () => {
          const decoded = viewer.state.samples.filter(
            (x: { at: number; frames: number }) =>
              x.at >= since - 5000 && x.frames > 0,
          );
          let longestGapMs = 0;
          for (let i = 1; i < decoded.length; i++)
            longestGapMs = Math.max(
              longestGapMs,
              decoded[i]!.at - decoded[i - 1]!.at,
            );
          const s = stallsSince(since);
          return {
            longestDecodedGapMs: longestGapMs,
            videoStalls: s,
            longestStallMs: s.length
              ? Math.max(...s.map((x: { durationMs: number }) => x.durationMs))
              : 0,
          };
        },
      );
      // 3. Ingest relay: the broadcaster drops; the server is healed, the client reconnects itself.
      since = Date.now();
      const reconnectsBefore = publishers[0]!.reconnects.length;
      await run(
        round,
        "crash-relay",
        "relay",
        ["relay"],
        async (find) => {
          await expect
            .poll(async () => (await find())?.faultConfirmedAt ?? null, {
              timeout: 30000,
            })
            .not.toBeNull();
          let watchText = "";
          await expect
            .poll(
              async () => {
                watchText =
                  (await watch
                    .locator(".watch-main")
                    .innerText()
                    .catch(() => "")) || "";
                return /reconnecting|unavailable|connecting/i.test(watchText);
              },
              { timeout: 30000, intervals: [1000] },
            )
            .toBe(true)
            .catch(() => undefined);
          if (round === 1)
            await watch.screenshot({
              path: `${shots}/relay-viewer-broadcaster-reconnecting.png`,
            });
          return {
            viewerTextDuringOutage: watchText
              .split("\n")
              .slice(0, 3)
              .join(" | "),
          };
        },
        async () => {
          await expect
            .poll(
              async () =>
                (
                  await (
                    await lakshitaCtx.request.get("/api/v1/streams/" + main.id)
                  ).json()
                ).status,
              {
                timeout: 90000,
                intervals: [1000],
              },
            )
            .toBe("live");
          const s = stallsSince(since);
          return {
            publisherReconnects:
              publishers[0]!.reconnects.length - reconnectsBefore,
            videoStalls: s,
            longestStallMs: s.length
              ? Math.max(...s.map((x: { durationMs: number }) => x.durationMs))
              : 0,
          };
        },
      ).then((x) => {
        if (!x) return;
        expect(x.e.evidence.broadcasterClientReconnected).toBe(true);
        expect(x.e.evidence.sourceRestoredByHealer).toBe(false);
      });
      // 4. Hang: API-2 frozen (running, not answering) -> restart, not start.
      const latency: {
        at: number;
        ms: number;
        servedBy: string | null;
        status: number;
      }[] = [];
      let probing = false;
      const probeLoop = async () => {
        probing = true;
        while (probing) {
          const started = performance.now();
          let status = 0,
            servedBy: string | null = null;
          try {
            const r = await fetch(base + "/api/v1/streams", {
              signal: AbortSignal.timeout(15000),
            });
            status = r.status;
            servedBy = r.headers.get("x-served-by");
            await r.arrayBuffer();
          } catch {
            /* status stays 0: no answer */
          }
          latency.push({
            at: Date.now(),
            ms: Math.round(performance.now() - started),
            servedBy,
            status,
          });
          await new Promise((r) => setTimeout(r, 400));
        }
      };
      await run(
        round,
        "hang-api",
        "api-2",
        ["api-2"],
        async (find) => {
          latency.length = 0;
          void probeLoop();
          await expect
            .poll(async () => (await find())?.faultConfirmedAt ?? null, {
              timeout: 30000,
            })
            .not.toBeNull();
          if (round === 1) {
            await expect
              .poll(async () => (await find())?.actionStartedAt ?? null, {
                timeout: 60000,
              })
              .not.toBeNull();
            await presentationShot("hang-presentation-healer-restarting");
          }
          return {};
        },
        async () => {
          await new Promise((r) => setTimeout(r, 6000));
          probing = false;
          const max = Math.max(...latency.map((l) => l.ms));
          const tail = latency.slice(-5);
          return {
            maxRequestLatencyMs: max,
            requestsDuringWindow: latency.length,
            slowRequests: latency.filter((l) => l.ms > 3000).length,
            failedRequests: latency.filter(
              (l) => l.status === 0 || l.status >= 500,
            ).length,
            normalLatencyAfterMs: Math.max(...tail.map((l) => l.ms)),
            servedByAfter: [...new Set(tail.map((l) => l.servedBy))],
          };
        },
      ).then((x) => {
        if (!x) return;
        expect(x.attempts[0]!.playbook).toBe("api-restart-unresponsive");
        expect(x.attempts[0]!.evidence.controlReceipt).toBe(
          "docker_restart_accepted",
        );
        expect(x.attempts[0]!.evidence.failureCode).toBe("probe_timeout");
        expect(x.attempts[0]!.evidence.containerState).toBe("running");
        expect(Number(x.record.visible.maxRequestLatencyMs)).toBeGreaterThan(
          3000,
        );
        expect(Number(x.record.visible.normalLatencyAfterMs)).toBeLessThan(
          2000,
        );
      });
      // 5. Edge-1: invisible failover, visible proof via X-Edge-ID.
      let edgeMark = 0;
      await run(
        round,
        "crash-edge",
        "edge-1",
        ["edge-1"],
        async (find) => {
          await expect
            .poll(async () => (await find())?.faultConfirmedAt ?? null, {
              timeout: 30000,
            })
            .not.toBeNull();
          edgeMark = Date.now();
          return {};
        },
        async () => {
          // Every response through the gateway carries its serving edge.
          await expect
            .poll(
              () =>
                viewer.state.responses
                  .slice(-30)
                  .some((r: { edge: string }) => r.edge === "edge-1"),
              { timeout: 60000 },
            )
            .toBe(true);
          const during = viewer.state.responses.filter(
            (r: { at: number }) => r.at >= edgeMark,
          );
          const firstEdge1 = during.find(
            (r: { edge: string }) => r.edge === "edge-1",
          );
          return {
            edgesServingAfterInjection: [
              ...new Set(during.map((r: { edge: string }) => r.edge)),
            ],
            onlyEdge2UntilMs: firstEdge1 ? firstEdge1.at - edgeMark : null,
            edge1ServingAgain: true,
            videoStalls: stallsSince(edgeMark),
          };
        },
      );
      // 6. Primary origin: standby keeps media, Healer restores primary.
      await run(
        round,
        "crash-primary",
        "origin-primary",
        ["origin-primary"],
        async (find) => {
          await expect
            .poll(async () => (await find())?.faultConfirmedAt ?? null, {
              timeout: 30000,
            })
            .not.toBeNull();
          return {};
        },
        async () => {
          const switches = [...viewer.state.sourceSwitches];
          viewer.preferPrimary();
          return { sourceSwitches: switches, preferredSourceRetried: true };
        },
      );
      // Traffic surge: load climbs, Healer adds API-3, later removes it.
      await run(
        round,
        "traffic-surge",
        "api-tier",
        ["api-tier"],
        async (find) => {
          latency.length = 0;
          void probeLoop();
          await expect
            .poll(async () => (await find())?.actionStartedAt ?? null, {
              timeout: 90000,
            })
            .not.toBeNull();
          if (round === 1)
            await presentationShot("surge-presentation-scale-out");
          return {};
        },
        async () => {
          probing = false;
          const servedBy = [...new Set(latency.map((l) => l.servedBy))];
          return {
            maxRequestLatencyMs: Math.max(...latency.map((l) => l.ms)),
            requestsDuringWindow: latency.length,
            servedByDuringWindow: servedBy,
            api3ServedRealRequests: latency.some((l) => l.servedBy === "api-3"),
          };
        },
      ).then((x) => {
        if (!x) return;
        expect(x.e.evidence.recoveryPlaybook).toBe("api-scale-out");
        expect(x.e.evidence.healerReceipt).toBe("docker_start_accepted");
        expect(x.e.evidence.spareServingThroughGateway).toBe(true);
        expect(x.record.visible.api3ServedRealRequests).toBe(true);
        expect(Number(x.e.evidence.loadP95Ms)).toBeGreaterThan(1000);
      });
      // 7. Whole API tier: site down (banner), Healer starts API-1 then API-2.
      since = Date.now();
      await run(
        round,
        "crash-api-tier",
        "api-tier",
        ["api-1", "api-2"],
        async (find) => {
          await expect
            .poll(async () => (await find())?.faultConfirmedAt ?? null, {
              timeout: 30000,
            })
            .not.toBeNull();
          const at = Date.now();
          let bannerAt: number | null = null;
          await expect(watch.getByTestId("outage-banner"))
            .toBeVisible({ timeout: 30000 })
            .then(
              () => (bannerAt = Date.now()),
              () => undefined,
            );
          if (round === 1) {
            await watch.screenshot({
              path: `${shots}/api-tier-viewer-outage-banner.png`,
            });
            await presentationShot("api-tier-presentation-during");
          }
          const framesAtBanner = viewer.state.frames;
          await watch.waitForTimeout(4000);
          return {
            outageBannerShown: bannerAt !== null,
            bannerAfterInjectionMs: bannerAt ? bannerAt - at : null,
            videoAdvancedWhileApiDown: viewer.state.frames > framesAtBanner,
          };
        },
        async () => {
          const started = Date.now();
          await expect(watch.getByTestId("outage-banner")).toBeHidden({
            timeout: 90000,
          });
          await expect(watch.getByTestId("chat-status")).toHaveAttribute(
            "data-status",
            "Connected",
            { timeout: 60000 },
          );
          return { bannerClearedAfterVerificationMs: Date.now() - started };
        },
      ).then((x) => {
        if (!x) return;
        expect(
          x.attempts.every(
            (a) => a.evidence.controlReceipt === "docker_start_accepted",
          ),
        ).toBe(true);
        expect(x.e.evidence.healerReceipts).toBe(2);
        expect(x.record.visible.outageBannerShown).toBe(true);
      });
      // Re-pin chat sockets for the next round (API restarts move them).
      first.disconnect();
      second.disconnect();
      first = await socketFor(
        rashiCtx,
        csrf,
        process.env.RESILIENCE_API1_HOST!,
      );
      second = await socketFor(
        lakshitaCtx,
        lakshita.csrf,
        process.env.RESILIENCE_API2_HOST!,
      );
    }
    // ---------- Presentation, report and analysis screenshots at five widths ----------
    const widths = [375, 768, 1280, 1440, 1920];
    const overflow = async (p: Page) =>
      p.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
    const layout: Record<string, number> = {};
    for (const path of [
      "/control/presentation",
      "/control/analysis",
      "/control/presentation/report",
    ]) {
      for (const w of widths) {
        await presentation.setViewportSize({ width: w, height: 1000 });
        await presentation.goto(path);
        await presentation.waitForTimeout(4000);
        const name =
          path.split("/").filter(Boolean).slice(1).join("-") + "-" + w;
        layout[name] = await overflow(presentation);
        await presentation.screenshot({
          path: `${shots}/${name}.png`,
          fullPage: true,
        });
      }
    }
    (measurements as Record<string, unknown>).layoutOverflowPx = layout;
    for (const [name, px] of Object.entries(layout))
      expect(px, name).toBeLessThanOrEqual(0);
    // Analysis swimlane for Redis shows the real failed -> healing -> green order.
    await presentation.setViewportSize({ width: 1920, height: 1000 });
    await presentation.goto("/control/analysis");
    const redisRun = runs.find((r) => r.scenario === "crash-redis") as
      { timestamps: { injected: string; finished: string } } | undefined;
    if (redisRun) {
      const lane = presentation.locator(
        '.lane[data-component="redis"] .lane-seg',
      );
      await expect(lane.first()).toBeVisible({ timeout: 20000 });
      const tones = await lane.evaluateAll(
        (els, w) =>
          els
            .filter(
              (e) =>
                Date.parse(e.getAttribute("data-to")!) >= Date.parse(w.from) &&
                Date.parse(e.getAttribute("data-from")!) <=
                  Date.parse(w.to) + 40000,
            )
            .map((e) => e.getAttribute("data-tone")),
        {
          from: redisRun.timestamps.injected,
          to: redisRun.timestamps.finished,
        },
      );
      (measurements as Record<string, unknown>).redisSwimlane = tones;
      const order = ["failed", "healing", "recovered"].map((t) =>
        tones.indexOf(t),
      );
      expect(order.every((i) => i >= 0)).toBe(true);
      expect(order[0]! < order[1]! && order[1]! < order[2]!).toBe(true);
    }
    // History persists after reload.
    await presentation.goto("/control/presentation");
    await expect(
      presentation.locator(".presentation-report tbody tr").first(),
    ).toBeVisible({ timeout: 20000 });
    save();
  } finally {
    save();
    for (const v of viewers) await v.stop().catch(() => undefined);
    for (const s of sockets) s.disconnect();
    for (const p of publishers) await p.stop();
    for (const c of contexts) await c.close().catch(() => undefined);
  }
});
