# StreamShield

**Self-healing live streaming, built on verifiable foundations.**

Phase 1 provides a responsive React shell and a working Express API. It does **not** broadcast video, authenticate users, measure viewers or recover infrastructure. The roadmap in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) covers these later phases. See [ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and risks and [docs/PHASE_1.md](docs/PHASE_1.md) for validation evidence.

## Prerequisites

- Node.js 24.x and npm 11+ (Node 24 is enforced).
- Docker Engine and Docker Compose v2 for container development (optional for local npm).
- Registry access to registry.npmjs.org; Docker additionally needs Docker Hub image registry access.

## Local development

From the repository root:

```sh
cp .env.example .env # first time only; preserve an existing .env
npm ci
npm run dev
```

The safe example defaults expose web at port 5173 and API at port 4000 on loopback. Read the startup output for your configured addresses. Vite forwards `/api` to `API_PROXY_TARGET`. Open the web application in your local browser, then choose **Foundation** to verify readiness and metadata. No credentials are needed in Phase 1. If npm's cache is unwritable, prefix installation with `npm_config_cache=/workspace/.npm-cache` (or another writable directory).

`.env` is ignored. API settings are loaded by Node from the root file; Vite loads it via `envDir`. All required fields are documented in `.env.example`. `API_HOST`/`WEB_HOST` control binding, ports control listeners, `CORS_ORIGINS` is an exact comma-separated origin allowlist (no trailing slashes), and request/shutdown/browser timings are bounded by Zod. `VITE_API_BASE_URL` is a relative API prefix or an HTTP(S) base URL; only public settings may use `VITE_`. Vite settings are build-time values: restart/rebuild after changes. For remote environments bind hosts deliberately and configure the actual allowed frontend origin. Do not expose development servers publicly as a production deployment.

## Docker development

```sh
cp .env.example .env # only if absent
# npm is not required on the host for this workflow
docker compose config --quiet
docker compose up --build --wait
docker compose ps
docker compose logs api web
docker compose down
```

Only API and web run. Source directories are read-only mounts with hot reload; dependency installation is baked into the image from the lockfile. Rebuild after changing dependencies or tooling. Containers bind internally to all interfaces; published host ports bind to `BIND_ADDRESS` (loopback by default). The internal web proxy uses the Compose API service name. Web health checks both the HTML response and proxied API readiness. No database, persistent volume, privileged mode or Docker socket mount is required. `docker compose down` stops only this Compose project. The image uses the supported Node 24 line; rebuilds may pick up newer patches, while npm dependencies remain lockfile-pinned.

## Verification

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
# While npm run dev OR Docker services are running:
npx playwright install chromium
E2E_BASE_URL=http://127.0.0.1:5173 npm run test:e2e
```

Set `E2E_BASE_URL` to your configured web origin. Browser tests verify real backend connectivity, explicit HTTP failure/retry, navigation, mobile overflow and browser errors. Screenshots and traces are ignored outputs under `test-results/`. If a system Chromium is already installed, set `PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium` instead of downloading a browser. Unit tests use explicitly mocked fetch responses; browser connectivity uses the actual API. CI is provided but a remote run is not implied.

Build outputs are `apps/web/dist` and `services/api/dist`. The API bundle runs with `npm start -w @streamshield/api`. The shared package exports source contracts, bundled by Vite/tsup. Production hosting of static assets, API routing, TLS and deployment orchestration are not part of Phase 1. Do not serve Vite's development process as production.

### HTTP probes

With the default local settings:

```sh
curl -i http://127.0.0.1:4000/api/v1/health/live
curl -i http://127.0.0.1:4000/api/v1/health/ready
curl -i http://127.0.0.1:4000/api/v1/system/info
curl -i http://127.0.0.1:5173/api/v1/health/ready
```

Use your configured ports if changed. Liveness means the process can answer; readiness means it is accepting work. Before listening and while draining, readiness is false (503 when a request can still be served). With no external dependencies yet, this does not prove future media health. API SIGINT/SIGTERM marks it unready, stops accepting connections and drains requests to the configured deadline. Forced deadline expiry exits nonzero.

## Troubleshooting

- **Invalid configuration:** startup names rejected fields; copy missing defaults from `.env.example`, then restart. Do not put secret values into logs or commits.
- **Port already in use:** stop your own previous instance or choose new API/web ports, update CORS and the local proxy target together. Vite deliberately fails instead of silently changing port.
- **API unavailable:** inspect API logs, call readiness directly, then check the Vite proxy and browser API prefix. A green indicator appears only after valid metadata and readiness responses. Failed refreshes remove the healthy claim.
- **CORS:** use an exact browser origin. CORS is not authentication and cannot protect future administration endpoints.
- **Docker image pull/build:** verify Docker daemon access and required registry connectivity. Never disable TLS or signature/checksum verification to bypass errors.
- **Browser binaries:** install Chromium with Playwright; Linux may need `npx playwright install --with-deps chromium` where system package installation is permitted.

## Next phase

Phase 2 should add configurable MediaMTX/RTMP/HLS, OBS/FFmpeg instructions and an hls.js player with genuine source/playback checks. Reuse the current configuration, contracts, API lifecycle and design components. Do not add chat, authentication, self-healing or fabricated telemetry in that phase.

### Restricted cloud filesystem/network notes

This cloud environment has a read-only home directory. Use `npm_config_cache=/workspace/.npm-cache` for npm and `DOCKER_CONFIG=/workspace/.docker-client` for Docker commands here. On a proxy-based network, use the optional helper to forward predefined proxy build arguments, resolve the proxy hostname for the build network, and mount the injected CA as a BuildKit secret:

```sh
DOCKER_CONFIG=/workspace/.docker-client node infrastructure/docker/build-cloud.mjs
DOCKER_CONFIG=/workspace/.docker-client docker compose up --wait
```

The helper reads existing proxy and CA bindings without logging their values. The CA is mounted only for installation, and TLS/package integrity verification stays enabled. Proxy URLs and credentials must never be committed or printed. Browser downloads may require a network allowlist addition for Playwright's CDN; the provided system Chromium avoids that download in this instance.
