# StreamShield final system architecture

StreamShield is a live-streaming product (accounts, channels, browser WHIP and
OBS/RTMP publishing, HLS playback, Socket.IO chat) running on a deliberately
redundant local topology, watched by an independent **Observer**, repaired by an
independent **Healer**, and exercised by an administrator-only **Chaos**
controller. This document is grounded in the code on branch
`feature/final-self-healing-presentation`; measured numbers live in
[SELF_HEALING_RECOVERY_EVIDENCE.md](SELF_HEALING_RECOVERY_EVIDENCE.md).

## Topology

```
                          APPLICATION PATH
 Browser ──► web (nginx, React) ──► api-gateway (nginx) ──► api-1 ─┬─► PostgreSQL
                │                                       ├─► api-2 ─┤
                │                                       └─► api-3* ┴─► Redis (Socket.IO bus,
                │                                                         presence, rate limits)
                │                          MEDIA PATH
 Browser camera (WHIP) / OBS (RTMP) ──► ingest relay (MediaMTX) ──► origin-primary ─┬─► edge-1 ─┐
                │                                         └────────► origin-standby ┴─► edge-2 ─┤
                └───────────────────────────── HLS ◄── video-gateway (nginx) ◄──────────────────┘

 observer ── probes every component, persists state transitions and incidents (PostgreSQL)
 healer   ── reads observer frames, diagnoses, acts ONLY through healing-control
 healing-control ── the only container with the Docker socket; allowlisted start/restart/stop
 chaos-controller ─ admin experiments; chaos-fault-adapter injects allowlisted faults only
 Prometheus / Grafana / exporters ── metrics; toxiproxy + dependency-demo ── resilience demo
 * api-3 is a pre-provisioned spare: created stopped, started/stopped only by the Healer
```

All generated configuration lives in the ignored `.local/` directory
(`setup:dynamic` → chaos → healing → monitoring → resilience → platform/media).

## Failover versus self-healing

| Mechanism               | What it does                                                      | Who does it                                                                                            | Example                                                                                                            |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Failover**            | Keeps serving through a redundant peer while one instance is down | nginx upstreams (`max_fails=1`, `fail_timeout=5s`, `proxy_next_upstream`), the player's standby source | Edge-1 dies → the video gateway uses Edge-2; API-1 dies → the gateway uses API-2                                   |
| **Self-healing**        | Restores the failed component itself and proves it works          | The Healer, through `healing-control`                                                                  | The Healer starts Edge-1 and verifies authorized, advancing HLS segments through it                                |
| **Client reconnection** | A client re-establishes its own session                           | Browser player/chat, Studio WHIP, OBS                                                                  | Studio republishes after the relay returns. Recorded as `broadcaster_client_reconnected`, never as a Healer repair |
| **Timed fault cleanup** | A temporary injected fault expires                                | chaos-fault-adapter                                                                                    | Toxiproxy latency removed after 15 s. Labelled "timed fault cleanup, not Healer repair"                            |

## Detection (Observer)

- Probes every target every 2 s with a 1 s timeout and confirms after 2
  consecutive failures (unchanged thresholds).
- **Distinguishes the symptom** (`monitoring/policy.ts`):
  - `probe_timeout`: the request was accepted but no answer came (a hung process).
  - `probe_unreachable`: refused, DNS gone, reset, or a connect-phase timeout (a dead process).
  - `probe_denied`: the observer's own authority was rejected.
- **Logical `api-tier` component** derived from Prometheus: p95, 5xx %, req/s and 429/s.
  It is overloaded after 3 consecutive samples above `OBS_OVERLOAD_P95_MS` (1,200 ms) or 5% 5xx.
  Individual APIs are never marked unhealthy just because they are slow.
- **A stopped spare** reads `spare_standby` and is excluded from health baselines.
- **History:** every thresholded state transition is appended to `monitoring_state_changes`.
  The observer has insert/select rights only, and transitions are buffered across database loss.

## Diagnosis and repair (Healer)

`selectPlaybook(component, failureCode)` chooses by component **and** symptom:

| Playbook                                                 | Services                               | Symptom              | Action                                                 | Receipt                   |
| -------------------------------------------------------- | -------------------------------------- | -------------------- | ------------------------------------------------------ | ------------------------- |
| `api-start`                                              | api-1, api-2                           | unreachable / http   | start an exited container                              | `docker_start_accepted`   |
| `api-restart-unresponsive`                               | api-1, api-2                           | `probe_timeout`      | bounded restart (SIGTERM, 3 s, SIGKILL, start)         | `docker_restart_accepted` |
| `redis-start`                                            | redis                                  | unreachable          | start                                                  | `docker_start_accepted`   |
| `gateway-start`                                          | video-gateway                          | unreachable          | start                                                  | `docker_start_accepted`   |
| `relay-start`                                            | relay (MediaMTX)                       | unreachable          | start                                                  | `docker_start_accepted`   |
| `edge-start`                                             | edge-1, edge-2                         | unreachable          | start                                                  | `docker_start_accepted`   |
| `primary-start`                                          | origin-primary                         | unreachable          | start after verified standby                           | `docker_start_accepted`   |
| `api-scale-out`                                          | api-tier → api-3                       | `overloaded`         | start the spare                                        | `docker_start_accepted`   |
| `api-scale-in`                                           | api-tier → api-3                       | normal load for 60 s | bounded stop of the spare only (SIGTERM, 3 s, SIGKILL) | `docker_stop_accepted`    |
| `dependency-reconnect`, `database-review`, `source-wait` | demo dependency, postgres, broadcaster | —                    | circuit probe / escalate / wait                        | —                         |

**Guardrails**, all unit-tested:

- **Freshness and dependencies:**
  - Confirmed, fresh evidence only.
  - Dependencies must be healthy. The relay waits for both APIs, because MediaMTX authenticates its own API through them.
- **Restart rules:**
  - The peer API must be HEALTHY before any restart, so the last serving instance is never restarted.
  - No restart while the API tier is overloaded or carries real load
    (`HEALER_HANG_MAX_RPS`, 15 req/s): a timeout under load is congestion, not a hang
    (`tier_under_load_timeout_not_a_hang`), and scale-out owns that symptom.
  - The timeout must persist for `HEALER_HANG_CONFIRM_MS` (10 s) first
    (`hang_unconfirmed_wait`). A hang persists; the lagging tier rate catches
    up with surge congestion within that window.
  - Before restarting, the Healer runs its own **corroborating probe**, which must also time out:
    - if it answers, nothing is done;
    - if it is unreachable, the diagnosis is revised to `api-start`.
- **Budgets and identity:**
  - One side effect per cycle, while verification of other attempts continues every cycle.
  - One open attempt per component: a flapping signal joins the open attempt instead of opening another.
  - Rolling budget of 2 operations per service per 10 minutes, shared by start, restart and stop.
  - 30 s cooldown.
  - Attempt identity is never replayed, including after an ambiguous outcome.
- **Escalation:**
  - Verification windows with bounded retries, then escalation.
  - OOM-killed containers escalate.
  - A surge with the spare already running escalates as `capacity_exhausted_operator_action_required`.
- **Postgres and broadcasters:**
  - PostgreSQL is never acted on.
  - A broadcaster's source is never recreated.

**Verification** is functional, never "the container is running":

| Target         | What must be proven                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API            | Readiness, real catalogue reads, and gateway counters showing the repaired API (and its healthy peer) serving. A restart must also answer within 500 ms. |
| Gateway        | Authorized HLS playlist and advancing segment, fetched **through** the gateway.                                                                          |
| Relay          | Relay API, plus the RTMP and WHIP listeners accepting connections.                                                                                       |
| Edge / primary | Advancing segments on every live path.                                                                                                                   |
| Redis          | Authenticated PING and both APIs ready.                                                                                                                  |
| Scale-out      | The spare serves through the gateway and tier p95 is back under the threshold.                                                                           |

The adapter (`healing-control`) exposes only the following, each bound to the
lease, the epoch and the attempt identity:

- `POST /v1/start`
- `POST /v1/restart` (api-1 and api-2 only; `running`, non-OOM)
- `POST /v1/stop` (spare only)
- `GET /v1/inspect/:service` and `GET /v1/budgets` (read-only)

## Fault injection (Chaos)

- Admin, CSRF, typed confirmation, one experiment at a time, durable journal.
- **Never injects a fault the Healer cannot currently repair:** each target needs available budget, and a surge needs two operations (scale-out and scale-in).
- The fault adapter can only:
  - SIGKILL these allowlisted targets: api-1, api-2, edge-1, origin-primary, redis, video-gateway, relay;
  - **SIGTSTP** api-2. tini (PID 1) ignores SIGSTOP for its child; SIGTSTP stops Node while Docker still reports `running`. This was verified empirically.
- There is no start, restart, unpause or SIGCONT on the fault side.
- The traffic surge is generated by the controller itself:
  - local API gateway only, bounded users and duration, cancellable;
  - its end is recorded as `LOAD_ENDED`, not as a repair.

## What the audience sees (visible proof layer)

- `X-Served-By` (API) and `X-Edge-ID` (edges, passed through the video gateway)
  on real responses. Controlled by `EXPOSE_SERVING_INSTANCE`, off in production.
- The footer badge reads "Served by API-n · N ms". An outage banner with a retry
  countdown appears only when no API answers, and data reloads by itself.
- The chat label shows Reconnecting / Connected / Delivered.
- The player's **Stream health** overlay shows the serving edge, primary/standby source,
  segment number, buffer and a live "Frozen for N s / Resumed after N s" timer.
- Studio auto-republishes on the same key after an ingest drop (8 bounded attempts).
- `/control/presentation` shows video, the SVG topology, the experiment console,
  stages lit only by stored timestamps, metric tiles, the load meter and the health band.
  `/control/presentation/report` is printable.
- `/control/analysis` shows the band, swimlanes, shaded impact charts,
  before/during/after tables and a scorecard.
- In the terminal: `npm run final:watch` and `npm run final:healer-log`.

## Defects found and fixed while building the final version

| Area            | Defect                                                                                                             | Fix                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Player          | Retry budget (3) never reset after recovery; a 13 s gateway outage ended in "Retry playback"                       | Reset on decoded progress; live limit 12                            |
| Chat            | 5 reconnect attempts (~17 s) gave up before an API-tier repair                                                     | Bounded backoff, limit 30, clear states                             |
| Browser timeout | 5 s browser timeout < 10 s gateway failover budget: the browser gave up before nginx failed over from a hung API   | 12 s (timeouts now nest)                                            |
| Studio          | A dropped ingest connection called `end()` and stopped the broadcast permanently                                   | Same-key bounded auto-republish                                     |
| Healer          | A VERIFYING attempt consumed the one-operation slot, starving the second failed API (tier repair ~81 s)            | One side effect per cycle; reads every cycle                        |
| Healer          | API verification required both APIs serving even when the peer was down                                            | Peer required only when healthy                                     |
| Healer          | Relay looked failed during API outages (auth through APIs) and was escalated                                       | Relay depends on both APIs; dependency check before symptom refusal |
| Chaos           | Could inject a fault the Healer had no budget to repair (left API-2 down)                                          | Budget-gated admission                                              |
| Video gateway   | Hid `X-Edge-ID`, so the serving edge was invisible                                                                 | Passed through when serving-instance exposure is on                 |
| Healer          | Under the surge, API-1's readiness timed out from congestion and was restarted twice                               | No restart while the tier is under load; 10 s hang confirmation     |
| Healer          | Scale-in escalated as ambiguous: API-3 ignored SIGTERM for 10 s, longer than the 5 s action timeout                | Spare stop uses the bounded 3 s grace                               |
| Healer          | A flapping tier signal opened a second scale-out while the first was verifying; it escalated as capacity exhausted | One open attempt per component                                      |
| Metrics         | 429 load shedding counted only as 4xx; p95 interpolated between 1 s and 2.5 s                                      | Dedicated counter; finer buckets                                    |

## What works, what is partial

See [FINAL_TEST_RESULTS.md](FINAL_TEST_RESULTS.md) for every command and
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for every PARTIAL item with its reason.
