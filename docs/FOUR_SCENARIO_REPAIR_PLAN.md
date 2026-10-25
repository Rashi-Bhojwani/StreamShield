# Four-scenario repair and verification plan

Baseline: fb160d8, current feature/final-self-healing-presentation branch; clean tree before edits. Preserve .env, ignored generated configuration, user data and backend scenarios. Use the existing explicit authorization for ordinary branch delivery; never force push or merge automatically.

1. Inspect the authoritative UI/API/controller/adapter/observer/Healer/control paths and current environment. Historical Windows logs are not current diagnosis; Windows is not mounted here.
2. Select crash-api, crash-video-gateway, crash-edge and network-timeout in a shared catalog. Keep extended backend functionality. Require present, fresh critical components, authorized recovery, durable audit, safe peers and genuine progressing media for media faults. Empty media must not verify recovery.
3. Build one simple shared demonstration surface: four selectable cards, one run button, exact blocked reason/next step, component health, seven real lifecycle stages and honest final measurements. Keep previous operational views behind expandable advanced sections.
4. Add a configurable 15-second observation window in the controller, persisted per experiment. Continue behavioral verification during the window; preserve actual restoration duration separately from demonstration duration. Never sleep in request handlers or synthesize events.
5. Measure network baseline and verification against explicit latency tolerance. Prove edge fallback where supported and distinguish expiry cleanup from independent service restart.
6. Add admission, UI, timing, refresh/polling, failure and verification regression tests. Run existing typecheck/lint/test/build/format/Compose checks.
7. Attempt actual four-scenario validation using only isolated owned fixtures and existing images. The host has 4.9GB free under VFS: avoid the original full deployment and any user volumes. Consolidate independent control-plane processes into a fixture container if needed; target API/media/edge containers remain separate. Capture limits and results honestly. Clean only labelled fixtures and verify original .env checksum.
8. Document actual outcomes and exact Windows commands. Unverified full-stack scenarios remain explicitly unverified; missing operational prerequisites stay blocked.

Outcome: implemented four-scenario UI, bounded readiness, strict behavioral admission and safe durable reconciliation of stale failed/timed-out history. Complete four-scenario live validation is blocked by VFS storage; the initial owned fixture was removed after capacity exhaustion and a conservative 8GB VFS guard now refuses startup. UI/protocol evidence is distinguished from full live recovery. See the results document.

Final verification: 349 unit tests in 32 files, 19 Chromium UI checks with mocked REST, real restricted-role protocol checks, and typecheck/lint/build/Compose validations pass. Four full live scenarios remain BLOCKED, not passed.
