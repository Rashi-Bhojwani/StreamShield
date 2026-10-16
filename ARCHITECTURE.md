# StreamShield architecture

## Phase 1: implemented boundary

An npm workspace contains a React browser application (`apps/web`), an Express API (`services/api`), and small Zod response contracts (`packages/shared`). The browser polls real metadata and readiness using TanStack Query. React Router separates the introduction from the foundation status screen. Vite proxies relative `/api` requests; deployment-specific endpoints are validated configuration. There is no database or external dependency in readiness yet: readiness means this API instance is accepting requests, not that future video delivery works.

The API owns input validation, request IDs, structured logs, HTTP errors and lifecycle state. Liveness tests process responsiveness; readiness returns 503 during startup/draining. No authentication or administrative routes exist in Phase 1. CORS is an exact origin allowlist; it is not authorization. Helmet and bounded bodies protect the foundation, not a complete production security perimeter.

## Future data and media planes (not implemented)

Phase 2 adds OBS → RTMP → MediaMTX → HLS → hls.js. Phase 3 introduces PostgreSQL for durable accounts/streams and Redis for ephemeral presence, chat and bounded rate limits. Stream publishing credentials must be scoped, rotated and kept out of browser logs. Authentication and broadcaster/viewer/admin authorization precede protected management endpoints.

Phase 4 adds Nginx API load balancing and video delivery edges. Standby media requires explicit replication or independent publishing; a second container alone cannot preserve a live source. HLS caching, playlist freshness, origin load, segment bandwidth and player reconnect behavior need separate measurements.

## Future control plane (not implemented)

An independent controller observes probes, playback evidence and metrics, opens incidents and selects bounded, predefined recovery playbooks. Each action has a trigger, evidence, timeout, cooldown, retry budget and verification probe. Restart success never substitutes for user-facing recovery. Recovery permissions must be narrowly scoped; Docker control sockets must never be public. Toxiproxy and authenticated chaos controls introduce isolated faults with expiry and audit records. Prometheus/Grafana complement the product dashboard.

## Configuration and risks

Root `.env` supplies API configuration and Vite configuration; only `VITE_` values enter the browser. Zod rejects invalid hosts, ports, origins, URLs and timing settings. Compose overrides container bind addresses and internal proxy routing; published host ports stay configurable. Local development and Docker use Node 24, strict TypeScript and the same lockfile.

This single API/Vite development topology is not production deployment infrastructure. It has no durable storage, media playback, failover, healing or capacity evidence. The 50,000–60,000 viewer objective is an untested architectural target. API RPS, virtual users, segment consumers and real playing viewers require different tests. Future decisions include authentication/session design, media replication, CDN strategy, controller authority, incident schema and distributed load generation. No unused infrastructure is installed now.
