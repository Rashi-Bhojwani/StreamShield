# Phase 6 implementation plan

Baseline: Phase 5 `393c7dffc0be24b5fbc1ae875ab6240a9a7234f5`, open PR #6. Its six GitHub jobs, fourteen-component live probe and 98 unit tests passed before implementation. Phase 6 branches from that head and targets the Phase 5 branch. Preserve the prerequisite PR stack and all existing data volumes.

## Existing system and missing capability

Two Express APIs share PostgreSQL sessions/chat and Redis distribution. Nginx routes API traffic and two HLS edges. An authenticated relay feeds independent primary/standby MediaMTX packagers. Phase 4 routing and player source switching already mitigate individual failures, but do not repair stopped services. Phase 5 independently observes fourteen components, samples real media, persists deduplicated incidents/events and exposes administrator-only snapshots and Control. Component restoration and browser playback are distinct signals.

## Controller and authority

Add a separately deployed TypeScript Healer, with modules for policy/playbooks, orchestration, verification, audit journal, metrics and a narrow Docker HTTP adapter. Only the adapter mounts the Docker socket. Its private dedicated network, independent bearer credential, fixed Compose project/service mapping, request validation and hardcoded inspect/start endpoints forbid arbitrary names, commands, exec, deletes, volume manipulation or migrations. A read-only socket mount is not a Docker permission boundary: the adapter is explicitly trusted privileged code, and socket compromise remains host-equivalent. Never expose this service publicly. Privileged recovery defaults disabled; a loopback-development setup flag explicitly enables it.

The adapter grants a durable expiring leader lease with fencing epochs and serializes allowlisted actions. Its separate SQLite journal enforces action idempotency, rolling service budgets and cooldown even if PostgreSQL is down. It starts only stopped/exited containers; a live-but-unreachable container is not blindly restarted. Container creation/recreation is unsupported and escalates. Persist the operation before the Docker request; ambiguous results are inspected/reconciled, never blindly replayed.

Node 24's built-in SQLite is maintained but release-candidate stability; document and test this choice. Local named volumes retain WAL journals. The Healer journal records attempts before effects and synchronizes them to additive PostgreSQL tables when available. Local acceptance is explicitly separate from PostgreSQL persistence. A single adapter/shared local volume is the deployment coordination boundary, not multi-host consensus. Expired leaders cannot authorize new actions. An interrupted attempt resumes verification or escalates without another start.

## Policy and playbooks

Use an explicit typed, versioned registry with eligibility, dependency guards, bounded action/verification windows, maximum attempts, exponential backoff with jitter, cooldown, compensation and escalation policy. Confirmed fresh Phase 5 incidents are inputs; no browser connection is required. Invalid credentials, unknown/stale observations, failed dependencies and unavailable control authority prohibit repair. PostgreSQL failure suppresses API restarts. Global action concurrency is one; the adapter also imposes per-service limits across incidents/restarts.

- API repair: preserve the peer, start only the failed API, verify liveness/readiness, real stream metadata and gateway routing to both instances.
- Edge repair: preserve the healthy edge, start the failed edge and verify actual authorized HLS manifests, nonempty latest segments and segment progression for every currently sampled publishing path.
- Primary repair: require healthy relay/standby and fresh standby media, start primary only, verify both dynamic paths and progressing segments. Preserve sticky standby player policy; no forced failback.
- Redis repair: start only stopped Redis, independently verify authenticated PING and both APIs ready; integration verifies cross-instance sockets and durable chat.
- PostgreSQL: deliberately escalate for operator storage review; no automatic database starts, resets or migrations. Independent local audit and adapter coordination remain available; synchronize the observed incident/attempt after storage returns.
- Network/external demo: introduce a clearly labelled read-only simulated recommendation dependency behind pinned private Toxiproxy. Use bounded safe-read reconnect attempts and a CLOSED/OPEN/HALF_OPEN circuit breaker with recovery probes, explicit degraded fallback and measured transitions. No money operations. Fault removal restores the network, while reconnection/probing is autonomous.
- Broadcaster interruption: corroborate missing previously observed source with healthy relay/origins, record an unresolved source incident and escalate without restarting origins. Continue observing authorized reconnection, verify fresh media and record the external source's return honestly. The controller cannot recreate camera video.

## Audit, incidents and UI

Add recovery attempts/events and a restricted verification table through a forward migration. Preserve original incident timestamps and Phase 5 history. Store diagnosis, playbook/version, actor, attempt number, action/verification timing, outcomes, sanitized evidence and escalation reason. Correlate each attempt with its original incident; delayed database persistence remains visible. Gate Phase 5 resolution while an attached repair is unverified. Do not invent ACTION_TAKEN events for observation-only cases.

Expose administrator-only read APIs under existing monitoring authorization and versioned recovery invalidations using the existing Socket.IO session/role checks. Reconnect reads authoritative snapshots. Add a full-width recovery page, real counts and measured durations, incident-linked attempt timelines and service recovery states. No chaos buttons or decorative recovery timers. Prometheus collects bounded-label attempt/outcome counters, timing histograms, active/escalated counts and breaker state/rejections. Grafana gets real recovery panels.

## Validation and rollback

Unit-test registry/policy, dependency suppression, lease/fencing, idempotency, attempt limits, cooldowns, crash reconciliation, circuit states and metrics. Run real API/edge/primary/Redis crashes with Docker restart policies disabled for managed services; never use manual restoration to satisfy autonomous-repair assertions. Use two independently owned FFmpeg broadcasts, advancing decoded browser frames, authenticated sessions and chat sockets on separate APIs. Inject bounded Toxiproxy network faults and stop the demo dependency to verify breaker fallback/probes. Verify PostgreSQL safe escalation, source interruption/reconnection, unavailable observer/control authority and Healer restart. Record injection, observation, action and verification clocks separately. Cleanup may restore deliberately unrecoverable faults, labelled as cleanup.

Retain Phase 1–5 static, unit, platform, browser, media, resilience and monitoring suites with Healer disabled outside its dedicated composition. Inspect screenshots at 375/768/1280/1440/1920px. Validate Compose and repeatable setup, scan for actual secret values, and preserve named volumes. Document Windows Docker Desktop commands, permissions, safety policy, failed experiments and measured results. Rollback stops the optional healing composition without deleting volumes, then restarts the monitoring-only composition; additive audit migrations remain.

Phase 7 receives authenticated read contracts, incident/attempt correlation and a bounded CLI test harness. It must add its own audited, expiring fault authorization; Phase 6 exposes no fault injection HTTP endpoint.

## Official research

- Docker Engine v28.4 API specification: https://github.com/moby/moby/blob/v28.4.0/api/swagger.yaml (container discovery, inspect, start, response codes and bounded calls).
- Docker socket authority: https://docs.docker.com/engine/security/protect-access/ . An HTTP allowlist limits this adapter's behavior, not the socket's inherent permissions.
- Node 24 SQLite: https://nodejs.org/docs/latest-v24.x/api/sqlite.html (transactions, prepared statements, release-candidate stability).
- PostgreSQL locks: https://www.postgresql.org/docs/17/explicit-locking.html . Database locks cannot coordinate database-outage recovery.
- Node AbortSignal deadlines: https://nodejs.org/docs/latest-v24.x/api/globals.html .
- Toxiproxy maintained release: https://github.com/Shopify/toxiproxy/releases/tag/v2.13.0 ; private HTTP API/toxic management and version-pinned image used by tests only.
