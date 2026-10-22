# End-to-end livestreaming fix results

## Status and diagnosed boundaries

Verification in progress. No physical Windows camera session or user machine logs are available in this cloud environment. The precise cause of Rashi's reported Windows failure is **unconfirmed**. Screenshots described in the request are observations, not proof of successful publishing.

Two defects were demonstrated in the current code:

- WHIP SDP acceptance resolved the publishing promise while ICE/DTLS was still connecting. New regression tests failed on the original implementation, including failure to delete an accepted session after permanent connection failure. Studio had no server LIVE verification deadline. A blocked Docker ICE port could leave an indefinite pending state.
- Studio Watch links navigated out of the broadcasting page. Its existing unmount cleanup stops the camera/peer, so following that link in the publishing tab stops the source. Watch links now open a separate tab. Closing/navigating away from Studio still ends browser capture by design; keep Studio open.

No evidence established a global discovery SQL, UUID routing or Redis room-isolation defect. Those existing paths are preserved and tested with independent accounts rather than patched speculatively.

## Files and behavior

- `apps/web/src/platform/whip.ts`: require actual peer connectivity, 20-second ICE connection deadline, cancellation, actionable negotiation/network errors and exact same-origin authenticated WHIP DELETE cleanup.
- `apps/web/src/platform/verify-broadcast.ts`: require typed server status LIVE after media progress/delivery; 45-second deadline tolerates brief API failover. Camera preview/peer connectivity alone never supplies LIVE.
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
- Webcam/screen access requires a secure context: localhost/127.0.0.1 or HTTPS. Arbitrary plain HTTP LAN hostnames do not satisfy this. General remote-browser publishing requires trusted HTTPS, correct frontend origin/cookies/CORS, routable ICE candidates/ports and possibly TURN; this local composition does not claim automatic remote-browser support.
- Trusted LAN OBS ingest is configurable with `npm.cmd run setup:dynamic -- --enable-local-chaos --ingest-host YOUR_ASSIGNED_LAN_IPV4`, then recreate with `dynamic:up`. `--ingest-host` changes RTMP only. Use Private firewall scope and TCP **MEDIA_RTMP_PORT=1935**. Copy that owner's actual OBS Server/Key from Studio; use H.264/AAC and 2-second keyframes. Never use a shared generic key or remote laptop's localhost destination.
- HLS is served through the existing frontend `/media/primary/...` and `/media/standby/...` routes, obtained from API metadata. Check progressing playlists/segments and decoded frames, not just HTTP 200. Audio policy/codec incompatibility is separate from source availability.
- `npm.cmd run dynamic:status`, `npm.cmd run chaos:probe` and `node scripts/dynamic-diagnostics.mjs` inspect the generated topology; diagnostics write bounded, redacted service logs to `test-results/dynamic/services.log`. Never publish `.env` or `.local`.
- If Start Live fails, read the persistent Studio notice. Failed allocated attempts are stopped/revoked. If cleanup cannot be confirmed during an API outage, use **End Live** / **End stream** after services recover. Do not rotate another user's key or delete database volumes.

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

Baseline before changes: `npm test` — **179 passed in 18 files**. New WHIP regression checks before the fix: **2 failed**, demonstrating premature publishing success and missing accepted-session cleanup. After fixing these boundaries: targeted WHIP/server-verification tests — **8 passed in 2 files**. Updated local checks: lint, formatting, typecheck and build passed; `npm test` passed **186 tests in 19 files**. Generated dynamic Docker Compose validation passed. The build emits its existing large-bundle warning. Clean Linux Docker/browser results will be recorded after execution. No claim of physical Windows validation, public remote-browser support, 50K capacity or recovery of a closed user camera tab is made.
