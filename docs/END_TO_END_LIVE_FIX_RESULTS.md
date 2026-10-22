# End-to-end livestreaming fix results

## Status and diagnosed boundaries

**Linux end-to-end verification PASS**, using synthetic browser camera/microphone devices and real WebRTC/HLS transport. No physical Windows camera session or user machine logs are available in this cloud environment. The precise cause of Rashi's reported Windows failure is **unconfirmed**. Screenshots described in the request are observations, not proof of successful publishing.

Two defects were demonstrated in the current code:

- WHIP SDP acceptance resolved the publishing promise while ICE/DTLS was still connecting. New regression tests failed on the original implementation, including failure to delete an accepted session after permanent connection failure. Studio had no server LIVE verification deadline. A blocked Docker ICE port could leave an indefinite pending state.
- Studio Watch links navigated out of the broadcasting page. Its existing unmount cleanup stops the camera/peer, so following that link in the publishing tab stops the source. Watch links now open a separate tab. Closing/navigating away from Studio still ends browser capture by design; keep Studio open.

No evidence established a global discovery SQL, UUID routing or Redis room-isolation defect. Those existing paths are preserved and tested with independent accounts rather than patched speculatively.

## Files and behavior

- `apps/web/src/platform/whip.ts`: require actual peer connectivity, 20-second ICE connection deadline, cancellation, actionable negotiation/network errors and exact same-origin authenticated WHIP DELETE cleanup.
- `apps/web/src/platform/verify-broadcast.ts`: require typed server status LIVE after media progress/delivery; 45-second deadline tolerates brief API failover. Camera preview/peer connectivity alone never supplies LIVE.
- `packages/shared/src/platform.ts`, `services/api/src/platform/routes.ts`: typed owner/CSRF-protected attempt cancellation; atomic credential comparison prevents obsolete tabs from revoking/kicking replacement publishers. Explicit End retains its existing behavior.
- `BrowserStudio.tsx`: distinguish preview/connecting/publishing/verified state, stop and revoke failed allocated attempts, persistent parent notice if the ended editor disappears, cancel during pending setup, close on device termination/permanent peer failure, unload warning.
- `Studio.tsx`: separate-tab Watch links and Copy Watch Link for stable UUID URLs.
- Unit tests cover acceptance without ICE, permanent ICE failure, timeout, cancellation, server progress verification, authoritative failure and transient API outage.
- `tests/e2e/dynamic.spec.ts`: extends actual multi-stream coverage with rejected browser authorization cleanup, Rashi sign-in and exact title, already-open Lakshita feed, third independent viewer, real browser camera/microphone, popup preserving capture, decoded media/audio, acknowledged UI chat and explicit Redis chat between API-2 and API-1, viewer network reconnect, independent concurrent sources and camera playback/chat during API/edge faults.

Media remains camera/screen + microphone → same-origin WHIP signaling → unique authenticated relay path with direct ICE media → replicated origins → HLS edges → stable `/watch/<uuid>`. Express handles metadata/control, not video payloads. Per-stream ownership, random revocable credentials, CSRF/session checks, chat limits/moderation and restricted administration remain intact. No runtime dependency, migration or data reset is needed.

## Windows VS Code startup — PowerShell

Prerequisites: Node.js 24, Git, VS Code, Chrome/Edge, FFmpeg on PATH and Docker Desktop running **Linux containers**. Preserve existing `.env` and named volumes. Stop an older topology using its own documented `down` command first. Do not run `npm run dev` alongside the Docker web service on port 5173.

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/fix/end-to-end-multi-user-live-streaming
code .
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:dynamic -- --enable-local-chaos
node infrastructure/dynamic/compose.mjs config --quiet
npm.cmd run dynamic:up
npm.cmd run chaos:probe
```

For an existing clone: preserve local edits, stop services, `git fetch origin`, and `git switch fix/end-to-end-multi-user-live-streaming` (omit `--track` if the local branch exists), then repeat dependency/setup/start commands. Updating source alone does not rebuild Docker's frontend bundle or regenerate the WHIP proxy.

## Windows CMD

```bat
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/fix/end-to-end-multi-user-live-streaming
code .
npm ci
if not exist .env copy .env.example .env
npm run setup:dynamic -- --enable-local-chaos
node infrastructure/dynamic/compose.mjs config --quiet
npm run dynamic:up
npm run chaos:probe
```

## Exact two-account workflow

1. Open **http://127.0.0.1:5173/signup**, register Rashi's account, create its channel and a livestream titled **learn c++ in 2 hour**. Existing accounts can log in instead.
2. In another Chrome profile/incognito session, log in as Lakshita and leave **http://127.0.0.1:5173/live** open. Separate profiles prevent shared session cookies. A third independent profile can join.
3. In Rashi's Studio, grant camera/microphone permissions, click **Preview camera**, check moving preview/audio meter, then **Start Live**. Preview is private. Wait for **Verified LIVE**; ICE connection and server verification have separate deadlines and errors.
4. Keep Studio open. Lakshita's already-open feed should show Rashi automatically. Click its card; check moving video and use the player's sound control to permit audio. Browser autoplay may initially mute sound.
5. Rashi's **Open watch page** / **Share/watch link** opens a separate tab, preserving publishing. **Copy Watch Link** gives the same UUID route to another profile. Chat from Lakshita must appear once in Rashi's Watch tab and the third viewer's chat.
6. Run an independent broadcast from another registered owner's Studio/OBS. Its source and chat remain separate. Click **End Live** in Rashi's Studio; both Watch pages become offline and Rashi's live card disappears. The independent source continues. Ending an attempt revokes its key; create a new livestream for the next attempt.

**Share screen** uses genuine `getDisplayMedia` video plus the selected microphone. System/tab audio mixing is not implemented. Physical camera drivers and the operating-system screen chooser require manual verification; synthetic camera testing does not establish those work on every Windows installation.

## Networking and diagnosis

- Signaling goes through frontend **5173** at `/ingest/<unique-path>/whip`; relay **BROWSER_WHIP_PORT=8889** is private, not a separate public frontend URL. WHIP POST must return **201** with a valid same-origin resource Location. A 401/403 indicates publish authorization; 404/502 usually indicates stale/missing proxy or unhealthy relay. Do not paste credentials, SDP or request headers into public issues.
- Media bypasses HTTP through **BROWSER_ICE_PORT=8189**, forwarded **UDP and TCP** on loopback. Camera preview says nothing about this connection. Check Docker Desktop, VPN and local firewall. The relay advertises **127.0.0.1**; use this loopback deployment on the Docker host. Do not expose administration, PostgreSQL, Redis or private media APIs to fix ICE.
- On PowerShell, `Test-NetConnection 127.0.0.1 -Port 8189` checks the published TCP listener; it does not prove UDP, ICE or media delivery. Check browser DevTools Network for the actual WHIP response and Studio connection error. Never disable the entire firewall as a workaround.
- Webcam/screen access requires a secure context: localhost/127.0.0.1 or HTTPS. Arbitrary plain HTTP LAN hostnames do not satisfy this. General remote-browser publishing requires trusted HTTPS, correct frontend origin/cookies/CORS, routable ICE candidates/ports and possibly TURN; this local composition does not claim automatic remote-browser support.
- Trusted LAN OBS ingest is configurable with `npm.cmd run setup:dynamic -- --enable-local-chaos --ingest-host YOUR_ASSIGNED_LAN_IPV4`, then recreate with `dynamic:up`. `--ingest-host` changes RTMP only. Use Private firewall scope and TCP **MEDIA_RTMP_PORT=1935**. Copy that owner's actual OBS Server/Key from Studio; use H.264/AAC and 2-second keyframes. Never use a shared generic key or remote laptop's localhost destination.
- HLS is served through the existing frontend `/media/primary/...` and `/media/standby/...` routes, obtained from API metadata. Check progressing playlists/segments and decoded frames, not just HTTP 200. Audio policy/codec incompatibility is separate from source availability.
- `npm.cmd run dynamic:status`, `npm.cmd run chaos:probe` and `node scripts/dynamic-diagnostics.mjs` inspect the generated topology; diagnostics write bounded, redacted service logs to `test-results/dynamic/services.log`. Never publish `.env` or `.local`.
- If Start Live fails, read the persistent Studio notice. Failed allocated attempts are stopped/revoked. If cleanup cannot be confirmed during an API outage, use **End Live** / **End stream** after services recover. Do not rotate another user's key or delete database volumes.

## Standalone FFmpeg broadcaster

Use a **different registered broadcaster/channel** when testing alongside Rashi's camera. In that owner's Studio create a new stream, click **Create publishing key**, reveal/copy its private OBS key and keep the terminal private. The key format is `s-<path>?user=<stream UUID>&pass=<private credential>`; use the actual values from Studio. Do not start camera publishing on the same path simultaneously.

PowerShell (prompts avoid putting credentials in command history; values remain transient process environment):

```powershell
$env:MEDIA_RTMP_BASE_URL = Read-Host "Studio RTMP server"
$env:MEDIA_STREAM_PATH = Read-Host "Stream-key path before ?"
$env:MEDIA_PUBLISH_USER = Read-Host "Stream-key user= value"
$env:MEDIA_PUBLISH_PASSWORD = Read-Host "Stream-key pass= value (private)"
$env:TEST_PUBLISH_DURATION_SECONDS = "120"
npm.cmd run broadcast:test
Remove-Item Env:MEDIA_RTMP_BASE_URL,Env:MEDIA_STREAM_PATH,Env:MEDIA_PUBLISH_USER,Env:MEDIA_PUBLISH_PASSWORD,Env:TEST_PUBLISH_DURATION_SECONDS
```

CMD:

```bat
set /p MEDIA_RTMP_BASE_URL=Studio RTMP server:
set /p MEDIA_STREAM_PATH=Stream-key path before ?:
set /p MEDIA_PUBLISH_USER=Stream-key user value:
set /p MEDIA_PUBLISH_PASSWORD=Stream-key pass value (private):
set TEST_PUBLISH_DURATION_SECONDS=120
npm run broadcast:test
set MEDIA_RTMP_BASE_URL=
set MEDIA_STREAM_PATH=
set MEDIA_PUBLISH_USER=
set MEDIA_PUBLISH_PASSWORD=
set TEST_PUBLISH_DURATION_SECONDS=
```

This runs `scripts/test-publisher.mjs`: actual H.264/AAC test video and a tone, with a bounded duration and redacted destination. Ctrl+C stops it early; then clear the variables using the listed cleanup commands. FFmpeg must be on PATH, or set `FFMPEG_PATH` to its actual executable. Synthetic test video is distinct from browser camera verification. Do not put private publishing values in `.env`, commits, screenshots or issue logs.

## Automated checks and shutdown

```powershell
npm.cmd run lint
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run test:dynamic
npm.cmd run dynamic:down
```

CMD uses the same commands with `npm` / `npx`. `test:dynamic` requires FFmpeg and the owned, healthy loopback topology with local chaos enabled; it registers isolated random users and runs real browser/FFmpeg media and destructive faults only against that explicit test topology. Do not run it against an active personal broadcast. Test accounts/audit history remain durable. Stop personal external FFmpeg publishers with Ctrl+C. `dynamic:down` preserves named volumes; never add `-v`.

## Actual verification evidence

[Clean Docker/browser runtime run](https://github.com/Rashi-Bhojwani/StreamShield/actions/runs/39742661575), source `a451e4343f7fc26c766e43b4156c85af0543d7e9`: **all eight CI jobs passed**: verify, resilience, monitoring, healing, chaos, demo, capacity and dynamic. [Immutable source-linked raw measurements and screenshot hashes](END_TO_END_LIVE_FIX_MEASUREMENTS.json). PR checks show the full regression status for the final documentation revision.

- Before changes: **179 unit tests passed in 18 files**. Two new WHIP regressions failed on the original implementation.
- Updated local `lint`, `format:check`, `typecheck`, `build`: **passed**; `npm test`: **186 passed in 19 files**. Generated Docker Compose validation passed. Build retains its existing large-bundle warning.
- Rashi signs in, creates **learn c++ in 2 hour**, previews and starts genuine browser camera/microphone publishing. Lakshita's already-open global feed receives the typed LIVE event and card without replacing the document. A third account discovers/watches the same stream.
- WHIP reaches **connected**; relay, primary and standby all report the same browser path ready with **H.264/Opus**. At the snapshot their respective inbound counters were **357202 / 330346 / 332869 bytes**.
- Remote media observation: **480×270** video, **6262 decoded audio bytes**, audio RMS **0.451273**. During an earlier adaptive-resolution observation, non-dropped frames advanced **14 → 24** and media time **0.336686 → 0.843603 seconds**. Resolution adapts; these are separate actual observations, not a fixed-resolution guarantee.
- Lakshita's UI message is acknowledged and appears exactly once in Rashi's separate Watch tab and the third viewer's chat. An additional direct **API-2 → API-1** test confirms acknowledged Redis distribution with **one delivery**. Durable history survives the viewer's injected network loss and reload; separate-channel history excludes the message.
- The popup preserves Studio and its camera source. Three distinct FFmpeg streams decoded at 640/480/320px earlier in the same run; two remained active alongside the browser source. Ending Rashi changes both accounts' Watch pages offline, removes its card from an already-open feed without a document reload, and leaves the independent streams progressing.
- Injected HTTP 401 and accepted WHIP with test-corrupted ICE parameters both show a persistent error, revoke that attempt and remain outside discovery. Recorded WHIP cleanup DELETE responses were 404; backend end/revocation checks passed. An obsolete credential cannot stop a newer real publisher, and another account cannot invoke its cleanup.
- Captured browser page errors: **0**. Three console errors occurred alongside the intentionally failed 401/404 requests. Redacted bounded service logs and all eleven captured PNGs are available in the run's `dynamic-streaming-results` artifact.

### Actual fault observations

| Source               | Fault         | Detection (s) | Healer start (s) | Service restoration (s) | Maximum sampled browser-progress gap (s) |
| -------------------- | ------------- | ------------: | ---------------: | ----------------------: | ---------------------------------------: |
| Three FFmpeg sources | crash-api     |         3.816 |            4.741 |                  16.382 |                                    0.500 |
| Three FFmpeg sources | crash-edge    |         4.157 |            4.599 |                  14.428 |                                    0.500 |
| Three FFmpeg sources | crash-primary |         3.304 |            4.740 |                  26.543 |                                    1.500 |
| Browser camera       | crash-api     |         2.346 |            3.158 |                  16.884 |                                    0.504 |
| Browser camera       | crash-edge    |         2.226 |            3.034 |                  13.405 |                                    0.500 |

All five experiments completed with independent Healer verification; the camera's API/edge cases additionally confirmed decoded playback afterward and acknowledged chat received by Rashi. No manual service restoration was used. Normal gateway/origin failover and player reconnect are separate from Healer restarting/verifying a target. The server's `browserPlaybackVerified` remains **false** and `playbackInterruptionMs` remains **null**; browser probes are independent test evidence. Sampling uses media time and total video-frame progress every 250ms; it does not establish zero buffering, a precise per-frame interruption duration, public-host capacity or 50K users.

### Actual reviewed screenshots

The green animated camera pattern is Chromium's synthetic capture device transmitted through the actual publishing/playback pipeline. Studio shows the earlier intentionally rejected/blocked attempts as ended history; their error notices are expected test evidence. Initial player estimates can lag until visible playback heartbeats arrive; the later Studio capture shows three approximate active players. These counts are not human-audience guarantees. PNGs are copied unchanged from the runtime artifact; no publishing secrets are shown.

- [Lakshita's global Live feed with Rashi's card](screenshots/live-fix/exact-lakshita-live.png)
- [Lakshita watching Rashi and participating in shared chat](screenshots/live-fix/exact-lakshita-watch.png)
- [Rashi's verified LIVE Studio, desktop](screenshots/live-fix/studio-1440.png)
- [Rashi's verified LIVE Studio, 375px](screenshots/live-fix/studio-375.png)

### Remaining limitations and next validation

The user's original physical Windows failure was not reproduced on their machine. Apply the branch and regenerate/rebuild Docker using the commands above, then perform the two-profile camera/chat/end workflow. If ICE fails, use the new exact error and loopback port checks to diagnose that Windows firewall/VPN/Docker installation. Physical webcam/drivers, OS screen-share chooser, LAN browser ingress and 50K capacity remain unverified. The existing Observer/Healer/Chaos foundation is preserved; recovery of a user-closed camera tab is not an infrastructure restart capability.
