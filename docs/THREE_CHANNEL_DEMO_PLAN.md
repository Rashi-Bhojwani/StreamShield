# Three-channel demonstration and capacity plan

## Inspected baseline

Phase 7 PR #8 is merged into `feature/phase-4-redundancy-failover` at `5993c65`. `main` does not contain the integrated stack. The dedicated feature branch starts at that verified merge; the initial tree was clean and all 155 baseline tests passed. Existing Express/React/Zod workspaces, PostgreSQL migrations, authenticated MediaMTX callbacks, independent relay/origins/edges, Redis Socket.IO, observer, fenced Healer and six-scenario Chaos Controller remain the foundation. No data reset or prerequisite PR merge is needed.

## Product and data

An explicit `DEMO_ENABLED` mode presents exactly Streamer 1/2/3 through stable `/watch/streamer-1`–`3` routes. Additive tables reference existing users/channels/streams. A transactionally locked CLI seed creates fixed UUID identities idempotently and refuses conflicting legacy names rather than adopting or deleting an account. Legacy deployments retain their existing UI/API behavior with this mode off. Demo discovery filters to the three referenced channels; older records stay intact. Streaming lifecycle/history stays in the existing catalog, with an additive observation history for independent source transitions.

Guest viewing remains public. An HttpOnly session cookie identifies a temporary guest, with a random server-assigned name, bounded expiry, same-origin CSRF and connection/message/IP limits. Guest messages reuse stream-specific rooms, Redis cross-API distribution and PostgreSQL history with an additive nullable guest sender reference. User text remains plain text rendered through React. Redis loss displays degradation and preserves durable catch-up; it cannot promise live Pub/Sub delivery during outage.

Public login/register/profile/Studio screens are absent in demo mode and public account creation/password login is denied server-side. A trusted local CLI issues a one-use, 90-second capability that exchanges for a 15-minute administrator cookie on loopback only. No HTTP endpoint issues that capability. Existing current-role checks, CSRF and privileged network separation remain. Broadcaster provisioning/rotation happens only through the trusted CLI; private files/console output are deliberate operator secrets, never public DTOs or committed artifacts.

## Media and networking

Three unique protected media paths feed the existing relay → primary/standby → edges → HLS player. The new overlay can bind **RTMP only** to an explicitly selected local LAN interface and advertise that IP in private provisioning. Web/API/monitoring/control stay loopback; other laptops need only outbound RTMP access to the host. Default ingest remains loopback. Firewall scope is the trusted LAN/subnet, not internet forwarding. Internet deployment is separately documented with reachable authenticated ingress, TLS/RTMPS/HTTPS, bandwidth and network controls. Three real independent encoded publishers and advancing decoded viewers must verify content and room isolation.

## Capacity architecture and truthful measurements

Use a bounded Node.js harness because the repository already uses the maintained Socket.IO client and k6's raw WebSocket client is not Socket.IO-compatible. Profiles are independent: API HTTP workers, persistent Socket.IO clients, bounded labelled ephemeral synthetic chat, HLS playlist/segment HTTP workers, and a smaller Playwright decoded-browser profile. HTTP worker concurrency is labelled in-flight activity, never connected viewers. Browser frame progress is the only decoded-playback evidence.

An operator creates a finite owned-target run through the trusted CLI. Independent random per-run credentials authorize only generator registration/reporting and synthetic participants, never administrator actions. Durable PostgreSQL run/worker leases cap total distributed allocation and deadlines. Workers report cumulative counters and bounded histograms, server arrival timestamps, active/peak counts, reconnects, delivery confirmation/failure and generator CPU/RSS. Reports reject sequence regression and out-of-allocation counts; stale workers are labelled unknown rather than reporting target as achieved. The dashboard separately shows target, actual workers/requests/sockets/HLS/browser measures, incidents and Healer records, and retains historical runs. Percentiles merge histogram counts rather than averaging worker percentiles.

Local defaults are small; levels support 100/1k/5k/10k/25k/50k with ramps and cooldown. A local generator refuses more than 1,000 clients, insufficient file-descriptor/memory headroom or unacknowledged non-owned targets. Distributed grants permit at most 50,000 allocated clients with per-worker limits; they do not establish achieved capacity. Runs stop on deadlines, signals, resource pressure or sustained errors; missed worker heartbeats remove active certainty. Chat traffic is explicitly synthetic, bounded and not inserted into permanent chat history. Credentials/run files stay ignored. Opening a dashboard never launches traffic.

## Control and faults

Add `/control/capacity` and `/control/three-stream-demo`. The latter combines three actual players, existing health/incident/recovery data, precise load measurements and existing Chaos confirmation/timeline. Reuse the Phase 7 controller without any direct restore operation. Reject fault admission during a stale/unhealthy capacity run or an unverified high-load stage; only bounded, healthy local stages up to 1,000 allocated clients permit interactive faults. Existing observer/Healer prerequisites, cooldowns, start budgets and media guards still apply. No arbitrary target or infrastructure control is added.

## Verification and delivery

Unit/security checks cover mode/gates, short-lived capability consumption, seed conflicts, histogram aggregation, run limits/report sequence/leases, synthetic identity and cross-room enforcement. Integration starts all three sources; checks guest access/no public auth, independent decoded dimensions/content, real guest cross-API delivery/history, guest admin denial, rate rejection and channel isolation. Execute a measured small capacity run against owned endpoints and real faults during bounded load, retaining actual durations/counters and separate browser evidence. Preserve Phase 1–7 jobs with demo mode off; add an isolated demo CI job. Capture/inspect mobile and desktop public/demo/capacity UI. Full local VFS topology may remain storage constrained; clean Linux CI supplies real integration rather than fabricated local success.

Publish measured evidence, Windows/three-device guide, topology/security/limits and screenshots. Commit/push `feature/three-channel-streaming-load-demo`; open `Three-Channel Live Streaming, Guest Chat and Capacity Testing` against the integrated baseline. Do not merge. Platform acceptance and the 50,000-client capacity milestone are reported separately; unachieved capacity is PARTIAL with verified maximum and actual bottlenecks.
