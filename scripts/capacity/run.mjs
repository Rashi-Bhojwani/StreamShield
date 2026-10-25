import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resourceGuard } from "./guards.mjs";
import { io } from "socket.io-client";
import { capacityConfig } from "../../packages/shared/src/demo.ts";
import { operator, savePrivate } from "../demo-cli.mjs";
import { initialMetrics, observe, validateOwnedTarget } from "./metrics.mjs";
const args = process.argv.slice(2),
  get = (key, fallback) => {
    const i = args.lastIndexOf("--" + key);
    return i < 0 ? fallback : args[i + 1];
  },
  has = (key) => args.includes("--" + key);
if (existsSync(".env")) process.loadEnvFile(".env");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let grant;
if (has("worker")) {
  const file = get("grant");
  if (!file)
    throw Error(
      "Use capacity:worker -- --grant PRIVATE_FILE --clients N --authorize-owned-target",
    );
  grant = JSON.parse(readFileSync(file, "utf8"));
  validateOwnedTarget(grant.target, has("authorize-owned-target"));
  capacityConfig.parse(
    Object.fromEntries(
      [
        "profile",
        "clients",
        "duration",
        "ramp",
        "distributed",
        "chatPerSecond",
        "target",
      ].map((k) => [k, grant[k]]),
    ),
  );
} else {
  const target = validateOwnedTarget(
    get("target", process.env.E2E_BASE_URL || "http://localhost:5173"),
    has("authorize-owned-target"),
  );
  const config = capacityConfig.parse({
    profile: get("profile", "api"),
    clients: Number(get("clients", "100")),
    duration: Number(get("duration", "30")),
    ramp: Number(get("ramp", "5")),
    distributed: has("distributed"),
    chatPerSecond: Number(get("chat-per-second", "2")),
    target,
  });
  if (config.distributed && !has("create-only"))
    throw Error(
      "Distributed runs require capacity:create, then separately resource-checked capacity:worker processes",
    );
  if (!config.distributed) resourceGuard(config.clients, config.profile);
  grant = operator({
    action: "capacity-create",
    config,
    authorizedDistributed: has("authorize-distributed"),
  });
  const path = `.local/demo/capacity-${grant.id}.json`;
  savePrivate(path, grant);
  console.log(
    JSON.stringify({
      runId: grant.id,
      profile: grant.profile,
      targetClients: grant.clients,
      privateGrantFile: path,
      capacity50000: "UNVERIFIED",
    }),
  );
  if (has("create-only")) process.exit(0);
}
const clients = Number(
    get("clients", String(grant.distributed ? 100 : grant.clients)),
  ),
  resources = resourceGuard(clients, grant.profile);
if (clients > grant.clients)
  throw Error("Worker allocation exceeds run target");
if (grant.profile === "chat" && clients < 2)
  throw Error("Chat delivery needs two independent recipients");
const origin = validateOwnedTarget(grant.target, has("authorize-owned-target")),
  workerId = get("worker-id", randomUUID());
const headers = {
  "Content-Type": "application/json",
  Origin: origin,
  Authorization: "Bearer " + grant.token,
};
async function control(path, body) {
  const r = await fetch(origin + "/api/v1/capacity/agent" + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!r.ok) {
    const error = Error("Generator control rejected: HTTP " + r.status);
    error.status = r.status;
    throw error;
  }
  return r.json();
}
const registration = await control("/register", { id: workerId, clients });
if (registration.runId !== grant.id || registration.profile !== grant.profile)
  throw Error("Private grant metadata disagrees with the authoritative run");
const metrics = initialMetrics(),
  started = performance.now(),
  deadline = Math.min(
    Date.now() + 1000 * (grant.duration + grant.ramp),
    Date.parse(registration.expiresAt) - 1000,
  ),
  think = Number(get("think-ms", "100"));
if (!Number.isFinite(think) || think < 20 || think > 10000)
  throw Error("--think-ms must be 20–10000");
let stopped = false,
  reason = "deadline",
  seq = 0,
  reporting = false,
  lastCpu = process.cpuUsage(),
  lastCpuTime = performance.now(),
  lastErrors = 0,
  lastRequests = 0,
  badWindows = 0;
const sockets = [],
  pending = new Map(),
  abort = new AbortController();
process.on("message", (message) => {
  if (message === "stop") stop("signal");
});
const stop = (why) => {
  if (stopped) return;
  stopped = true;
  reason = why;
  abort.abort();
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => stop("signal"));
const deadlineTimer = setTimeout(
  () => stop("deadline"),
  Math.max(0, deadline - Date.now()),
);
async function report(final = false) {
  if (reporting && !final) return;
  reporting = true;
  try {
    const now = performance.now(),
      cpu = process.cpuUsage(),
      dt = Math.max(1, now - lastCpuTime);
    metrics.generatorCpuPercent =
      (cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / dt / 10;
    lastCpu = cpu;
    lastCpuTime = now;
    metrics.generatorRssBytes = process.memoryUsage().rss;
    const body = {
      ...metrics,
      seq: ++seq,
      finished: final,
      stopReason: final ? reason : "running",
      requestHistogram: [...metrics.requestHistogram],
      deliveryHistogram: [...metrics.deliveryHistogram],
    };
    const until = Date.now() + 30000;
    for (let attempt = 0; attempt < (final ? 12 : 3); attempt++) {
      try {
        await control(`/${workerId}/report`, body);
        return;
      } catch (e) {
        if (
          e.status === 403 ||
          e.status === 409 ||
          attempt === (final ? 11 : 2) ||
          Date.now() >= until
        )
          throw e;
        await sleep(final ? 2000 : 500);
      }
    }
  } finally {
    reporting = false;
  }
}
let lastReport = Promise.resolve();
const reportTimer = setInterval(() => {
  if (!reporting)
    lastReport = report().catch((error) => {
      if (error.status === 403) stop("grant-revoked");
      /* A failed report remains visible as stale server-side; no traffic is fabricated. */
    });
}, 2000);
const safetyTimer = setInterval(() => {
  const requests = metrics.requests - lastRequests,
    errors = metrics.errors - lastErrors;
  lastRequests = metrics.requests;
  lastErrors = metrics.errors;
  badWindows = requests >= 20 && errors / requests > 0.1 ? badWindows + 1 : 0;
  if (badWindows >= 3) stop("error-budget");
  if (process.availableMemory() < 128 * 1048576) stop("resource-pressure");
}, 1000);
function endpoint(value) {
  const u = new URL(value, origin);
  if (u.origin !== origin || u.username || u.password)
    throw Error("Refusing playlist URL outside the authorized origin");
  return u;
}
async function http(value) {
  if (stopped) throw abort.signal.reason;
  const url = endpoint(value),
    at = performance.now();
  metrics.active++;
  metrics.peak = Math.max(metrics.peak, metrics.active);
  let shutdownAbort = false;
  try {
    const r = await fetch(url, {
      headers: { Origin: origin },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
      redirect: "error",
    });
    const bytes = Buffer.from(await r.arrayBuffer());
    metrics.bytes += bytes.length;
    if (!r.ok) throw Error("HTTP " + r.status);
    return bytes;
  } catch (e) {
    shutdownAbort =
      stopped &&
      abort.signal.aborted &&
      (e.name === "AbortError" || e === abort.signal.reason);
    if (!shutdownAbort) metrics.errors++;
    throw e;
  } finally {
    metrics.active--;
    if (!shutdownAbort) {
      metrics.requests++;
      observe(metrics.requestHistogram, performance.now() - at);
    }
  }
}
async function discover() {
  const response = await fetch(origin + "/api/v1/demo/channels", {
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!response.ok) throw Error("Three-channel discovery unavailable");
  const value = await response.json();
  if (value.channels?.length !== 3)
    throw Error("Provision all three channels first");
  return value.channels;
}
async function httpWorker(index, channels) {
  await sleep((index / clients) * grant.ramp * 1000);
  let cycle = 0;
  while (!stopped) {
    try {
      if (grant.profile === "api")
        await http(
          [
            "/api/v1/channels",
            "/api/v1/streams",
            "/api/v1/streams/streamer-" + ((index % 3) + 1) + "/status",
          ][cycle % 3],
        );
      else {
        const channel = channels[index % 3];
        const sources = channel.playbackSources?.length
          ? channel.playbackSources.map((s) => s.url)
          : [channel.playbackUrl];
        const base = endpoint(sources[cycle % sources.length]);
        let playlist = (await http(base)).toString("utf8"),
          playlistUrl = base;
        const child = playlist
          .split("\n")
          .find((l) => l.trim() && !l.startsWith("#"));
        if (playlist.includes("#EXT-X-STREAM-INF") && child) {
          playlistUrl = endpoint(new URL(child.trim(), base));
          playlist = (await http(playlistUrl)).toString("utf8");
        }
        if (!playlist.includes("#EXTINF"))
          throw Error("No current HLS segments");
        const init = playlist.match(/#EXT-X-MAP:URI="([^"]+)"/);
        if (init) await http(endpoint(new URL(init[1], playlistUrl)));
        const segment = playlist
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("#"))
          .at(-1);
        if (!segment) throw Error("Missing current HLS segment");
        await http(endpoint(new URL(segment.trim(), playlistUrl)));
      }
    } catch {
      if (grant.profile === "hls" && !stopped) metrics.deliveryFailures++;
      /* Actual HTTP failures counted above; next bounded cycle may use the alternate origin. */
    }
    cycle++;
    if (!stopped) await sleep(think);
  }
}
async function socketWorker(index, channels) {
  await sleep((index / clients) * grant.ramp * 1000);
  if (stopped) return;
  const stream = channels[index % 3],
    socket = io(origin, {
      transports: ["websocket"],
      extraHeaders: { Origin: origin },
      auth: { loadToken: grant.token, workerId, clientIndex: index },
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 30,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 2000,
      timeout: 5000,
    });
  sockets.push(socket);
  let manualRetry;
  const retry = () => {
    if (!stopped && !socket.active && !manualRetry)
      manualRetry = setTimeout(() => {
        manualRetry = undefined;
        if (!stopped) socket.connect();
      }, 2000);
  };
  let connected = false,
    once = false;
  socket.on("connect", () => {
    if (manualRetry) clearTimeout(manualRetry);
    manualRetry = undefined;
    connected = true;
    metrics.active++;
    metrics.peak = Math.max(metrics.peak, metrics.active);
    metrics.connections++;
    if (once) metrics.reconnects++;
    once = true;
    socket.timeout(5000).emit("join", { streamId: stream.id }, (err, reply) => {
      if (err || !reply?.ok) metrics.joinFailures++;
    });
  });
  socket.on("disconnect", () => {
    retry();
    if (connected) {
      metrics.active--;
      connected = false;
      metrics.disconnects++;
    }
  });
  socket.on("message", (message) => {
    if (!message.synthetic || message.streamId !== stream.id) return;
    const nonce = message.content.split(" ").at(-1),
      entry = pending.get(nonce);
    if (!entry || entry.sender === index) return;
    pending.delete(nonce);
    clearTimeout(entry.timer);
    metrics.delivered++;
    observe(metrics.deliveryHistogram, performance.now() - entry.at);
  });
  socket.on("connect_error", () => {
    metrics.connectionFailures++;
    retry();
  });
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (stopped) {
        clearInterval(poll);
        resolve();
      }
    }, 250);
  });
  if (manualRetry) clearTimeout(manualRetry);
  socket.disconnect();
}
async function browserWorker(index) {
  const { chromium } = await import("@playwright/test"),
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    });
  try {
    await sleep((index / clients) * grant.ramp * 1000);
    if (stopped) return;
    const page = await browser.newPage(),
      at = performance.now();
    await page.goto(origin + "/watch/streamer-" + ((index % 3) + 1));
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return (
          v &&
          !v.paused &&
          v.currentTime > 0 &&
          v.getVideoPlaybackQuality().totalVideoFrames > 0
        );
      },
      null,
      { timeout: 30000 },
    );
    metrics.startupMs = Math.max(
      metrics.startupMs || 0,
      performance.now() - at,
    );
    metrics.active++;
    metrics.verifiedBrowsers++;
    metrics.peak = Math.max(metrics.peak, metrics.active);
    let lastTime = 0,
      lastFrames = 0,
      lastAdvance = performance.now(),
      stalled = false;
    while (!stopped) {
      await sleep(250);
      const sample = await page.evaluate(() => {
        const v = document.querySelector("video");
        return v
          ? {
              time: v.currentTime,
              frames: v.getVideoPlaybackQuality().totalVideoFrames,
            }
          : null;
      });
      if (sample && sample.time > lastTime && sample.frames > lastFrames) {
        lastAdvance = performance.now();
        stalled = false;
      } else if (performance.now() - lastAdvance >= 2000 && !stalled) {
        metrics.stalls++;
        stalled = true;
      }
      if (sample) {
        lastTime = sample.time;
        lastFrames = sample.frames;
      }
    }
    metrics.active--;
  } catch {
    metrics.deliveryFailures++;
  } finally {
    await browser.close();
  }
}
let chatTimer;
try {
  const channels = grant.profile === "browser" ? null : await discover();
  if (grant.profile === "hls" && channels.some((c) => c.status !== "live"))
    throw Error("All three real publishers must be live for the HLS profile");
  if (grant.profile === "chat") {
    const perWorker = grant.chatPerSecond / Math.ceil(grant.clients / clients);
    let cursor = 0;
    if (perWorker > 0)
      chatTimer = setInterval(
        () => {
          if (stopped) return;
          const ready = sockets
            .map((s, i) => ({ s, i }))
            .filter((x) => x.s.connected);
          if (ready.length < 2) return;
          // One receiver in the same channel must exist; distribute sends across all three rooms.
          const sender = ready[cursor++ % ready.length],
            channel = channels[sender.i % 3];
          if (!ready.some((x) => x.i !== sender.i && x.i % 3 === sender.i % 3))
            return;
          const nonce = randomUUID(),
            entry = {
              sender: sender.i,
              at: performance.now(),
              timer: undefined,
            };
          metrics.messages++;
          entry.timer = setTimeout(() => {
            if (pending.delete(nonce)) metrics.deliveryFailures++;
          }, 5000);
          pending.set(nonce, entry);
          sender.s.timeout(5000).emit(
            "message",
            {
              streamId: channel.id,
              content: `Capacity ${grant.id.slice(0, 8)} ${nonce}`,
            },
            (err, reply) => {
              if ((err || !reply?.ok) && pending.delete(nonce)) {
                clearTimeout(entry.timer);
                metrics.deliveryFailures++;
              }
            },
          );
        },
        Math.max(20, 1100 / perWorker),
      );
  }
  await Promise.all(
    Array.from({ length: clients }, (_, i) =>
      grant.profile === "browser"
        ? browserWorker(i)
        : ["socket", "chat"].includes(grant.profile)
          ? socketWorker(i, channels)
          : httpWorker(i, channels),
    ),
  );
} catch (e) {
  stop("failed");
  console.error("Generator failed: " + e.message);
} finally {
  clearTimeout(deadlineTimer);
  clearInterval(reportTimer);
  clearInterval(safetyTimer);
  if (chatTimer) clearInterval(chatTimer);
  for (const s of sockets) s.disconnect();
  for (const e of pending.values()) {
    clearTimeout(e.timer);
    metrics.deliveryFailures++;
  }
  pending.clear();
  metrics.active = 0;
  await lastReport;
  let finalReportConfirmed = false;
  try {
    await report(true);
    finalReportConfirmed = true;
  } catch {
    console.error(
      "Final report unconfirmed; retained local evidence must not be treated as server-confirmed.",
    );
    process.exitCode = 1;
  }
  const result = {
    runId: grant.id,
    workerId,
    profile: grant.profile,
    targetClients: grant.clients,
    allocatedClients: clients,
    startedAt: new Date(
      Date.now() - (performance.now() - started),
    ).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedSeconds: (performance.now() - started) / 1000,
    resources,
    finalReportConfirmed,
    measurements: { ...metrics, seq, finished: true, stopReason: reason },
    capacity50000: "UNVERIFIED",
  };
  const path = `.local/demo/result-${grant.id}-${workerId}.json`;
  savePrivate(path, result);
  console.log(
    JSON.stringify({
      runId: grant.id,
      profile: grant.profile,
      actualSingleWorkerPeak: metrics.peak,
      requests: metrics.requests,
      errors: metrics.errors,
      delivered: metrics.delivered,
      verifiedBrowsers: metrics.verifiedBrowsers,
      stopReason: reason,
      resultFile: path,
      finalReportConfirmed,
      capacity50000: "UNVERIFIED",
    }),
  );
  if (["failed", "resource-pressure", "error-budget"].includes(reason))
    process.exitCode = 1;
}

if (process.connected) process.disconnect();
