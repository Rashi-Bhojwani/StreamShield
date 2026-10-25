# Lightweight four-scenario presentation

This runs the existing React website, Express APIs, PostgreSQL/Redis, MediaMTX,
Nginx gateways/edges, observer, Healer and restricted Chaos adapter. It does not
run the full telemetry fixture. Prometheus, Grafana, API-tier load metrics and
the spare API-3 are intentionally absent; their health is not fabricated.

## Start on Windows

The implementation is on `feature/lightweight-self-healing-demo`. If your
existing checkout has uncommitted changes, use a separate Git worktree to keep
those changes (including an untracked `findstr`) untouched:

```powershell
cd E:\StreamShield\StreamShield
git fetch origin feature/lightweight-self-healing-demo
git worktree add --detach ..\StreamShield-lightweight-demo FETCH_HEAD
cd ..\StreamShield-lightweight-demo
```

The destination must be a new directory; if it already exists, Git stops rather
than overwriting it. The original Windows checkout is not merged, reset or
modified. This fresh worktree contains the published version; incorporating
your separate local edits later requires comparing their diffs first. Windows
runtime readiness is established by running the checks below, not by the Linux
results included in this branch.

Start Docker Desktop in **Linux containers** mode. Use Node.js 24. In PowerShell:

```powershell
npm.cmd ci
if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run demo:light
```

After `READY`, the command opens a private Chromium window already signed into a
fresh disposable administrator account. Open **http://127.0.0.1:5174/control/chaos**
in that window. A second tab contains the actual Watch page; its exact URL is
printed in the terminal. No password, session cookie or publishing key is printed.
Other browser profiles do not inherit that administrator session. If port 5174
is occupied, startup stops; keep the existing application running and release
that port yourself before retrying. Do not terminate unrelated processes.

The command creates a unique, loopback-only demo with temporary databases and a
labelled FFmpeg H.264/AAC sample source, not your existing accounts or broadcasts.
The conditional copy above supplies frontend build settings in a fresh checkout;
it never overwrites an existing `.env`. The demo generates its own isolated
configuration and preserves existing `.env`, `.env.local`, generated user
configuration and named volumes. Keep the terminal open. This is
a disposable local presentation environment, not a persistent production mode.
It lasts at most about 60 minutes. Faults are never injected automatically by
`demo:light`; each requires the existing authenticated, CSRF-protected confirmation.

### Cached images

The command uses `--no-build --pull never`. If a required image is missing, it
stops before starting services. On a new installation, these are the exact image
preparation commands (additional download/build space is required):

```powershell
docker build -f infrastructure/healing/runtime.Dockerfile -t streamshield-healing-runtime:latest .
docker build -f infrastructure/healing/web.Dockerfile -t streamshield-healing-web:latest .
docker pull postgres:17.9-alpine
docker pull redis:8.6.2-alpine
docker pull bluenviron/mediamtx:1.21.2-ffmpeg
docker pull nginx:1.30.6-alpine
docker pull ghcr.io/shopify/toxiproxy:2.13.0
```

Do not rebuild images just to refresh application source: the isolated runner
copies current source and builds/binds the frontend, reusing cached dependencies
and runtime images. It does not download Grafana or Prometheus. A clean-host
image build is separate from the verified cached-image disk budget.

## Record the demonstration

1. Wait for `READY`, **System status: Healthy**, four `HEALTHY` cards and healthy
   component checks. Confirm the Watch tab plays the labelled generated source.
   Startup verifies real API reads and advancing HLS bytes on both origins, plus
   browser-decoded frames; a player element alone does not establish readiness.
2. Select **API Server Crash**, click **Run failure demonstration**, acknowledge
   impact and type `api-1`. The real container process stops. API-2 continues
   serving; the independent Healer starts API-1 and verifies actual API reads.
3. Wait for **Verified demonstration result**, `HEALED`, and renewed admission.
   Select **Video Gateway Crash**, confirm `video-gateway`. Playback can freeze;
   the Healer must restore the gateway and advancing media through it.
4. Wait for the healthy baseline/cooldown. Select **Edge Node Failure**, confirm
   `edge-1`. In this mode Nginx prefers edge-1 and uses the separate edge-2 as a
   backup. The timeline records a live manifest served by edge-2 while edge-1
   is unavailable. Healer restoration of edge-1 is a separate required check.
5. Wait again. Select **Network Disruption**, confirm `demo-dependency`. A scoped
   Toxiproxy delay affects only the existing read-only recommendation simulator.
   Observe timeout detection, circuit/backoff, owned fault expiry and successful
   reconnection. Read-attempt counts and measured restored latency are shown.
   This is real network failure against a deliberately simulated dependency;
   it does not interrupt your internet and is not a container restart.
6. Show the timestamped controller events, failure reason, recovery action and
   verification time. `RECOVERING` means work is in progress. `HEALED` requires
   actual verification and fresh readiness. Failed/timed-out results remain
   `DEGRADED`; waiting a fixed duration never converts them into successes.

One experiment runs at a time. Server-side cooldowns, repair budgets, fresh health
checks and cleanup gates still apply. If blocked, use **Refresh readiness** and
read the reason; do not force-enable controls. The controller independently
rechecks a safe baseline after failed/timed-out recovery, retaining the failure
in history. For a fresh recording beyond the bounded restart budget, stop this
disposable session and start a new one. Cancellation cleans owned temporary
network faults; it does not claim to have repaired a crashed service.

## Stop and verify

Close the demo Chromium window or press **Ctrl+C once** in its terminal, then
wait for the cleanup summary. Only containers/network labelled with this run's
random ID and its temporary workspace are removed. No Docker image, named user
volume, database or unrelated container is removed. No `down -v` is used.
Do not force-close Docker or the terminal during cleanup. A cleanup failure keeps
the temporary workspace and reports the affected run instead of masking it.

```powershell
npm.cmd run test:light-four
npm.cmd run demo:light -- --smoke
npm.cmd test
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
npm.cmd run format:check
```

`test:light-four` runs four real UI-driven faults sequentially on one shared
13-container stack, verifies recovery and live browser playback after each, then
cleans up. It chooses a free loopback port. `demo:light -- --smoke` tests the same
presentation startup headlessly, verifies zero injected faults, then stops; its
`DEMO_STOPPED` result is not a four-scenario pass. Run these commands one at a time.
Results/logs/screenshots are in `test-results/light-four/runs/<id>/` and
`test-results/light-demo/runs/<id>/`, with a latest `measurements.json` in each
parent directory. Failed runs retain the exact stage and redacted diagnostics.

The optional `npm.cmd run test:four-live` still uses the original full telemetry
topology and its 8 GiB VFS preflight guard; its measured practical requirement is
about 9 GiB. It is **not** required to start this demo. Compact modes retain a
4 GiB preflight floor and, before every allocation, the conservative image-size
check plus 768 MiB reserve. The interactive session also stops safely if free
space drops below that reserve. Docker logs are capped at 5 MiB per container.
On the verified VFS host, compact service roots use about 3.70 GiB rather than
7.50 GiB. Different storage drivers, image builds and host workloads can differ.

API-1, gateway, both edges, relay and origins remain separate containers. The
trusted control processes share one container; API-2 is a separate unprivileged
process in it, with real Docker-socket permission denial checked at startup.
Only the narrow trusted adapters have effective Docker authority. This local
demonstration arrangement does not establish production tenant/host isolation.

## Troubleshooting

- **Browser missing:** run `npx.cmd playwright install chromium`. Linux GUI mode
  needs a desktop/display; headless tests do not establish Windows GUI operation.
- **Docker unavailable:** start Docker Desktop, select Linux containers, retry.
- **Image missing:** use the exact preparation commands above with adequate
  build space. The runner never silently pulls or builds container images.
- **Disk guard:** free additional space outside user data or use a roomier drive;
  never lower the guards. The 768 MiB reserve is not a guarantee against unrelated
  processes filling the host. On Docker Desktop check its VM disk capacity too.
- **Disabled button:** inspect its real reason and the captured stage/health
  logs. Wait for current recovery, cooldown or source readiness. Do not reset
  volumes, force admission or turn a failed recovery into a pass.
- **Credentials:** use the automatically signed-in demo window. Never paste
  `.env`, cookies or generated credentials into reports.

See `LIGHTWEIGHT_DEMO_RESULTS.md` for measured results and remaining limitations.
