# Implementation plan

## Phase 1 plan

Use npm workspaces (`apps/web`, `services/api`, `packages/shared`), strict TypeScript and a lockfile. React/Vite provide the web shell; Router handles navigation; Query handles live API state; Tailwind supplies styling integration. Express, Zod, Pino, Helmet and CORS provide the HTTP foundation. Vitest, Testing Library, Supertest and Playwright validate contracts, configuration, behavior and browser connectivity. Compose builds a shared development image and runs only API/web with health checks. Validate build, types, lint, formatting, tests, local startup and Docker startup. See `docs/PHASE_1.md` for actual evidence and limitations.

## Roadmap and acceptance

| Phase            | Dependencies                          | Acceptance                                                                                                   | State                                            |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 1 Foundation     | Node 24, npm, optional Docker runtime | Responsive shell, real API connectivity, validated config, lifecycle probes, tests/build, reproducible setup | Complete (local and Docker verified)             |
| 2 Live streaming | Phase 1, OBS/FFmpeg/MediaMTX          | Real RTMP ingest and HLS browser playback with source interruption handling                                  | Complete (real RTMP/HLS/browser verified)        |
| 3 Platform       | Phase 2, PostgreSQL/Redis             | Auth/RBAC, scoped publishing credentials, streams, chat, viewer sessions                                     | Complete (two independent live streams verified) |
| 4 Redundancy     | Phase 3, Nginx, replication design    | Multiple APIs/edges and verified health-aware failover                                                       | Planned                                          |
| 5 Monitoring     | Phase 4, metrics/incident schema      | Actual service/video measurements and incident dashboard                                                     | Planned                                          |
| 6 Self-healing   | Phase 5, restricted controller        | Bounded playbooks detect, act, verify and audit without manual healing                                       | Planned                                          |
| 7 Chaos          | Phase 6, authenticated isolation      | Expiring audited experiments and real recovery evidence                                                      | Planned                                          |
| 8 Load           | Phase 7, k6/distributed generators    | Bounded representative API/HLS tests with measured limits                                                    | Planned                                          |
| 9 Resilience     | Phase 8                               | Automated before/after recovery and viewer interruption measurements                                         | Planned                                          |
| 10 Deployment    | Phase 9                               | Reproducible secure deployment, report and demonstration                                                     | Planned                                          |

Future phases must read the architecture and prior handoff, preserve working modules, add regression coverage, and update evidence. Key unresolved decisions: media replication, CDN/cache policy, controller privileges and distributed test budget. Phase 3 establishes durable identity/session storage and scoped publishing authorization. Do not implement future services as placeholders.

## Phase 2 completion

See [the implementation plan](docs/PHASE_2_PLAN.md), [official references](docs/PHASE_2_REFERENCES.md) and [actual verification/handoff](docs/PHASE_2.md). The current work adds real authenticated RTMP ingest, fMP4 HLS, browser playback, availability observations and bounded reconnect. It does not introduce Phase 3 identity/storage/chat or later redundancy/healing/chaos services.

Phase 1 is preserved in initial baseline commit `387cc57`. Remote `main` preserves that baseline and the completed Phase 2 implementation. Phase 2 was delivered on `feature/phase-2-live-streaming` through PR #1, subsequently merged by the user.

## UI/product correction after Phase 2

Phase 2 PR #1 was merged into main before this work. The dedicated `feature/streamshield-platform-ui-redesign` branch replaces the technical landing page with full-width consumer discovery and Watch, separates the future Control product, centralizes visual primitives, and retains the real media pipeline. Verification includes responsive screenshots, search/navigation, API recovery and real decoded RTMP/HLS playback. No Phase 3 backend capabilities are introduced. See [UI redesign](docs/UI_REDESIGN.md).

## Combined Phase 2 completion

The requested `feature/phase-2-live-streaming` branch now fast-forwards through current main and the existing UI redesign commit, preserving both histories. Add typed local player events/metrics, a separate developer route and two-viewer media regression, then publish a new combined PR with the requested Phase 2 engine-and-platform title. PR #1 remains the merged engine delivery; PR #2 remains the unmodified earlier UI review. No PR is automatically merged. Phase 3 should retain the verified media path, UI primitives and observation callback while adding real authenticated product capabilities.

## Phase 3 authenticated platform

Implemented on feature/phase-3-streaming-platform, stacked on the verified Phase 2 PR #3 head while that PR is open. Scope: PostgreSQL migrations and durable accounts/sessions/channels/streams/chat; Argon2id and HttpOnly revocable sessions with Origin/CSRF; server ownership/roles; per-stream MediaMTX publishing authorization and key revocation; Redis-backed Socket.IO chat, bounded history and actual player-driven approximate presence; responsive account/channel/Studio/chat UI.

Verification preserves Phase 1/2 tests and adds isolated real DB/Redis/independent-API checks, actual account/browser flows and two independent authenticated FFmpeg/HLS decoded streams, rotation/end, persistence and dependency degradation. Commands/results and remaining limitations are in [PHASE_3.md](docs/PHASE_3.md). The PR targets feature/phase-2-live-streaming until the owner merges #3, then can be reconciled with a normal main merge and retargeted.

Phase 4 should add deployment redundancy, Nginx media edges and standby origins using these validated session/ownership/chat/media boundaries. No replicas, healing/chaos controllers or audience-capacity claim is included in Phase 3.
