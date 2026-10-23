# Final test results

Every command below was run on branch `feature/final-self-healing-presentation`
at the commit named in each section, on the host described in
[SELF_HEALING_RECOVERY_EVIDENCE.md](SELF_HEALING_RECOVERY_EVIDENCE.md). Pass/fail
is copied from the command's own exit status and summary line.

## Static checks and unit tests (commit `a9e4bcd`)

| Command                | Result | Summary                                      |
| ---------------------- | ------ | -------------------------------------------- |
| `npm run lint`         | PASS   | eslint, 0 problems                           |
| `npm run format:check` | PASS   | "All matched files use Prettier code style!" |
| `npm run typecheck`    | PASS   | root `tsc --noEmit` plus every workspace     |
| `npm test`             | PASS   | 23 files, **249 tests** passed (vitest)      |
| `npm run build`        | PASS   | every workspace builds (web, api, shared)    |

New unit tests added for the final build cover, among others: probe
`probe_timeout` vs `probe_unreachable` classification, symptom-aware playbook
selection, the restart guards (peer healthy, tier under load, hang confirmation
window, congested peer refuses the restart, corroborating probe answered /
unreachable), scale-out/scale-in eligibility, the overload decision with the
minimum-rate gate, timeline segment building and overall tone, and the restart /
stop adapter preconditions.

## Docker integration: `npm run test:final`

`FINAL_ROUNDS=1`, Playwright with the preinstalled Chromium
(`PLAYWRIGHT_EXECUTABLE_PATH=/opt/pw-browsers/chromium`).

| Execution | Commit                                                   | Result   | Exact outcome                                                                                                              |
| --------- | -------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| 5         | `1b9486f`                                                | FAIL     | six core scenarios COMPLETED; traffic-surge FAILED (`capacity_exhausted_operator_action_required`, duplicate scale-out)    |
| 6         | `053f277`                                                | FAIL     | hang-api admission returned 409 after the poll reported it admissible (harness race)                                       |
| 7         | `053f277` + the 409 re-wait later committed in `f146ddf` | FAIL     | all eight scenarios COMPLETED; post-repair video check failed (publisher's 600 s cap inside the API-tier outage)           |
| 8         | `f146ddf`                                                | PASS     | passed, but the scale-in escalated as ambiguous (`scaledIn=false`) — the suite did not yet assert scale-in                 |
| 9         | `9c8d2ce`                                                | FAIL     | traffic-surge TIMED_OUT: scale-in audit insert conflicted with the open capacity incident from execution 8                 |
| 10        | `291216a`                                                | FAIL     | all scenarios COMPLETED incl. scale-in; post-surge video check failed (publisher cap after a budget wait)                  |
| 11        | `2e86264`                                                | FAIL     | all scenarios COMPLETED incl. scale-in; API-2 restarted for congestion 6 s before scale-out; post-surge video check failed |
| **12**    | `a9e4bcd`                                                | **PASS** | `1 passed (10.8m)`: all eight scenarios COMPLETED, scale-in verified, Redis swimlane, layout and history checks passed     |

Execution 12 recorded:

- Scenario outcomes: crash-redis, crash-video-gateway, crash-relay, hang-api,
  crash-edge, crash-primary, traffic-surge (scaled in), crash-api-tier — all COMPLETED.
- Redis swimlane from persisted evidence: healthy → degraded → failed → healing → recovered → healthy.
- Horizontal overflow 0 px for `/control/presentation`, `/control/presentation/report`
  and `/control/analysis` at 375, 768, 1280, 1440 and 1920 px.
- Safety: guest 401, non-admin 403, missing CSRF 403, unknown scenario 400,
  disabled database scenario 400, no stream key in the timeline.
- Screenshots: 23 files in [`docs/screenshots/final/`](screenshots/final/),
  inspected for secrets before commit (only test usernames appear).

Measured times per execution are in
[SELF_HEALING_RECOVERY_EVIDENCE.md](SELF_HEALING_RECOVERY_EVIDENCE.md).

## Regression suite after the Healer changes

`npm run test:chaos` (the earlier Chaos Lab e2e suite) was run against the running
final stack after the Healer changes: **FAIL, not attributable to this change and
not runnable in this sandbox.**

- Its first in-browser playback assertion (`advances`: at least 8 decoded frames
  in the `<video>` element) timed out after 90 s, before any fault was injected.
  This sandbox's Chromium has no H.264 decoder (see KNOWN_LIMITATIONS). The CI
  `chaos` job uses Playwright's own Chromium with H.264.
- Its `finally` block then failed in fixture cleanup and hid that first error:
  on a dynamic stack `broadcast_events` (added by the PR #11 base migration)
  still references the test streams, which `scripts/cleanup-test-fixtures.mjs`
  does not delete. The cleanup rolled back, so two `e2e_` test accounts from
  that run remain in the local database. Pre-existing and left out of this PR's
  scope; the CI `chaos` job runs on the non-dynamic composition.
- The original error was recovered by temporarily logging it in the spec
  (reverted, not committed).

## Not run here

- `FINAL_ROUNDS=2` in one execution (the CI `final` job does this) — see
  [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
- CI on GitHub: this session cannot push to `Rashi-Bhojwani/StreamShield`, so
  no CI run exists for these commits.
- Windows / Docker Desktop / OBS / a physical camera.

## Operator actions during development

- One stale relay incident left by a Docker daemon restart was closed with an
  explicit `operatorNote` (see KNOWN_LIMITATIONS).
- Earlier, before budget-gated admission existed, API-2 was left down by an
  injected fault the Healer had no budget to repair and was restored by the
  operator; that defect is fixed (chaos now refuses such faults).
- Between executions (never during one), the healer, healing-control and
  chaos-controller containers were restarted to deploy code changes; their
  source is bind-mounted. No other manual container start, restart or
  database change was made during the measured executions.
