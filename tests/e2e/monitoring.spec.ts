import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { io, type Socket } from "socket.io-client";
import type {
  MonitoringSnapshot,
  Incident,
  MonitoringMetrics,
} from "@streamshield/shared";
import { account } from "./platform-helpers";
test.use({ trace: "off", actionTimeout: 15000, navigationTimeout: 20000 });
const args = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  ".local/resilience/compose.yml",
  "-f",
  ".local/monitoring/compose.yml",
];
const compose = (...cmd: string[]) =>
  execFileSync("docker", [...args, ...cmd], {
    encoding: "utf8",
    timeout: 60000,
    stdio: ["pipe", "pipe", "pipe"],
  });
const privateRequest = (path: string) =>
  JSON.parse(
    compose(
      "exec",
      "-T",
      "api-2",
      "node",
      "--input-type=module",
      "-e",
      `const r=await fetch(process.env.PROMETHEUS_URL+process.argv[1],{signal:AbortSignal.timeout(3000)});console.log(JSON.stringify(await r.json()));`,
      path,
    ),
  );
const db = (sql: string, params: unknown[] = []) =>
  JSON.parse(
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
        `import {Pool} from 'pg';const input=JSON.parse((await import('node:fs')).readFileSync(0,'utf8'));const p=new Pool({host:process.env.POSTGRES_HOST,port:Number(process.env.POSTGRES_PORT),database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD});try{console.log(JSON.stringify((await p.query(input.sql,input.params)).rows));}finally{await p.end();}`,
      ],
      {
        encoding: "utf8",
        input: JSON.stringify({ sql, params }),
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
test("real monitoring: access, scrape, durable deduplicated outages, restart, stale/reconnect and responsive Control", async ({
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const ids: string[] = [],
    stopped = new Set<string>(),
    report: Record<string, unknown>[] = [];
  let socket: Socket | undefined, publisher: ChildProcess | undefined;
  const context = await browser.newContext();
  const reader = await browser.newContext();
  const page = await context.newPage();
  const requestErrors: string[] = [];
  let snapshotReadErrors = 0;
  page.on("pageerror", (e) => requestErrors.push(e.message));
  try {
    expect((await request.get("/api/v1/monitoring/snapshot")).status()).toBe(
      401,
    );
    const name = "e2e_m" + randomUUID().replaceAll("-", "").slice(0, 12),
      password = randomUUID() + randomUUID();
    const auth = await account(context.request, name, password);
    ids.push(auth.user.id);
    expect(
      (await context.request.get("/api/v1/monitoring/snapshot")).status(),
    ).toBe(403);
    expect(
      (await context.request.get("/api/v1/monitoring/incidents")).status(),
    ).toBe(403);
    await page.goto("/control");
    await expect(
      page.getByRole("heading", { name: "Administrator access required" }),
    ).toBeVisible({ timeout: 20000 });
    const cookie = (await context.cookies())
      .map((c) => c.name + "=" + c.value)
      .join("; ");
    socket = io(process.env.E2E_BASE_URL!, {
      transports: ["websocket"],
      auth: { csrf: auth.csrf },
      extraHeaders: {
        Cookie: cookie,
        Origin: new URL(process.env.E2E_BASE_URL!).origin,
      },
      reconnectionAttempts: 10,
    });
    await expect.poll(() => socket!.connected, { timeout: 15000 }).toBe(true);
    const subscribe = () =>
      new Promise<{ ok: boolean }>((resolve) =>
        socket!
          .timeout(5000)
          .emit("monitoring:subscribe", (e: unknown, v: { ok: boolean }) =>
            resolve(e ? { ok: false } : v),
          ),
      );
    expect((await subscribe()).ok).toBe(false);
    compose(
      "exec",
      "-T",
      "api-2",
      "node",
      "scripts/set-role.mjs",
      name,
      "administrator",
    );
    expect((await subscribe()).ok).toBe(true);
    let eventCount = 0;
    socket.on("monitoring:v1", () => eventCount++);
    // The operator UI and synthetic inspector are independent administrator clients.
    // Preserve the real per-account production limiter instead of exempting tests.
    const probeName = "e2e_p" + randomUUID().replaceAll("-", "").slice(0, 12);
    const probeAccount = await account(
      reader.request,
      probeName,
      randomUUID() + randomUUID(),
    );
    ids.push(probeAccount.user.id);
    compose(
      "exec",
      "-T",
      "api-2",
      "node",
      "scripts/set-role.mjs",
      probeName,
      "administrator",
    );
    let nextReadAt = 0;
    const readMonitoring = async (path: string) => {
      const delay = Math.max(0, nextReadAt - performance.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      nextReadAt = performance.now() + 750;
      return await reader.request.get(path, { timeout: 5000 });
    };
    const snap = async () => {
      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        try {
          const response = await readMonitoring("/api/v1/monitoring/snapshot");
          if (response.ok())
            return (await response.json()) as MonitoringSnapshot;
          if (response.status() < 500)
            throw new Error("non_retryable_" + response.status());
          snapshotReadErrors++;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("non_retryable_")
          )
            throw error;
          snapshotReadErrors++;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        "Authoritative snapshot remained unavailable within the bounded read-retry window",
      );
    };
    await expect
      .poll(
        async () => {
          const s = await snap();
          return (
            !s.stale &&
            s.components.length === 14 &&
            s.components.every((c) => c.state === "HEALTHY")
          );
        },
        { timeout: 60000, intervals: [1000] },
      )
      .toBe(true);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Every signal. One clear picture." }),
    ).toBeVisible();
    await expect.poll(() => eventCount, { timeout: 15000 }).toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          privateRequest("/api/v1/targets").data.activeTargets.filter(
            (t: { health: string }) => t.health !== "up",
          ).length,
        { timeout: 60000, intervals: [1000] },
      )
      .toBe(0);
    console.log(
      "Verified administrator authorization, real-time delivery and all scrape targets.",
    );
    const metrics = (await (
      await context.request.get("/api/v1/monitoring/metrics")
    ).json()) as MonitoringMetrics;
    expect(metrics.available).toBe(true);
    expect(
      metrics.series.find((s) => s.id === "memory")!.points.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await context.request.get("/api/v1/monitoring/metrics?query=up")
      ).status(),
    ).toBe(400);
    const grafana = JSON.parse(
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
          `const password=(await import('node:fs')).readFileSync(0,'utf8');const r=await fetch('http://grafana:3000/api/search',{headers:{Authorization:'Basic '+Buffer.from('operator:'+password).toString('base64')}});console.log(JSON.stringify({status:r.status,data:await r.json()}));`,
        ],
        {
          input: process.env.OBS_GRAFANA_PASSWORD!,
          encoding: "utf8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    );
    expect(grafana.status).toBe(200);
    expect(
      grafana.data.some(
        (d: { uid: string }) => d.uid === "streamshield-operations",
      ),
    ).toBe(true);
    expect(
      (await (await request.get("/api/v1/streams")).json()).streams.every(
        (s: { publisher: string }) => s.publisher !== "online",
      ),
    ).toBe(true);
    publisher = spawn(process.execPath, ["scripts/test-publisher.mjs"], {
      env: { ...process.env, TEST_PUBLISH_DURATION_SECONDS: "300" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const viewer = await context.newPage();
    await viewer.goto("/watch/" + process.env.MEDIA_STREAM_PATH);
    const video = viewer.getByLabel("Live stream video");
    const advances = async () => {
      const before = await video.evaluate((n) => ({
        time: (n as HTMLVideoElement).currentTime,
        frames: (n as HTMLVideoElement).getVideoPlaybackQuality()
          .totalVideoFrames,
      }));
      await expect
        .poll(
          () =>
            video.evaluate((n) => {
              const v = n as HTMLVideoElement;
              return {
                time: v.currentTime,
                frames: v.getVideoPlaybackQuality().totalVideoFrames,
              };
            }),
          { timeout: 30000, intervals: [1000] },
        )
        .toEqual(
          expect.objectContaining({
            time: expect.any(Number),
            frames: expect.any(Number),
          }),
        );
      await expect
        .poll(
          () =>
            video.evaluate((n, before) => {
              const v = n as HTMLVideoElement;
              return (
                v.currentTime > before.time &&
                v.getVideoPlaybackQuality().totalVideoFrames > before.frames + 5
              );
            }, before),
          { timeout: 30000, intervals: [1000] },
        )
        .toBe(true);
    };
    await advances();
    await expect
      .poll(
        async () => {
          const s = await snap();
          return (
            s.mediaAvailable &&
            s.media.some(
              (p) =>
                p.publisher &&
                p.sources.every(
                  (o) => o.manifest && o.segment && o.fresh === true,
                ),
            )
          );
        },
        { timeout: 60000, intervals: [1000] },
      )
      .toBe(true);
    const incidents = async (id: string, status = "active") =>
      (
        await (
          await readMonitoring(
            "/api/v1/monitoring/incidents?component=" +
              id +
              "&status=" +
              status,
          )
        ).json()
      ).incidents as Incident[];
    for (const [service, component] of [
      ["api", "api-1"],
      ["edge-1", "edge-1"],
      ["origin-primary", "origin-primary"],
    ]) {
      const before = await incidents(component!, "resolved");
      const injectedAt = new Date().toISOString(),
        start = performance.now();
      compose("kill", "-s", "SIGKILL", service!);
      stopped.add(service!);
      await expect
        .poll(
          async () =>
            (await snap()).components.find((c) => c.id === component)?.state,
          { timeout: 30000, intervals: [1000] },
        )
        .toBe("UNHEALTHY");
      const detectionMs = performance.now() - start;
      await advances();
      const found = await incidents(component!);
      expect(found).toHaveLength(1);
      const incident = found[0]!;
      expect(incident.severity).toBe("critical");
      await expect(
        page
          .locator(".cc-service-card")
          .filter({
            hasText:
              component === "api-1"
                ? "API-1"
                : component === "edge-1"
                  ? "Video edge 01"
                  : "Primary origin",
          })
          .getByText("UNHEALTHY", { exact: true }),
      ).toBeVisible({ timeout: 15000 });
      if (component === "api-1") {
        await page.setViewportSize({ width: 1440, height: 1100 });
        mkdirSync("test-results/phase5", { recursive: true });
        await page.screenshot({
          path: "test-results/phase5/api-1-unhealthy.png",
          fullPage: true,
          animations: "disabled",
        });
      }
      if (component === "api-1") {
        compose("restart", "observer");
        await expect
          .poll(
            async () => {
              const s = await snap();
              return (
                s.components.find((c) => c.id === component)?.state ===
                  "UNHEALTHY" && !s.stale
              );
            },
            { timeout: 30000, intervals: [1000] },
          )
          .toBe(true);
        expect((await incidents(component))[0]!.id).toBe(incident.id);
      }
      await expect
        .poll(async () => (await incidents(component!)).length, {
          timeout: 10000,
        })
        .toBe(1);
      compose("up", "-d", "--no-deps", service!);
      stopped.delete(service!);
      await expect
        .poll(async () => (await incidents(component!)).length, {
          timeout: 40000,
        })
        .toBe(0);
      const resolved = (await incidents(component!, "resolved")).find(
        (i) => i.id === incident.id,
      )!;
      expect(resolved.verified_at).not.toBeNull();
      expect(resolved.duration_ms).toBeGreaterThan(0);
      const detail = (await (
        await context.request.get("/api/v1/monitoring/incidents/" + incident.id)
      ).json()) as Incident;
      expect(detail.events!.map((e) => e.state)).toEqual([
        "DETECTED",
        "DIAGNOSED",
        "SERVICE_RESTORED",
        "RECOVERY_VERIFIED",
        "RESOLVED",
      ]);
      expect(detail.evidence.playbackVerified).toBe(false);
      expect((await incidents(component!, "resolved")).length).toBe(
        before.length + 1,
      );
      console.log(
        "Verified outage, durable incident and restoration:",
        component,
      );
      report.push({
        service,
        component,
        incidentId: incident.id,
        injectedAt,
        injectionToSnapshotObservationMs: detectionMs,
        injectionToObserverConfirmationWallMs:
          Date.parse(incident.detected_at) - Date.parse(injectedAt),
        browserDecodedProgressVerified: true,
        browserPlaybackRecoveryTimingMs: null,
        firstObservedAt: incident.first_observed_at,
        confirmedAt: incident.detected_at,
        confirmationDelayMs: incident.detection_ms,
        firstSuccessAt: resolved.restored_at,
        verifiedAt: resolved.verified_at,
        observedUnavailableMs: resolved.duration_ms,
        experimentElapsedMs: performance.now() - start,
        verification:
          "component probes; media playback measured by retained resilience suite",
      });
    }
    if (publisher?.connected) publisher.send("stop");
    await viewer.close();
    // Observer downtime is not a green status. Authoritative REST fallback remains durable and stale.
    compose("stop", "observer");
    stopped.add("observer");
    await expect
      .poll(async () => (await snap()).stale, { timeout: 20000 })
      .toBe(true);
    await expect(
      page.getByText("Telemetry stale or unavailable", { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await expect(
      page.locator(".cc-service-card").getByText("HEALTHY", { exact: true }),
    ).toHaveCount(0);
    compose("up", "-d", "--no-deps", "observer");
    stopped.delete("observer");
    await expect
      .poll(async () => !(await snap()).stale, {
        timeout: 30000,
        intervals: [1000],
      })
      .toBe(true);
    console.log(
      "Verified observer downtime and restart; checking dashboard navigation.",
    );
    socket.disconnect();
    socket.connect();
    await expect.poll(() => socket!.connected, { timeout: 10000 }).toBe(true);
    expect((await subscribe()).ok).toBe(true);
    await page.getByRole("link", { name: /Infrastructure/ }).click();
    await page.getByRole("link", { name: /Primary origin/ }).click();
    await expect(
      page.getByRole("heading", { name: "Primary origin", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: /Incidents/ })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Incident history" }),
    ).toBeVisible();
    await page.getByLabel("Component", { exact: true }).selectOption("api-1");
    await page.locator(".cc-incident-row").first().click();
    await expect(
      page.getByRole("heading", { name: "api-1 availability incident" }),
    ).toBeVisible();
    await expect(
      page.getByText("Observation timeline", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/phase5/incident-detail.png",
      fullPage: true,
      animations: "disabled",
    });
    for (const width of [375, 768, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto("/control");
      await expect(
        page.getByRole("heading", { name: "Service health", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      mkdirSync("test-results/phase5", { recursive: true });
      await page.screenshot({
        path: "test-results/phase5/control-" + width + ".png",
        fullPage: true,
        animations: "disabled",
      });
    }
    // Prometheus outage makes metrics unavailable while independently probed application state survives.
    compose("stop", "prometheus");
    stopped.add("prometheus");
    await expect
      .poll(
        async () =>
          (
            await (
              await context.request.get("/api/v1/monitoring/metrics")
            ).json()
          ).available,
        { timeout: 30000, intervals: [1000] },
      )
      .toBe(false);
    expect((await snap()).components.find((c) => c.id === "api-2")!.state).toBe(
      "HEALTHY",
    );
    compose("up", "-d", "--no-deps", "prometheus");
    stopped.delete("prometheus");
    // Redis and DB direct observations continue even when public auth/persistence cannot work.
    for (const dependency of ["redis", "postgres"]) {
      compose("stop", dependency);
      stopped.add(dependency);
      await expect
        .poll(
          () => {
            try {
              return JSON.parse(
                compose(
                  "exec",
                  "-T",
                  "observer",
                  "node",
                  "--input-type=module",
                  "-e",
                  `const r=await fetch('http://127.0.0.1:'+process.env.OBS_PORT+'/health');console.log(JSON.stringify(await r.json()));`,
                ),
              ).alive;
            } catch {
              return false;
            }
          },
          { timeout: 15000 },
        )
        .toBe(true);
      // Inspect bounded in-process observations through a private diagnostic endpoint (no credential output).
      await expect
        .poll(
          () =>
            JSON.parse(
              compose(
                "exec",
                "-T",
                "observer",
                "node",
                "--input-type=module",
                "-e",
                `const r=await fetch('http://127.0.0.1:'+process.env.OBS_PORT+'/observations',{headers:{Authorization:'Bearer '+process.env.OBS_SECRET}});console.log(JSON.stringify(await r.json()));`,
              ),
            ).components.find((c: { id: string }) => c.id === dependency)
              ?.state,
          { timeout: 25000, intervals: [1000] },
        )
        .toBe("UNHEALTHY");
      if (dependency === "redis") {
        expect(
          (await snap()).components.find((c) => c.id === "redis")!.state,
        ).toBe("UNHEALTHY");
        await expect(
          page.getByText("Realtime degraded · REST fallback"),
        ).toBeVisible({ timeout: 15000 });
      }
      compose("up", "-d", "--no-deps", dependency);
      stopped.delete(dependency);
      await expect
        .poll(
          async () => {
            try {
              return (await snap()).components.find((c) => c.id === dependency)
                ?.state;
            } catch {
              return "unavailable";
            }
          },
          { timeout: 40000, intervals: [1000] },
        )
        .toBe("HEALTHY");
    }
    // Second confirmed failure after resolution creates a distinct recurrence.
    const countBefore = db(
      "SELECT count(*)::int AS n FROM monitoring_incidents WHERE component='edge-1'",
    )[0].n;
    compose("kill", "-s", "SIGKILL", "edge-1");
    stopped.add("edge-1");
    await expect
      .poll(async () => (await incidents("edge-1")).length, {
        timeout: 25000,
        intervals: [1000],
      })
      .toBe(1);
    expect(
      db(
        "SELECT count(*)::int AS n FROM monitoring_incidents WHERE component='edge-1'",
      )[0].n,
    ).toBe(countBefore + 1);
    compose("up", "-d", "--no-deps", "edge-1");
    stopped.delete("edge-1");
    await expect
      .poll(async () => (await incidents("edge-1")).length, {
        timeout: 30000,
        intervals: [1000],
      })
      .toBe(0);
    expect(requestErrors).toEqual([]);
    const pgIncident = (
      await (
        await context.request.get(
          "/api/v1/monitoring/incidents?component=postgres&status=resolved",
        )
      ).json()
    ).incidents[0] as Incident;
    expect(pgIncident).toBeTruthy();
    expect(pgIncident.verified_at).not.toBeNull();
    const pgDetail = (await (
      await context.request.get("/api/v1/monitoring/incidents/" + pgIncident.id)
    ).json()) as Incident;
    const detected = pgDetail.events!.find((e) => e.state === "DETECTED")!;
    expect(
      Date.parse(detected.evidence.persistedAt as string),
    ).toBeGreaterThanOrEqual(Date.parse(pgIncident.detected_at));
    console.log(
      "Verified Redis/PostgreSQL observations, delayed persistence, recurrence and stale/reconnect handling.",
    );
    // Server-side role changes revoke monitoring delivery and HTTP access.
    compose(
      "exec",
      "-T",
      "api-2",
      "node",
      "scripts/set-role.mjs",
      name,
      "viewer",
    );
    expect(
      (await context.request.get("/api/v1/monitoring/snapshot")).status(),
    ).toBe(403);
    expect((await subscribe()).ok).toBe(false);
    mkdirSync("test-results/phase5", { recursive: true });
    writeFileSync(
      "test-results/phase5/measurements.json",
      JSON.stringify(
        {
          outcome: "PASS",
          measuredAt: new Date().toISOString(),
          clock:
            "Harness monotonic durations; separate UTC injection and observer timestamps. Probe resolution ~2s.",
          experiments: report,
          snapshotReadErrors,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    socket?.disconnect();
    if (publisher?.connected) publisher.send("stop");
    else publisher?.kill("SIGTERM");
    if (publisher)
      await expect
        .poll(
          () => publisher!.exitCode !== null || publisher!.signalCode !== null,
          { timeout: 10000 },
        )
        .toBe(true);
    for (const service of stopped) compose("up", "-d", "--no-deps", service);
    await context.close();
    await reader.close();
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
          timeout: 20000,
        },
      );
  }
});
