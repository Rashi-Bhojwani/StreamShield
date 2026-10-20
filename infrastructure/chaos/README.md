# Local chaos composition

Run npm run setup:chaos -- --enable-local-chaos from the repository root, then npm run chaos:up. The generator layers docker-compose.yml, .local/resilience/compose.yml, .local/monitoring/compose.yml, .local/healing/compose.yml and .local/chaos/compose.yml. Generated files and credentials remain ignored by Git. All paths are relative to the repository; no Codex workspace path is required.

The existing web, API, RTMP and HLS public bindings retain their configured loopback addresses. New chaos-controller (4030) and chaos-fault-adapter (4031) listeners are private, configurable and have no published host ports. Only the adapter joins the internal chaos-control network with Toxiproxy and the controller; application APIs cannot resolve the adapter. Only that trusted adapter mounts the Docker socket. A read-only socket bind does not reduce Docker API authority.

The unprivileged controller owns chaos-data. The narrow privileged adapter owns chaos-control-data. Separate credentials, independent WAL/FULL journals and a restricted PostgreSQL audit identity preserve separation from the Healer’s existing fenced start adapter. One-shot setup creates only the additive audit role/schema access and owned journal directory. No reset, volume deletion or automatic storage repair is provided.

Use npm run chaos:probe for live controller/audit/enablement facts and the number of currently admissible scenarios. An active experiment, prerequisite, cooldown or cleanup can legitimately make individual controls unavailable. Use npm run chaos:status to inspect real container state. Use npm run chaos:down to stop the composition while retaining named volumes. Do not run independent fault suites simultaneously against one topology.

Ordinary Windows Docker Desktop uses the normal Compose build/start path. The optional infrastructure/docker/start-healing-cloud.mjs --chaos helper serializes VFS setup jobs, removes only successful completed setup containers, omits unnecessary child-init wrappers for Node-only services and stages Grafana last. The current 32 GB cloud snapshot still exhausts writable storage with the full extended topology; a clean larger environment or clean GitHub CI runner is needed for full tests there. Do not treat cache cleanup or a generated configuration as successful runtime verification. Never delete named data volumes to free space.

See [the Phase 7 handbook](../../docs/PHASE_7.md) for exact Windows setup, OBS/FFmpeg, safety policy, supported/disabled scenarios, measurements, test commands and troubleshooting.
