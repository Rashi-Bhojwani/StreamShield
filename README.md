# StreamShield Live + Control

**Current four-scenario repair:** [UI, safe stale-recovery reconciliation, actual checks, Windows diagnosis/run instructions and remaining blockers](docs/FOUR_SCENARIO_REPAIR_RESULTS.md). Full live acceptance is PARTIAL; mocked UI screenshots and historical final-demo measurements are separate evidence.

## Final presentation build

Five-plus **genuinely Healer-driven** repairs that the audience can see in the
real product, not only on a dashboard: Redis (chat breaks), video gateway
(everyone's video freezes), the whole API tier (site down, video survives),
the ingest relay (broadcaster drops, then reconnects by itself), API-2 frozen
(alive but unresponsive, so the Healer **restarts** it), plus a traffic surge
with autonomous **scale-out to a spare API and scale-in**, Edge-1 failover and
primary origin. Each repair ends with an accepted Docker receipt and independent
functional verification. `/control/presentation` shows live video, the topology,
stage-by-stage evidence and measured durations; `/control/analysis` shows the
green → red → blue → green history from persisted evidence.

```powershell
npm.cmd ci
npm.cmd run final:up        # setup, build, start, create the stopped spare API, chaos probe
npm.cmd run final:demo      # optional bounded 10-minute test pattern + presentation URL
npm.cmd run final:watch     # read-only terminal proof: StartedAt, uptime, Healer actions
npm.cmd run final:down      # never removes volumes
```

[Architecture](docs/FINAL_SYSTEM_ARCHITECTURE.md) ·
[Scenarios](docs/FINAL_DEMO_SCENARIOS.md) ·
[Measured evidence](docs/SELF_HEALING_RECOVERY_EVIDENCE.md) ·
[Demo guide (Hinglish)](docs/FINAL_DEMO_GUIDE.md) ·
[Test results](docs/FINAL_TEST_RESULTS.md) ·
[Known limitations / PARTIAL](docs/KNOWN_LIMITATIONS.md)

**Browser Go Live correction:** peer connectivity and server LIVE verification now have deadlines and credential-bound failed-attempt cleanup. Studio Watch links open a separate tab to preserve camera broadcasting. The exact Rashi/Lakshita browser workflow passed with real H.264/Opus delivery, decoded video/audio, cross-replica chat, independent sources and API/edge recovery using synthetic capture devices. Local checks and 186 tests passed; [all eight clean CI jobs passed](https://github.com/Rashi-Bhojwani/StreamShield/actions/runs/39742661575). Physical Windows device/firewall checks remain unverified. [Exact workflow, Windows CMD/PowerShell commands, measurements and screenshots](docs/END_TO_END_LIVE_FIX_RESULTS.md) · [Fix plan](docs/END_TO_END_LIVE_FIX_PLAN.md).

**StreamShield 2.0 dynamic mode** restores public registration/login and user-owned channels, adds browser WHIP publishing, authoritative media-progress lifecycle/discovery, working category filters and channel chat moderation. Start with `npm.cmd run setup:dynamic -- --enable-local-chaos`, then `npm.cmd run dynamic:up`. Open http://127.0.0.1:5173/signup. No shared accounts are seeded. [Complete Windows, browser/OBS/LAN and healing guide](docs/DYNAMIC_STREAMING.md) · [Design and verification plan](docs/DYNAMIC_STREAMING_PLAN.md).

All eight [CI jobs](https://github.com/Rashi-Bhojwani/StreamShield/actions/runs/39729395061) passed with 179 tests, real three-source playback, automatic discovery, authenticated chat and independent recovery. Browser WHIP remote video/audio passed using synthetic camera/microphone devices; physical Windows/OBS/screen-choice checks remain unexecuted. [Actual dynamic measurements and screenshots](docs/DYNAMIC_STREAMING.md#verified-results).

The earlier fixed three-channel experience below is a preserved optional demo, not the dynamic platform limit.

The new explicit **three-channel demo mode** provides Streamer 1/2/3, guest viewing/chat, private CLI broadcaster provisioning and one-use local administrator access. The presentation screen combines three genuine live players, real capacity measurements and the existing independent Healer/Chaos controls. The **50,000 simulated-client target remains unverified**; workload profiles and achieved counts are kept separate.

Platform acceptance passed all seven [CI jobs](https://github.com/Rashi-Bhojwani/StreamShield/actions/runs/39567930528) with 174 unit/security tests, genuine three-source playback, guest isolation and real recovery under bounded load. The isolated 1,000-socket trial reached 252 connected sockets; the 50K milestone remains PARTIAL. [Actual measurements and screenshots](docs/THREE_CHANNEL_DEMO.md#verified-results-and-capacity-limits).

See [three-channel Windows/OBS/LAN guide](docs/THREE_CHANNEL_DEMO.md), [capacity harness and distributed stages](docs/CAPACITY_TESTING.md), [design](docs/THREE_CHANNEL_DEMO_PLAN.md) and [actual verification status](docs/THREE_CHANNEL_DEMO_MEASUREMENTS.json).

```powershell
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:demo -- --enable-local-chaos
npm.cmd run demo:up
npm.cmd run demo:admin
$env:TEST_PUBLISH_DURATION_SECONDS="600"
npm.cmd run broadcast:demo -- all
```

Open http://127.0.0.1:5173 for the three public channels. Use the private terminal-issued link for `/control/three-stream-demo` and `/control/capacity`; no public password login exists in this mode. `npm.cmd run demo:down` preserves data volumes. Earlier phase workflows below apply with demo mode off; do not run fault compositions simultaneously.

Phase 7 adds the administrator-only **Chaos Laboratory** and **Live Demo**. Inject one of six real allowlisted local faults, watch the independent observer/Healer respond, and inspect durable incident/recovery evidence. Chaos never executes recovery playbooks. Database and broadcaster fault controls remain disabled with explicit safety reasons. See [Phase 7 Windows setup, scenarios and demo](docs/PHASE_7.md), [design](docs/PHASE_7_PLAN.md), and [actual measurements](docs/PHASE_7_MEASUREMENTS.json).

All five [clean CI jobs](https://github.com/Rashi-Bhojwani/StreamShield/actions/runs/39466656790) passed, including 155 unit/security tests and all six authenticated real-fault experiments with two independent decoded live streams. [Measured results and screenshots](docs/PHASE_7.md#verified-results) distinguish actual component restoration, timed cleanup, control-read outages and browser playback.

## Phase 7 quick start

Start Docker Desktop (Linux containers), use Node.js 24 and PowerShell:

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/feature/phase-7-chaos-control-center
code .
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:chaos -- --enable-local-chaos
npm.cmd run chaos:up
npm.cmd run chaos:probe
```

Open http://localhost:5173, register, then grant that existing account administrator access:

```powershell
node infrastructure/chaos/compose.mjs exec -T api-2 node scripts/set-role.mjs YOUR_USERNAME administrator
npm.cmd run broadcast:test
```

Open /control/demo for genuine video and /control/chaos for fault controls. Confirm the exact API-1 target once, then observe autonomous recovery without issuing a restore command. Wait for completion and healthy baseline before edge/primary faults. npm.cmd run test:chaos runs real authenticated failure experiments; npm.cmd run chaos:down stops services while retaining data. See the complete handoff for OBS, ten-minute FFmpeg publishing, tests, safety, troubleshooting and the five-minute judge demonstration.

Phase 6 PR #7 was merged into feature/phase-4-redundancy-failover at c7655cc, which contains the verified Phase 1–6 baseline. Phase 7 is stacked on that branch; main does not yet contain the whole stack. Earlier phase workflows below remain available in their respective isolated compositions.

Phase 6 adds the independent **StreamShield Healer**: confirmed Phase 5 incidents select bounded recovery playbooks, a private control adapter starts explicitly managed stopped services, and independent application/media verification determines outcomes. Recovery runs with the browser closed. The Control Center displays actual recovery audit records, escalation and circuit state. See [Phase 6 setup, evidence and limitations](docs/PHASE_6.md), [implementation plan](docs/PHASE_6_PLAN.md) and [architecture](ARCHITECTURE.md).

## Phase 6 quick start in Windows VS Code

Start Docker Desktop in Linux-container mode. Use Node.js 24, Git, Chrome and FFmpeg with H.264/AAC support:

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

This starts redundancy, monitoring and the independent Healer together. Privileged actions otherwise default disabled. Open http://localhost:5173, register, create an owned stream in Studio, and copy its exact OBS Server/Stream Key. OBS uses Custom, H.264/yuv420p, AAC and two-second keyframes. npm.cmd run broadcast:test provides a bounded FFmpeg development source at /watch/live. Use two owned streams for isolation tests.

Grant your existing account administrator access from the trusted terminal:

```powershell
node infrastructure/healing/compose.mjs exec -T api-2 node scripts/set-role.mjs YOUR_USERNAME administrator
```

Reload http://localhost:5173/control and open Recoveries. Grafana http://localhost:3000 uses operator and the generated private OBS_GRAFANA_PASSWORD; its Autonomous Recovery dashboard reads actual Healer metrics. Prometheus and control endpoints remain private.

Inject one bounded local crash, then observe automatic repair without issuing a restore command:

```powershell
npm.cmd run healing:control -- crash api
# Wait for VERIFIED in Control / Recoveries before the next experiment.
npm.cmd run healing:control -- crash edge-1
npm.cmd run healing:control -- crash origin-primary
npm.cmd run healing:control -- crash redis
```

Wait between experiments. Default policy allows two starts per service per ten minutes and a 30-second cooldown. PostgreSQL/storage issues escalate for operator review; a disconnected camera cannot be reconstructed. Source/network return is observed separately from an autonomous container start. The adapter is privileged trusted local infrastructure, not production tenant isolation.

```powershell
npx.cmd playwright install chromium
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd test
npm.cmd run build
npm.cmd run test:healing
npm.cmd run healing:down
```

Stop your own broadcaster before automated failure tests. Shutdown preserves named volumes; never add -v to preserve account/chat/incident/journal data. See the [complete Phase 6 Windows handoff](docs/PHASE_6.md) for database escalation, source reconnection, metrics, measured results and troubleshooting. Older monitoring-only and lightweight workflows follow below; stop one topology before starting another.

GitHub ancestry checked on 2026-10-20: Phase 5 PR #6 was merged into the Phase 4 branch, but its implementation has not reached main. This phase targets the Phase 4 branch containing that verified Phase 5 baseline. No prerequisite PR is automatically merged.

## Phase 5 quick start in Windows VS Code

Start Docker Desktop with Linux containers. With Node.js 24 installed, use PowerShell:

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/feature/phase-5-observability-control-center
code .
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:monitoring
node infrastructure/monitoring/compose.mjs config --quiet
npm.cmd run monitoring:up
npm.cmd run monitoring:status
npm.cmd run monitoring:probe
```

Open http://localhost:5173, register your intended account, then grant that account access through the trusted terminal:

```powershell
node infrastructure/monitoring/compose.mjs exec -T api-2 node scripts/set-role.mjs YOUR_USERNAME administrator
```

Reload and open **http://localhost:5173/control**. Grafana is **http://localhost:3000**, username operator, with the generated OBS_GRAFANA_PASSWORD in your private .env. Prometheus remains private. Studio provides owned OBS server/key credentials; npm.cmd run broadcast:test supplies a bounded FFmpeg development stream at /watch/live.

A local measured incident demonstration uses npm.cmd run monitoring:control -- crash api followed by npm.cmd run monitoring:control -- restore api. These retain the monitoring overlay and reuse the Phase 4 CLI whitelist. The observer records evidence independently; it does not perform recovery actions. For automated checks run npm.cmd run test:monitoring and npm.cmd run test:resilience:monitoring after npx.cmd playwright install chromium. See the [full Windows/test/troubleshooting handoff](docs/PHASE_5.md) for baseline regression commands and limitations.

Stop your broadcaster, then npm.cmd run monitoring:down **without -v**. Account/chat/incident/PostgreSQL and Grafana/Prometheus volumes are preserved. The lightweight Phase 3 and Phase 4-only workflows below remain available; stop one topology before starting another.

Phase 4 adds an optional redundant development topology: two APIs, Nginx API routing, two HLS edges and independently packaged primary/standby media supplied by an authenticated relay. See [Phase 4 results and limitations](docs/PHASE_4.md) and [implementation plan](docs/PHASE_4_PLAN.md). Phase 4 is stacked on open Phase 3 PR #4; no dependency PR is automatically merged.

A multi-user livestreaming platform with real RTMP ingestion, HLS browser playback, owned channels, a broadcaster Studio and durable live chat. PostgreSQL stores accounts, sessions, streams and chat history; Redis distributes Socket.IO events and tracks expiring approximate active-player leases. Media remains on MediaMTX/HLS, separate from Express.

Phase 3 builds on [Phase 2 PR #3](https://github.com/Rashi-Bhojwani/StreamShield/pull/3). While that PR remains open, the Phase 3 branch and PR are stacked on feature/phase-2-live-streaming. No PR is automatically merged. See [Phase 3 implementation](docs/PHASE_3.md), [plan](docs/PHASE_3_PLAN.md), [architecture](ARCHITECTURE.md) and [roadmap](IMPLEMENTATION_PLAN.md).

This is development infrastructure. The optional Phase 4 topology provides service-level redundancy on one Docker host. Host-level redundancy, chaos controls, a production CDN and evidence for 50,000–60,000 viewers remain future work.

## Prerequisites

- Git, Node.js 24.x / npm 11+, VS Code.
- Docker Engine or Docker Desktop with Linux containers and Compose v2.
- Chrome/current Chromium. Native Safari HLS requires separate platform validation.
- FFmpeg with libx264, AAC and lavfi for actual media tests; OBS Studio for a camera/screen.

## Phase 4: redundant topology in Windows VS Code

Use Node 24, Docker Desktop Linux containers/Compose **2.24.4+**, FFmpeg, OBS and Chrome. Allocate approximately 4 CPUs and 6–8GB RAM to Docker for this optional twelve-service topology. The lightweight default below remains available for ordinary UI/account development. Containers share one Docker host; this is not host-level high availability.

Start Docker Desktop, then in PowerShell:

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/feature/phase-4-redundancy-failover
code .
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:resilience
node infrastructure/resilience/compose.mjs config --quiet
npm.cmd run resilience:up
npm.cmd run resilience:status
npm.cmd run resilience:probe
```

The setup command preserves existing Phase 3 secrets and the PostgreSQL volume, adds missing settings, and generates private ignored configs under .local/resilience/. API-1 and API-2 share the same schema; the one-shot migrate service applies forward migrations before startup. No new Phase 4 schema reset/migration is required. To repeat migrations explicitly, use docker compose run --rm migrate.

Open **http://localhost:5173**. Register normally, create a channel and livestream in Studio, then create its publishing key. OBS uses Custom and the exact server/key supplied by Studio: the default stable RTMP server is rtmp://127.0.0.1:1935. Use H.264/yuv420p, AAC and two-second keyframes. Both origins receive that authorized dynamic path through private RTSP/TCP pulls. Viewers use the generated Watch URL; they never need internal service addresses. Open another Chrome profile, sign in, watch and chat. Each additional broadcaster gets independent owned paths and credentials.

For a bounded synthetic development broadcast:

```powershell
npm.cmd run broadcast:test
```

Open /watch/live through the website. This is the legacy development channel; create owned streams through Studio for real accounts/chat. Stop FFmpeg/OBS before automated tests. MediaMTX remuxes rather than transcodes, and no service can recreate video after the broadcaster or ingest relay fails.

### Controlled failures and recovery

With a broadcast running, the following commands affect only the explicitly selected service in this repository's local resilience Compose project. They are CLI tools, not application/admin HTTP endpoints:

```powershell
npm.cmd run resilience:control -- crash api
npm.cmd run resilience:probe
npm.cmd run resilience:control -- restore api

npm.cmd run resilience:control -- crash edge-1
npm.cmd run resilience:control -- restore edge-1

npm.cmd run resilience:control -- crash origin-primary
npm.cmd run resilience:control -- restore origin-primary
```

After API-1 fails, API-2 serves surviving requests and sockets reconnect using the shared session/Redis adapter. probe expects both peers, so it reports a failure until API-1 is restored; the browser/API readiness route can remain available through API-2. Edge failure retries media requests through the other edge, preserving the origin timeline. Primary failure triggers bounded player reinitialization on standby. Restoration uses the same configuration and DNS discovery; routing is not edited during incidents. The player stays on a working standby to avoid flapping; **Retry preferred playback source** explicitly tests primary again.

For measured, isolated experiments with two disposable broadcasters and actual decoded video:

```powershell
npx.cmd playwright install chromium
npm.cmd run test:resilience
```

This refuses an already active broadcaster, injects API/edge/origin crashes, restores services, cleans only its publishers/accounts, captures all five required UI widths and writes test-results/phase4/measurements.json. Durations use monotonic clocks, UTC injection timestamps and real request/frame observations. Traffic recovery, playback progression and infrastructure restoration are separate fields. Inspect the actual report; no zero-interruption or 30-second guarantee is implied.

### Regression tests and switching topology

The original test:platform, test:e2e, test:media and test:media:platform commands remain unchanged. Run them against the lightweight topology for their original Phase 1–3 coverage; CI runs those plus a separate redundant-topology browser/failure job. To return to lightweight mode without deleting data:

```powershell
npm.cmd run resilience:down
npm.cmd run setup:platform
docker compose up --build --wait
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd test
npm.cmd run build
npm.cmd run test:platform
npm.cmd run test:e2e
npm.cmd run test:media
npm.cmd run test:media:platform
```

To return to redundant mode, run setup:resilience and resilience:up again. To stop the redundant stack safely, stop OBS/FFmpeg and run npm.cmd run resilience:down, without -v. Both topologies retain the same postgres-data named volume.

### Phase 4 troubleshooting

- Use resilience:status and resilience:probe. Inspect a selected service with node infrastructure/resilience/compose.mjs logs --tail=50 SERVICE. Do not dump .env, generated media configs or resolved Compose output.
- Regenerate configs after changing .env topology settings, then recreate affected containers with resilience:up. DNS re-resolution handles restored/recreated peers without incident-time edits.
- A service /health probe is liveness, not proof of that stream's fresh HLS. The API separately checks publisher/source evidence; only progressing decoded frames prove viewer playback.
- Live playlists bypass edge caches; media objects have bounded caches keyed by origin-prefixed URL. Errors and stale playlists are not cached. A new source uses a distinct timeline and full player reinitialization.
- A primary-origin HTTP error does not mark every edge dead; edge transport failures and origin availability are distinct boundaries.
- API gateway retries do not enable non_idempotent on public writes. A failed ambiguous creation/key rotation should be checked in Studio before submitting again.
- PostgreSQL/Redis, ingest relay, gateways, frontend and Docker host remain single points of failure. Existing HLS can continue through an API failure; starting new supply still needs database-backed authorization.

## Windows VS Code: first run

Start Docker Desktop and wait for the engine. In a VS Code PowerShell terminal:

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/feature/phase-4-redundancy-failover
code .
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:platform
docker compose config --quiet
docker compose up --build --wait
docker compose ps
```

The setup command preserves existing nonempty Phase 2 environment values, appends missing configuration and generates private database/Redis/CSRF/media-service secrets without displaying them. It writes ignored .env and .local/mediamtx.yml. Use setup:platform for Phase 3; setup:media alone produces the earlier single-path configuration.

Compose starts PostgreSQL, Redis, the application API, frontend and MediaMTX. A one-shot migrate service applies forward migrations before API startup. Re-running startup does not reset data. No database, Redis or media administrative port is published by standard Compose.

Open **http://localhost:5173** in Chrome. The default watch URL is http://localhost:5173/watch/live for the explicitly labelled development compatibility channel.

## Your first owned broadcast

1. Open **Create an account** from Sign in, or visit /signup. Choose a unique username/email and a password of at least 12 characters.
2. Open **Broadcaster Studio**. Create your channel with a unique address, display name and description. Your account gains broadcaster capability while retaining viewing/chat access.
3. Choose **Create livestream**. Enter a title and description. It starts as Draft; a database row alone does not mean Live.
4. Choose **Create publishing key**. Studio returns a path-bound key once, masked by default. Copy it into OBS, then dismiss it. It cannot be recovered after refresh; rotate to generate another.
5. Open your public channel or watch link. Source status reflects actual MediaMTX publisher/HLS observations.
6. Open a second Chrome profile/incognito window, register another viewer account and open the same watch link. Both users can send real chat messages; history is stored in PostgreSQL.
7. While video time advances in visible tabs, the panel shows approximate active-player counts. Tabs sharing the same login/browser session are deduplicated per stream. Paused/hidden/disconnected players expire or leave; unavailable Redis means Unavailable.
8. Use **End stream** to revoke publishing and disconnect its active publisher. Metadata/history stays saved. Create a new stream for the next broadcast.

Each account owns one channel and can create multiple independent broadcasts. Public channels and stream lists are bounded/paginated. Accounts cannot edit another owner's resources or publish to another stream's path.

## OBS Studio

Studio is the authoritative source of each stream's actual credentials; no source or .env edit is needed to create streams.

- Settings → Stream → Custom.
- Server: the RTMP server shown in Studio (default rtmp://127.0.0.1:1935).
- Stream key: use **Copy stream key**, including its path, user and pass query parameters.
- Video: H.264 / x264 or compatible hardware encoder, yuv420p, 1280×720, 30 fps, 2500 kbps starting bitrate.
- Audio: AAC, 128 kbps. Keyframe interval: 2 seconds.
- Add a camera/screen and Start Streaming. Allow several seconds for HLS generation/buffering.
- Playback starts muted; use real native controls for sound, pause and fullscreen.
- Rotating a key revokes the previous key and disconnects its active publisher. Stop OBS before changing its key, then reconnect with the new one.

Never share credential-bearing keys or put them into public URLs, screenshots, logs or source. Standard publishing is local unencrypted RTMP; public hosting requires RTMPS/TLS, HTTPS, secret distribution and an appropriate deployment boundary. The private media auth listener is not an application-user API.

## FFmpeg and real media verification

For the preserved development-only channel, in another terminal:

```powershell
npm.cmd run broadcast:test
```

This generates actual moving H.264 video and an AAC tone, bounded to TEST_PUBLISH_DURATION_SECONDS (120 by default; 5–600 allowed), and stops cleanly on Ctrl+C. It never prints publishing credentials. Stop it before OBS or media integration tests.

For owned-stream automation use **npm.cmd run test:media:platform** on an idle local development stack. It registers disposable test broadcasters, creates distinct streams/keys through real APIs, publishes simultaneous 640×360 and 320×180 videos, verifies decoded playback, chat/presence, key rotation/revocation and independence. It also stops/restarts this project's Redis/PostgreSQL to verify graceful degradation and durable recovery. It cleans its publishers and explicitly identified disposable accounts. Do not run outage tests against a shared/production environment.

The original **npm.cmd run test:media** remains intact: invalid/wrong-path/competing publishers, actual HLS playlists/segments, decoded frames/time progression, source return and origin outage reporting. It uses only the development compatibility path. Set ENABLE_LEGACY_STREAM=false to remove that path for a non-regression deployment; it is forbidden in production mode.

## Migrations, persistence and trusted administration

Normal Docker startup runs migrations. To reapply explicitly:

```powershell
docker compose run --rm migrate
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name,run_on FROM schema_migrations ORDER BY id"'
```

Migration files live in migrations/. node-pg-migrate owns the journal/transaction/advisory-lock workflow; SQL uses one PostgreSQL data model. Destructive rollback/reset is disabled. The postgres-data named volume persists registrations, channels, streams, sessions and chat across container restarts.

Create development accounts through normal signup. There are no seeded live channels, fake conversations or administrator passwords. For a trusted operator only:

```powershell
docker compose exec api npm run account:role -- your_username administrator
```

This parameterized local database command is not exposed through HTTP. It does not enable future Control/chaos tools. Public registration rejects role flags.

Platform integration creates a unique disposable test database, uses Redis logical DB 1 with a separate adapter namespace, checks real transactions/security/chat/presence, then drops only its own generated database. Browser/media fixtures are actual registered accounts with generated e2e_ names and known UUIDs; cleanup refuses any other accounts. No generic database reset command or volume deletion runs.

## Tests

With services healthy and your broadcaster stopped:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd test
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run test:platform
npm.cmd run test:e2e
npm.cmd run test:media
npm.cmd run test:media:platform
```

test:platform runs inside an ephemeral API container, so private DB/Redis ports remain unexposed. Browser/media tests use host Chromium and FFmpeg. PLAYWRIGHT_EXECUTABLE_PATH can select an installed Chromium; E2E_BASE_URL selects the browser-facing origin. Tests that handle one-time credentials disable traces, and documentation screenshots dismiss keys before capture. Artifacts/builds are ignored.

## Configuration and boundaries

.env.example is the complete inventory; API/platform/media/browser values are validated. No secrets belong in VITE_ variables.

| Group                                                               | Purpose                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| POSTGRES_HOST/PORT/DB/USER/PASSWORD, DB_POOL_MAX                    | PostgreSQL connection and bounded pooling; Compose overrides host to private postgres DNS |
| REDIS_HOST/PORT/PASSWORD/DB, REDIS_RECONNECT_LIMIT                  | Private shared state, logical test isolation, bounded reconnection                        |
| DEPENDENCY_TIMEOUT_MS                                               | DB connection/query and Redis command deadlines                                           |
| SESSION_TTL_SECONDS, COOKIE_SECURE, CSRF_SECRET                     | Expiring revocable sessions, HTTPS cookie mode and CSRF tokens                            |
| AUTH_RATE__, WRITE_RATE_LIMIT, CHAT_RATE__                          | Shared Redis admission/rate limits                                                        |
| CHAT_HISTORY_LIMIT, VITE_CHAT_WINDOW_LIMIT                          | Bounded durable history pages and browser message retention                               |
| PRESENCE_TTL_SECONDS / HEARTBEAT_MS                                 | Expiring active-player leases; TTL must exceed two heartbeat intervals                    |
| SOCKET_CONNECT_LIMIT, VITE_CHAT_RECONNECT_*                         | Shared connection admission and bounded browser reconnection                              |
| API_INTERNAL_HOST/PORT, MEDIA_AUTH_SECRET/BASE_URL                  | Dedicated private MediaMTX HTTP authorization listener; no public proxy                   |
| MEDIA_RTMP_PUBLIC_URL                                               | Owner-facing publishing server, separate from private control addresses                   |
| MEDIA_STREAM_PATH/TITLE, ENABLE_LEGACY_STREAM                       | Explicit development compatibility path, not a credential shared by user streams          |
| MEDIA_API__, MEDIA_HLS__, MEDIA_PUBLIC_HLS_BASE_URL                 | Private authenticated control, actual origin HLS and browser-facing /media delivery       |
| MEDIA_PROBE_TIMEOUT_MS, MEDIA_STATUS_CACHE_MS, MEDIA_OBSERVER_LIMIT | Bounded source observations/cache                                                         |
| VITE_API__, VITE_STREAM_POLL_MS, VITE_STATUS_POLL_MS, VITE_PLAYER__ | Public API, polling, actual player deadlines and bounded retry                            |
| TEST_PUBLISH__, MEDIA_TEST__                                        | Bounded synthetic publisher and test settings                                             |

Default exposed loopback ports: web 5173, API 4000, RTMP 1935, HLS 8888. PostgreSQL 5432, Redis 6379, private media auth 4001 and MediaMTX control 9997 stay internal. Container service names are not browser addresses. Video uses the Vite /media proxy directly to MediaMTX; Express/Socket.IO never transport video.

Use Compose bind mounts for frontend/API hot reload; rebuild after dependency changes. The Phase 2 host-only npm workflow needs extra DB/Redis/callback networking and is no longer the standard Phase 3 startup. The optional compose.local.yml retains an explicitly loopback-only media-control publishing override; it is not required for normal development.

## Stop without deleting data

Ctrl+C stops your FFmpeg publisher or stop OBS. Then:

```powershell
docker compose down
```

Do not add -v: it deletes named volumes. Never paste resolved Compose config or secret-bearing keys into issue reports. Use docker compose config --quiet for validation.

## Troubleshooting

- **Docker unavailable on Windows:** start Docker Desktop, wait for its engine, select Linux containers and confirm WSL2/virtualization. Reopen VS Code after installing Git/Node/FFmpeg so PATH refreshes.
- **PowerShell blocks npm.ps1:** use npm.cmd/npx.cmd; no execution-policy change is required.
- **FFmpeg missing:** verify ffmpeg -version; install a trusted Windows build or set FFMPEG_PATH to its executable.
- **Port occupied:** stop the conflicting service or update consistent .env public/internal ports/origins. Rerun setup:platform and recreate affected containers. Do not change DB credentials on an existing volume without an explicit PostgreSQL password change.
- **Migration/API fails:** inspect docker compose ps and docker compose logs --tail=50 migrate api postgres. Forward migrations preserve data. Never reset volumes to conceal an error.
- **Login or form rejected:** check exact browser origin against CORS_ORIGINS, allow same-origin cookies and refresh to renew CSRF. Rate-limited actions return 429; wait for the configured window.
- **Chat unavailable:** the deployment must support WebSocket upgrades at /socket.io; this implementation intentionally uses WebSocket transport. Check Redis/API health and exact Origin. The reconnect button starts a new bounded connection attempt. Long outages that exhaust server Redis retries require an explicit API restart.
- **OBS offline:** verify the Studio-generated server/key, H.264/AAC and correct owned stream. Use one publisher per path. Rotation disconnects an old publisher, so update OBS afterward. Arbitrary or cross-path publishing is rejected.
- **Source available, video not playing:** allow HLS startup delay, use native Play if blocked, and inspect collapsed diagnostics. A manifest alone is not decoded video. MediaMTX remuxes rather than transcodes.
- **Dependency outage:** existing HLS can continue. DB-dependent actions fail with structured errors; chat/presence report degradation/Unavailable and history remains durable. Redis Pub/Sub cannot guarantee every distributed delivery during an outage; reconnect/history catches up.
- **Browser chunks above 500kB:** an existing build advisory remains; no size checks are disabled.

## Phase boundaries

Accounts, Studio, channels, independent streams, chat and approximate active-player estimates are real. Following, categories, uploads, email verification/password reset, moderation tooling and StreamShield Control are not implemented. Native Safari, physical OBS/webcam and Windows execution require manual verification. The lightweight topology remains a single-instance workflow. Optional Phase 4 service redundancy and measured recovery are described in [PHASE_4.md](docs/PHASE_4.md); no host-level availability, recovery-time guarantee or audience-capacity claim is made.
