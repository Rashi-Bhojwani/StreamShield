# Phase 6: independent autonomous recovery

This branch extends Phase 5's real observations and incidents with a separately deployed TypeScript Healer and a narrow service-control adapter. Phase 4 Nginx/player failover preserves continuity; Phase 6 starts a failed component and verifies restoration. These are separate mechanisms and measurements. Verification results are recorded below after the actual experiments complete.

## Windows VS Code startup

Use Node.js 24, Git, VS Code, Chrome, FFmpeg with libx264/AAC and Docker Desktop in Linux-container mode. Four CPUs, 8GB Docker RAM and at least 20GB free Docker storage are recommended for ordinary layered Docker storage. VFS storage can require substantially more space; see the cloud note below.

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/feature/phase-6-autonomous-healing
code .
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:healing -- --enable-local-repairs
node infrastructure/healing/compose.mjs config --quiet
npm.cmd run healing:up
npm.cmd run healing:probe
```

The branch must be pushed before the checkout command is usable. Check the actual PR for publication and CI status; source files alone do not establish verification. Start Docker Desktop before Compose. Setup preserves existing nonempty configuration and credentials, applies forward migrations and builds the same React application for the optional Nginx frontend. The lightweight Vite development topology remains available. The recovery composition uses a separate lockfile/image containing only backend runtime dependencies; Windows-host native modules are never mounted into Linux containers.

Privileged actions default disabled. `--enable-local-repairs` explicitly opts this loopback development deployment into the allowlisted policy. Do not expose the composition publicly. To disable actions set HEALER_ENABLED=false, rerun setup:healing and recreate healer/healing-control. Threshold changes also require regenerating config and recreating affected services. The monitoring-only composition remains independent of healing.

Open http://localhost:5173, register your intended account, then grant that existing username administrator access from the trusted local terminal:

```powershell
node infrastructure/healing/compose.mjs exec -T api-2 node scripts/set-role.mjs YOUR_USERNAME administrator
```

Reload and open http://localhost:5173/control, then Recoveries. Overview, topology, metrics, service details and incident history remain available. Recovery cards show real playbooks, actions, attempt numbers, actual timestamps, verification evidence, escalation and local-versus-PostgreSQL persistence. Opening or closing the browser never starts or stops recovery.

Grafana: http://localhost:3000, user operator and the private generated OBS_GRAFANA_PASSWORD. Prometheus, observer, Healer, adapter and Toxiproxy have no published host control ports. Never paste secrets, private generated configs or resolved Compose output into logs/screenshots.

## Real publishing and bounded failures

In Studio create a channel/stream and generate its publishing credential. OBS → Settings → Stream → Custom: copy Studio's exact Server and Stream Key. Default server: rtmp://127.0.0.1:1935. Use H.264/yuv420p, AAC and two-second keyframes. Open that owned stream's Watch URL. Both origins receive its dynamic authorized path. Repeat through a second account for an independently owned stream.

For a bounded synthetic development broadcast:

```powershell
npm.cmd run broadcast:test
```

Open http://localhost:5173/watch/live. This FFmpeg test pattern is not a webcam and stops after 120 seconds by default. Stop your own broadcaster before automated tests, which create their own two independent sources.

With streaming and Control open, inject one supported local fault at a time:

```powershell
npm.cmd run healing:control -- crash api
# Observe API-1: diagnosis → start → independent verification → outcome.
# Do not issue a restore command; the Healer must perform restoration.
npm.cmd run healing:probe

npm.cmd run healing:control -- crash edge-1
npm.cmd run healing:control -- crash origin-primary
npm.cmd run healing:control -- crash redis
```

Wait for verified restoration between experiments. Open the correlated incident and its recovery evidence. The API repair preserves API-2; edge repair preserves Edge-2; primary repair requires a healthy relay/standby and fresh standby segments. It verifies all currently sampled live paths after starting primary. The player remains sticky on a working standby; no forced failback is added. Redis repair starts the stopped Redis service; session/chat data stays in PostgreSQL. Pub/Sub messages during an outage are not durable, and restoration does not replay ambiguous writes.

Each service has a persistent rolling start budget (default two starts per ten minutes) and a 30-second cooldown. Repeated tests can correctly exhaust these limits. Do not erase journals or raise production admission limits to make a test pass. The test report must identify the policy used.

## Unsafe or impossible repairs

PostgreSQL is deliberately absent from the adapter's start allowlist. A confirmed outage creates a locally journaled escalation requiring operator storage review. API dependency symptoms do not trigger cascading API restarts. The Healer cannot inspect or repair database corruption, does not delete volumes and never runs a migration as a repair.

To demonstrate this escalation on an idle local deployment:

```powershell
node infrastructure/healing/compose.mjs stop postgres
# Fresh dashboard authorization/database persistence will be unavailable.
# Inspect private Healer logs; the source continues where the existing media path permits.
node infrastructure/healing/compose.mjs logs --tail=30 healer
# After reviewing this deliberately injected stop, restore it as the operator:
node infrastructure/healing/compose.mjs up -d --no-deps --wait postgres
```

That last command is explicit operator cleanup, not an autonomous database repair. After storage returns, the Healer independently verifies a restricted database read/write, synchronizes the previously local attempt and records that restoration originated externally. Existing sessions and application data are checked by integration tests.

For a permanently disconnected broadcaster, the observer and Healer corroborate that a previously observed authorized path is missing while relay/origins remain healthy. The source-wait playbook escalates without restarting origins. Watch truthfully displays its source-unavailable/offline state. Only the broadcaster can return the original source. Authorized reconnection and progressing media are independently observed and recorded; no camera video is fabricated and source reconnection is not called a container repair.

## Authority and coordination

Only healing-control mounts the Docker socket, on an unexposed dedicated internal network. APIs and React have no control token/socket access. The HTTP interface accepts only a strict typed start request for configured logical service IDs. It discovers exactly one container with the configured Compose project/service and explicit managed label, then inspects it. Only exited, non-OOM containers are eligible for a start. It cannot create/recreate containers, exec arbitrary commands, change networks, delete files/volumes or run migrations. Running-but-unreachable and unsafe/ambiguous states require verification or escalation rather than a blind restart.

The read-only socket mount does **not** reduce Docker API privilege. The adapter is trusted privileged code; compromising its process/socket remains host-equivalent authority. HTTP allowlisting, separate credentials, network separation, dropped capabilities and read-only filesystem constrain this application interface, not the underlying socket. This is a local development mechanism, not a multi-tenant production isolation guarantee.

The adapter owns an independent SQLite leader lease with monotonically fenced epochs, persistent operation IDs, per-service cooldowns and rolling budgets. PostgreSQL outage therefore does not make coordination fictitiously available through a failed database lock. One leader authorizes operations; one global operation executes at a time. Ownership expiry rejects stale leaders. The same operation ID never starts a container again. Interrupted/ambiguous operations are reconciled or escalated rather than blindly replayed.

The Healer has its own local WAL audit journal, on a separate named volume, and records intent before effects. A restarted controller adopts existing attempts under its new fenced epoch and resumes verification. A second controller sharing these journals must remain a follower. This single-host adapter/shared-volume boundary is not distributed consensus or multi-region availability.

## Evidence, storage and realtime

The additive healing migration creates healing_attempts, ordered healing_events, a restricted healing_verification table and a view of expected ready source paths. Existing users, sessions, channels, streams, chat and Phase 5 incidents remain intact. A restricted Healer database identity can access only monitoring/recovery records and that source-path view. It cannot read account hashes, session tokens or chat contents.

Attempt records include the original observed failure time, incident ID, actor, selected versioned playbook, diagnosis, action type, attempt number, real execution/verification timestamps, sanitized evidence, outcome and escalation reason. SCHEDULED → EXECUTING → VERIFYING → VERIFIED is distinct from RETRY_WAIT/ESCALATED. Source/operator observation-only cases have no invented action start. Verification retries have bounded windows, exponential backoff/jitter and a maximum count; they do not issue another potentially ambiguous start.

PostgreSQL persistence is confirmed separately from local SQLite acceptance. During a database outage, the local escalation survives a Healer process restart and synchronizes afterward. An observer's confirmed in-memory episode can be correlated when its delayed PostgreSQL incident arrives. Simultaneous loss of the host or local journal storage is not protected by this mechanism. The local queue/read views are bounded; UI summaries cover the latest 100 retained attempts, not lifetime accounting.

Phase 5 resolution is gated while an attached repair lacks independent verification. It preserves the original incident's timestamps. Monitoring:v1 uses version 1, a sequence and kind snapshot_changed/recovery_changed. Recovery invalidations are emitted only from persisted changes through the existing administrator/session-validated Socket.IO path. Authenticated GET /api/v1/monitoring/healing returns current controller/audit state, with durable fallback labelled unavailable when the controller cannot be reached. GET /api/v1/monitoring/dependency-demo exposes only the simulated read-only fallback. There is no public recovery mutation endpoint. Reconnect and periodic REST reconciliation remain authoritative.

## Network and external dependency demonstration

A private, clearly labelled read-only recommendation simulator sits behind pinned Toxiproxy 2.13.0. It has no money, payment or write operations. The circuit uses CLOSED, OPEN and HALF_OPEN, bounded request deadlines, capped exponential recovery backoff with jitter, rejected-call metrics, recovery windows and consecutive successful probes before closing. Degraded responses explicitly contain an empty unavailable fallback. Safe reads can retry; ambiguous writes are never replayed.

Tests inject real latency/connection failure into this selected connection and stop the simulated upstream. Removing a toxic or restoring the external simulator restores the external network/dependency; autonomous probes/reconnection verify the return. The Healer does not claim to repair an unavailable outside network by restarting unrelated platform services. Toxiproxy's administration API stays private and is used only by trusted CLI tests. Phase 7 UI fault controls are not implemented.

## Configuration and metrics

.env.example documents HEALER_ENABLED, HEALER_ALLOWED_SERVICES, HEALER_DISABLED_PLAYBOOKS, HEALER_INTERVAL_MS, HEALER_PROBE_TIMEOUT_MS, HEALER_ACTION_TIMEOUT_MS, HEALER_VERIFY_MS, HEALER_STABILITY_MS, HEALER_COOLDOWN_MS, HEALER_BUDGET_WINDOW_MS, HEALER_MAX_STARTS, HEALER_MAX_ATTEMPTS, HEALER_BACKOFF_MS, HEALER_LEASE_MS, HEALER_SOURCE_GRACE_MS, HEALER_CIRCUIT_FAILURES, HEALER_CIRCUIT_RESET_MS and listener ports. HEALER_DOCKER_SOCKET configures the local Linux daemon socket path. Setup generates independent HEALER_SECRET, CONTROL_SECRET and HEALER_DB_PASSWORD without printing them.

Prometheus scrapes the private Healer registry. Grafana provisions a separate Autonomous Recovery dashboard with actual action/outcome rates, active attempts, circuit state/rejections and recovery/verification duration distributions. Actual metrics include created attempts, action requests, terminal outcomes, detection-to-action/action/verification/total durations, active attempts, suppression reasons, circuit state and rejected calls. Labels contain bounded playbook/outcome/reason values, never user IDs, publishing keys or arbitrary incident UUIDs. Process counters reset on process restart; durable audit summaries do not. Component health, routing continuity, authorized media-byte progression and browser decoding remain separate evidence.

## Cloud VFS disk recovery

The Codex cloud host uses a 32GB filesystem and Docker's VFS driver. VFS copies whole container filesystems, and retained completed migration/setup containers can prevent a full startup. This is a cloud storage issue, not a Windows Docker Desktop setting.

After building the prepared runtime/web images, use:

```bash
DOCKER_CONFIG=/workspace/.docker-client node infrastructure/docker/start-healing-cloud.mjs
```

The helper temporarily removes only Grafana's disposable container, starts the rest with Grafana scaled to zero, verifies the four setup jobs exited successfully, removes those completed containers and then starts Grafana alone. All named volumes remain. This staged sequence was exercised successfully on the current cloud host. The full observer inventory then reported fifteen healthy components and thirteen healthy scrapes. Source and image file modes must permit the mounted non-root container UIDs to read public code/manifests; .env and generated secret parents remain private. New images explicitly normalize public manifest/static-asset permissions.

Do not use docker system prune --volumes, down -v or delete /var/lib/docker. Optional trusted-image flattening and disposable builder cache cleanup are cloud-only tools; ordinary Docker Desktop/overlay2 does not need them. Keep headroom before builds. A larger cloud disk remains useful for concurrent builds or additional topology copies. Saving environment instructions does not publish a snapshot or verify a fresh task.

## Verification and shutdown

```powershell
npx.cmd playwright install chromium
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd test
npm.cmd run build
npm.cmd run test:healing
```

The healing test uses real accounts, two FFmpeg broadcasts and decoded Chrome frames, real service stops, independent verification, fenced duplicate-controller exclusion, observer/Healer restart, private control restrictions, network/circuit faults, PostgreSQL safe escalation and source interruption. It never calls a manual restore to satisfy an autonomous service-repair assertion. Restoring an intentionally unrecoverable/external fault is labelled separately. Stop other broadcasters and run fault suites sequentially. Inspect the actual generated test-results/phase6/measurements.json and screenshots; failed/interrupted runs are not passes.

Retained Phase 1–5 regressions run with the Healer disabled in their original compositions. Stop healing without -v before switching modes. See docs/PHASE_5.md for monitoring/resilience and lightweight platform/browser/media commands. Preserve all PostgreSQL/Grafana/Prometheus/healing journal volumes.

```powershell
npm.cmd run healing:down
```

If Docker cannot start, check Linux-container mode and ports 5173/4000/1935/8888/3000. If actions are absent, check the enabled/allowed policy, observer freshness, failed dependencies, leader/adapter reachability, cooldowns and budgets before assuming a bug. A running container does not establish successful repair. If the Docker socket path/permission is unsupported, escalate; do not expose it publicly or run the whole application privileged. Regenerate config after port/policy changes. The optional compiled frontend needs setup:healing plus an image rebuild after UI edits; lightweight Vite mode retains hot development.

## Results and Phase 7 boundary

The complete local healing suite passed on 2026-10-20 at 12:08 UTC in 5.3 minutes: private control/admin restrictions, second-controller exclusion, API repair with all React pages closed, edge repair with Healer/observer restart, primary restoration for both dynamic paths, Redis repair/cross-instance chat/durable history, real network latency and external-service circuit recovery, PostgreSQL safe escalation/delayed audit, and broadcaster loss/reconnection. All four automatic service starts have adapter receipts and exactly one persisted EXECUTING event, with no manual restore command. Both independent Chromium viewers decoded video after each repair.

| Component      | Failure injection → VERIFIED audit (s) | Actual action (s) | Verification (s) |
| -------------- | -------------------------------------: | ----------------: | ---------------: |
| API-1          |                                 11.523 |             0.201 |            8.211 |
| Edge-1         |                                 43.468 |             0.244 |           36.539 |
| Primary origin |                                 18.489 |             0.271 |           13.030 |
| Redis          |                                 13.823 |             0.942 |            7.596 |

Edge verification includes an intentional controller/observer restart and lease handover. These are one-run development measurements, not SLO estimates. Mean injection-to-verified restoration across these four cases was 21.826 seconds; all four starts verified. Measured mean threshold-confirmed detection (MTTD) was 3.686 seconds. MTTD uses threshold-confirmed incident detection, not the first failed probe; the raw artifact retains original first-observed/action/verification timestamps and separate monotonic harness polling observations. The original local run checked decoded frames after repair; continuous per-viewer interruption sampling was added afterward for the next full run. No zero-interruption claim is made.

[Raw local measurements](PHASE_6_MEASUREMENTS.json) and [actual screenshots](images/phase-6/) are retained. Five viewport captures (375/768/1280/1440/1920) have no horizontal overflow; the incident view shows correlated recovery evidence and the source-interruption capture records a real escalation. The current local checks also passed 125 unit tests, typecheck, lint, formatting, build, full staged startup, fifteen healthy observations/thirteen scrapes and quiet Compose validation. Root and restricted-runtime production dependency audits reported zero known vulnerabilities. Earlier development runs failed on publisher duration, test socket reconnection and a natural-return/incident-correlation race; each was corrected and the complete rerun above passed.

Retained Phase 1–5 suites and a fresh healing run are configured as separate CI jobs with their original deployment modes. Their current branch results must be checked before declaring the complete phase PASS. Windows Docker Desktop, physical OBS/webcam and Safari were not run in this Linux environment.

Known failure domains remain the Docker host, adapter, observer, shared journal volumes, PostgreSQL, Redis, relay and gateways. SQLite in Node 24 is release-candidate stability and was tested directly; it is not an external database HA replacement. Browser metrics are approximate; bounded server media sampling is not a global viewer guarantee. Windows, physical OBS/webcam and Safari require separate manual validation. Existing bundle-size advisories remain.

Phase 7 can consume the authenticated monitoring/healing read APIs, version-1 invalidations, stable component IDs and incident/attempt IDs. Its test harness can use the same explicit logical service whitelist and measured fault boundaries. It must add its own authorization, durable experiment record, expiry, rollback and bounded fault budget. Phase 6 provides no interactive Chaos Panel or public fault/control endpoint.
