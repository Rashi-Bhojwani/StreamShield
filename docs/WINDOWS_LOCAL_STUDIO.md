# Run the app and failure dashboard together on Windows

Use Node.js 24.x, npm 11+, Git, Docker Desktop with Linux containers/WSL 2,
and current Chrome. Keep Docker's engine running. The two deployments have
separate databases, credentials and Docker project names.

| Deployment             | Website               | Purpose                                                    |
| ---------------------- | --------------------- | ---------------------------------------------------------- |
| `streamshield-main`    | http://127.0.0.1:5173 | Persistent accounts, channels and streams                  |
| `ss-light-<random ID>` | http://127.0.0.1:5174 | Temporary live streaming and four real failure experiments |

Failure buttons affect the deployment on **5174**. They do not stop containers
belonging to `streamshield-main` on 5173. The demonstration is disposable and
expires after about an hour; closing its browser or pressing Ctrl+C cleans up
only its own containers. Its accounts and broadcasts must be recreated next time.

## Get the GitHub version

This branch includes the stability, browser streaming, Studio chat and design
updates. Do not apply the old downloadable patches on top of it.

If your previous checkout has manual patches, keep it intact and clone into a
new folder. In PowerShell:

```powershell
cd E:\
git clone --branch feature/reliable-live-studio https://github.com/Rashi-Bhojwani/StreamShield.git StreamShield-updated
cd E:\StreamShield-updated
npm.cmd ci
```

Stop the **old temporary demo** with Ctrl+C in its original terminal and wait
for cleanup before starting a new one on 5174. Keep the persistent app running.
If the old demo terminal is unavailable, identify its exact containers with
`docker ps --filter "label=streamshield.light-run"`; stop only that demo's
containers. Do not stop all Docker containers or delete data volumes.

## Prepare the demo once

The setup preserves existing nonempty local settings and generates private
credentials without printing them. Never share `.env`, `.local`, or stream keys.

```powershell
npm.cmd run setup:platform
npm.cmd run build
npx.cmd playwright install chromium

docker build -f infrastructure/healing/runtime.Dockerfile -t streamshield-healing-runtime:latest .
docker build -f infrastructure/healing/web.Dockerfile -t streamshield-healing-web:latest .
docker pull postgres:17.9-alpine
docker pull redis:8.6.2-alpine
docker pull bluenviron/mediamtx:1.21.2-ffmpeg
docker pull nginx:1.30.6-alpine
docker pull ghcr.io/shopify/toxiproxy:2.13.0
```

The images may already be cached. Do not rebuild images merely for a source
change: the demo compiles current API/control source once on the host and mounts
the JavaScript into the pinned Linux runtime images. Native dependencies stay
inside those images. Windows native modules are not copied into Linux containers.

Start the failure demo:

```powershell
npm.cmd run demo:light
```

On Windows the interactive runner supplies supported probe budgets by default;
explicit environment overrides remain respected. It requires 30 continuous
seconds of genuine healthy operation with zero incidents, repairs or injected
faults before reporting **READY**. Unavailable observations reset that window.
Real faults remain visible; health checks are never disabled or forced green.

Wait for **READY**, then use the automatically opened, signed-in Chromium window.
Open http://127.0.0.1:5174/control/chaos in that window. Other browser profiles do
not inherit its administrator session. Keep the terminal and browser open.

## Broadcast and read your comments

1. Use Studio on **5174** for a stream that should experience these failures.
   The existing generated sample is labelled sample content; keep it running.
2. Use the demo administrator's existing channel, or register a separate creator
   in another browser profile on the same origin and create a channel.
3. Create a new livestream. Select **Preview camera** or **Share screen**, allow
   capture, then **Start Live**. Wait for the verified live message.
4. Keep the Studio tab open. **Stream chat** beside the preview receives real
   audience messages and lets the broadcaster reply without leaving capture.
   The local preview does not count as an additional audience player.
5. Open the exact watch link in another tab/profile and confirm moving video,
   sound when unmuted, and chat in both directions.

The demo publishes browser ICE on loopback **TCP and UDP 18189**, separate from
the main app. A camera preview alone does not establish successful broadcasting.
A failed publishing attempt is cleaned up and ended; create a new broadcast to retry.

For OBS, create a publishing key in Studio and copy the full key privately. The
demo uses a dynamic RTMP host port: do not use main-app port 1935 by mistake.
Find the demo mapping in another PowerShell window:

```powershell
docker ps -q --filter "label=streamshield.light-run" --filter "label=com.docker.compose.service=mediamtx" |
  ForEach-Object { docker port $_ 1935/tcp }
```

Use `rtmp://127.0.0.1:<printed-port>` in OBS with H.264 video, AAC audio and a
two-second keyframe interval. OBS is separate from the browser's Start Live button.

## What the four failures actually affect

Run one scenario at a time. Acknowledge impact and confirm the exact target.
Wait for verified recovery and healthy readiness/cooldown before the next one.

| Failure             | Confirm           | Actual audience impact                                                                                                                                  |
| ------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API crash           | `api-1`           | Requests can fail over to API-2; chat/account requests may reconnect. Independent video can continue.                                                   |
| Video gateway crash | `video-gateway`   | Video can stall or buffer until the gateway and advancing segments are restored.                                                                        |
| Edge failure        | `edge-1`          | The backup edge serves video. Uninterrupted playback is successful redundancy.                                                                          |
| Network disruption  | `demo-dependency` | The real read-only recommendations demo times out and reconnects through its circuit breaker. The network delay lasts 20 seconds; video is independent. |

Studio and Watch show **Live service impact** during an actual experiment.
**Discover next** shows its genuine dependency loading/reconnect state. These
read-only viewer projections do not grant administrator or Docker authority.
Production deployments do not expose the optional development endpoint.

The player is not artificially paused to make a successful failover look broken.
Its loading state follows actual delivery. Recovery notices describe what is
being repaired and whether video can continue through a backup.

## Preview and verification evidence

- [Studio with a synthetic camera and real audience comments](screenshots/reliable-studio/studio-desktop.png)
- [Mobile Studio](screenshots/reliable-studio/studio-mobile.png)
- [Healthy failure dashboard](screenshots/reliable-studio/control-healthy.png)
- [Validation results](RELIABLE_STUDIO_VALIDATION.json)

The screenshots use a generated camera test pattern and disposable test accounts.
The chat messages traveled between separate authenticated browser contexts while
the remote player decoded video. The four-scenario check verified visible recovery
notices in every experiment and the actual recommendation reconnect/loading state
during network disruption. These Linux checks do not claim physical Windows camera
or firewall verification.

## Start or upgrade the persistent application too

For a brand-new main deployment:

```powershell
npm.cmd run setup:platform
docker compose -p streamshield-main up -d --build --wait
```

If `streamshield-main` already has a database, **reuse its existing `.env`** before
running setup/recreating it from a new checkout. Generating a new password will
not change the password stored in an existing PostgreSQL volume. For example,
before creating `.env` in the new folder, copy it locally from the old checkout:

```powershell
Copy-Item -LiteralPath E:\final-demo\StreamShield\.env -Destination E:\StreamShield-updated\.env
npm.cmd run setup:platform
docker compose -p streamshield-main up -d --build --wait
```

Do not overwrite a different existing `.env` blindly. Preserve any settings
you changed and never paste its values into chat or issues. Main-app data stays
in its named volume. To stop the main app, use
`docker compose -p streamshield-main stop`; do not use `down -v`.

Create an account before granting administrator access:

```powershell
docker compose -p streamshield-main exec api npm run account:role -- YOUR_USERNAME administrator
```

Administrator access alone does not start the main app's missing failure
services. Use the separate signed-in demo administrator on 5174 for failures.

## Validation and troubleshooting

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

With the disposable demo running, `npm.cmd run test:studio` performs a genuine
synthetic-camera broadcast, decoded remote playback, viewer-to-Studio chat,
Studio-to-viewer replies, responsive layout and presence verification. It uses
temporary `e2e_` accounts in the disposable demo, not the main application's users.
It disables traces so publishing credentials are not captured. Physical Windows
device and firewall behavior still require a local test.

`npm.cmd run test:light-four` creates its own isolated fixture, actually injects
the four faults and verifies receipts, independent behavior, progressing media,
and visible live impact/recommendation reconnect states. Do not run multiple
resource-heavy demo instances just to collect results.

If startup fails, the terminal's final JSON gives an artifact directory under
`test-results/light-demo/runs/<id>`. Its measurements and redacted service logs
preserve the failure after cleanup. Do not repeatedly retry account registration
or fault submission: a timed-out write may already have succeeded.
