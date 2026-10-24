# Lightweight demo implementation and verification

The existing application now has a foreground `demo:light` startup and a separate
`test:light-four` acceptance command. Neither starts Grafana or Prometheus. The
full `test:four-live` telemetry fixture remains optional with its original guard.

## What changed

- `scripts/fixture-profile.mjs`, `fixture-profile.test.mjs`, `light-demo.mjs`:
  explicit compact/full/interactive modes, separate run labels and artifacts,
  unchanged full-mode disk requirement, tested active/backup Nginx configuration.
- `scripts/four-scenario-live.mjs`: reuse the proven compact topology for all
  four faults; retain separate fault targets and surviving edge; no automatic
  fault injection in foreground mode; authenticated browser startup, bounded
  source/session, isolated data, disk reserve, bounded Docker logs and owned-only
  shutdown. Keep all original recovery and browser checks and add controller
  edge-identity and dependency circuit/read-attempt assertions. The extra
  occupied-port probe has its own stage and a traced disposable child.
- `scripts/fixture-diagnostics.mjs`: print named waiting stages rather than
  leaving startup silent; existing redaction and failure retention remain.
- `services/api/src/healing/verification.ts` and its test: require a real HLS
  manifest and matching response header for serving-edge evidence.
- `services/api/src/chaos/engine.ts`, `chaos.test.ts`,
  `packages/shared/src/chaos.ts`: record the serving edge before injection;
  require a successful backup manifest while the failed edge is unavailable;
  retain independent restoration verification; record actual dependency reads
  and circuit transitions. Add explicit failover event type and negative tests.
- `services/api/src/healing/circuit-regression.test.ts`: test exponentially
  backed-off failed reads, the 60-second cap, rejection without another network
  request, and two successful half-open reads before CLOSED.
- `apps/web/src/control/Demonstration.tsx`, `demo-model.ts` and their tests:
  backend-derived per-scenario states, timestamped events for all four scenarios,
  serving-edge proof, circuit/read counts. Keep cooldown admission separate from
  actual healthy/verified recovery; buttons remain disabled during cooldown.
- `package.json`, `README.md`, `LIGHTWEIGHT_DEMO.md`, this report and adjacent
  evidence files: commands, Windows preparation, recording order and limitations.

No new dependency was added. Existing `services/api/src/server.ts` startup work
was preserved unchanged. The diagnostic child is an isolated source copy with
additional sanitized tracing, not a change to the running API.

## Capacity and safety

The full measured VFS baseline needed about 7.50 GiB in empty container roots.
Removing optional telemetry and the extra API runtime root reduces the compact
baseline to about 3.70 GiB. All four scenarios share one 13-container topology
and execute sequentially. No container image is rebuilt/pulled by these commands.

The verified compact runs started with about 4.78 GiB free and retained about
1.08 GiB while running, above the 768 MiB reserve. API-2 runs as a separate
unprivileged process with verified Docker-socket denial in the shared trusted
control container. Fault-target API-1, video gateway, edge-1 and surviving edge-2
remain separate containers. This is explicitly a local demonstration topology.

All runs clean only their own labelled temporary containers/network. Seven
pre-existing named volumes, existing images, original configuration and user
data remain intact. `.env`/`.env.local` preservation is verified by hashes.
Measurements were captured on `feature/final-self-healing-presentation` before publication.
The publication branch is `feature/lightweight-self-healing-demo`, based on
`34c55f91d7b65dbd050dfc05e2156182a095616e`. The original working tree is preserved.

## Results and retained failure history

Four implementation runs are retained in `LIGHTWEIGHT_DEMO_HISTORY.json`:

- `a5ec83a3`: preliminary compact four-scenario run PASS, four recoveries verified.
- `3cfc65f0`: four recoveries PASS, but overall run FAIL because the additional
  occupied-port startup child exceeded its existing ten-second deadline.
- `dd756a25`: all four recoveries and traced occupied-port startup check PASS.
  The child reported `public_listener / EADDRINUSE`, completed all five cleanup
  steps and exited 1 naturally; the running API remained healthy and unchanged.
- `a109af7b`: final application/UI run **PASS**, all four verified, no browser
  page errors, actual decoded playback after every recovery, all 13 owned
  containers cleaned and user environment unchanged. The occupied-port check
  also passed again. Responsive overflow checks passed at 375, 768 and 1440 px.

| Final scenario      | Verified recovery | Required observed evidence                                                                               |
| ------------------- | ----------------: | -------------------------------------------------------------------------------------------------------- |
| API crash           |          24.933 s | Actual stop, changed start time, independent Healer receipt, API reads                                   |
| Video gateway crash |          12.541 s | Actual stop/start, independent receipt, advancing HLS through gateway                                    |
| Active edge failure |          12.691 s | edge-1 → edge-2 live manifest while edge-1 unavailable; peer unchanged; edge-1 restored                  |
| Network timeout     |          19.299 s | Real timeout, OPEN/HALF_OPEN/CLOSED circuit, 7 read attempts, owned toxic removed, restored read at 5 ms |

These durations measure verified restoration, not just fault cleanup or a UI
timer. The independent control plane stayed running throughout all four.

[Healthy baseline](lightweight-demo/baseline.png) ·
[API recovery](lightweight-demo/crash-api.png) ·
[Gateway recovery](lightweight-demo/crash-video-gateway.png) ·
[Edge failover](lightweight-demo/crash-edge.png) ·
[Network recovery](lightweight-demo/network-timeout.png) ·
[Decoded Watch page](lightweight-demo/network-timeout-watch.png)

The intermittent startup-probe timeout is **not established as fixed**. The
failed run lacked a child trace. The new trace makes recurrence diagnosable;
no timeout was increased or failed record rewritten. It does not prevent normal
demo startup or establish a failure in any of the four recovery mechanisms.

Presentation startup smoke run `31dde83a` reached the real healthy baseline on
http://127.0.0.1:5174/control/chaos, decoded progressing live video, injected zero
faults and cleaned 13 containers. Its truthful result is `DEMO_STOPPED`, not a
four-scenario PASS. Windows GUI mode remains unexecuted.

Final run evidence and timing are recorded in `LIGHTWEIGHT_DEMO_MEASUREMENTS.json`.
The startup smoke evidence is in `LIGHTWEIGHT_DEMO_STARTUP.json`. Screenshots in
`lightweight-demo/` are captured from the actual website, not mockups.

## Checks

- `npm test`: 412 tests passed across 38 files.
- `npm run lint`, `npm run typecheck`, `npm run build`: passed.
- `node infrastructure/dynamic/compose.mjs config --quiet` and
  `node infrastructure/chaos/compose.mjs config --quiet`: passed.
- Syntax checks for both runners, formatting and `git diff --check` are included
  in the final handoff verification.
- `npm run test:four-live`: expected **BLOCKED**, exit 2 at the unchanged 8 GiB
  VFS preflight; zero scenarios and zero containers. This is a guard check, not a
  full-suite pass.
- Linux live commands use `PLAYWRIGHT_BROWSERS_PATH=/tmp/ss-four-browsers` only
  to reuse this host's installed Chromium. Code does not depend on that path;
  Windows uses Playwright's standard installed-browser location.

## Limits

The original full telemetry fixture was not run at this disk capacity. No
Grafana/Prometheus, traffic surge, 50K audience or host-failure result is claimed.
Video evidence uses a generated FFmpeg H.264/AAC sample. Real camera/OBS devices,
Windows Docker Desktop GUI operation and production tenant isolation were not
tested. New installations need space for the cached image prerequisites before
the measured compact runtime budget applies. Read attempts are actual circuit
requests since injection, not a count of synthetic UI timer updates.

See [the presentation guide](LIGHTWEIGHT_DEMO.md) for the next startup command,
exact URL, safe stop, verification commands and troubleshooting.
