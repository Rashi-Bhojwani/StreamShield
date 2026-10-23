# Known limitations and PARTIAL items

Every item here is a real limit of the final build or of how it was verified.
Nothing below is hidden behind a green dashboard.

## Architecture limits

- **Single Docker host.** Every redundant pair (API-1/2, Edge-1/2, primary and
  standby origin) runs on one machine. Losing the host loses everything; the
  Healer can only repair containers on that host.
- **Single points of failure:** PostgreSQL, the ingest relay, the API gateway,
  the video gateway, Redis and the web server each run once. The Healer repairs
  Redis, the relay and the video gateway. The API gateway and web are not
  Healer-managed. **PostgreSQL is never acted on**: storage faults escalate for
  operator review, and a database outage cannot be injected (disabled on purpose).
- **Camera/OBS loss cannot be healed.** The server cannot recreate a
  broadcaster's source. After a relay repair the broadcast returns only if the
  broadcaster's client reconnects within `DYNAMIC_SOURCE_GRACE_MS` (8 s) of the
  relay coming back; otherwise the product ends the stream. Recorded as
  `broadcaster_client_reconnected`, never as a Healer repair.
- **The relay depends on the API tier for its own control API**, because MediaMTX
  authenticates its API through the APIs. During an API outage the relay looks
  failed. The Healer defers instead of acting, and the topology shows it red
  until the APIs return.
- **A broadcaster cannot (re)connect while both APIs are down.** MediaMTX
  authenticates every publish through the API tier. A broadcast that is
  already live keeps flowing during an API-tier outage, but an OBS/Studio
  client that reconnects inside that outage is refused, and if no source
  returns within `DYNAMIC_SOURCE_GRACE_MS` the product ends the stream. Found
  when the test publisher's 600 s cap happened to land inside the API-tier
  outage; the suite now rotates its publisher just before each experiment.
  The same applies under a traffic surge: publish authentication waits on the
  overloaded API tier.
- **Budgets are deliberate limits.** At most 2 operations per service per 10
  minutes, with a 30 s cooldown. A third failure inside the window escalates
  (purple), and Chaos refuses to inject a fault the Healer could not repair.
  Rehearsals need about 10 minutes between repeats of the same scenario.
- **External network:** the "external API" and "network latency" experiments use
  a simulated dependency behind Toxiproxy; they show timed cleanup and circuit
  breaking, not a Healer repair of a real third party.
- **Pub/Sub chat messages sent during a Redis outage are not replayed.**
  Durable history in PostgreSQL is intact.

## PARTIAL — verified differently or not at all, with the reason

| Item                                                                  | Status                     | Exact reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-browser decoded video in this cloud sandbox                        | PARTIAL                    | The preinstalled Chromium 141 here reports `MediaSource.isTypeSupported('video/mp4; codecs="avc1…"') === false` (no H.264/AAC), and the environment forbids `playwright install`. Decoded progress, stalls and the serving edge were instead measured by the headless viewer (`scripts/final/hls-viewer.mjs`), which fetches through the same web → video gateway → edge path and decodes every segment with ffprobe; it is labelled "ffprobe-decoded". The CI `final` job installs Playwright's own Chromium, which previous CI runs used for real H.264 playback. |
| Studio WHIP auto-republish                                            | PARTIAL                    | Implemented and type/lint/unit-checked, but not executed end to end here: this Chromium has no H.264 encoder for WebRTC either. The relay scenario was verified with the RTMP test publisher, which reconnects itself like OBS.                                                                                                                                                                                                                                                                                                                                     |
| Browser-observed evidence POST (stalls, chat reconnects)              | PARTIAL                    | The endpoint and recorder work, but browser playback stalls were not measurable in this sandbox's Chromium (no decode). Video stalls in the evidence come from the ffprobe viewer.                                                                                                                                                                                                                                                                                                                                                                                  |
| Traffic surge: latency recovered **while load continued**             | PARTIAL                    | On the 4-CPU host, scale-out was detected (about 7 s), executed (`docker_start_accepted`), verified (API-3 served real requests) and scaled in (`docker_stop_accepted`). But p95 fell back under 1.2 s only after the load ended. The spare raised throughput by about 33% because all containers share the same 4 CPUs. Laptop load numbers are demo evidence, not a capacity claim.                                                                                                                                                                               |
| Two rounds in one execution (`FINAL_ROUNDS=2`)                        | Not executed here          | The CI `final` job runs two rounds. Locally each round spends most repair budgets (2 operations per service per 10 min), so a second round waits on budgets; instead six back-to-back single rounds ran (executions 7–12), the last one passing completely.                                                                                                                                                                                                                                                                                                         |
| Peer-probe congestion guard, live                                     | Unit-tested only           | In the passing execution no API timed out during the surge, so the guard that refuses a restart when the healthy peer is slow too was not triggered live. Earlier executions (5, 8, 11) are the live evidence of the problem it fixes.                                                                                                                                                                                                                                                                                                                              |
| Hang repair time                                                      | Trade-off                  | The 10 s hang confirmation plus peer probe make `hang-api` about 10 s slower (Act ≈ 13–14 s, restore ≈ 36–42 s) in exchange for never restarting a congested API.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Surge Socket.IO joins                                                 | Not implemented            | The load generator issues realistic catalogue reads only (stream list + stream detail); it does not open sockets.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Load generator in a dedicated container                               | Deviation                  | The bounded load runs inside the chaos controller (local API gateway only, bounded users and duration, cancellable), not a separate `load-generator` container.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Physical Windows, Docker Desktop, OBS, a physical camera and LAN RTMP | Not executed               | Everything here ran in a Linux cloud container. Windows commands are documented but were not run on Windows in this session.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GitHub PR and CI run                                                  | Not done from this session | This session has read-only access to `Rashi-Bhojwani/StreamShield`: attaching it with push access was refused. Commits exist locally on `feature/final-self-healing-presentation`; push, PR and CI must be done from a session or machine with push access.                                                                                                                                                                                                                                                                                                         |

## Operational notes from development

- After a Docker daemon restart, Healer-managed services (`restart: "no"`) stay
  stopped until `final:up`/`dynamic:up`. If the Healer meanwhile spent its
  budget on them, those attempts are recorded as escalated, which is honest.
- During development, one stale relay incident left by a daemon restart
  (repair escalated on budget) was closed by the operator with an explicit
  `operatorNote` so later detection timings would not be attributed to it.
