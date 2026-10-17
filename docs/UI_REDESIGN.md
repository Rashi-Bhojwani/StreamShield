# StreamShield Live product redesign

## Assessment and scope

The Phase 2 homepage was a technical introduction: a 1320px maximum width, roadmap and health cards dominated discovery, and small uppercase metadata reduced readability. This correction preserves the RTMP → MediaMTX → HLS → browser architecture and existing API contracts. It introduces no backend changes, dependencies, simulated broadcasters or metrics.

## Product boundaries

StreamShield Live is the consumer application. Home offers a real live preview when the API verifies a source, otherwise an explicit offline presentation. Live lists verified broadcasts and configured channels. Search filters actual channel titles and IDs. Explore honestly explains that category metadata is not yet available. Watch prioritizes a 16:9 player, stream information below it, and an explicitly unavailable chat panel beside it on desktop.

Accounts, Following, Broadcaster Studio and Control Center are disabled and marked as future functionality. `/control` is a separate product notice, not an operations dashboard or authorization implementation. Future monitoring, incidents, chaos testing and recovery belong in the authorized StreamShield Control product.

The existing health checks live under `/diagnostics`; `/foundation` redirects there. Watch diagnostics are collapsed by default and fetch API health only when expanded. Source availability remains distinct from successful browser decoding. A failed refresh labels the source unknown without interrupting already running playback.

## Layout and reusable foundations

The full-width top bar combines product identity, consumer navigation and functional search. A 232px sidebar gives way to a keyboard-accessible drawer below 1100px. Content expands with the viewport rather than inheriting the old marketing width cap. Watch uses the remaining space for video plus chat; chat stacks below on smaller screens.

`styles.css` centralizes color, typography, spacing, borders and surfaces. Shared Brand, Icon, StatusBadge and ConnectionStatus components support consistent future pages. The normal interface uses readable 14–16px text, clear heading hierarchy, visible focus, sufficiently large actions and reduced-motion support. No external imagery or invented thumbnails are used. Neutral cover art explicitly states that a channel preview is unavailable.

## Verification and screenshots

Browser regression covers 375, 768, 1280, 1440, 1680 and 1920px: Home, search to a real configured channel, offline Watch, collapsed diagnostics, unavailable chat, category notice, no horizontal overflow and desktop content width. Mobile tests check drawer opening, Escape and focus restoration. API outage and retry are retained. Media integration verifies real authenticated RTMP, HLS segment delivery, decoded frames and progressing playback, native 16:9 video at every width, a real Home preview, source stop/return and origin outage reporting.

Committed before/after desktop and mobile screenshots are in `docs/images/ui-*`. They show the actual application; live screenshots show the FFmpeg test publisher, not a claimed creator broadcast. Other tested viewport captures remain runner artifacts.

## Actual validation results

- `npm test`: 57 tests passed across five files.
- `npm run test:e2e`: consumer layout/navigation and API recovery passed at all six documented widths.
- `npm run test:media`: passed; 108 decoded frames observed before progressing playback, source stop/return and origin outage checks.
- Typecheck, ESLint, production build and formatting checks passed. Vite retains the existing advisory about chunks above 500kB.
- Docker services remained healthy after integration cleanup; Compose service and media wiring were preserved.

## Windows / VS Code

Install Git, Node.js 24, Docker Desktop with Linux containers and FFmpeg on PATH. Start Docker Desktop, then in a VS Code PowerShell terminal:

```powershell
git clone https://github.com/Rashi-Bhojwani/StreamShield.git
cd StreamShield
git fetch origin
git checkout feature/streamshield-platform-ui-redesign
npm.cmd ci
Copy-Item .env.example .env
npm.cmd run setup:media
docker compose up --build --wait
```

Open `http://localhost:5173`. In a second terminal run `npm.cmd run broadcast:test`, then use Home or `/watch/live` (the default `MEDIA_STREAM_PATH`). Stop the publisher with Ctrl+C. OBS configuration is unchanged: Custom service, server `rtmp://localhost:1935`, stream key `live?user=<MEDIA_PUBLISH_USER>&pass=<MEDIA_PUBLISH_PASSWORD>` using your local `.env` values. Use H.264 video and AAC audio. Never share the resulting credential-bearing stream key. Changed ports and paths must agree with `.env`; see the README for full configuration.

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd test
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run test:media
docker compose down
```

Run browser tests with services up and no broadcaster active; media integration manages its own publisher. If Docker is unreachable, start Docker Desktop and check Linux-container mode. For occupied ports, stop conflicting services or update the documented port variables. If FFmpeg is missing, reopen VS Code after adding it to PATH. For offline playback check OBS credentials/path and H.264/AAC, then `docker compose ps` and service logs. Browser autoplay begins muted; use native controls for sound. HLS startup can take several seconds. Control, chat and accounts remain unavailable by design.
