# Phase 5 implementation plan

## Assessment and baseline

Verified Phase 4 acc467579fdd803e06fde9682759faea3682b13e, 71 unit tests, twelve healthy services and successful push/PR CI runs 39278203324/39278239637. PRs 3–5 remain open; Phase 5 branches from that commit and targets feature/phase-4-redundancy-failover. Existing source, migrations, request logging, Socket.IO session/CSRF checks, player events and resilience suite were inspected. Preserve PostgreSQL volumes and lightweight Compose.

## Topology and signals

Existing web → API gateway → API1/API2 → PostgreSQL/Redis; video gateway → edge1/edge2 → primary/standby ← RTSP ← RTMP relay. Add independent Node observer, Prometheus, Grafana and maintained Nginx/Redis/PostgreSQL exporters. Never mount Docker sockets. APIs expose authenticated private official Prometheus JS client metrics; MediaMTX exposes private built-in metrics; Nginx private stub_status supplies supported connection/request counters only. No unsupported upstream status/cache hit claims. Process CPU/RSS/event loop cover Node; host/container resource collection is unavailable without additional host privileges.

Observer inventories validated deployment targets. Bounded HTTP probes, direct SELECT 1 and authenticated Redis PING establish availability. API readiness failure with live process is DEGRADED. Private MediaMTX paths plus sampled HLS playlists/latest segments independently establish media supply. No publisher is an idle state, not an outage. Browser progress observations are untrusted client evidence, never infrastructure recovery proof.

## Observer and incidents

Standalone lifecycle independent of API/browser. Defaults: 2s service interval with jitter, 1s request deadlines, concurrency four, two consecutive failures, two successes, initial warm-up, separate slower media cycle. UNKNOWN on denied/invalid observations, stale telemetry or observer failure. HEALTHY/DEGRADED/UNHEALTHY are explicit. RECOVERING only after observed restoration pending verification. Redundancy aggregate is degraded when one peer fails and unhealthy only when all peers fail; shared dependencies can independently render platform unhealthy.

Transactional PostgreSQL component snapshots, singleton heartbeat and incidents/events. Partial unique index deduplicates active component/failure identities. First failing UTC observation and confirmation are distinct. Detection delay uses monotonic time within process; restart-spanning durations use UTC with explicit assumption. DETECTED → DIAGNOSED; first successful probe records SERVICE_RESTORED; thresholded consecutive success records RECOVERY_VERIFIED → RESOLVED. No action-taken events. Unresolved incidents reconcile after restart. Persistence outage is explicit; bounded latest-per-component state, no unlimited journal. Resolved evidence retained 90 days; unresolved never pruned. Warm-up suppresses startup storms; coordinated shutdown may still create truthful incidents; stop observer first for maintenance.

## Delivery and UI

Admin-only existing-session REST snapshot, paginated/filterable incidents/details and fixed allowlisted PromQL charts. No arbitrary query proxy. Observer publishes versioned invalidation events on namespaced Redis; APIs recheck admin session before local delivery. REST is authoritative after connect/reconnect and sequence changes; fallback periodic reconciliation handles lost Pub/Sub. Stale observer heartbeat turns displayed component states UNKNOWN, never old green. DB outage can deny session validation; UI explicitly unavailable.

Full-width separate Control shell: overview, SVG metric charts, accurate keyboard-clickable layered topology/dependencies, service detail, incident history/detail. Existing Live untouched. Read-only historical experiments linked as historical documentation, never live telemetry. Responsive 375/768/1280/1440/1920 screenshots must be captured and inspected.

## Configuration, security and budgets

Validated OBS_* interval/deadline/concurrency/threshold/stale/retention/range settings; generated service secret and Grafana password in ignored private files, not VITE variables. Prometheus private network only; Grafana loopback login required, no anonymous access. Exporters private; scrape database identity restricted to pg_monitor with separate password. Bounded Prometheus disk/time retention and container memory limits. No credentials/URLs/user identifiers in metric labels or diagnostic evidence. Admin promotion through existing privileged account:role CLI.

## Verification and limitations

Unit policy/config/duration/metric tests; actual Docker scrape/provisioning checks; admin/ordinary/anonymous HTTP and socket authorization; actual API/edge/origin failure and recovery incidents, observer restart deduplication, PostgreSQL/Redis degradation, stale/reconnect browser behavior. Retain all Phase 1–4 suites including actual decoded FFmpeg video. Run types/lint/format/build, Compose validation, startup repeatability and secret scan. Document actual results, failures and unverified Windows/OBS/Safari. Single host/shared DB/Redis/gateways/relay remain failure domains. Polling precision and hysteresis are not injection timestamps. Browser client reports cannot prove global audience health.

## Phase 6 boundary

Versioned monitoring invalidation envelope, immutable incident ID/events and service inventory are read-only interfaces for a future separately authorized controller. Phase 5 performs probes, diagnosis and verification only. Future actions need their own audit/schema/idempotency/authority/timeouts; no Docker management HTTP or interactive fault buttons now.

## Official research

Reviewed Prometheus configuration/retention, Grafana provisioning, Nginx stub_status/exporter, maintained client_js defaults/histograms, postgres_exporter pg_monitor, redis_exporter authentication and Socket.IO server rooms/events. MediaMTX and Prometheus documentation websites returned HTTP 403 in this environment; use official repository docs/config for those sources. Exact pinned versions and URLs/results are recorded in PHASE_5.md after deployment verification.
