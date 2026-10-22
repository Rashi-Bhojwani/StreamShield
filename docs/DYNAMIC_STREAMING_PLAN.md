# Dynamic multi-user streaming implementation plan

## Baseline and scope

Base: `79e9658`, merged PR #9 on `feature/phase-4-redundancy-failover`. Its ancestor `83e3a42` passed all seven CI jobs; the inspected working tree was clean and 174 baseline tests passed locally. Work belongs on `feature/dynamic-multi-user-livestreaming`. Existing fixed-channel demo and capacity evidence remain preserved as optional historical modes; the new default setup enables public accounts and never seeds shared broadcaster identities.

Reuse Argon2id/PostgreSQL sessions, CSRF/origin validation, one owned channel per account, independent random stream paths/keys, authenticated Socket.IO/Redis chat, durable history, hls.js/native playback, Nginx redundancy, observer, independent Healer and restricted Chaos adapters. Extend through additive migrations and an explicit dynamic mode so Phase 1–7 regression compositions remain testable.

## Product and UI

Vimeo's live-streaming page was fetched and rendered, and web research checked MediaMTX publishing/authentication/HLS, hls.js, browser autoplay, Prometheus and Toxiproxy. Adapt its clear headline, large media surface, restrained accent and simple primary actions to a functional application, rather than copying a marketing page or its paid features.

Public navigation: Home, Live Streams, Explore, My Channel, Go Live and Account. Dynamic discovery has working category/search filters, creator identity, genuine status, labelled avatar/poster artwork, watch actions and useful empty/error states. Studio preserves channel/session/history management and adds actual camera/screen publishing with microphone/device controls. Operational controls remain administrator-only. Capture and inspect 375/768/1280/1440/1920px layouts.

## Media and browser compatibility

OBS/FFmpeg → authenticated RTMP relay → primary/standby MediaMTX packagers → redundant HLS edges → browser. Browser camera/screen → RTCPeerConnection/WHIP → the same authorized relay path → the same delivery pipeline. SDP negotiation is proxied separately from Express; actual media uses ICE/DTLS-SRTP directly, not HTTP upload or local preview substitution.

Enable WHIP only in the new generated composition. Keep its signaling same-origin and its MediaMTX administrative listener private. Expose explicit loopback UDP/TCP ICE ports with a configured advertised address. Use owner-issued per-stream credentials in authorization headers, never URL query/logs. Validate WHIP resource Locations before PATCH/DELETE. Prefer H.264 video and Opus audio, check actual negotiated tracks and browser HLS codec support, and verify both emitted media and remote decoded playback. MediaMTX remuxes rather than transcodes: unsupported codec combinations must fail visibly. If a bridge/transcode proves necessary, document and implement it explicitly rather than claiming compatibility. LAN OBS uses a validated assigned interface; browser camera/screen remains on localhost secure context unless separately configured HTTPS/ICE/TURN is provided. No paid service is required; hosting/egress costs are not claimed free.

## Authoritative lifecycle and discovery

Add category/avatar metadata, indexed durable broadcast states, source progress/grace evidence and lifecycle history. Retain existing draft/ready/ended fields for compatibility. New session states: CREATED, PREPARING, PUBLISHING, LIVE, CONNECTION_LOST, RECONNECTING, ENDING, ENDED, FAILED. Key issuance/start intent cannot assert LIVE. Publisher presence, increasing received media and valid delivery must confirm it. Source loss becomes non-live immediately and expires after a bounded grace; metadata/control outages display unknown rather than inventing offline or live.

A bounded background observer polls active dynamic sessions independently of dashboard requests. Shared PostgreSQL leases/conditional updates prevent duplicate cross-API transitions. Publish typed versioned discovery invalidations over the existing Redis Socket.IO adapter; clients reconcile through authoritative REST after connection/reconnection and periodically. Filter live discovery before pagination; prevent older drafts from hiding active streams. Keep exact stream/path/watch/chat ownership association.

## Security and data

Preserve secure password hashing, duplicate validation, session expiration/logout/revocation and shared auth/write/chat limits. No registration-selected privileges, hidden accounts or public administrative endpoints. Publishing and editing require current owner role checks; revoke before disconnecting RTMP/WebRTC publishers. One active session per channel is enforced transactionally in dynamic mode; independent channels are unlimited subject to resources. Add owner/admin moderation with durable deletion and room-scoped invalidation, safe plain-text rendering and reconnect catch-up. Do not expose credentials, email, infrastructure state or session tokens in public DTOs.

## Setup and verification

Add `setup:dynamic`, `dynamic:up/down/status` and `test:dynamic`, layering on the existing Chaos/Healer composition without deleting volumes or running a competing dev server. Defaults disable demo/legacy publishing and enable dynamic mode. Document Windows PowerShell, registration/channel creation, browser secure-context/device permission errors, OBS/LAN, exact ports/configuration, safe shutdown and private administrator promotion.

Keep seven original CI jobs. Add a dynamic job: register three random accounts, create distinct owned channels/sessions, verify false-LIVE prevention and automatic cross-API feed updates, publish three different genuine sources, decode each exact watch page, verify authenticated chat/room isolation/moderation, stop one source without affecting others, test key/ownership/security boundaries, and inject controlled faults while independently sampling playback. Add a real Chromium camera/audio WHIP publishing test, reporting browser and OBS/FFmpeg results separately. Run lint/format/typecheck/unit/build/Compose checks and preserve prior regressions. Publish only real measurements/screenshots. No uncontrolled 50K run; existing capacity limits remain explicit.

## Delivery and limitations

Commit/push the feature branch and open `Dynamic Multi-User Livestreaming, Live Discovery and Real-Time Chat` against the latest integrated base. Leave it open. Include actual test source/results, screenshots, architecture, Windows guide and unresolved limits. Existing single-host relay/gateways/PostgreSQL/Redis and Docker host remain failure domains; the Healer cannot recreate a disconnected camera or recover deleted media. No adaptive bitrate, CDN, recording, host HA or 50K success is inferred from this scope.

References: [Vimeo Live](https://vimeo.com/features/livestreaming), [MediaMTX publishing](https://mediamtx.org/docs/features/publish-and-read), [browser publishing](https://mediamtx.org/docs/publish/web-browsers), [authentication](https://mediamtx.org/docs/features/authentication), [HLS](https://mediamtx.org/docs/read/hls), [hls.js](https://github.com/video-dev/hls.js), [browser autoplay](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay), [Prometheus](https://prometheus.io/docs/introduction/overview/), [Toxiproxy](https://github.com/Shopify/toxiproxy).
