## Summary

Implement Phase 2's real media path: authenticated OBS/FFmpeg RTMP → MediaMTX → HLS → React/hls.js (native fallback). Preserve the Phase 1 baseline on `main` (`387cc57`); this PR contains only Phase 2 work and remains open for review.

## Architecture and services

- Add pinned official `bluenviron/mediamtx:1.21.2-ffmpeg` with one configured publishing path, HLS, real HTTP health verification and a private Control API.
- Keep video out of Express. Vite's configured media proxy handles request and redirect rewriting; Express observes source availability using authenticated control requests plus bounded HLS probes.
- Distinguish publisher offline, HLS starting, source/manifest available and origin unavailable. Browser playing/buffering/blocked/retrying states are separate observations.
- Use path-scoped publishing credentials, no publisher takeover, no arbitrary control passthrough, and bounded player retries. No accounts, chat, persistence, failover, infrastructure healing or chaos controls are added.

## Files and dependencies

Add the `apps/web/src/streaming` player/discovery/watch components, `services/api/src/media.ts`, `scripts` media bootstrap/publisher/test helpers, MediaMTX template, local npm Compose override, media browser tests and documentation screenshots. Extend existing contracts, validators, Compose, Vite configuration, tests and CI. Detailed inventory: [Phase 2 handoff](docs/PHASE_2.md).

Add hls.js 1.7.3 for playback and yaml for configuration rendering; explicitly declare Zod at root for tooling validation. Lockfile installation and integrity verification remain enabled.

## Configuration

`npm run setup:media` creates/preserves `.env`, generates separate local publish/control credentials and renders ignored `.local/mediamtx.yml` with hashed passwords. Nonempty settings are preserved, reserved anonymous users are rejected and non-development bootstrap fails closed. No credentials or generated runtime/build files are committed.

All ports, media addresses/path/title, HLS settings, polling, deadlines, retry budget and bounded publisher/test settings are documented in `.env.example`. Standard Compose does not publish the admin API. The optional local npm override binds it only to loopback for the host API. Production RTMPS/TLS and authorization are explicitly outside this development deployment.

## Run locally

With Node 24, Docker/Compose, FFmpeg and a supported browser, from repository root:

```sh
npm ci
npm run setup:media
docker compose config --quiet
docker compose up --build --wait
npm run broadcast:test
```

Open `http://127.0.0.1:5173/watch/live` with default settings. The broadcaster sends an actual encoded synthetic pattern/tone for 120 seconds by default; Ctrl+C stops it. Stop it before the media test or OBS. Use `docker compose down` to stop services. The README has a full Windows VS Code/PowerShell walkthrough and a host npm alternative.

## OBS

- Service: Custom.
- Server: `rtmp://127.0.0.1:1935` with defaults (`MEDIA_RTMP_BASE_URL`).
- Stream key: `live?user=broadcaster&pass=YOUR_LOCAL_MEDIA_PUBLISH_PASSWORD`; substitute private `.env` values for path/user/password, never paste the resulting credential into this PR.
- H.264/yuv420p-compatible video, AAC audio, 30 fps, 2-second keyframes; start with 720p.
- Stop the FFmpeg publisher, add a real OBS source, start streaming, then use the watch page. Playback starts muted.

## FFmpeg test broadcaster

Install FFmpeg with libx264/AAC/lavfi or set `FFMPEG_PATH`. Run `npm run broadcast:test`. It reads local configuration without printing credential-bearing arguments. Its duration, grace timeout, fps, size, keyframe interval and tone are configurable and bounded. A wall-clock deadline covers stalled output; test-owned shutdown uses IPC for Windows portability.

## Validation

- Phase 1 baseline: 22 original tests and all foundation checks passed before implementation; remote baseline CI also succeeded.
- Clean `npm ci`, `npm run typecheck` (root plus workspaces), `npm run lint`, `npm run format:check`, `npm test` and `npm run build` passed. **57** unit/integration tests cover configuration/security, observations, routes and player behavior.
- `docker compose config --quiet`, official MediaMTX `--validate-conf`, real image build and Compose health checks passed. Unauthenticated internal Control API returned 401.
- `npm run test:e2e`: foundation connectivity/error/retry/mobile regression passed.
- `npm run test:media`: actual RTMP/HLS/browser integration passed, including invalid credentials, unknown path, competing publisher, playlist/segment bytes, decoded frames and advancing video time, source stop/return and origin unavailable/restart. The test restarts the origin; no self-healing claim is made.
- Bootstrap repeatability and production rejection were checked without changing existing credentials. Credential scans found no local publish/control values in eligible repository files. Production dependency audit reported zero vulnerabilities at check time.

Cloud checks used existing system Chromium and a proxy-aware Docker builder with supplied CA trust; no verification was disabled. CI is configured to run the same media path on GitHub; its result should be assessed separately from these executed checks.

## Screenshots

Actual decoded FFmpeg test-pattern video, explicitly synthetic test media:

![Desktop live watch page](https://raw.githubusercontent.com/Rashi-Bhojwani/StreamShield/refs/heads/feature/phase-2-live-streaming/docs/images/phase-2-live-desktop.png)

[Mobile live watch screenshot](https://github.com/Rashi-Bhojwani/StreamShield/blob/feature/phase-2-live-streaming/docs/images/phase-2-live-mobile.png)

## Known limitations

Physical OBS/webcam, Windows Docker Desktop and Safari/native HLS were not executed in this Linux environment. Native fallback and autoplay rejection have unit coverage; Chromium decoded-video playback is verified. This is one development origin, HLS adds latency, large browser chunks still emit build-size warnings, and there is no capacity/HA or infrastructure-healing claim. Use TLS/RTMPS and proper secrets/authorization before deployment.

## Acceptance checklist

- [x] Preserve Phase 1 history and isolate Phase 2 branch.
- [x] Real authenticated RTMP ingestion and HLS playlists/segments.
- [x] Browser decodes video and playback time advances.
- [x] Honest source, media and playback states; bounded reconnect and cleanup.
- [x] Private control API, scoped publishing and safe local configuration.
- [x] Builds, types, lint, formatting and automated/media checks executed.
- [x] Compose and actual healthy services verified.
- [x] OBS, FFmpeg and Windows/VS Code documentation provided.
- [x] No Phase 3+ implementation or fabricated telemetry.
- [ ] Reviewer approval and merge (intentionally pending).
