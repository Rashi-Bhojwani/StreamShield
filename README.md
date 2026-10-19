# StreamShield Live

A multi-user livestreaming platform with real RTMP ingestion, HLS browser playback, owned channels, a broadcaster Studio and durable live chat. PostgreSQL stores accounts, sessions, streams and chat history; Redis distributes Socket.IO events and tracks expiring approximate active-player leases. Media remains on MediaMTX/HLS, separate from Express.

Phase 3 builds on [Phase 2 PR #3](https://github.com/Rashi-Bhojwani/StreamShield/pull/3). While that PR remains open, the Phase 3 branch and PR are stacked on feature/phase-2-live-streaming. No PR is automatically merged. See [Phase 3 implementation](docs/PHASE_3.md), [plan](docs/PHASE_3_PLAN.md), [architecture](ARCHITECTURE.md) and [roadmap](IMPLEMENTATION_PLAN.md).

This is development infrastructure. It does not provide redundancy, automated healing, chaos controls, a CDN or evidence for 50,000–60,000 viewers.

## Prerequisites

- Git, Node.js 24.x / npm 11+, VS Code.
- Docker Engine or Docker Desktop with Linux containers and Compose v2.
- Chrome/current Chromium. Native Safari HLS requires separate platform validation.
- FFmpeg with libx264, AAC and lavfi for actual media tests; OBS Studio for a camera/screen.

## Windows VS Code: first run

Start Docker Desktop and wait for the engine. In a VS Code PowerShell terminal:

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/feature/phase-3-streaming-platform
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

Accounts, Studio, channels, independent streams, chat and approximate active-player estimates are real. Following, categories, uploads, email verification/password reset, moderation tooling and StreamShield Control are not implemented. Native Safari, physical OBS/webcam and Windows execution require manual verification. This phase makes no redundancy, recovery-time or capacity claim. [Phase 4 handoff](docs/PHASE_3.md) describes extension points without deploying them prematurely.
