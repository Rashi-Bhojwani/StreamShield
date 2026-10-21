# Capacity protocols and measurements

This harness evaluates a **50,000 concurrent simulated-client target** through separate finite profiles. That target is a milestone, not an achieved number. No dashboard page launches a test. The existing maintained Node/Socket.IO client is used because ordinary WebSocket generators are not Socket.IO protocol clients; Node fetch handles bounded HTTP loops and Playwright supplies a much smaller real-decoding check. No new runtime dependency was added.

## Profiles

| Profile | Actual activity                                                                            | Measurements                                                                                               | What it does not prove                             |
| ------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| api     | Independent paced HTTP workers cycling three-channel discovery/metadata/status             | in-flight requests, actual completions, bytes, errors, wall-time average RPS, merged p50/p95/p99 histogram | Persistent sessions, sockets, video viewers        |
| socket  | Independent Socket.IO websocket transports, real room joins                                | connected clients, connection/reconnection/disconnect counters                                             | Video playback or guest audience                   |
| chat    | Socket.IO clients in three rooms, bounded labelled synthetic sends                         | send attempts, first other same-room recipient confirmation, failures, delivery latency histogram          | Exactly-once delivery, permanent user chat history |
| hls     | Authorized-origin master/media playlists, initialization and actual latest segment fetches | HTTP concurrency, bytes, errors, latency, request throughput                                               | Browser decoding or real-time watching             |
| browser | <=12 separate Chromium processes/pages across three stable Watch routes                    | advancing decoded frames, actual startup, 250 ms observations and >=2-second progress gaps                 | 50,000 Chrome viewers                              |

HTTP workers are paced (`--think-ms`, 20–10000, default 100); ramp is bounded (`--ramp`, 1–300 seconds). Hold duration is 5–900 seconds. API and HLS active values are requests in flight at the sampled instant, not the number of allocated idle workers. Socket activity excludes connection attempts until connect succeeds. Browser verification requires actual frames/time advance. Generator-controlled shutdown aborts are excluded from completed-request statistics. Network/read errors during active traffic remain counted.

All workload profiles have a finite deadline and stop on signals, critically low available memory or three consecutive sufficiently sampled windows over 10% HTTP errors. A stopped/expired server grant revokes registration/reporting and synthetic actions; socket leases recheck at most ten seconds later. Workers check Node/cgroup available memory, open-file limits and the <=1000 per-generator client limit (<=12 browsers) **before traffic**. These checks are estimates, not a promise that the target can be sustained. If a worker disappears, the server marks current activity unknown after ten seconds instead of substituting the requested target.

## Owned-target authorization and credentials

Every command requires `--authorize-owned-target`; operators may use only their owned local/staging infrastructure. Run creation additionally requires trusted local database access via the fixed operator CLI and exact membership in `CAPACITY_ALLOWED_ORIGINS` (default localhost/127.0.0.1:5173). URLs with credentials, query strings, paths or unsupported protocols are rejected. HLS URI resolution and redirects cannot send the harness to a different origin. There is no arbitrary command/target execution endpoint.

One unexpired run may be active at once. Each grant has an independent random bearer credential stored only as a database hash and in a private ignored `.local/demo/capacity-RUN_UUID.json` file. It authorizes only registration, cumulative reporting and appropriate synthetic participants. It cannot authenticate an administrator, publish media, mutate real accounts or inject faults. Bound allocations are durably locked so distributed workers cannot exceed the run ceiling. Each worker is <=1000 clients; at most 100 worker identities belong to a run. Worker IDs and allocations are immutable. Report sequences are monotonic/idempotent, cumulative counters cannot decrease, and report activity cannot exceed allocation. Never paste a grant into a command line, public issue or artifact.

## Local stages

```powershell
npm.cmd run capacity:run -- --profile api --clients 100 --duration 30 --ramp 5 --authorize-owned-target
npm.cmd run capacity:stages -- --levels 100,1000 --profile socket --duration 30 --ramp 20 --authorize-owned-target
```

The latter creates sequential independent runs and stops if a stage fails. Local >1000 client runs are rejected rather than automatically launched on a laptop. A 1000-client test still requires suitable memory/file descriptors and can exceed the current topology's actual capacity. Repeating a measured failure at higher load is not necessary to make a dashboard impressive; inspect the error/resource evidence first.

## Distributed 1k/5k/10k/25k/50k stages

Provision generators and owned staging infrastructure separately; local demo web/admin endpoints remain loopback. Distributed workers need an explicitly configured safe reachable data ingress (HTTPS/WSS recommended), authenticated reporting, allowed origin/CORS, network policies and synchronized clocks. Do not make Docker/Healer/MediaMTX admin endpoints public to support generators. A loopback-only desktop composition cannot be reached directly by generators on other machines. A trusted private tunnel or proper staging ingress is required.

On the trusted operator host, configure the exact owned staging origin in `CAPACITY_ALLOWED_ORIGINS`, regenerate setup, then create one finite stage, for example:

```powershell
npm.cmd run capacity:create -- --profile socket --clients 50000 --duration 120 --ramp 120 --distributed --authorize-distributed --target https://YOUR-OWNED-STAGING-HOST --authorize-owned-target
```

This creates a private grant file and **does not start clients**. Transfer only that short-lived run grant securely to the prepared generator hosts. Install Node 24 and this checkout's dependencies on each generator. In each worker terminal:

```powershell
npm.cmd run capacity:worker -- --grant C:\PRIVATE\capacity-RUN_UUID.json --clients 1000 --authorize-owned-target
```

Fifty distinct 1000-client workers allocate a 50,000-client socket stage; allocations are not achievements. Worker UUIDs are random unless `--worker-id` supplies a retained valid UUID. A restarted worker must not silently reset cumulative counters: use a new stage after process loss, rather than reusing an allocation with counters starting at zero. Deadline/one-run admission prevent unbounded reuse. Inspect actual connected peaks, stale workers, errors and generator/target resource observations. Repeat deliberate stages at 1000, 5000, 10000 and 25000 before attempting 50000; finish or stop each run first. The 50K milestone stays PARTIAL until actual evidence verifies the desired concurrency and acceptable error/resource behavior.

HLS bandwidth is a distinct limit: 50,000 clients each consuming 2 Mbit/s would require roughly 100 Gbit/s egress before overhead. An HTTP-request capacity result is never evidence of that delivery rate or decoding. A real public deployment normally needs a CDN and distributed media delivery; this release does not install one.

## Reports and dashboard semantics

Authenticated workers send cumulative metrics every two seconds, with bounded retry and separate CPU/RSS samples. PostgreSQL stores run configuration, immutable worker allocation, latest reports and aggregate samples (at most one per second per run). History is retained for comparison. p50/p95/p99 merge bucket counts across workers; bucket values are upper bounds, never an average of percentiles. Empty measurements remain null. RPS/chat rates use cumulative completions divided by run wall time, including ramp/setup, and are labelled averages.

Actual active values sum only current reports; any stale unfinished worker makes global current activity unknown. A single worker's observed peak is a valid local peak; distributed peak is the maximum time-aligned aggregate sample, not the sum of unrelated worker maxima. Sampling can miss brief concurrency peaks. Target, allocated clients, active measurements and verified browser counts remain distinct. Completed/expired runs are historical evidence, not current audience.

Socket/HTTP/browser metrics come from the trusted generators, with server validation/allocation bounds. They are not independently verified human audience counts. Target CPU/RSS, API throughput, socket gauge, media availability, incidents and Healer attempts come from the existing private observability stack. Generator CPU/RSS is separately labelled. Browser serving-edge identity remains unobserved.

Synthetic chat is rate-limited across the run, marked `[SYNTHETIC]`/`Load-...`, broadcast only inside the chosen channel and excluded from permanent chat history. Guest messages remain durable. The retained sequence counter can have gaps; no message is fabricated to fill them. The delivery metric confirms another same-room client, not just the sender's acknowledgement.

Stop a run safely:

```powershell
npm.cmd run capacity:stop -- RUN_UUID
# Or Ctrl+C in each local worker, allowing its final report before grant revocation.
```

If a grant expires or is revoked before a final report, the CLI explicitly reports final persistence unconfirmed and retains local results. Those files must not be labelled server-confirmed. Do not delete users, chat or named volumes as a load-test cleanup shortcut. Run/audit retention is an explicit operator responsibility.

## Capacity acceptance evidence

See `THREE_CHANNEL_DEMO_MEASUREMENTS.json` and actual PR checks. The platform has separate acceptance from the 50K milestone. The integration test exercises smaller profiles, verifies three independent encoded/decoded streams and performs real Chaos API/edge/primary/Redis/network faults during a current bounded API workload. It checks reporting/allocations, guest denial, durable history and dashboard consistency. Achieved maxima are reported per profile; a local target of 100 is not automatically 100 active HTTP requests. A clean CI result cannot establish laptop/staging/50K capacity.
