# Run the app and failure dashboard together on Windows

Use Node.js 24.x, npm 11+, Git, Docker Desktop with Linux containers/WSL 2,
and current Chrome. Keep Docker's engine running. The two deployments have
separate databases, credentials and Docker project names.

| Deployment             | Website               | Purpose                                                                                     |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `streamshield-main`    | http://127.0.0.1:5173 | Persistent accounts, channels and streams                                                   |
| `ss-light-<random ID>` | http://127.0.0.1:5174 | Temporary live streaming, four automatic recovery experiments and one operator-only failure |

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
git clone --branch main https://github.com/Rashi-Bhojwani/StreamShield.git StreamShield-updated
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
seconds of genuine healthy operation with no unresolved incidents, unverified
repairs or injected experiments before reporting **READY**. A transient startup
incident may remain in history after its repair is VERIFIED, persisted and the
incident is RESOLVED. It then needs a fresh 30-second quiet window; new recovery
activity or unavailable observations restart that window. Open, escalated or
unverified work still blocks readiness. History is retained; checks are never
disabled or forced green.

If `idle-baseline-stable` times out, inspect that run's `measurements.json` under
`test-results/light-demo/runs/<id>`. Its last wait observation now identifies the
unresolved repair/incident IDs, components, states and repair reasons, rather than
only reporting historical counts. The startup-history section records completed
repairs honestly; a recovered startup is not labelled as having had no repairs.

Wait for **READY**, then use the automatically opened, signed-in Chromium window.
Open http://127.0.0.1:5174/control/chaos in that window. Other browser profiles do
not inherit its administrator session. Keep the terminal and browser open.

The browser can appear while `browser-controller-readiness` or
`browser-baseline-stable` is still WAITING. Leave it open and wait for the terminal's
READY before injecting a failure. Starting real video/browser tabs adds load;
temporary readiness changes now wait for genuine stability instead of immediately
closing the browser with `refresh_or_polling_triggered_fault`. A new completed
repair resets the 30-second quiet window and stays in history. Real experiments,
escalated/unverified repairs and stale observations still block READY. Sustained
failure remains a bounded failure with the actual pending evidence saved.

Interactive startup opens only Control and Watch and avoids an extra homepage tab
and forced reload. The automated four-scenario runner retains homepage and reload
acceptance coverage. After the stability check, decoded playback is checked again.

The lightweight runner starts API-1 immediately after database/cache setup and
migrations. It waits at `api-listener-readiness` for a real readiness response
directly inside that container before starting the media/gateway/web stack.
Later `api-authentication` still checks the full web-to-API route and CSRF response.
This reduces competing startup work and distinguishes API boot from proxy errors.
The omitted API-3 spare is removed from this compact gateway configuration.

If either API stage fails, the terminal prints `api-startup-evidence` with safe
runtime import/stage markers and error codes. The report saves the same evidence;
full redacted API logs remain under `services/api.log` in that run's artifacts.
Markers distinguish import loading, PostgreSQL/Redis initialization, application
routes and listener binding. They contain no environment values or credentials.
The runtime still requires actual readiness; no failed probe is forced to pass.

Before requesting the sample stream's publishing key, startup checks the authenticated
RTMP and browser-publisher control inventories and requires three seconds of successful
checks. `media-control-readiness` is a normal waiting stage. Control operations have a
separate five-second budget (`MEDIA_CONTROL_TIMEOUT_MS`); the shorter media health
probe budget stays unchanged. Inventory reads run together under that bounded deadline.
Keys remain revoked if disconnection cannot be confirmed; writes are not blindly retried.

If this stage fails, its final error identifies `media_control_timeout`,
`media_control_unreachable`, `media_control_auth_denied`,
`media_control_invalid_response`, or another reviewed control error. Keep the saved
run artifacts. A fresh sample has no OBS publisher to stop: the old generic "Stop OBS"
message did not identify the underlying control-read failure.

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

## Update an existing checkout from this branch

Stop the old temporary demo with **Ctrl+C** and wait for its cleanup. Keep the
persistent application running. In your new checkout (adjust the folder if needed):

```powershell
cd E:\final-streamshield\StreamShield-updated
git pull --ff-only origin main
npm.cmd run build
npm.cmd run demo:light
```

The current update adds no dependencies or database migrations. The demo compiles
the updated API and controller and builds its own isolated web assets automatically.
Its existing runtime and Nginx images can be reused. Do not apply old patches.
If Git reports local tracked changes, preserve them before updating; do not reset
or delete your work. Accounts and streams in the temporary demo are recreated.

## Read understandable system logs

In the signed-in administrator browser, choose **System logs** in the Control
sidebar, or open http://127.0.0.1:5174/control/logs.

The page explains recorded service-health changes, broadcast lifecycle events,
failure experiments, recovery decisions and human escalations in plain language.
Search by component or explanation, filter by severity/source, choose the last
1, 6 or 24 hours, pause updates, or download the filtered JSON. It refreshes every
five seconds and shows the newest 500 recorded events. Missing sources and
truncated history are explicitly labelled; missing evidence never means healthy.

These are operational events, not all raw Docker stdout or every HTTP request.
Stream keys, credentials, chat messages and arbitrary raw process details are not
included. Administrator access is required. Logs belong to their deployment:
5174 shows the disposable demo; 5173 shows the persistent application's events.

For OBS, create a publishing key in Studio and copy the full key privately. The
demo uses a dynamic RTMP host port: do not use main-app port 1935 by mistake.
Find the demo mapping in another PowerShell window:

```powershell
docker ps -q --filter "label=streamshield.light-run" --filter "label=com.docker.compose.service=mediamtx" |
  ForEach-Object { docker port $_ 1935/tcp }
```

Use `rtmp://127.0.0.1:<printed-port>` in OBS with H.264 video, AAC audio and a
two-second keyframe interval. OBS is separate from the browser's Start Live button.

## What the five failures actually affect

Run one scenario at a time. Acknowledge impact and confirm the exact target.
Wait for verified recovery and healthy readiness/cooldown before the next one.

Selecting a card only selects the scenario. Choose **Run failure demonstration**,
acknowledge its impact, type the target (for example `api-1`), then choose
**Inject controlled failure** to actually start it.

The card and **Service health** header use the same fresh controller observations.
A real experiment shows **Healthy → Preparing → Failed → Recovering → Healthy**;
the four timestamp boxes retain the healthy baseline, confirmed failure, recovery
action and independently verified restoration. A request rejected before injection
is labelled **No failure injected**. An uncertain injection or unverified recovery
remains explicitly unverified.

**Demo readiness** is separate from service health: cooldown or a pending functional
check can block another experiment while the services are healthy. Its panel and
card notes keep their space during refreshes so the controls do not jump around.

| Failure                  | Confirm           | Actual audience impact                                                                                                                                                                                             |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API crash                | `api-1`           | Requests can fail over to API-2; chat/account requests may reconnect. Independent video can continue.                                                                                                              |
| Video gateway crash      | `video-gateway`   | Video can stall or buffer until the gateway and advancing segments are restored.                                                                                                                                   |
| Edge failure             | `edge-1`          | The backup edge serves video. Uninterrupted playback is successful redundancy.                                                                                                                                     |
| Network disruption       | `demo-dependency` | The real read-only recommendations demo times out and reconnects through its circuit breaker. The network delay lasts 20 seconds; video is independent.                                                            |
| Media authorization loss | `media-authority` | Both real HLS routes reject new playlists and segments with HTTP 503. Buffered video drains and stops. The system reports **Human action required**; automatic recovery cannot recreate missing signing authority. |

Studio and Watch show **Live service impact** during an actual experiment.
Their **Live API connection** panel shows primary and backup health and which API
actually served its latest response. During API-1 recovery, watch for responses
served by API-2. Video uses its own delivery path and can keep playing. Use the
video gateway crash to demonstrate a real video delivery interruption.
**Discover next** shows its genuine dependency loading/reconnect state. These
read-only viewer projections do not grant administrator or Docker authority.
Production deployments do not expose the optional development endpoint.

The player is not artificially paused to make a successful failover look broken.
Its loading state follows actual delivery. Recovery notices describe what is
being repaired and whether video can continue through a backup.

### The failure automatic healing cannot fix

Select **Media Authorization Loss** and confirm `media-authority`. This disposable
simulation represents a missing private-key backup or revoked privileged access
to an external signing/key-management service. In a real incident, only the
original key backup or an authorized external administrator could supply that
prerequisite; restarting a container cannot invent it. The demo blocks actual
video delivery but does not destroy a real key or contact a real external vault.

Both delivery paths are denied. The camera can continue sending and chat can
continue working, while viewers lose delivery after buffered media runs out.
Other failure buttons stay blocked. No timer or background restart removes this
gate. **Human action required** persists until explicit operator restoration or
until this disposable demo is stopped.

To continue your demonstration, type `media-authority` in **Confirm manual media
restoration**, then select **Restore demo media authorization**. This explicit
reset represents the authorized operator supplying the external prerequisite.
The controller records human intervention, opens the simulated gate, and checks
actual progressing video before allowing another experiment. The result says
**Human restoration verified · not automatically healed**. Logs and analysis keep
that distinction. If a player exhausted its retry budget during a long outage,
use its **Retry playback** button after restoration. Do not delete any volumes.

Screenshots: [manual recovery requirement](screenshots/reliable-studio/manual-recovery.png)
and [system logs](screenshots/reliable-studio/system-logs.png).

## Preview and verification evidence

- [Studio with a synthetic camera and real audience comments](screenshots/reliable-studio/studio-desktop.png)
- [Mobile Studio](screenshots/reliable-studio/studio-mobile.png)
- [Healthy failure dashboard](screenshots/reliable-studio/control-healthy.png)
- [Validation results](RELIABLE_STUDIO_VALIDATION.json)
- [Logs and operator-only failure validation](SYSTEM_LOGS_VALIDATION.json)
- [Media control startup validation](MEDIA_CONTROL_READINESS_VALIDATION.json)
- [Consistent health and recovery validation](RECOVERY_HEALTH_VALIDATION.json)
- [Readiness after verified startup recovery](STARTUP_BASELINE_VALIDATION.json)
- [API-first startup, safe boot diagnostics and real API recovery](API_STARTUP_VALIDATION.json)
- [Browser startup stability and recovery without premature closure](BROWSER_READINESS_VALIDATION.json)
- [Recovered dashboard with retained recovery timestamps](screenshots/reliable-studio/recovered-dashboard.png)

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

With exactly one disposable demo running, `test:system` verifies the fifth failure
and logs with an actual decoded video player. It creates only temporary `e2e_`
accounts, grants its test account administrator access in that demo, checks that
ordinary viewers cannot read logs or restore access, confirms actual denial on
both routes and stopped playback, uses the operator reset, and verifies decoded
video resumes. It requires local Docker test authority and rejects main projects.

```powershell
$env:SYSTEM_E2E_PROJECT = (docker ps --filter "label=streamshield.light-run" --filter "label=com.docker.compose.service=control-plane" --format '{{.Names}}') -replace '-control-plane-1$', ''
npm.cmd run test:system
Remove-Item Env:SYSTEM_E2E_PROJECT
```

If startup fails, the terminal's final JSON gives an artifact directory under
`test-results/light-demo/runs/<id>`. Its measurements and redacted service logs
preserve the failure after cleanup. Do not repeatedly retry account registration
or fault submission: a timed-out write may already have succeeded.
