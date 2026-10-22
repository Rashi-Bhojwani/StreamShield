# StreamShield 2.0: dynamic accounts and broadcasting

This mode replaces the fixed three-channel public experience with registered users and independently owned channels. It does not delete the earlier demo or its data. There is **one channel per account and one concurrently prepared/publishing dynamic session per channel**, with no three-user/channel platform cap. Create a new broadcast session after ending the previous one. Public viewing is available without login; chat and publishing require a current authenticated account. Email verification, password reset, uploaded avatars, recording and CDN delivery are outside this release; profiles support persistent display names and colored initial avatars.

## Windows / VS Code

Install Git, VS Code, Node.js **24**, Chrome/Edge, FFmpeg with H.264/AAC and Docker Desktop. Start Docker Desktop from the Windows Start menu, select **Linux containers**, wait until running, and allow at least 4 CPUs / 8 GB RAM / 25 GB free Docker storage. Commands below use PowerShell. Do not run a competing `npm run dev` process on the Docker frontend port.

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git switch --track origin/feature/dynamic-multi-user-livestreaming
code .
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:dynamic -- --enable-local-chaos
node infrastructure/dynamic/compose.mjs config --quiet
npm.cmd run dynamic:up
npm.cmd run chaos:probe
```

If the branch already exists, use `git switch feature/dynamic-multi-user-livestreaming`. Stop the previous composition first and preserve local changes. Setup preserves existing secrets and named volumes, enables `DYNAMIC_ENABLED` / `VITE_DYNAMIC_MODE`, disables fixed demo/legacy publishing and generates an ignored private composition. It creates **no shared accounts**. No cloud workspace path is required. The UI is already built and served by Docker.

Open **http://127.0.0.1:5173/signup**. Register with a unique username/email and password of at least 12 characters. In Studio create your channel, then create a livestream with a title/category. Another browser profile/incognito session can register a different account at the same URL.

## Browser camera and screen publishing

In Studio, open a non-ended broadcast. Select **Preview camera**, grant camera and microphone permissions, select devices and preview again after changing selectors. The local preview is private. The microphone meter shows actual captured samples; the mute button changes the outgoing audio track. **Share screen** uses the browser's screen chooser with microphone audio; system/tab audio mixing is not implemented.

Press **Start Live** to negotiate a genuine H.264/Opus WebRTC publisher using WHIP. The application shows connection/publishing state while the backend independently confirms increasing media bytes and HLS availability. Only verified broadcasts enter Live Streams. Open its exact Watch link in another account to verify video/audio and authenticated chat. Muted playback may require clicking Play/Unmute for sound.

**End Live** closes the publishing session and revokes the channel's credential. Navigating away closes capture/WHIP; unexpected source loss passes through CONNECTION_LOST and a bounded grace before ENDED. Creating/rotating a key alone never marks LIVE. Browser codec, ICE, permission or device errors remain explicit. If your browser lacks the required H.264 encoder or compatible HLS Opus playback, use supported Chrome/Edge or OBS; MediaMTX does not transcode automatically.

Browser capture requires localhost or HTTPS. The generated local deployment advertises loopback ICE on UDP/TCP **8189** (`BROWSER_ICE_PORT`) and proxies WHIP signaling from `/ingest/.../whip` to private port **8889** (`BROWSER_WHIP_PORT`). MediaMTX control APIs remain private. Camera/screen use from another machine requires a separately engineered HTTPS/ICE/TURN deployment; changing the RTMP LAN IP does not create that deployment.

## OBS and trusted LAN devices

Studio's **Create publishing key** / **Rotate publishing key** returns that stream's Server and masked Stream Key once. Reveal/copy only in private. OBS Settings → Stream → Custom: paste the exact Server and Stream Key; encode H.264/yuv420p, AAC audio and two-second keyframes. Start Streaming. Media uses that user's independent random path and exact Watch route. Rotation revokes and disconnects only the matching RTMP/WebRTC publisher; other channels continue.

For another laptop, run `ipconfig` on the host and use its actual assigned LAN IPv4. Example only:

```powershell
npm.cmd run dynamic:down
npm.cmd run setup:dynamic -- --enable-local-chaos --ingest-host 192.168.1.50
npm.cmd run dynamic:up
```

Allow TCP **1935** (`MEDIA_RTMP_PORT`) only from the trusted Windows Private subnet. An administrator PowerShell example, after replacing the address:

```powershell
New-NetFirewallRule -DisplayName "StreamShield trusted RTMP" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 192.168.1.50 -LocalPort 1935 -RemoteAddress LocalSubnet -Profile Private
```

Issue a new private key in each owner's Studio and copy only that owner's values to their OBS device. Never use localhost as the remote laptop's destination. RTMP is cleartext and intended only for the trusted LAN in this setup. Web/admin/database/Redis/control listeners remain loopback/private; do not publish them or forward router ports. Internet deployments require TLS, appropriate ingress, secure cookies and network policy.

## Watching, live discovery and chat

Home, Live Streams and Explore show verified broadcasts with creator identity, category, labelled channel artwork and approximate active-player sessions. Search/categories operate against the backend before pagination. Socket.IO invalidations update connected feeds automatically; initial/reconnected/periodic REST snapshots remain authoritative. Stale or unreachable media observations do not manufacture LIVE status.

Watch uses the exact stream's HLS path through the existing origin/edge pipeline. Every channel has an isolated chat room. Messages require authentication, shared throttling and validation; PostgreSQL stores history, Redis distributes across API replicas, and the browser suppresses duplicates. Owners/admins can remove messages or block/allow an account in that channel. Moderation never grants infrastructure privileges. Pub/Sub can lose transient deliveries during outages; history reconciliation restores durable messages. Live sessions, active players, sockets and synthetic clients remain separate metrics, not human-audience guarantees.

## Administrator and healing demonstration

Register your own account first. Grant it an administrator role only from the trusted local terminal:

```powershell
node infrastructure/dynamic/compose.mjs exec -T api-2 node scripts/set-role.mjs YOUR_USERNAME administrator
```

Refresh your account, then open `/control/chaos`, `/control/incidents` and `/control/recoveries`. Keep multiple genuine publishers active and wait for fresh healthy observer/standby/Healer admission. Configure a supported API/edge/primary/Redis/dependency fault, type its exact target and acknowledge impact. Follow real fault confirmation → incident detection → independent Healer attempt → functional verification. Wait for full recovery before another experiment. The UI never repairs services; timed network cleanup is distinguished from autonomous repair. Existing cooldown, concurrency and start budgets remain enforced. An absent physical broadcaster is not recoverable by restarting a container.

## Tests and shutdown

Stop your own publishers before integration tests; the test creates random accounts, channels and real media sources. Test-created accounts/audit history remain durable, clearly named test data; it does not reset users or volumes.

```powershell
npm.cmd run lint
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run test:dynamic
npm.cmd run dynamic:status
npm.cmd run dynamic:down
```

The dynamic test exercises three distinct FFmpeg broadcasters and a fourth independently registered browser camera publisher, remote decoded video, authenticated chat/history/moderation, ownership boundaries, source stop, automatic feed changes and real independent fault recovery. Synthetic Chromium camera/audio verifies the transport, not a physical webcam or operating-system screen chooser. Browser and OBS/FFmpeg evidence must be reported separately. Previous seven CI jobs retain earlier phase coverage.

Stop your load workers and external publishers with Ctrl+C. Shutdown retains named volumes; never add `-v` or delete journals/databases. Existing capacity tooling and its separate historical demo mode remain available; do not run different compositions simultaneously. The 50K target remains unverified and is not launched by opening a page. See [capacity documentation](CAPACITY_TESTING.md).

## Troubleshooting and limits

- Docker: confirm Linux-container mode, free storage and no existing composition competing for ports 5173/4000/1935/8888/3000/8189. Re-run setup and recreate services after environment changes.
- Camera: use localhost, grant camera/microphone permissions and close other applications holding devices. Device choices apply when Preview camera is restarted. Screen audio is microphone-only.
- Browser connection: check host UDP/TCP 8189 and local firewall/VPN. There is no configured TURN service or general remote-browser support. Inspect explicit negotiation/codec errors; do not replace them with a false live badge.
- OBS: check actual LAN address, Private firewall scope, current exact credential and H.264/AAC. A rotated or ended credential cannot publish again.
- Live feed: it requires observed publisher progress and delivery. A draft, local preview, stale observation or failed encoder does not qualify. REST automatically reconciles missed websocket invalidations.
- Chat: expired sessions, rate limits and bans produce visible errors. Redis disruption can interrupt live delivery without stopping independent media.
- Healing: wait for healthy fresh peers and full verification; exhausted cooldown/start budgets must expire naturally. Never erase audit state to bypass admission.

The free self-hosted software stack does not make machines, bandwidth or public hosting free. Single-host relay/gateways/PostgreSQL/Redis remain failure domains. There is no recording, adaptive-bitrate transcoding, CDN, host-level HA or claimed 50K capacity in this release. Actual test measurements and screenshots will be attached to this feature's PR after execution.
