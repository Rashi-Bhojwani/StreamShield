# StreamShield

**Real live video, on a verifiable foundation.** Phase 2 accepts an authenticated OBS/FFmpeg RTMP broadcast, remuxes it to HLS with MediaMTX, and plays it in React using hls.js or native HLS. Express carries metadata, not video. The homepage discovers the configured channel; the watch page distinguishes publisher availability, HLS evidence and this browser's playback state.

There are no accounts, chat, viewer counts, failover, incident dashboards, infrastructure healing or chaos controls yet. The 50,000–60,000 viewer goal remains untested. See [architecture](ARCHITECTURE.md), [roadmap](IMPLEMENTATION_PLAN.md), [Phase 2 plan](docs/PHASE_2_PLAN.md), [Phase 2 evidence/handoff](docs/PHASE_2.md), and the preserved [Phase 1 handoff](docs/PHASE_1.md).

## Prerequisites

- Node.js **24.x**, npm 11+, Git.
- Docker Engine / Docker Desktop in **Linux container** mode and Compose v2.
- FFmpeg with `libx264`, AAC and lavfi for the bounded test broadcaster and media integration suite. Optional OBS Studio for camera/screen publishing.
- A current browser with H.264/AAC decoding and MediaSource or native HLS. Safari native behavior needs separate platform validation.

## Start with Docker

Run from the repository root, in this order:

```sh
npm ci
npm run setup:media
docker compose config --quiet
docker compose up --build --wait
docker compose ps
```

The cross-platform setup command creates `.env` if absent, adds missing defaults to existing files, preserves nonempty values, generates unique local publishing/API passwords, and writes `.local/mediamtx.yml`. Neither secrets nor generated config should be committed. Running setup again preserves existing credentials and produces the same media configuration. Regenerate after changing media path, credentials, ports, origins or HLS settings. Restart/recreate affected containers after configuration changes.

With the checked-in defaults, open **http://127.0.0.1:5173**, then **Open live player**. The default channel is **http://127.0.0.1:5173/watch/live**. It is offline until a real publisher connects.

In a second terminal at the repository root:

```sh
npm run broadcast:test
```

This sends a genuine encoded **synthetic test pattern and audio tone**, not a camera or simulated viewer activity. It runs for `TEST_PUBLISH_DURATION_SECONDS` (120 seconds by default, bounded to 5–600) or until Ctrl+C. A wall-clock deadline and `TEST_PUBLISH_GRACE_MS` shutdown bound also cover stalled output. It uses `.env` without printing credentials. Install FFmpeg on the host or set `FFMPEG_PATH` to its executable. Stop this broadcaster before starting OBS or running `npm run test:media`; only one publisher may own the path.

```sh
docker compose logs --tail=50 api web mediamtx
docker compose down
```

Logs can contain operational information; do not paste resolved Compose configuration or publishing URLs with credentials. Use `docker compose config --quiet`, not a full config dump.

## OBS Studio

Defaults below come from `.env.example`. Use your configured values if changed.

1. **Settings → Stream → Service: Custom**.
2. **Server:** `rtmp://127.0.0.1:1935` (`MEDIA_RTMP_BASE_URL`).
3. **Stream key:** `live?user=broadcaster&pass=YOUR_LOCAL_MEDIA_PUBLISH_PASSWORD`. Substitute `MEDIA_STREAM_PATH`, `MEDIA_PUBLISH_USER` and the generated `MEDIA_PUBLISH_PASSWORD` from your private `.env`; never commit or share that resulting key. Credentials are URL-safe in the generated defaults.
4. **Output → Streaming:** H.264 (x264 or compatible hardware encoder), AAC audio, keyframe interval **2 seconds**, 30 fps; start with 1280×720 and a suitable local bitrate. Do not select AV1/HEVC as a substitute for this verified browser-compatible path.
5. Add a camera, screen or media source, then **Start Streaming**. Open the watch page and allow several seconds for HLS generation/buffering. Playback starts muted; use native video controls for audio/fullscreen.
6. Stop streaming to observe publisher-offline state. Returning to the same path reopens the player after a verified source returns. This does not restart failed infrastructure.

RTMP authentication uses MediaMTX's documented query parameters. Publishing is path-scoped and authenticated; anonymous/wrong-path/competing publishing is rejected. RTMP here is **unencrypted local development traffic**. Do not expose it to the Internet. Production publishing requires RTMPS/TLS, secret distribution/rotation and an authorization design; `setup:media` intentionally rejects non-development mode.

## Configuration and addresses

`.env.example` is the complete variable inventory. Node loads `.env` for the local API; Vite uses the root `envDir`; Compose passes only required fields to each service. Only public `VITE_` values enter browser bundles.

| Setting                                                                            | Default / purpose                                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `API_HOST`, `API_PORT`                                                             | Local API `127.0.0.1:4000`                                                  |
| `WEB_HOST`, `WEB_PORT`                                                             | Local Vite `127.0.0.1:5173`                                                 |
| `API_PROXY_TARGET`, `VITE_API_BASE_URL`                                            | Local API target and `/api/v1` browser prefix                               |
| `BIND_ADDRESS`                                                                     | `127.0.0.1`, published Docker ports stay on loopback                        |
| `MEDIA_STREAM_PATH`, `MEDIA_STREAM_TITLE`                                          | One configured `live` channel / StreamShield Live                           |
| `MEDIA_RTMP_BASE_URL`, `MEDIA_RTMP_PORT`                                           | Host publisher target `rtmp://127.0.0.1:1935`                               |
| `MEDIA_HLS_BASE_URL`, `MEDIA_HLS_PORT`                                             | Host HLS target `http://127.0.0.1:8888`                                     |
| `MEDIA_HLS_PROXY_TARGET`, `MEDIA_PUBLIC_HLS_BASE_URL`                              | Origin for Vite and public `/media` prefix (or direct HTTP(S) HLS base)     |
| `MEDIA_API_BASE_URL`, `MEDIA_API_PORT`                                             | Authenticated local control target; **not published** in standard Compose   |
| `MEDIA_CONTAINER_HOST`                                                             | `mediamtx`, private Compose DNS; override internal media target when needed |
| `MEDIA_PUBLISH_*`, `MEDIA_API_*` credentials                                       | Generated local values; never browser variables                             |
| `CORS_ORIGINS`                                                                     | Exact local frontend origins for API and HLS                                |
| `MEDIA_PROBE_TIMEOUT_MS`, `MEDIA_STATUS_CACHE_MS`                                  | Bounded origin observation deadline and short cache/coalescing window       |
| `MEDIA_READ_TIMEOUT`, `MEDIA_WRITE_TIMEOUT`, `MEDIA_HLS_*` timings/sizing          | Origin read/write deadlines, fMP4 segment duration/count/maximum size       |
| `VITE_STREAM_POLL_MS`                                                              | Discovery/source polling interval                                           |
| `VITE_PLAYER_LOAD_TIMEOUT_MS`, `VITE_PLAYER_STALL_TIMEOUT_MS`                      | Player load and no-progress deadlines                                       |
| `VITE_PLAYER_RETRY_LIMIT`, `VITE_PLAYER_RETRY_BASE_MS`, `VITE_PLAYER_RETRY_MAX_MS` | Bounded per-session exponential reconnect budget                            |
| `TEST_PUBLISH_*`                                                                   | Bounded synthetic source duration, resolution, fps, GOP and tone            |
| `MEDIA_TEST_TIMEOUT_MS`, `MEDIA_TEST_POLL_MS`, `E2E_BASE_URL`                      | Integration deadlines, polling and web test target                          |

Docker overrides application bind addresses and internal origin addresses using its private network. HLS is served at `http://127.0.0.1:8888/live/index.m3u8`, or through Vite at `http://127.0.0.1:5173/media/live/index.m3u8`. A master playlist request may redirect for MediaMTX's cookie/session negotiation; the Vite proxy rewrites `Location` headers as well as request paths. Relative segment URLs stay under the media prefix. Express never proxies playlists or segments to viewers.

The MediaMTX control API is not exposed through Vite or Express. A separate API credential is used internally. The container health probe calls the actual control API on its own loopback interface; this verifies service response, not an active broadcast. API readiness remains available during a media outage so discovery can report degradation honestly.

## Local npm application development

To run API/web on the host while only MediaMTX runs in Docker:

```sh
# Stop a full Compose stack first to free API/web ports.
docker compose down
npm run setup:media
docker compose -f docker-compose.yml -f infrastructure/docker/compose.local.yml up -d --wait mediamtx
npm run dev
```

The **opt-in** local override publishes the authenticated MediaMTX control API to host loopback only, allowing the host API to observe it. It is not needed for all-Docker development. Never change this binding to a public address. Use the same two `-f` arguments when stopping the local media stack. Stop npm with Ctrl+C; confirm its child processes exited before switching workflows on the same ports.

Source directories and Vite configuration are read-only bind mounts with hot reload. Dependencies are installed in the development image from the lockfile; rebuild after dependency changes. Media settings are generated locally and mounted read-only. No database, persistent media volume, privileged container or Docker socket mount is needed.

## Tests and build

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
# Once per machine for Playwright, unless using an existing system Chromium:
npx playwright install chromium
# While the Docker stack is healthy and no publisher is running:
npm run test:e2e
npm run test:media
```

`test:e2e` retains the foundation browser regression. `test:media` owns a bounded FFmpeg publisher, rejects wrong credentials/path and competing sources, fetches real playlist/segment bytes, verifies decoded browser frames and advancing video time, checks source stop/return, then temporarily stops/restarts **only this Compose project's MediaMTX** to verify unavailable reporting. Do not run it against a shared or production environment. It refuses to interrupt an already active publisher and cleans up its own children/services. It requires Docker, FFmpeg and a browser. No skipped or mocked media integration is presented as proof of playback.

Optional `PLAYWRIGHT_EXECUTABLE_PATH` points to an existing Chromium. Override `E2E_BASE_URL` when changing web ports. Unit tests use explicitly labelled fixtures; media integration uses actual RTMP, HLS and decoded video. Browser artifacts go to ignored `test-results/`. Production build outputs are `apps/web/dist` and `services/api/dist`; run the API bundle with `npm start -w @streamshield/api`. Static asset hosting, TLS and production media routing are future deployment work.

## How to Run Phase 2 in VS Code (Windows)

Install Git, Node 24, VS Code, Docker Desktop (WSL 2 backend, Linux containers), and FFmpeg/OBS as needed. Docker Desktop must be running before Compose. Reopen the VS Code terminal after installing tools so PATH refreshes.

In PowerShell:

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/feature/phase-2-live-streaming
# After merging the PR, use main instead of the feature branch.
code .
node --version
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:media
docker compose config --quiet
docker compose up --build --wait
```

The remote branch must first have been published; see the delivery status in `docs/PHASE_2.md` if GitHub access blocked the handoff. If PowerShell blocks `npm.ps1`, the explicit `npm.cmd` commands above avoid changing execution policy.

Open **http://127.0.0.1:5173/watch/live** with defaults. In a second VS Code terminal:

```powershell
ffmpeg -version
npm.cmd run broadcast:test
```

If FFmpeg is missing, install a trusted Windows FFmpeg build (for example `winget install --id Gyan.FFmpeg -e`), reopen the terminal, and verify `ffmpeg -version`. If not on PATH, set `$env:FFMPEG_PATH` to your installed `ffmpeg.exe`. The install command is Windows-specific and was not executed in the Linux cloud. For a webcam/screen, stop the test publisher and use the OBS settings above.

Verification and shutdown:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd test
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run test:media
# Ctrl+C in the broadcaster terminal, then:
docker compose down
```

## Troubleshooting

- **Empty/offline player:** start the publisher and check the discovery status. No fake stream is substituted. Use one publisher per path; inspect FFmpeg availability and private `.env` values. If credentials/path changed, rerun setup and recreate MediaMTX.
- **Source available but not playing:** HLS buffering takes several seconds. Click native Play if autoplay is blocked. Use H.264/yuv420p and AAC with regular keyframes. MediaMTX remuxes; it does not transcode incompatible codecs. Inspect browser network/console and verify a `.m3u8` response is a playlist, not HTML.
- **Origin unavailable:** inspect `docker compose ps` and MediaMTX logs. Unknown/unreachable is distinct from offline. Health endpoints on Express do not prove media health.
- **Windows Docker connection failure:** start Docker Desktop, wait for the engine, select Linux containers, and check WSL 2 integration/virtualization. Avoid mounting the repository from a restricted or unshared directory. Do not expose the Docker daemon to fix access.
- **Mount/config errors:** run `npm.cmd run setup:media` before Compose. `.local/mediamtx.yml` must be a file, not a directory. Docker must have access to the project folder. Config strings are deliberately quoted for MediaMTX YAML compatibility.
- **Port conflicts:** free only your own prior processes, or change ports in `.env`. Update matching RTMP, HLS, API proxy, browser origin and E2E targets together, rerun setup and recreate services. Vite intentionally does not silently switch ports.
- **OBS cannot connect:** use RTMP, the correct host port and the full stream key query. Stop the test publisher first. The API credential is different from the publishing credential.
- **CORS/mixed content:** use configured exact frontend origins; do not mix an HTTPS page with HTTP HLS. There is no TLS termination in this development stack.
- **Tests fail before publishing:** the integration suite requires healthy services, FFmpeg, installed Chromium and an idle channel. A failed browser installation is not a passed playback test.
- **Cloud read-only home/proxy:** set npm's cache and Docker client config to writable directories outside the checkout. The optional `node infrastructure/docker/build-cloud.mjs` forwards existing proxy bindings and mounts the supplied CA transiently for image installation; it does not disable TLS verification or store credential values. Then use `docker compose up --no-build --wait`. This helper is optional and contains no Codex-specific paths.

## Next phase

Phase 3 can reuse the player, observed stream contracts, media configuration and API conventions to add authenticated accounts/roles, durable stream management, scoped publishing authorization, PostgreSQL/Redis, chat and viewer sessions. Do not call player reconnect “self-healing”; infrastructure recovery requires later independent detection, playbooks and outcome verification.
