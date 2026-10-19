# Phase 3 — authenticated multi-user live platform

## Baseline and Git delivery

The repository was clean at verified Phase 2 head 89983b7. PR #1 was merged; #2 and combined Phase 2 PR #3 were still open. The new feature/phase-3-streaming-platform branch starts from the fetched head of feature/phase-2-live-streaming and targets that branch as a stacked PR. No user changes, commits, volumes or remote history were discarded. PR #3 is a dependency, not an automatically merged prerequisite.

When the owner merges #3, preserve history:

```sh
git fetch origin
git switch feature/phase-3-streaming-platform
git merge origin/main
# Resolve only actual conflicts, rerun all checks, then:
git push origin feature/phase-3-streaming-platform
```

Retarget the Phase 3 PR base to main in GitHub. Review its Files changed after merging main; do not cherry-pick Phase 2 again, reset or force-push. A normal merge commit from #3 is an ancestor of this branch; if the owner used squash/rebase merging, reconcile the resulting content with a normal main merge before retargeting.

## Implemented product

Accounts register/sign in/out and restore revocable cookie sessions. A profile edits the real display name. Studio creates one owned channel per account, grants broadcaster capability transactionally, edits metadata, creates independent livestreams, generates masked one-time publishing keys, rotates/revokes them, previews actual live video and preserves paginated broadcast history. Public channel pages and bounded/paginated discovery use PostgreSQL records and actual MediaMTX observations.

Watch retains the Phase 2 HLS player, native controls, bounded retry, actual browser metrics and collapsed diagnostics. Real Socket.IO chat replaces the reserved panel for database-backed streams. The explicitly labelled legacy development channel retains its earlier unavailable-chat panel because it is not a user-owned durable stream.

Full-width navigation, desktop sidebar, mobile drawer, typography and shared tokens remain. Signup/login, profile, channels and Studio use the same product design. Accounts and Studio are functional; Following, categories and Control remain future features. No fake creators, thumbnails, follower counts, seeded live status or conversation history are introduced.

## Database and migrations

PostgreSQL 17.9-alpine with pg 8.23.1 and node-pg-migrate 9.0.0. There is one SQL data model and migration journal, not competing ORM abstractions.

| Entity        | Integrity and purpose                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| users         | UUID, canonical unique username/email, Argon2id hash, display name, viewer/broadcaster/administrator role, UTC timestamps                                     |
| auth_sessions | SHA-256 opaque-token digest, user FK, creation/expiry/revocation; user/expiry indexes                                                                         |
| channels      | UUID, unique owner FK and canonical slug, display name/description, UTC timestamps                                                                            |
| streams       | UUID, owned channel FK, title/description, unique generated media path, publish-key hash, draft/ready/ended lifecycle, first/last live and ended observations |
| chat_messages | UUID plus monotonic bigint sequence, stream/sender FKs, bounded plain text, creation/deletion timestamp and stream/order index                                |

Restrict/cascade rules preserve important records. Parameterized queries and strict Zod inputs prevent SQL injection and mass assignment. Channel creation/role promotion and session replacement use transactions. Migrations run in a one-shot Compose service before API startup and can be repeated explicitly with docker compose run --rm migrate. The non-migration SQL support file is excluded from migration discovery. Destructive rollback and automatic resets are disabled. The postgres-data named volume persists application records.

Started timestamps mean first verified media observation, not a guessed exact RTMP connection time. End timestamps reflect an explicit owner end or observed source absence. Observations never infer media Live from database lifecycle.

## Sessions, authorization and CSRF

Passwords use @node-rs/argon2 2.2.2, Argon2id with the OWASP baseline of 19MiB memory, two passes and one lane; the library supplies salts/encoding. Invalid credentials use the same message and perform Argon2 verification against a dummy hash for missing accounts.

Session tokens are random 256-bit values, stored only as SHA-256 digests in PostgreSQL. Cookies are HttpOnly, path-scoped without a Domain attribute, SameSite=Lax and optionally Secure. Production validation requires Secure cookies and disabled legacy publishing. Every privileged request resolves the session and its current role/expiry/revocation server-side. Login replaces/revokes the current browser session; logout revokes it and disconnects session-room sockets through the supported Redis adapter where distribution is available. Each authenticated socket also expires on the session deadline and revalidates before sending messages.

All REST mutations, including registration/login/logout, require an exact allowed Origin and a nonce-cookie-bound HMAC CSRF token returned by /auth/me. The nonce cookie is also HttpOnly. Socket handshakes use the same CSRF boundary and require an allowed browser Origin. Forwarded headers are not trusted for identity, origin or media callback authorization. Redis atomically limits registration/login, authenticated writes, chat, joins, connection admission and heartbeats. Redis failure rejects protected admissions/writes explicitly rather than bypassing limits.

Registration rejects role flags. Creating your owned channel atomically grants broadcasting; stream creation checks broadcaster/administrator on the server. Private publishing and modifications always verify ownership, and publishing also checks the owner's broadcaster/admin role. Trusted local role provisioning is available only through the parameterized account:role command with database access. No admin/Control/chaos HTTP endpoint exists.

Public DTOs omit account emails except your own profile, password hashes, session digests and publish hashes. The API logs request correlation, method/path/status/duration, never body/cookies/auth headers/keys. The HLS proxy strips application session/CSRF cookies and Authorization while preserving MediaMTX's own HLS cookie behavior.

## Per-stream media ownership

MediaMTX remains pinned at 1.21.2-ffmpeg. Its maintained HTTP authentication mechanism calls a dedicated unexposed Express listener on API_INTERNAL_PORT with a generated service Basic credential. It is not mounted on the public API and Vite never proxies it. Callback bodies are bounded; arbitrary forwarded headers do not grant access.

Dynamic paths match generated s-UUIDhex identifiers. Each stream has a different random 256-bit key, stored only as a digest and returned once by the CSRF-protected owned publishing action. Media authorization verifies path, stream ID, key digest, ready state and broadcaster ownership. The same key cannot publish another path. Anonymous/invalid/unconfigured/competing publishing remains rejected.

Rotation revokes before disconnecting matching active RTMP publisher connections through the private authenticated Control API, then installs a new key. Ending marks ended, revokes and kicks. If disconnection cannot be confirmed, the action returns PUBLISHER_STOP_UNCONFIRMED instead of claiming success; the credential stays revoked. A concurrently ended stream cannot receive a newly valid key. Public stream responses never reveal publishing secrets.

Read actions are intentionally public and excluded from the external DB callback so already-ingested HLS does not depend on PostgreSQL/Redis per segment. MediaMTX's Control API retains separate credentials, private networking and its local health probe permission. The old fixed publisher credential applies only to MEDIA_STREAM_PATH when ENABLE_LEGACY_STREAM=true in development; it grants no user-stream rights and is forbidden in production mode.

## Socket.IO, durable history and Redis

Socket.IO/client 4.8.4 with @socket.io/redis-adapter 8.3.0 and redis 6.3.0. The browser intentionally uses WebSocket transport and the Vite proxy supports /socket.io upgrades. There is no polling fallback or sticky-session claim. Separate Redis command/pub/sub clients have bounded queues, command/connect deadlines, reconnect budgets, structured dependency logs and graceful close. Adapter channels are namespaced by logical DB; integration uses DB 1. The adapter's unawaited publish failures are caught at its client boundary and reported as degraded transport rather than process-level unhandled rejections.

Rooms are stream-scoped. Joining checks the real stream; messages require a fresh valid session, room membership, strict 1–1000-character validation and shared rate limit. Messages are parameterized PostgreSQL inserts before broadcast. HTML-like content stays literal React text; no unsafe HTML rendering is used. Public history queries filter deletion state and use bounded sequence cursors. Reconnect joins recover durable history; earlier pages are explicit and browser retention is capped by VITE_CHAT_WINDOW_LIMIT. Autoscroll follows only when the viewer is near the end; manual scrollback is respected and Latest messages returns to the current page.

A successful send means persisted/accepted, not confirmed delivery to every remote viewer. Redis Pub/Sub is not durable, connection-state recovery is not claimed, and distributed events may be missed during outages. Reconnect/history is the recovery path. No bespoke broadcasting protocol, durable Redis history or full replica deployment is added.

## API surface

All paths below use /api/v1. Inputs are strict Zod contracts; errors use the existing structured code/message envelope. Mutations require the Origin/CSRF boundary, with ownership enforced for private resources.

| Method       | Path                                        | Purpose                                                    |
| ------------ | ------------------------------------------- | ---------------------------------------------------------- |
| GET          | /auth/me                                    | Current session and CSRF bootstrap                         |
| POST         | /auth/register, /auth/login, /auth/logout   | Account/session lifecycle                                  |
| PATCH        | /auth/profile                               | Own display name                                           |
| GET          | /channels, /channels/:slug                  | Bounded discovery and public channel streams               |
| POST / PATCH | /channels, /channels/:id                    | Create/update owned channel                                |
| GET          | /studio/channel, /studio/streams            | Owned Studio metadata and paginated history                |
| POST / PATCH | /studio/streams, /studio/streams/:id        | Create/update owned stream                                 |
| POST         | /studio/streams/:id/publishing              | Generate or rotate a one-time publishing credential        |
| POST         | /studio/streams/:id/end                     | Revoke, end and disconnect own publisher                   |
| GET          | /streams, /streams/:id, /streams/:id/status | Bounded search and actual source observations              |
| GET          | /streams/:id/chat                           | Durable ordered history with before cursor                 |
| GET          | /streams/:id/presence                       | Approximate active-player count or explicit unavailability |

Socket.IO at /socket.io supports stream-scoped join, message and heartbeat events with acknowledged validation errors. Switching rooms leaves the previous room and lease; disconnect removes the lease. The private MediaMTX callback listener is separate from this public surface.

## Approximate active-player presence

One estimate member is a distinct authenticated browser login session, or an anonymous browser's CSRF identity, per stream. Several tabs sharing that identity are deduplicated. Separate browsers/login sessions can count separately, so this is not unique-human analytics.

A client heartbeat is sent only for a real video whose media time advanced since the previous sample, is unpaused/ready and is visible. Paused/hidden/non-progressing samples remove the socket's lease. Redis sorted-set scores are expiry times; disconnect removes that socket and TTL/pruning handles crashes. Public API returns only the number and label. Redis failure becomes Unavailable, never a retained/fabricated count. Client signals can be forged by a malicious client and playback outside the application is not counted. Scalable audience analytics/load testing is deferred.

## Graceful degradation and extension points

Application readiness checks PostgreSQL plus Redis clients while liveness remains independent. Source status and player metrics stay separate. A failed metadata refresh labels source state unknown while retaining an already attached player, including Home preview. DB/Redis actions show structured errors. Chat exposes connected/degraded/disconnected states, bounded reconnect and durable history; heartbeat readiness permits recovery after dependencies return. Long outages exhausting Redis's bounded reconnect require an explicit API restart.

HLS continues through DB/Redis outages after ingestion. Starting a new publisher requires DB authorization and fails closed if unavailable. A MediaMTX outage is still unavailable rather than publisher-offline, and API readiness can remain ready when only media is down. No application restart or dependency restart is attributed to a healer; integration tests explicitly operate their local services.

## Configuration and Windows use

The [README](../README.md) gives the exact clone/branch/VS Code/.env/setup/migrate/Studio/OBS/viewer/chat/testing/shutdown walkthrough and troubleshooting. setup:platform appends configuration, generates separate secrets and preserves existing nonempty Phase 2 settings. Standard Compose publishes only loopback web/API/RTMP/HLS; PostgreSQL, Redis, Control API and callback stay private. No Docker socket, cloud path or automatically deleted volume is required.

New configuration covers POSTGRES__, DB_POOL_MAX, DEPENDENCY_TIMEOUT_MS, REDIS__ (DB 1 reserved for tests), sessions/cookie/CSRF, auth/write/chat limits, history/window limits, presence TTL/heartbeat, socket admission/reconnect, internal media auth and the public owner-facing RTMP URL. .env.example is authoritative. Changing ports/origins/keys requires setup regeneration and affected container recreation. Existing volume passwords are not silently rotated.

## Verification evidence

- Phase 2 baseline: 61 tests before changes, clean Git worktree and verified open PR #3.
- Current unit suite: 64 tests across seven files, preserving all existing checks and adding production/configuration, CSRF, role-input and chat-validation coverage.
- Real isolated platform integration: 22 named checks against a uniquely migrated PostgreSQL database and separate Redis namespace. Includes session/hash/expiry/revocation, duplicate accounts, CSRF, transactional role promotion, ownership, per-path key rotation, cross-instance chat/logout, durable ordered history, room isolation, validation/spam, presence expiration/deduplication and shared auth rate limiting.
- Browser suite: ten tests, retaining API recovery/navigation/width regressions and adding actual registration/login/logout, session refresh, Studio/channel/stream/key masking, two-user chat and reconnect history. Responsive screenshots cover 375/768/1280/1440/1920px; existing layout tests also exercise 1680px.
- Phase 3 real media: two independent authenticated FFmpeg publishers with distinct resolutions, decoded browser frames/time progression, cross-path rejection, active key rotation/revocation, correct publisher termination, two-session/tab-deduplicated presence, isolated chat, real dependency outages, durable restart and ongoing HLS. Chat is verified usable after dependencies recover.
- The retained Phase 2 media suite verifies genuine HLS bytes/decoding, invalid/competing publishers and origin stop/return separately.
- Typecheck, lint, formatting, production build and Compose validation are mandatory before delivery. Actual final command results and remote CI status are recorded in the PR/chat handoff; earlier failures are not counted as passes.

Integration tests own only their bounded publishers and generated e2e_ accounts. Cleanup validates UUIDs and refuses non-test users; the isolated DB runner drops only its own generated test database. No volume reset is used.

## Visual review and limitations

Committed assets under images/phase-3 show actual UI and actual synthetic video, real test-created accounts/messages and measured estimates. Keys are dismissed before screenshots; auth/key flows disable traces. Mobile sign-in sizing and transition-aware screenshot capture were corrected during rendered review. Tests use explicit disposable data, not seeded public production content.

Windows, physical OBS/webcam and Safari/native HLS were documented rather than executed on this Linux host. Actual Chromium/FFmpeg/Docker paths are verified. Existing bundle-size advisories remain. This local environment lacks HTTPS/RTMPS, email verification/reset, uploaded profile assets, moderation tools, following/categories and production incident/analytics retention. Expired/revoked session records require a future retention policy; they are never treated as valid sessions. Source observations are bounded on-demand polling, not a monitoring controller or complete live catalog index.

## Phase 4 handoff

Multiple API instances can share PostgreSQL sessions/ownership/history and Redis rate limits, adapter distribution and presence leases. Independent-instance integration verifies that boundary; deployment redundancy is not implemented. Phase 4 must add deployment routing/TLS, trusted proxy configuration, appropriate pool/concurrency budgets, WebSocket routing and idempotent migration orchestration. If polling is introduced, configure appropriate stickiness.

Media paths and browser source identifiers are independent of UI ownership IDs. Future Nginx video edges and standby origins can extend media delivery/source selection while preserving publishing authorization, state evidence and player observations. They need independent origin/edge probes and verified recovery semantics. Replicas, edges, standby media, monitoring/healing/chaos controllers and 50,000–60,000-viewer validation remain later phases.

## Official references reviewed

- [MediaMTX pinned HTTP authentication](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/2-features/06-authentication.md), [implementation payload](https://github.com/bluenviron/mediamtx/blob/v1.21.2/internal/auth/manager.go), [Control API](https://github.com/bluenviron/mediamtx/blob/v1.21.2/api/openapi.yaml).
- [node-postgres pooling/lifecycle](https://node-postgres.com/features/pooling), [node-pg-migrate](https://github.com/salsita/node-pg-migrate).
- [Redis Socket.IO adapter](https://github.com/socketio/socket.io-redis-adapter), [node-redis](https://github.com/redis/node-redis).
- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

### Final local results and fixes

All final local checks passed: typecheck, ESLint (no warnings), 64 unit tests / seven files, formatting, build, Compose validation, repeatable setup and rebuilt-image startup. The runtime dependency audit reported zero advisories. The 22-check isolated platform suite, ten-test browser suite and both real media suites passed. The retained Phase 2 suite observed 103 decoded frames plus advancing playback in its recorded run; Phase 3 verified distinct 640×360 and 320×180 sources and usable chat after dependencies returned. All five services were healthy afterward and migrations completed successfully.

Failures encountered during implementation were fixed and rerun: migration discovery initially treated its SQL support file as another migration; browser chat initially attempted polling without the strict Origin expected by the handshake; narrow sign-in sizing overflowed/wrapped; a misplaced pagination rendering block was caught before delivery; and dependency recovery needed an explicit chat-ready signal. No failing run was counted as a pass. Studio's route was made lazy so preview/HLS code stays out of the initial application chunk. Existing size advisories remain.

The current screenshots include masked-key dismissal, actual profile persistence and both empty/real-message chat states. Production-hosting, Windows execution, physical OBS and Safari remain unverified as described above; CI results are reported by the actual GitHub checks rather than inferred from local success.
