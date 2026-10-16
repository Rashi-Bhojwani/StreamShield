# Implementation plan

## Phase 1 plan

Use npm workspaces (`apps/web`, `services/api`, `packages/shared`), strict TypeScript and a lockfile. React/Vite provide the web shell; Router handles navigation; Query handles live API state; Tailwind supplies styling integration. Express, Zod, Pino, Helmet and CORS provide the HTTP foundation. Vitest, Testing Library, Supertest and Playwright validate contracts, configuration, behavior and browser connectivity. Compose builds a shared development image and runs only API/web with health checks. Validate build, types, lint, formatting, tests, local startup and Docker startup. See `docs/PHASE_1.md` for actual evidence and limitations.

## Roadmap and acceptance

| Phase            | Dependencies                          | Acceptance                                                                                                   | State                                |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 1 Foundation     | Node 24, npm, optional Docker runtime | Responsive shell, real API connectivity, validated config, lifecycle probes, tests/build, reproducible setup | Complete (local and Docker verified) |
| 2 Live streaming | Phase 1, OBS/FFmpeg/MediaMTX          | Real RTMP ingest and HLS browser playback with source interruption handling                                  | Planned                              |
| 3 Platform       | Phase 2, PostgreSQL/Redis             | Auth/RBAC, scoped publishing credentials, streams, chat, viewer sessions                                     | Planned                              |
| 4 Redundancy     | Phase 3, Nginx, replication design    | Multiple APIs/edges and verified health-aware failover                                                       | Planned                              |
| 5 Monitoring     | Phase 4, metrics/incident schema      | Actual service/video measurements and incident dashboard                                                     | Planned                              |
| 6 Self-healing   | Phase 5, restricted controller        | Bounded playbooks detect, act, verify and audit without manual healing                                       | Planned                              |
| 7 Chaos          | Phase 6, authenticated isolation      | Expiring audited experiments and real recovery evidence                                                      | Planned                              |
| 8 Load           | Phase 7, k6/distributed generators    | Bounded representative API/HLS tests with measured limits                                                    | Planned                              |
| 9 Resilience     | Phase 8                               | Automated before/after recovery and viewer interruption measurements                                         | Planned                              |
| 10 Deployment    | Phase 9                               | Reproducible secure deployment, report and demonstration                                                     | Planned                              |

Future phases must read the architecture and prior handoff, preserve working modules, add regression coverage, and update evidence. Key unresolved decisions: identity/session storage, publishing authorization, media replication, CDN/cache policy, controller privileges and distributed test budget. Do not implement future services as placeholders.
