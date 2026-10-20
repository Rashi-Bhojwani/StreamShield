# Phase 7: interactive Chaos Engineering Control Center

Phase 7 adds an administrator-only Chaos Laboratory and a genuine split-screen live demonstration. The new Chaos Controller injects faults and observes recovery; the existing independent observer and Healer remain responsible for detection and repair. Opening or closing a browser never runs a recovery playbook.

## How to Run Phase 7 in VS Code

Use Windows PowerShell with Git, VS Code, Node.js 24, Docker Desktop in Linux-container mode, Chrome and FFmpeg with libx264/AAC available on PATH. Start Docker Desktop and wait for its engine to become ready. Allow at least 4 CPUs, 8 GB Docker RAM and 25 GB free Docker storage for the full topology. VFS cloud hosts need extra headroom; ordinary Docker Desktop uses more efficient layered storage.

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/feature/phase-7-chaos-control-center
code .
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:chaos -- --enable-local-chaos
node infrastructure/chaos/compose.mjs config --quiet
npm.cmd run chaos:up
npm.cmd run chaos:probe
```

For an existing checkout, use git fetch origin, then git switch feature/phase-7-chaos-control-center if the local branch already exists. Keep your changes before switching. This branch is based on the verified integration branch feature/phase-4-redundancy-failover because Phase 6 PR #7 was merged there, rather than into main. No prerequisite PR is merged automatically.

Setup chains the existing media/platform/redundancy/monitoring/healing generators, preserves nonempty credentials and persistent volumes, builds React assets and generates an additive private chaos overlay. The explicit flag enables both local Healer repairs and local chaos. Without opt-in, injection defaults off. Do not expose this development composition on a public interface.

Open http://localhost:5173 and register your intended account. Grant that existing username administrator access using the trusted local terminal:

```powershell
node infrastructure/chaos/compose.mjs exec -T api-2 node scripts/set-role.mjs YOUR_USERNAME administrator
```

Reload the browser. Open http://localhost:5173/control/chaos for the Laboratory, http://localhost:5173/control/demo for the live demonstration, /control/topology for infrastructure, /control/incidents for incidents and /control/recoveries for the independent recovery audit. Ordinary viewers receive no operational data or mutation authority.

### OBS and FFmpeg

For a genuine webcam or display broadcast, create your owned channel/stream in Studio and generate its publishing credential. In OBS Settings → Stream → Custom, copy Studio's exact Server and Stream Key. The default RTMP server is rtmp://127.0.0.1:1935. Use H.264, yuv420p, AAC and two-second keyframes. Click Start Streaming, then open the stream's Watch URL. Select that actual live stream in /control/demo.

For the bounded development test pattern, run this in another VS Code terminal:

```powershell
npm.cmd run broadcast:test
```

Open http://localhost:5173/watch/live, then select the development source in Demo. It is an FFmpeg test pattern, not a camera, and stops after the configured duration (120 seconds by default). For a five-minute demonstration, set a bounded duration in that terminal:

```powershell
$env:TEST_PUBLISH_DURATION_SECONDS="600"
npm.cmd run broadcast:test
```

Ctrl+C stops your publisher. Do not paste publishing keys into logs or PRs. Stop other broadcasters before automated media/fault tests, which create two independent authorized sources.

### Run experiments

Wait for fresh monitoring, all healthy baseline components and an enabled independent Healer. In Chaos Lab choose Crash API-1, inspect the exact target/disruption/deadline, type api-1 and acknowledge the active-user impact. Click Inject controlled failure. The UI records its UUID and then displays actual fault confirmation, incident correlation, independent Healer action, verification and outcome. Do not issue a restore command.

Wait for completion and healthy baseline before selecting Crash Edge-1 (type edge-1), then Crash primary origin (type origin-primary). Those media scenarios require a real source and independently verified fresh standby segments. Watch actual video in Demo while inspecting the current service states and experiment timeline. The player can remain on a healthy standby after primary restoration; automatic failback is deliberately absent.

## Scenario coverage

| Control                       | Actual injection                                                                           | Independent recovery and verification                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Crash API-1                   | SIGKILL only the managed api-1 container                                                   | API-2 survives; Healer starts API-1. Direct readiness, application reads and counters proving both gateway peers serve requests verify restoration.                                                                |
| Crash Edge-1                  | SIGKILL only edge-1                                                                        | Edge-2 remains; Healer starts Edge-1. Authorized HLS playlists, nonempty segments and segment progression verify both live paths.                                                                                  |
| Crash primary origin          | SIGKILL only origin-primary                                                                | Healthy standby preserves source availability; Healer starts primary after standby guards. Real authorized segment progression verifies restored primary.                                                          |
| Interrupt Redis               | SIGKILL only Redis                                                                         | Healer starts Redis, application clients reconnect. Authenticated Redis/API health and real cross-instance chat plus durable PostgreSQL history are checked. Pub/Sub delivery during the outage is not guaranteed. |
| Introduce network latency     | Real Toxiproxy downstream latency of 3500 ms on the private recommendation-demo connection | The owned toxic expires; independent safe GET probes/circuit reconnection verify return. This is timed network cleanup and reconnection, not container repair.                                                     |
| Interrupt external API demo   | Toxiproxy reset_peer on the explicitly simulated read-only recommendation dependency       | Actual circuit rejection/fallback is observed. Owned fault cleanup and bounded safe probes permit recovery. No payment/write operations exist.                                                                     |
| Database outage               | **Disabled**                                                                               | Existing storage policy escalates for operator review. Chaos has no database injection or automatic restoration authority.                                                                                         |
| Test broadcaster interruption | **Disabled**                                                                               | Chaos does not own a user OBS/camera/FFmpeg lifecycle. The Healer cannot recreate missing camera video.                                                                                                            |

Only six controls can be enabled. Unsupported scenarios stay visible with explanations. An unavailable prerequisite, unhealthy dependency, stale observer, unavailable/disabled Healer, active experiment or unresolved cleanup disables admission. Actual Healer cooldown and rolling start budgets remain in force; repeated demonstrations can exhaust the default two starts per service per ten minutes. Do not erase journals or weaken budgets to make tests pass.

## Architecture and authority

React → fresh administrator API authorization/CSRF → private Chaos Controller → restricted fault adapter → real fault. Separately, observer → confirmed incident → independent Healer → its existing fenced start adapter → functional verification. Chaos reads Healer state but has no Healer control credential and no service-start endpoint. Media stays on the existing RTMP/MediaMTX/HLS path.

The new controller runs without root, a Docker socket or platform session secrets. Its PostgreSQL role can write only chaos audit records and read incident/recovery correlation. The fault adapter joins a separate internal network inaccessible to APIs and owns its own SQLite journal. It permits only four labelled logical service SIGKILL operations and experiment-named Toxiproxy toxic create/remove. It cannot execute shell commands, start services, delete containers or manipulate volumes through its HTTP interface. A read-only Docker socket bind still confers host-equivalent Docker API authority to that trusted adapter process; it is not a tenant isolation boundary. Do not deploy the privileged local demo topology to production.

Both SQLite journals use WAL/FULL synchronization. Experiment intent is persisted before injection; ambiguous responses are reconciled by UUID without repeating destructive POSTs. Duplicate UUIDs are actor/scenario bound. One durable active experiment, one active adapter fault, per-target cooldown and per-administrator rolling admission rate protect the topology. PostgreSQL persistence is labelled separately from local journal acceptance. Controller restart preserves experiments and adapter restart preserves owned fault deadlines; host/journal loss is outside this single-host guarantee.

The lifecycle is CREATED → VALIDATING → INJECTING → FAULT_CONFIRMED → AWAITING_DETECTION → HEALING_OBSERVED → VERIFYING, followed by COMPLETED, FAILED, TIMED_OUT or CANCELLED. A completed experiment requires actual injection evidence, a new independent recovery attempt and additional functional verification. Experiment outcomes never turn other infrastructure green. Database outage before injection denies the fault; later audit outage keeps the local record for synchronization.

A cancellation accepted during an in-flight fault response is retained in the journal. An older PostgreSQL acknowledgement cannot overwrite newer local intent or falsely mark it synchronized. The controller also rechecks cancellation after audit persistence and before sending an injection request. Deterministic concurrency tests cover both interleavings.

The adapter removes only its UUID-named temporary toxic at expiry, independent of browser and orchestrator. Cleanup failure remains visible and is retried; unresolved ownership prevents new injection. Cancellation removes an owned network condition where possible and stops experiment observation. It cannot undo SIGKILL and never starts a crashed service. Timeout does not prove restoration. Adapter/host unavailability can delay cleanup beyond the configured target duration; durable retry resumes when that infrastructure returns. Emergency operator review is required if the privileged adapter itself cannot run.

## APIs, events and measurements

Fresh administrator authorization protects GET /api/v1/monitoring/chaos, POST /api/v1/monitoring/chaos/experiments and POST /api/v1/monitoring/chaos/experiments/:id/cancel. Creation accepts exactly id (UUID), scenario and confirmation; actor comes from the current database-backed session. Mutations require a valid same-origin CSRF token. Cancellation remains available for safe cleanup if enablement is subsequently disabled. The API/controller/adapter additionally validate independent local gates and fixed scenario allowlists. Internal control ports have no host publication. Operational reads and experiment reads use separate bounded admission buckets (120 requests/minute per administrator per family), allowing reconciliation alongside the dashboard; destructive experiment admission retains its independent durable 12-per-ten-minute default limit.

Existing typed monitoring:v1 invalidations add chaos_changed. A persisted revision triggers the hint; clients reconcile authoritative REST on connect/reconnect and every three seconds. Socket loss cannot delete history or invent experiment progress. History covers the latest 100 retained records; locally only PostgreSQL-confirmed terminal records older than CHAOS_RETENTION_DAYS are pruned. PostgreSQL audit retention remains explicit operator responsibility.

Every record contains actor, UUID, target, actual timestamps, injection receipt, original incident detection, correlated recovery IDs, deadline, cleanup, mechanism and evidence. Detection/healing-start/action/restoration durations derive from those actual event clocks. HLS byte progression is distinct from browser decode. The backend leaves playback interruption null; actual Demo player metrics and automated 250 ms browser sampling report local startup, stalls, source and decoded progression separately. Serving edge is labelled unobserved because the player has no measured edge identity. No traffic animation or projected reliability statistic is shown.

## Configuration

.env.example lists CHAOS_ENABLED=false and CHAOS_ENVIRONMENT=disabled by default. Setup generates independent CHAOS_SECRET, CHAOS_CONTROL_SECRET and CHAOS_DB_PASSWORD, retains them privately and rejects shared authority. Config validates CHAOS_ALLOWED_SCENARIOS, CHAOS_FAULT_DURATION_MS (8–30 seconds, default 15 seconds), CHAOS_TIMEOUT_MS (30–300 seconds, default 180; at least fault duration + 15 seconds), CHAOS_CONCURRENCY=1, CHAOS_COOLDOWN_MS (default 30000), CHAOS_RATE_LIMIT (default 12), CHAOS_RATE_WINDOW_MS (default 600000), CHAOS_RETENTION_DAYS (default 90), CHAOS_PROBE_TIMEOUT_MS and distinct CHAOS_PORT/CHAOS_CONTROL_PORT (4030/4031). These are private listeners. RTMP/HLS/public ports retain existing .env configuration.

Injection additionally requires NODE_ENV=development, BIND_ADDRESS loopback and explicit local-development environment. Changing .env requires setup:chaos again and recreating services. The optional compiled frontend requires setup/build plus image rebuild after UI edits. Never print .env, private generated Compose or resolved Compose containing credentials. No new runtime dependency was added; the maintained Phase 6 libraries and pinned images are reused.

## Five-minute college demonstration

1. Before the presentation, start the full composition, administrator session and a ten-minute FFmpeg/OBS source. Check chaos:probe and Demo video progression. Avoid spending presentation time building images.
2. Minute 0–1: show real stream title/video, current topology and the distinction between failover and component repair. Open Crash API-1 confirmation and explain its exact target.
3. Minute 1–2: inject API-1 once. Show the real incident, independent action and verified experiment metrics while the surviving API serves the application.
4. Minute 2–3: inject Edge-1 after healthy baseline returns. Observe the live player, independent HLS verification and restored service without a restore click.
5. Minute 3–4: inject primary origin if fresh standby media remains available. Explain the actual source switch and sticky standby behavior; allow verification to complete.
6. Minute 4–5: inspect retained experiment/incident/recovery evidence and measured durations. Explain the two disabled controls, bounded network fault option and single-host limits. Durations are observed, not guaranteed; skip a new experiment if the previous one has not completed.

## Verification, shutdown and troubleshooting

```powershell
npx.cmd playwright install chromium
npm.cmd run lint
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:chaos
npm.cmd run chaos:status
npm.cmd run chaos:down
```

Shutdown preserves all named volumes. Never use down -v, volume reset, or Docker prune with --volumes. Previous Phase 1–6 regression suites retain their original isolated compositions and CI jobs; run those fault suites sequentially, stopping the active topology first. The Phase 7 test exercises every enabled scenario through the UI API, real two-user FFmpeg/HLS/decoded playback, cross-instance chat, security, durable controller restart, refresh/reconnect and five viewport widths. Unit/security tests cover production denial, admission, restart, timeout, failed cleanup and ambiguous responses. Consult PHASE_7_MEASUREMENTS.json and the actual PR check results for verification status.

If Docker is unreachable, start Desktop and select Linux containers. Check occupied host ports 5173/4000/1935/8888/3000 and regenerate config after port changes. A disabled media scenario usually means no real stream or insufficient fresh standby segments; confirm OBS is actually publishing and H.264/AAC are supported. Browser autoplay may require a click to unmute/play. RTMP connection refusal suggests port/engine/firewall issues; auth denial requires Studio's current owned key rather than a legacy path guess. HLS 404/stale media requires inspecting the publisher and origin readiness, not refreshing fake status.

If injection is denied, inspect current administrator role, local opt-in, fresh observer/Healer evidence, active experiment, adapter cleanup, healthy dependencies and Healer budgets/cooldowns. An offline controller can still show durable history labelled unavailable; that does not establish live health. Do not manually restore a service to make an autonomous-recovery assertion pass. If storage or publisher input fails, preserve data and review the explicit disabled/escalation policy.

For this constrained VFS cloud only, infrastructure/docker/start-healing-cloud.mjs --chaos removes completed setup containers after successful exit and stages Grafana last. Optional flatten-image.mjs handles trusted images only. Disposable old image-export archives/build cache can consume substantial disk; retain named volumes/source/credentials. Docker Desktop does not need this cloud workaround.

## Phase 8 handoff

Reusable experiment UUIDs, typed contracts, durable audit, exact scenario boundaries and separate playback/server measurements are ready for a later capacity-testing design. Phase 7 introduces no high-concurrency traffic simulation, host-level redundancy, production chaos permission model or audience-capacity guarantee.

## Reference semantics and environment limits

Temporary faults follow [Toxiproxy 2.13.0's documented toxic API](https://github.com/Shopify/toxiproxy/blob/v2.13.0/README.md). Logical SIGKILL targets use the same narrowly discovered Docker identities as the existing adapter; see [Docker Engine API](https://docs.docker.com/reference/api/engine/) and [VFS storage behavior](https://docs.docker.com/engine/storage/drivers/vfs-driver/). [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/) explain why persisted REST reconciliation remains necessary.

Media preflight independently observes a nonempty authorized path set and subsequent standby segment progression; a first segment alone is insufficient. Verification is bounded to five active authorized paths by the inherited verifier. A capacity/precondition failure cannot authorize a partial media fault. Playback checks require consecutive advancing video time and decoded frames within the current source timeline, because primary and standby clocks are independent.

Tests execute on clean Linux GitHub runners. PowerShell/Docker Desktop instructions are documented from the actual repository scripts; a Windows VM was not available for execution here. The current cloud snapshot's 32 GB VFS writable storage remains insufficient for the full extended topology despite safe staging/cache recovery. Local source, credentials and named volumes were preserved; the actual CI results establish integration verification.

## Verified results

All five clean Linux CI jobs passed on [007743a](https://github.com/Rashi-Bhojwani/StreamShield/actions/runs/39466656790): verify, resilience, monitoring, healing and chaos. The verify job includes build, lint, formatting, types, all 155 unit/security tests, migrations/platform integration, browser and real media regressions. The other jobs retain Phase 4–6 coverage and add the six authenticated Phase 7 experiments. Test artifacts include both independent decoded broadcasts, cross-instance chat/durable history, observer/Healer admission denial, controller restart during an owned toxic, UUID duplication/concurrency denial, browser refresh/reconnect, idempotent cleanup receipts, cancellation before injection and actual no-source instructions.

The following are single-run observations, not availability guarantees. Restoration is independent server verification, not the duration of browser interruption. Network cases use timed cleanup and safe-read/circuit reconnection rather than a service restart.

| Scenario        | Detection (s) | Healing start (s) | Action request (ms) | Independent restoration (s) | Largest sampled decode gap (s) |
| --------------- | ------------: | ----------------: | ------------------: | --------------------------: | -----------------------------: |
| crash-api       |         2.626 |             3.403 |                 218 |                      12.540 |                          0.500 |
| crash-edge      |         3.550 |             3.854 |                 166 |                      12.333 |                          0.500 |
| crash-primary   |         3.000 |             5.008 |                 271 |                      23.399 |                          1.500 |
| crash-redis     |         2.674 |             3.471 |                 179 |                      15.305 |                          0.500 |
| network-timeout |         4.415 |             6.647 |                   3 |                      30.955 |                          0.501 |
| external-api    |         3.262 |             4.060 |                   5 |                      30.330 |                          0.500 |

The largest observed control-read retry interval was 4.784 seconds. That sampled window is separate from media continuity; it is not a claim about total endpoint outage duration. The maximum counted interruption total in any one viewer experiment window, using the 2-second threshold, was 0.000 seconds. All raw event times, incident/recovery UUIDs, receipts, two-viewer samples and measurement definitions are retained in [PHASE_7_MEASUREMENTS.json](PHASE_7_MEASUREMENTS.json).

Both Laboratory and Demo were captured and visually inspected at all five requested widths. The screenshots show the actual live FFmpeg signal and durable backend records. Layout checks reject document-level horizontal overflow; screenshots wait for real catalog/history data. Additional captures show exact-target confirmation, an API experiment, an in-flight edge experiment and the honest no-live-source state.

| Width  | Chaos Laboratory                              | Live demonstration                            |
| ------ | --------------------------------------------- | --------------------------------------------- |
| 375px  | [Laboratory](screenshots/phase7/lab-375.png)  | [Live Demo](screenshots/phase7/demo-375.png)  |
| 768px  | [Laboratory](screenshots/phase7/lab-768.png)  | [Live Demo](screenshots/phase7/demo-768.png)  |
| 1280px | [Laboratory](screenshots/phase7/lab-1280.png) | [Live Demo](screenshots/phase7/demo-1280.png) |
| 1440px | [Laboratory](screenshots/phase7/lab-1440.png) | [Live Demo](screenshots/phase7/demo-1440.png) |
| 1920px | [Laboratory](screenshots/phase7/lab-1920.png) | [Live Demo](screenshots/phase7/demo-1920.png) |

[Confirmation](screenshots/phase7/confirm-api.png) · [API execution](screenshots/phase7/active-api-experiment.png) · [Live edge experiment](screenshots/phase7/live-edge-experiment.png) · [No source](screenshots/phase7/no-live-source.png).
