# End-to-end livestreaming fix plan

## Baseline and diagnosis

Start from merged dynamic multi-user PR #10 (`9d4be43` on the Phase 4 integration branch). Preserve all data, credentials, named volumes and earlier phase features. The working tree was clean. The requested branch is `fix/end-to-end-multi-user-live-streaming`.

The reported Windows screenshots show preview without verified media; they do not establish that a WHIP request succeeded. No Windows logs or screenshots were attached to this request. Existing Linux tests prove a successful synthetic-camera pipeline, but do not test failed ICE, a verification deadline, or the exact two-account camera workflow during faults.

Inspection found that `publishWhip` resolves after applying the SDP answer, without waiting for ICE/DTLS connectivity. Studio then calls that publishing and waits indefinitely for backend verification. A blocked media port can therefore leave a prepared session and unhelpful pending UI. Reproduce this boundary with controlled peer/network failures before fixing it. Treat the user's particular Windows cause as unconfirmed until observed.

## Changes

1. Require a connected WebRTC peer with a bounded connection deadline; preserve exact authenticated WHIP resource cleanup and provide actionable HTTP/ICE errors.
2. Give server-authoritative LIVE verification a bounded deadline, cancellation, retry and explicit cleanup of the owned publishing session. Keep local preview distinct from network publishing. Handle permanent peer failure and capture termination without leaving an owned source running.
3. Bind automatic failure cleanup to the allocated credential using an atomic conditional update; obsolete browser attempts must not revoke or kick a replacement publisher. Preserve the existing globally scoped `/live`, Redis-distributed discovery and per-stream HLS/chat isolation; change only failures demonstrated by tests.
4. Add an exact Rashi/Lakshita/third-viewer browser-camera scenario, an independent concurrent publisher, negative negotiation/connectivity checks, actual decoded video/audio, global discovery, acknowledged cross-account chat, explicit End and API/edge failure recovery.
5. Capture redacted console/network status, ICE state, media/control evidence and screenshots. Do not log credentials, SDP, cookies or authorization headers.
6. Document Windows CMD/PowerShell startup, loopback ICE ports and the limits of remote LAN/browser access. Preserve administrative security and named volumes.

## Media/control flow

Camera/screen + microphone → authenticated same-origin `/ingest/<unique-path>/whip` → MediaMTX relay (ICE UDP/TCP) → private origin/standby → HLS edges/gateway → exact `/watch/<uuid>`. Application APIs handle metadata, ownership, authorization and verified progress, never video transport. PostgreSQL records lifecycle/chat; Redis distributes socket events between API replicas. Preview is private; connected peer is not alone sufficient to label LIVE.

## Verification and delivery

Run existing baseline tests, lint, formatting, typecheck and build. Run targeted failure tests first. Use clean Linux CI for the complete Docker topology: this VFS cloud host previously exhausted its 32 GB disk with that topology and currently has about 4.9 GB available. Do not erase databases or volumes to make it fit. Record actual run results and distinguish synthetic devices from physical Windows hardware and screen chooser. Keep the PR draft while verifying, then mark ready only with the actual evidence. Push the feature branch and create the requested PR without merging it.

## Completed verification

All eight clean Linux CI jobs passed on `a451e4343f7fc26c766e43b4156c85af0543d7e9`: verify, resilience, monitoring, healing, chaos, demo, capacity and dynamic. The exact Rashi/Lakshita browser-camera workflow, acknowledged cross-account and cross-replica chat, decoded audio/video, automatic discovery/removal, credential isolation, independent concurrent streams and real API/edge recovery passed. Local lint/format/typecheck/build and 186 unit tests passed. See [actual results, Windows commands and reviewed screenshots](END_TO_END_LIVE_FIX_RESULTS.md) and [source-linked raw evidence](END_TO_END_LIVE_FIX_MEASUREMENTS.json). Physical Windows camera/firewall/OS screen-chooser checks remain unverified; the user's machine-specific first failing point remains unconfirmed.
