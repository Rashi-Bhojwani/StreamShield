# Phase 2 implementation plan

## Assessment and preservation

Phase 1's actual 42 files were reviewed, and 22 tests, types, lint, formatting, builds and Compose configuration passed before changes. Initial commit `387cc57` preserves that baseline on local main. Remote push was initially denied (403), then succeeded after the user restored access. Remote main contains that exact baseline; the feature branch shares it as its ancestor. No history is reset or forced.

## Changes and data flow

Add one configured development channel, not account/stream CRUD. OBS or FFmpeg → authenticated RTMP → pinned MediaMTX 1.21.2 → fMP4 HLS → Vite media proxy → hls.js (native fallback). Express carries only metadata. Existing request IDs, logging, configuration patterns, contracts, foundation UI and lifecycle checks remain.

## Infrastructure and publishing

The official pinned `1.21.2-ffmpeg` image includes a shell/HTTP probe and a real test encoder. A checked-in MediaMTX template disables unrelated protocols. A cross-platform Node setup command preserves existing .env settings, adds missing defaults, generates random local publishing/control credentials, and writes ignored runtime YAML with hashed passwords. Only one configured path accepts a publisher; publisher replacement is disabled. Public reads are intentionally allowed for this development channel. Admin API stays inside Docker networking; a localhost-only API permission supports the container health probe.

## Player and discovery

Typed REST discovery reports publisher and HLS evidence separately with timestamps. API timeout/auth/schema failures mean unknown/unavailable, never offline or healthy. Coalesced requests and a short configurable cache avoid repeated identical origin probes. The player reports actual media events, starts muted, handles autoplay rejection, supports native HLS fallback, and cleans up resources. Fatal loads/stalls trigger a bounded exponential retry budget; manual retry starts a new budget. Source return can reattach playback but cannot restore a missing publisher.

## Configuration and security

All ports, internal/public media base URLs, path/title, polling, deadlines, HLS timings and retry limits are documented in .env.example and validated. No browser variable contains publishing/control credentials. No generic URL proxy or admin passthrough exists. Compose binds host ports to loopback by default. The setup is development-only and rejects non-development media bootstrap; Internet deployment requires TLS/RTMPS, secret management and authenticated publishing authorization. No sockets, chaos controls or account APIs are added.

## Verification and acceptance

Preserve foundation tests; add configuration, MediaMTX response/probe, API route, player event/retry/cleanup tests. Run lint/format/types/unit/build/Compose. Publish a bounded, explicitly labelled synthetic FFmpeg video with H.264/AAC; verify path state, master/media playlist and a real segment, then actual browser frames/time progression. Stop/restart the publisher and test offline/return behavior. Reject bad credentials, unknown paths and a competing publisher. Stop the origin and verify unavailable state while the app remains ready. Inspect responsive watch screenshots and browser errors. Test the documented local and Docker commands where available. Record exact outcomes in PHASE_2.md and prepare a PR with Windows instructions.

## Limits and future healing

No failover, replica, controller, durable catalog, chat, auth accounts, viewer metrics, transcoding ladder or latency/capacity guarantee. HLS buffers delay interruption visibility; publish state and playing state are distinct. Native HLS/Safari and physical OBS require manual checks if unavailable here. Future phases can reuse timestamped observations and playback states, but must add independent probes, incident storage and verified bounded recovery without mistaking reconnect for infrastructure healing.
