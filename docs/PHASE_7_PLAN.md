# Phase 7 plan: controlled faults, independent recovery

## Verified baseline

PR #7 merged Phase 6 into feature/phase-4-redundancy-failover at c7655cc. Its tree contains the verified Phase 1–6 implementation; main does not. Phase 7 branches from this integrated head without rewriting history or merging prerequisite PRs. Baseline: 125 unit tests pass; current Healer probe reports fifteen healthy components/thirteen healthy scrapes, an active independent leader and database access. Existing real-media, authenticated chat, incident and recovery measurements/docs were inspected.

## Capabilities and supported scope

The Phase 5 observer confirms actual service failures. Phase 6 independently starts stopped allowlisted APIs, edges, primary and Redis, verifies real requests/media and persists incidents/recovery attempts. It supports safe read reconnection and a real circuit around the simulated recommendation dependency. These mechanisms operate without React. Existing Phase 4 routing/player failover remains a separate continuity mechanism.

Enable six fully implemented experiments: crash API-1, Edge-1, primary, Redis; recommendation-connection latency; simulated external API connection reset. Media scenarios require an actual live source, healthy standby/peer and progressing HLS. Database outage stays visibly disabled because the database playbook requires operator storage review and this release does not grant database fault/restore authority. Broadcast interruption stays disabled because no publisher lifecycle belongs to the controller: it must not terminate a user's OBS/camera. Do not add a working-looking unsupported button.

## Architecture and permissions

Add a separate unprivileged Chaos Controller and a narrow privileged Chaos Fault Adapter, with distinct credentials and private networks. Only the adapter has a Docker socket. It accepts a strict scenario/experiment UUID, discovers the project's uniquely labelled allowlisted container and issues only a fixed SIGKILL. It has no service start, shell, exec, create, delete-container or volume operation. Toxiproxy operations affect only a named experiment-owned toxic on the existing recommendation-demo proxy. No arbitrary target/address/command is accepted.

The independent Healer is the only component that executes service repair. The Chaos Controller observes Healer audit records and independently verifies behavior; it never calls the Healer's privileged adapter. Timed toxic removal is explicitly fault cleanup, not service repair. Socket mount read-only does not reduce Docker authority; the fault adapter remains trusted host-equivalent local infrastructure.

## Admission and durable lifecycle

Default disabled; require development, loopback deployment and explicit local chaos opt-in. Validate allowed scenarios, fault duration, experiment deadline, one concurrent experiment, cooldown, rolling administrator limits, probe deadlines, retention and private listeners. Every API mutation uses current administrator session authorization plus exact Origin/CSRF validation. The browser confirms the exact target and disruption. UUID idempotency survives an API-1 response lost during injection.

Persist CREATED, VALIDATING, INJECTING, FAULT_CONFIRMED, AWAITING_DETECTION, HEALING_OBSERVED, VERIFYING and terminal COMPLETED/FAILED/TIMED_OUT/CANCELLED states with actual times, actor, fault receipt, incident/recovery IDs, mechanism and cleanup status. SQLite WAL journals survive process/PG interruption; PostgreSQL confirms durable shared history through an additive restricted-role migration. Local acceptance is labelled separately from PostgreSQL confirmation. One durable active slot, request identity and adapter receipts prevent overlap/replay across API replicas and restarts. Persist ambiguous intent before effects; never automatically repeat an uncertain kill.

Temporary faults have an independently persisted adapter expiry and retryable cleanup, even if the browser/controller disappears. A failed cleanup is visible, blocks new experiments and survives restart. Cancellation removes only the owned toxic; it cannot undo an already accepted crash and never starts a service. Terminal results distinguish unresolved infrastructure, timed cleanup, client reconnection, preexisting routing and actual Healer actions.

## User experience and events

Add /control/chaos (six scenario cards plus explained disabled cases, exact-target confirmation, current execution and durable history) and /control/demo (real reusable HLS player with stream selector, actual playback observations, compact live topology and experiments). Preserve consumer streaming UI. Reduce redundant overview chrome on these focused workspaces. Reuse Phase 5 topology, highlighting actual experiment targets alongside authoritative service health; no animated traffic without measurement.

Extend monitoring:v1 with chaos_changed, emitted only after PostgreSQL persistence. Existing fresh administrator socket delivery remains. Query invalidation plus periodic REST reconciles reconnect/browser refresh. Current state is backend-owned, not a decorative timer. During unavailable authorization/telemetry, display unknown and deny injection.

## Verification and measurements

Read original incident detection/action/verification times; record fault request/confirmation, cleanup and independent experiment verification separately. Measure detection, healing-start, action and restoration durations with explicit definitions. Server verification is not decoded browser playback; retain separate real browser monotonic frame/time samples and player observations. Unknown measurements remain null. Single-run numbers are not availability guarantees.

Unit tests cover gates, invalid inputs, lifecycle, admission, UUID identity, persistence/restart, cooldown, timeout, ambiguous injection and failed cleanup. Real integration uses the same authenticated API as the UI, two owned FFmpeg sources, actual container stops and Toxiproxy faults, actual independent Healer receipts, HLS progression/decoded frames, cross-instance durable chat and incident correlation. Test anonymous/ordinary users, CSRF, invalid target, duplicate/concurrent requests, observer/Healer unavailability, cancellation, process restart, browser refresh and realtime resynchronization. No manual restoration satisfies a service-healing assertion. Cleanup removes only experiment-owned faults/fixtures.

Preserve Phase 1–6 regression suites in their original separate deployments. Run build/type/lint/format/unit and quiet Compose checks. Capture and inspect 375/768/1280/1440/1920 screenshots and real split-screen playback. Use staged cloud VFS startup to retain data and build headroom. Do not run simultaneous fault suites or target an existing outside broadcaster.

## Delivery

Create PHASE_7.md and real PHASE_7_MEASUREMENTS.json, update architecture/README/roadmap/env and CI, document Windows Docker Desktop setup and a five-minute judge demonstration. Push feature/phase-7-chaos-control-center, create the real PR against the verified containing branch and leave it open. Report actual checks and remaining limitations. Phase 8 may reuse explicit scenario/measurement contracts for separately authorized bounded load generators; no large-scale traffic simulation is implemented here.
