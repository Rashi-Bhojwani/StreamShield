# Final demo scenarios

The demo injects the same **end state** a real failure would leave (chaos
engineering). The Healer is never told the cause; it only sees what the Observer
measures. Every Healer scenario ends only in a genuine Healer action with an
accepted Docker receipt, followed by independent functional verification.

## Candidate comparison

Scores are 1 (poor) to 3 (strong). "Healability" means a safe, allowlisted
Healer action can genuinely repair the failure.

| Candidate                      | Realism | Significance | Redundancy           | Healability                | Safety           | Visibility                     | Testability              | Reliability      | Decision                                               |
| ------------------------------ | ------- | ------------ | -------------------- | -------------------------- | ---------------- | ------------------------------ | ------------------------ | ---------------- | ------------------------------------------------------ |
| Redis outage                   | 3       | 3            | 1 (single)           | 3                          | 3                | 3 chat breaks                  | 3                        | 3                | **Core 1**                                             |
| Video gateway crash            | 3       | 3            | 1 (single HLS entry) | 3                          | 3                | 3 everyone's video freezes     | 3                        | 3                | **Core 2**                                             |
| Whole API tier crash           | 3       | 3            | 1 (both gone)        | 3                          | 3                | 3 site down, video survives    | 3                        | 3                | **Core 3**                                             |
| Ingest relay crash             | 3       | 3            | 1                    | 3 server only              | 3                | 3 broadcaster drops            | 2 needs client reconnect | 2                | **Core 4**                                             |
| API hang (alive, unresponsive) | 3       | 3            | 2                    | 3 restart                  | 3 peer-guarded   | 2 slowness                     | 3                        | 3                | **Core 5**                                             |
| Traffic surge                  | 3       | 3            | 2                    | 2 scale-out                | 3 bounded, local | 2 latency/meter                | 2                        | 2 host-dependent | **Next priority**                                      |
| Edge crash                     | 3       | 2            | 3                    | 3                          | 3                | 1 invisible; overlay proves it | 3                        | 3                | Selected (failover proof)                              |
| Primary origin crash           | 3       | 2            | 3 standby            | 3                          | 2                | 2 source switch                | 3                        | 2                | Selected (bonus)                                       |
| API-1 crash                    | 3       | 2            | 3                    | 3                          | 3                | 1 invisible                    | 3                        | 3                | Kept (badge proof)                                     |
| Standby origin crash           | 2       | 1            | 1                    | 1 no playbook              | 3                | 1                              | 2                        | 2                | Not selected                                           |
| PostgreSQL outage              | 3       | 3            | 1                    | 1 storage needs review     | 1                | 3                              | 1                        | 1                | **Disabled** (no DB fault or repair authority)         |
| Network latency                | 3       | 2            | –                    | timed cleanup              | 3                | 2                              | 3                        | 3                | Resilience experiment                                  |
| External API outage            | 3       | 2            | –                    | circuit breaker            | 3                | 2                              | 3                        | 3                | Resilience experiment                                  |
| Broadcaster loss               | 3       | 2            | 1                    | 0 cannot recreate a camera | 2                | 3                              | 1                        | 1                | **Disabled** (controller does not own your camera/OBS) |

## Selected scenarios

Measured times for each run are in [SELF_HEALING_RECOVERY_EVIDENCE.md](SELF_HEALING_RECOVERY_EVIDENCE.md).

### 1. Disconnect Redis (chat breaks)

- **Target / fault:** `redis`, SIGKILL.
- **Real-world cause:** memory exhaustion, a host restart or a bad Redis upgrade.
- **User impact:** in both browsers, chat shows _Chat reconnecting…_. Messages stop
  crossing between API-1 and API-2, and the viewer count becomes unavailable.
  **Video keeps playing**: media does not use Redis.
- **Redundancy:** none (single Redis).
- **Observer signal:** `probe_unreachable` on redis. The APIs become DEGRADED, which is a
  dependency symptom shown amber, not an escalation.
- **Diagnosis / playbook:** "Redis is gone: start the stopped container" → `redis-start`.
- **Repair:** `docker_start_accepted`.
- **Verification:** authenticated PING and both APIs ready.
- **Media/chat:** history in PostgreSQL is intact. Pub/Sub messages sent during the outage are not replayed.
- **Guardrails:** PostgreSQL must be healthy, plus budget and cooldown.
- **Escalation:** budget exhausted, verification window exhausted, or OOM.
- **Demo suitability:** excellent. Send a message from Lakshita and watch it fail, then succeed after the repair.

### 2. Crash video gateway (everyone's video freezes)

- **Target / fault:** `video-gateway`, SIGKILL.
- **Real-world cause:** connection exhaustion or a bad configuration reload.
- **User impact:** every viewer's HLS requests fail while the gateway is down. If the
  outage outlasts the player's buffer, the video freezes: the overlay shows _Frozen for N s_,
  then _Resumed after N s_ with no page reload. Measured: one run decoded a 9.1 s gap, but
  in a later run the Healer restored the gateway 3.1 s after the kill, short enough that
  buffering can hide the freeze. The evidence records the failed requests and the longest
  decoded gap rather than assuming a freeze.
- **Redundancy:** none (the single HLS entry point).
- **Observer signal:** `probe_unreachable`.
- **Playbook:** `gateway-start`.
- **Verification:** gateway `/health` plus an authorized HLS playlist and **advancing** segment fetched _through the gateway_.
- **Demo suitability:** excellent and very visible.

### 3. Crash the whole API tier (website down, video survives)

- **Target / fault:** `api-tier` (types `api-tier` to confirm); SIGKILL api-1 **and** api-2 in one experiment.
- **Real-world cause:** a bad deployment, a memory leak or an unhandled crash.
- **User impact:** the site shows _StreamShield can't reach the server — retrying_ with a
  countdown, and chat disconnects. The **live video keeps decoding**, because media and
  application are separate paths. The banner disappears by itself and data reloads.
- **Repair:** `api-start` on api-1, then api-2. One side effect per cycle; two receipts are required before COMPLETED.
- **Verification:** readiness, real reads, and the gateway counters showing each API serving.
- **Guardrails:** budget for both APIs must be available before admission.

### 4. Crash ingest relay (broadcaster drops)

- **Target / fault:** `relay` (MediaMTX), SIGKILL.
- **Real-world cause:** a malformed incoming stream or ingest overload.
- **User impact:**
  - Studio shows _Connection to server lost · reconnecting_.
  - Viewers see _Broadcaster reconnecting…_ or _Video service reconnecting…_.
  - The stream is LIVE again once the broadcaster's client republishes.
- **Repair:** `relay-start` restores the **server**. The **broadcaster client reconnects
  itself** (Studio's same-key auto-republish; OBS's auto-reconnect; the test publisher
  restarts like OBS). This is recorded separately as `broadcaster_client_reconnected`,
  with `sourceRestoredByHealer: false`.
- **Verification:** relay API, plus the RTMP and WHIP listeners accepting connections.
- **Guardrails:**
  - Waits while either API is unhealthy, because MediaMTX authenticates its API through them.
  - A stream that stays without a source for more than `DYNAMIC_SOURCE_GRACE_MS` (8 s)
    _after_ the relay returns is ended by the product. The client must reconnect within that window.

### 5. Freeze API-2 (hung, not crashed)

- **Target / fault:** `api-2`, **SIGTSTP**. The container stays `running`, and Node stops answering.
- **Real-world cause:** a deadlock, an infinite loop or a stuck query.
- **User impact:** about half the requests wait up to the gateway's 10 s read timeout
  before nginx fails over. The latency badge jumps, then returns to normal.
- **Observer signal:** `probe_timeout`.
- **Diagnosis:** "API process alive but unresponsive (probe timeout, container running): bounded restart".
- **Playbook:** `api-restart-unresponsive`.
- **Repair:**
  - The timeout must persist for 10 s with the API tier at normal load (under 15 req/s),
    so surge congestion is never mistaken for a hang.
  - The Healer's own corroborating probe must also time out first.
  - API-1 must be HEALTHY.
  - Then a bounded restart → `docker_restart_accepted` (a new Docker `StartedAt`).
- **Verification:** the same checks as `api-start`, plus readiness answered within 500 ms.
- **Escalation / revision:**
  - A corroborating probe that answers means no action.
  - An unreachable probe revises the diagnosis to `api-start`.
- **Why it matters:** a crash fails fast, but a hang wastes every request's timeout.

### Traffic surge (too many users hit the API)

- **Target:** `api-tier`.
- **Fault:** the chaos controller runs 72 simulated viewers for 60 s against the
  local API gateway only. This is calibrated, see below.
- **Real-world cause:** a flash crowd, bots or a retry storm.
- **User impact:** the load meter rises, p95 latency climbs above 1.2 s, and pages slow down.
- **Repair:** `api-scale-out` starts the pre-provisioned spare API-3 (`docker_start_accepted`).
  "Served by API-3" then appears on real requests. After req/s stays below 50 with
  healthy latency for 60 s, `api-scale-in` stops it (`docker_stop_accepted`).
- **Load shedding:** 429/s is shown separately ("load shedding" is not healing).
- **Escalation:** if the spare is already running and the tier is still overloaded →
  `capacity_exhausted_operator_action_required`. Overloaded APIs are never restarted:
  a readiness timeout under load is refused as `tier_under_load_timeout_not_a_hang`.
- **Calibration on the 4-CPU dev host:**
  - At 0.5 CPU per API the workload was PostgreSQL-bound, and 300 users hit the
    gateway's connection limit. Defaults were therefore set to 0.2 CPU per API and 72 users.
  - **PARTIAL:** with the spare added, throughput rose by about 33%, but p95 fell
    under the threshold only after the load ended. Laptop numbers are demo evidence,
    not a capacity claim.

### 6. Crash video Edge-1 (invisible failover, visible proof)

- **Fault:** SIGKILL `edge-1`.
- **User impact:** video does not freeze. The overlay and the `X-Edge-ID` of real segments show only Edge-2.
- **Repair:** `edge-start`. Edge-1 serves segments again.

### 7. Kill primary origin (bonus)

- **Fault:** SIGKILL `origin-primary`.
- **User impact:** the player may reinitialize on Standby ("Source: Standby").
- **Repair:** `primary-start` runs only after standby media is verified.
  "Retry preferred playback source" returns to Primary.

### Resilience experiments — timed fault cleanup, not Healer repair

`network-timeout` (Toxiproxy latency) and `external-api` (connection resets) on
the simulated recommendation dependency. The fault expires and the circuit
breaker recovers. These are labelled as resilience, never as Healer repairs.

### Disabled, with reasons

- **Database outage:** no database fault or automatic database restoration authority is granted.
- **Broadcaster interruption:** the controller does not own your OBS, camera or FFmpeg process.

## Professor's choice

Stopping any allowlisted container yourself in Docker Desktop (Stop button) or
with `docker kill` leaves it `exited`. The Observer and Healer treat it exactly
like an injected crash: detect, start, verify. `final:watch` shows the new
`StartedAt`. PostgreSQL stays operator-review. Note the budget: at most 2
operations per service per 10 minutes.
