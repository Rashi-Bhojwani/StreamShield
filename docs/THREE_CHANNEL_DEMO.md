# Three-channel Live + Control demonstration

This explicit local mode exposes exactly **Streamer 1**, **Streamer 2** and **Streamer 3**, with stable `/watch/streamer-1`, `/watch/streamer-2`, `/watch/streamer-3` routes. Each owns a distinct database identity, channel, media path, publishing key, player presence and chat room. Existing accounts/channels/chat are retained; they are hidden in this simplified mode. No public login, signup or account settings are presented. The original Phase 1–7 deployments remain available with demo mode off.

## Windows PowerShell / VS Code

Install Git, VS Code, Node.js **24**, FFmpeg with H.264/AAC and Chrome. Start Docker Desktop, select Linux containers and allocate at least 4 CPUs, 8 GB RAM and 25 GB free Docker storage. Runtime checks execute on Linux CI; these Windows commands follow the actual repository scripts, not a Windows VM test.

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/feature/three-channel-streaming-load-demo
code .
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:demo -- --enable-local-chaos
node infrastructure/demo/compose.mjs config --quiet
npm.cmd run demo:up
npm.cmd run chaos:probe
```

If the local branch already exists, use `git switch feature/three-channel-streaming-load-demo`. Preserve local changes before switching. This branch starts from the verified integration branch containing merged Phase 7 PR #8, not from an incomplete main. No prerequisite PR is merged automatically.

Setup chains the existing platform, redundancy, monitoring, Healer and Chaos generators; builds the frontend; sets `DEMO_ENABLED=true`, `VITE_DEMO_MODE=true` and disables the legacy publisher. The explicit chaos flag enables only the existing local allowlisted repairs/faults. `demo:up` starts the whole composition and runs the transactionally locked idempotent seed. No account, session, stream or named volume is deleted. A conflicting reserved identity causes a visible error rather than silently adopting a legacy account.

Open **http://127.0.0.1:5173**. Three public cards display actual media availability. Posters are channel artwork, not fake live video. Each Watch page plays real HLS with existing primary/standby and edge failover. Viewers can chat without signing in. The server assigns an HttpOnly session-cookie guest identity; it remains stable in the browser session until expiry (six hours by default). Guests cannot publish, view Control, access infrastructure data or inject faults.

## Private operator access

```powershell
npm.cmd run demo:admin
```

Open the **private URL printed in your own terminal** within 90 seconds. It is a one-use capability, carried in the URL fragment and immediately removed from browser history by the application. The same-origin/CSRF-protected exchange issues a 15-minute HttpOnly administrator session. It is accepted only on the loopback browser host; no HTTP route issues the capability and no default password exists. Do not paste the URL into chat/logs or share it with viewers. Issue a new link after expiry. Current database role checks remain mandatory for every privileged action.

- Three-stream presentation: **http://127.0.0.1:5173/control/three-stream-demo**
- Capacity dashboard: **http://127.0.0.1:5173/control/capacity**
- Full Chaos Lab: **http://127.0.0.1:5173/control/chaos**
- Incidents: **http://127.0.0.1:5173/control/incidents**
- Independent Healer audit: **http://127.0.0.1:5173/control/recoveries**

Opening any of these pages starts no load generator or fault.

## Three independent publishers on this host

New keys are written only into ignored private files `.local/demo/streamer-1.json` through `streamer-3.json`. Only their hashes are stored in PostgreSQL. Files are created with owner-only permissions on POSIX; on Windows restrict the repository/private directory using your account's NTFS permissions and do not put it in a shared folder. If those private files are lost, rotate the affected key rather than attempting to recover a hash.

```powershell
# Private output: show each broadcaster only their own credential.
npm.cmd run demo:provision -- 1
npm.cmd run demo:provision -- 2
npm.cmd run demo:provision -- 3

# Real independent FFmpeg signals, not prerecorded browser animations:
$env:TEST_PUBLISH_DURATION_SECONDS="600"
npm.cmd run broadcast:demo -- all
```

Alternatively run `npm.cmd run broadcast:demo -- 1` (or 2/3) in separate terminals. The sources have different encoded dimensions and audio tones. Stop them with Ctrl+C. The default duration is bounded to 120 seconds unless changed. Do not run these against a channel currently occupied by someone else's OBS publisher.

## OBS from three different laptops on a trusted LAN

On the host, find its intended Wi-Fi/Ethernet IPv4 using `ipconfig`, for example `192.168.1.50`. This is an example address: use the **actual assigned host address**. Run:

```powershell
npm.cmd run demo:down
npm.cmd run setup:demo -- --enable-local-chaos --ingest-host 192.168.1.50
npm.cmd run demo:up
npm.cmd run demo:provision -- 1
npm.cmd run demo:provision -- 2
npm.cmd run demo:provision -- 3
```

The generator verifies that the ingest IP belongs to this host, rejects wildcards and overrides **only RTMP** binding. Web/API, MediaMTX admin APIs, PostgreSQL, Redis, Healer, fault adapters, Prometheus and Control remain private/loopback. Port `MEDIA_RTMP_PORT` defaults to **1935**; `MEDIA_RTMP_PUBLIC_URL` advertises the selected interface. `127.0.0.1` on another laptop would point at that other laptop and cannot reach the host.

Allow inbound TCP 1935 for the trusted private network only. An administrator PowerShell example, adjusted to your actual interface/address/port:

```powershell
New-NetFirewallRule -DisplayName "StreamShield trusted RTMP demo" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 192.168.1.50 -LocalPort 1935 -RemoteAddress LocalSubnet -Profile Private
```

Give Laptop A only Streamer 1's Server/Stream Key, Laptop B only Streamer 2's, and Laptop C only Streamer 3's, over a trusted private channel. In OBS Settings → Stream → Custom, paste those **exact provisioned values**. Use H.264/yuv420p, AAC, two-second keyframes; click Start Streaming. All three may publish simultaneously. Use the host browser to watch the three stable Watch routes or the presentation page. No internet port forwarding is required. This configuration intentionally does not expose the public website/admin application across the LAN; remote viewers need a separately configured safe public ingress.

Rotate one broadcaster only:

```powershell
npm.cmd run demo:provision -- 2 --rotate
```

Rotation revokes the old key before disconnecting only that channel's active RTMP publisher, then installs a fresh independent key. If disconnection fails, it reports that the revoked key's publisher could not be confirmed stopped; stop OBS and retry. Other channels retain their keys and video. Redis/API replicas share the durable publishing authorization.

## Viewing and guest chat

Open separate browser profiles/incognito sessions to obtain independent temporary identities. Pick a channel, watch the actual live source and send a message. Messages belong only to that stream room. Redis distributes events across API replicas; PostgreSQL retains actual guest messages and ordering/history. React renders plain text; there is no HTML chat injection. Message length is 1–1000 characters. Guest/session, shared gateway/IP, connection, join and message limits bound spam. Without account verification, cookie churn/shared-IP abuse cannot be eliminated; this is a trusted demonstration, not public internet moderation at scale.

Redis outages show Degraded/Unavailable, reconnect status and history catch-up. Live Pub/Sub delivery during an outage is not guaranteed. Approximate active-player identities are lease-based browser reports, not unique people or total audience. Synthetic load sockets are excluded from those viewer leases; synthetic messages are visibly labelled and not saved in permanent chat history.

## Capacity tests and failure demonstration

Start a small genuine owned-target run in another terminal:

```powershell
npm.cmd run capacity:run -- --profile api --clients 100 --duration 30 --ramp 5 --authorize-owned-target
npm.cmd run capacity:run -- --profile socket --clients 100 --duration 30 --ramp 5 --authorize-owned-target
npm.cmd run capacity:run -- --profile chat --clients 12 --duration 30 --ramp 5 --chat-per-second 2 --authorize-owned-target
npm.cmd run capacity:run -- --profile hls --clients 6 --duration 30 --ramp 5 --authorize-owned-target
npx.cmd playwright install chromium
npm.cmd run capacity:run -- --profile browser --clients 3 --duration 30 --ramp 5 --authorize-owned-target
```

Run profiles sequentially; one durable run can be active at a time. HTTP concurrency means in-flight requests, Socket.IO means connected synthetic clients, HLS means HTTP requests and only the browser profile verifies decoded frames. The dashboard and run files keep these separate. It never calls HTTP traffic "50,000 viewers". See [capacity protocols, stages, distribution and limitations](CAPACITY_TESTING.md).

For a presentation, prepare all three live sources before the judge arrives. Start a bounded API workload:

```powershell
npm.cmd run capacity:run -- --profile api --clients 100 --duration 240 --ramp 5 --authorize-owned-target
```

Open the three-stream presentation. Wait for a healthy fresh observer/Healer baseline. Configure Crash API-1, inspect disruption, type `api-1`, acknowledge impact and inject once. Follow actual incident → independent Healer action → functional verification while video and real request counters continue. After full restoration try Edge-1 (`edge-1`), primary (`origin-primary`), Redis (`redis`) or network latency (`demo-dependency`). The independent Healer performs repair; the panel never calls a restore endpoint. Timed network cleanup/reconnection is labelled separately from service repair.

Fault admission rejects distributed/high (>1,000 target), stale, unreported or materially erroring load stages. Existing Chaos allowlists, concurrency, cooldown, cleanup, fresh media/standby checks and Healer start budgets remain. Default two starts per service per ten minutes can be exhausted by repeated demos: wait; never erase journals. Database/source interruption controls remain disabled with their existing safety explanations.

## Checks, shutdown and troubleshooting

Stop your own publishers before the integration test; it creates three bounded test publishers and will refuse an already occupied topology.

```powershell
npm.cmd run lint
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run test:demo
npm.cmd run demo:status
npm.cmd run demo:down
```

Ctrl+C stops a load worker or publisher. To revoke a run centrally use `npm.cmd run capacity:stop -- RUN_UUID`. Run files and credentials are private under `.local/demo`; central reports/history remain in PostgreSQL. Shutdown preserves every named volume. Never use `down -v`, volume deletion or a database reset to recover space or bypass a safety policy.

For Docker errors check Desktop/Linux mode and free storage. Host ports default to web **5173**, API **4000**, RTMP **1935**, HLS **8888**, Grafana **3000**. For remote OBS check host LAN IP, private firewall profile/subnet, configured RTMP port, current exact key and codecs. HLS offline/404 requires a genuine publisher; unmute/play may require a browser gesture. A stale status becomes unknown, never a fabricated LIVE flag. Re-run setup and recreate services after `.env` changes. Private files lost after an idempotent seed require explicit per-channel rotation.

To return to an earlier workflow, set `DEMO_ENABLED=false` and `VITE_DEMO_MODE=false` in `.env`, stop the demo composition, then run the appropriate original setup/up commands. Retained user data is still present. Do not run different fault compositions simultaneously against one project.

## Internet and scalability limits

A LAN RTMP binding is not internet access. An internet deployment needs reachable authenticated ingest, TLS/RTMPS where supported, HTTPS playback/websockets, secure cookies, publishing-key transport/rotation, an appropriately configured reverse proxy/CDN, resource limits, egress bandwidth, external storage and network access control. Keep all privileged adapters/control/database endpoints private; the Docker socket remains host-equivalent authority in this trusted local topology.

The repository's single-host gateways, relay, PostgreSQL, Redis and host remain failure/capacity domains. Default Nginx connection limits, file descriptors, media egress, generator memory/CPU and database/Socket.IO work constrain achievable load. No claim of 50,000 decoded viewers or 50,000 achieved clients is made without evidence. See the actual measurement artifact and PR checks for the maximum verified workloads. Three independent publishers are tested with real encoded media; three physical Windows laptops and their firewall were not available for automated execution.
