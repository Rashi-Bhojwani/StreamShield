# StreamShield resilience report

**Date:** 27 October 2026. **Format:** five-page PDF submission.

[Download/read the PDF](StreamShield_Resilience_Report.pdf) · [Report data](RESILIENCE_REPORT_DATA.json) · [README](../README.md)

## 1. Architecture and scope

Camera/OBS → MediaMTX relay → primary/standby origins → Nginx edges → video gateway → web proxy → HLS viewer. REST and Socket.IO use web → API gateway → API-1/API-2 → PostgreSQL/Redis. The independent Observer detects; the Healer repairs through an allowlisted adapter; Chaos requests owned faults and checks independent evidence. API-2/control roles share one fixture container, and all services share one host.

Fresh run `a484d151`: Linux Docker/Chromium, one generated H.264/AAC path, 5 reported CPUs and 33.3 GiB daemon-reported memory. Physical Windows/8 GB laptop performance is not established.

## 2. Failure table

| Failure                  | Detection                                                                                                              | Healing / verification                                                                                                   | Measured recovery                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| API server crash         | Independent readiness probe becomes unreachable; consecutive failures confirm the incident. Detection 7.684 s.         | API-2 serves requests. Healer starts API-1; readiness, catalog and gateway participation verify recovery.                | 21.500 s                                  |
| Video gateway crash      | Gateway health is unreachable; real HLS delivery through it fails. Detection 6.497 s.                                  | Healer starts the gateway; valid playlists/init/media and advancing segments through it verify recovery.                 | 15.324 s                                  |
| Edge node failure        | Edge-1 probe fails; actual delivery is observed through Edge-2. Detection 4.700 s.                                     | Edge-2 carries delivery. Healer starts Edge-1 and independently verifies live media; peer remains unchanged.             | 14.232 s                                  |
| Network disruption       | Safe recommendation reads time out; the dependency circuit opens and the observer confirms failure. Detection 9.055 s. | Owned 20-second delay expires/is removed. Circuit half-open reads verify reconnection; this is not a third-party repair. | 27.247 s                                  |
| Media authorization loss | Both HLS routes deny new requests; buffered playback drains.                                                           | Explicit operator reset and advancing-media verification; separate historical acceptance.                                | Not recorded; human intervention required |

Recovery is injection-to-independent-service-verification, not Docker-action duration or browser buffering time. Network recovery includes owned 20-second fault expiry and circuit reconnection. No duration was recorded for the manual case; no estimate is substituted.

## 3. Before-and-after numbers

| Signal                     | Before fault | During fault            | After verification        |
| -------------------------- | ------------ | ----------------------- | ------------------------- |
| API-1 running flag         | 1            | 0; exit 137             | 1; functional checks pass |
| Video gateway running flag | 1            | 0; exit 137             | 1; HLS progresses         |
| Edge-1 running flag        | 1            | 0; Edge-2 serves        | 1; peer unchanged         |
| Recommendation read        | 2 ms         | Timeout / circuit opens | 1 ms; circuit closed      |

Running flags are state observations, not throughput measurements.

| Post-repair player sample | Decoded frames before → after | Media-time advance | New media responses |
| ------------------------- | ----------------------------- | ------------------ | ------------------- |
| API server crash          | 792 → 809                     | +0.701 s           | 2                   |
| Video gateway crash       | 183 → 200                     | +0.700 s           | 2                   |
| Edge node failure         | 727 → 757                     | +1.242 s           | 2                   |
| Network disruption        | 1565 → 1596                   | +1.268 s           | 2                   |

Playback samples establish progress after recovery. Total playback interruption was unmeasured (`null`), not zero.

| Scenario            | Earlier 282d20da | Current a484d151 | Change   |
| ------------------- | ---------------- | ---------------- | -------- |
| API server crash    | 16.503 s         | 21.500 s         | +4.997 s |
| Video gateway crash | 13.259 s         | 15.324 s         | +2.065 s |
| Edge node failure   | 17.383 s         | 14.232 s         | -3.151 s |
| Network disruption  | 26.227 s         | 27.247 s         | +1.020 s |

This two-run comparison is descriptive, not controlled: host load and code differ. Both slower and faster values are retained; no causal speedup or statistical reliability improvement is inferred.

## 4. Policy, execution and validation

Fresh confirmed evidence → symptom-specific playbook → lease/budget/dependency checks → durable action intent → restricted Docker receipt → independent stable functional verification. Unknown, escalated, stale or ambiguous evidence never establishes success. Default policy limits operations to two per service per ten minutes with a 30-second cooldown. Database repair and broadcaster recreation are outside automatic authority.

Prepare images/configuration using the README; use one disposable fixture at a time:

```powershell
npm.cmd run chaos -- --help
npm.cmd run chaos -- --verify
npm.cmd run chaos -- --interactive
```

The fresh script run passed 4/4 cases, removed 13 owned containers and preserved the user's environment. 513 unit/security checks across 44 files passed, with typecheck and lint. Actual fixture compilation and browser decoding passed. Arbitrary targets are rejected before Docker use. Manual authorization loss is available interactively and verified separately.

## 5. Known limits and sources

- One host; singleton database, relay, gateways, Redis and web remain failure boundaries.
- Compact control roles/API-2 share a trusted container; privileged Docker adapters require host trust.
- No automatic recreation of camera input, lost signing material or missing external permissions.
- Toxiproxy models a private dependency; timed cleanup is not an ISP/provider repair.
- No verified 50,000-viewer capacity, production availability, tail-latency or zero-interruption guarantee.
- Physical Windows devices/networking and 8 GB laptop performance are unverified; cloud figures are not transferable guarantees.
- Public deployment needs TLS, NAT/TURN design, secrets, backups and independent failure domains.

Sources: [current report data](RESILIENCE_REPORT_DATA.json), [earlier four-fault data](RECOVERY_HEALTH_VALIDATION.json), [manual failure evidence](SYSTEM_LOGS_VALIDATION.json), [browser recovery regression](BROWSER_READINESS_VALIDATION.json), [chaos entry point](../scripts/chaos.mjs), [actual driver](../scripts/four-scenario-live.mjs).

Application baseline: `48cf25b` (same application tree as `a783fdb`), plus the submitted entry point/report. Local checks do not assert remote CI or physical Windows acceptance.
