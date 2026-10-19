# Phase 4 implementation plan

## Verified baseline

PRs #3 and #4 are open. The clean Phase 3 head is 482a929; 64 existing tests pass. Branch feature/phase-4-redundancy-failover from that fetched head, targeting feature/phase-3-streaming-platform. Preserve history, PostgreSQL volume, shared contracts, ownership and existing browser/media tests. Do not merge dependencies or force-push.

## Architecture and failure domains

Keep the lightweight Phase 3 Compose default. Add a generated, validated optional resilience overlay: two independent APIs sharing PostgreSQL/Redis, an Nginx API gateway, two Nginx HLS edges, a video gateway, an authenticated MediaMTX ingest relay and primary/standby MediaMTX packagers. Existing web remains the viewer entry. Video never passes through Express. Gateway, relay, frontend, PostgreSQL, Redis and Docker host remain explicit single points of failure; this is service redundancy on one host.

## Routing and API recovery

Use Nginx Open Source passive upstream failure handling, short connect/read deadlines, bounded next-upstream attempts and fail_timeout re-admission. Do not claim active health checks. Never enable non_idempotent retries on public API requests. The private read-only media-auth callback may safely retry its POST. Generate request IDs at the trusted gateway and preserve them only through an explicitly configured trusted application boundary. Private Basic-authenticated instance diagnostics identify serving processes/sockets; no public topology/test endpoints. WebSocket-only Socket.IO preserves the supported Phase 3 Redis adapter and avoids polling stickiness requirements. Each API has a bounded pool; document aggregate pool use.

## Media replication

OBS/FFmpeg continue publishing a unique authorized stream/key to a stable relay RTMP endpoint. Both origins pull the same dynamic path over private authenticated RTSP/TCP using MediaMTX supported regex capture substitution and sourceOnDemand. A relay runOnAvailable hook continuously warms both HLS endpoints while the publisher is available, so both origins receive genuine video before failover and a restored origin reconnects. This hook supplies media, not a general service-healing controller. Origin RTMP/RTSP publishing is disabled; no shared broadcaster key replaces ownership. Relay RTSP reads require a separate replication secret plus current ready/owned stream authorization. Rotation/end still revoke and disconnect the relay publisher, removing supply to both origins.

## HLS edges and player failover

Use ordinary fMP4 HLS. Public source URLs distinguish primary/standby; each edge maps a source prefix to exactly one origin. Retry an edge request through the other edge without mixing origin timelines. Never cache playlists or error responses. Cache immutable media objects briefly with size/inactivity bounds and origin-prefixed keys. Strip application cookies/Authorization, use the supported MediaMTX HLS CDN mode with a separate private edge credential, preserve relative redirects, configure exact CORS and media content types. Source switching destroys/reinitializes HLS with a bounded existing retry budget; stay on a working standby to avoid flapping. Explicit preferred-source retry permits failback. Record source selection, detected failure, reinitialization and actual progression; assigning a URL is not recovery.

## Security and topology configuration

Generate ignored private configs from .env.example and validated topology settings. No Docker socket in application services, no public PostgreSQL/Redis/origin/control/auth ports. API-2 is private; retain local compatibility entry ports. Use pinned maintained images and reproducible setup preserving existing secrets/data. Do not print credentials or resolved Compose config. No schema reset or unnecessary schema migration is needed.

## Validation and measurements

Run all Phase 1–3 static, unit, isolated platform, browser and real media regressions. Add meaningful unit coverage for source selection/configuration, a bounded local resilience integration runner and browser decoding after controlled API/edge/origin crashes. Register two disposable owners and streams through real APIs; verify both origins carry both paths and distinct decoded resolutions. Verify round-robin HTTP outcomes, sessions, actual separate-instance chat, reconnect/history, no duplicated persistence, independent rooms, invalid replication/publisher rejection and key revoke/end.

Measure injection/detection/traffic/playback/infrastructure restoration separately using monotonic durations and UTC timestamps. Capture request errors, successful routes, browser frame/time progress, stalls and recovery deadlines. Restore only test-owned processes/services, stop publishers and remove only known test fixtures; never delete volumes. Inspect screenshots at 375/768/1280/1440/1920 and keep the existing consumer design.

## Resources, limitations and handoff

Use stream copy between relay/origins, bounded caches and pools; recommend Docker Desktop with 4 CPUs and 6–8GB allocated RAM for the optional topology. Actual usage and recovery timings must come from measured tests, not a promised 30-second objective. Source restarts change HLS timelines, requiring player reinitialization. Live supply cannot be recreated after broadcaster/relay failure. No host/region redundancy, durable Redis transport, monitoring dashboard, Healer or Chaos Panel is introduced. Phase 5 can consume structured instance logs, HTTP routing timing, source-selection/playback events and JSON experiment artifacts.

## Official references inspected

- Nginx upstream/passive failure: https://nginx.org/en/docs/http/ngx_http_upstream_module.html
- Nginx retries/cache/WebSocket proxy directives: https://nginx.org/en/docs/http/ngx_http_proxy_module.html and https://nginx.org/en/docs/http/websocket.html
- MediaMTX 1.21.2 configuration and regex static-source restrictions: https://github.com/bluenviron/mediamtx/blob/v1.21.2/mediamtx.yml and https://github.com/bluenviron/mediamtx/blob/v1.21.2/internal/conf/path.go
- hls.js API/lifecycle: https://github.com/video-dev/hls.js/blob/master/docs/API.md
- Socket.IO maintained Redis adapter/transport constraints: https://github.com/socketio/socket.io-redis-adapter
- node-postgres pool sizing: https://node-postgres.com/features/pooling
- Compose merge/override semantics: https://docs.docker.com/reference/compose-file/merge/
