> Current primary scope is four scenarios: API, video gateway, edge and network. See [current repair and actual verification limits](FOUR_SCENARIO_REPAIR_RESULTS.md). The earlier scope/results below are historical.

# One-run repair: actual results and Windows handoff

**Status: PARTIAL for the complete five-scenario live acceptance.** Implementation, regression checks and isolated real PostgreSQL/Observer/Toxiproxy checks passed. The complete production-shaped five-scenario deployment and the user's Windows installation were not exercised in this run. Historical measurements under `docs/FINAL_*` are not results of this repair.

Work was performed in the cloud repository on `feature/final-self-healing-presentation`, starting at `2cfea8c2f9ee9fc3f4e96d8cbc795adfa71d2688`. The Windows path `E:\StreamShield\StreamShield` is not mounted here. The initial repair run left all changes uncommitted and unpushed, as originally requested. The user subsequently explicitly authorized committing and pushing the repairs on this same branch. Preserve unrelated Windows changes and use the branch instructions below to obtain the repair commit.

## 1. Confirmed causes and evidence

- `apps/web/src/control/useChaos.ts` (`useChaos`): the previous unchecked response cast, hardcoded 12s age check and `now - timestamp < 12000` accepted future timestamps; authentication/request/contract failures collapsed into controller-unavailable text. The logged-in user's actual HTTP 200 JSON was not supplied, so its machine-specific denial remains unconfirmed. A 200 response alone does not establish `available`, fresh observation, persistence or scenario readiness. Bare CMD 401 remains expected; authentication was preserved.
- `apps/web/src/control/Presentation.tsx` (`Presentation`) and `Chaos.tsx` (`Confirmation`): buttons used only `scenario.available`, leaving cached availability usable when the shared request was stale or failed. Confirmation also relied on the snapshot captured when opening the dialog. Both now honor global and scenario-specific denial, and confirmation revalidates before POST.
- `services/api/src/monitoring/observer.ts` (`start`) / `store.ts` (`persist`, `durableSnapshot`): probe cycles awaited SQL and event work; SQL used one upsert and active-incident query per component, a blocking advisory lock, and retention work in each transaction. `/snapshot` awaited database history even when current probe observations were available. A real isolated PostgreSQL lock reproduced persistence loss while the repaired probe loop continued and `/snapshot` remained fast. This is evidence of the code's backpressure behavior, not proof that the user's historical timeout had this precise lock cause.
- `services/api/src/healing/circuit.ts` (`Circuit.execute`): the open interval began before a slow failed request completed. A real 300ms timeout with a 200ms reset demonstrated an immediately eligible half-open retry. The reset now begins at failure completion; a regression test and real latency/expiry recovery pass.
- `services/api/src/monitoring/observer.ts` (`promScalar`) / `prom-value.ts` (`promValue`): absent or non-finite results became zero and could look healthy. Missing/NaN metrics now produce UNKNOWN; explicitly observed finite zero remains valid. Empty error counters are explicitly coalesced in PromQL, while actual latency/request observations are still required.
- Primary scenario selection previously exposed more than five choices. One shared list now controls Chaos, Demo and Presentation; all additional backend implementations/history remain intact.

## 2. Meaningful changes

- `packages/shared/src/operations.ts`: runtime Chaos/Monitoring schemas, shared TTL/freshness classification, exact five-ID catalog. Invalid, missing, future and stale data fail closed.
- `useChaos.ts`, `chaos-readiness.ts`, `Control.tsx`: server-clock age plus monotonic elapsed time; correct authentication, transport, audit, invalid-contract and prerequisite explanations. Live probe time and durable checkpoint are separate. Unknown incident counts show a dash rather than a misleading zero.
- `Chaos.tsx`, `Presentation.tsx`, `evidence.ts`: five primary choices, fresh confirmation, accurate prerequisites/recovery descriptions, explicit denial, evidence-backed stages. A CREATED record does not paint a verified healthy baseline. Circuit protection/owned fault cleanup do not appear as a Healer restart.
- `chaos/engine.ts`, `routes.ts`, `config.ts`: configurable shared freshness, explicit observer/persistence/Healer/adapter reasons, no admission during recovery, and no restart-receipt-only recovery. An unverified destructive fault keeps subsequent injection disabled until appropriate verified recovery exists. Controller forwarding/auth/contract failures and history persistence failure remain distinct.
- `monitoring/writer.ts`, `snapshot.ts`, `observer.ts`, `store.ts`: one coalescing asynchronous writer; immutable probe snapshots; failure-episode acknowledgement prevents replay without losing a new episode. Batch component writes, one active-incident scan, nonblocking advisory admission, 250ms lock wait, unchanged statement timeout. Optional retention is moved out of the critical transaction and throttled to the existing retention policy once a minute. No new retention deletion policy is introduced. Dashboard GET uses cached durable history and immediate live observations, with explicit history/persistence availability.
- `healing/verification.ts`, `controller.ts`, `circuit.ts`: consistent invalid/future/stale rejection and corrected circuit backoff. Existing independent authority, receipts, budgets, leases and representative verification remain.
- `chaos/load.ts`: explicit local HTTP target allowlist, concurrency/duration/RPS/total-request validation, shared pacing, request deadline and cancellation. Fault confirmation waits for actual request dispatch. Ending traffic is never presented as automatic repair.
- `infrastructure/chaos/repair-policy.yml` and Compose wrappers: read freshness and traffic caps from existing environment/configuration without rewriting `.env`. No ports, Docker authority or destructive service targets added.
- Regression files cover schemas, timestamps, auth/request failures, all three five-choice interfaces, modal safety, failed requests, actual stages, queued persistence, failure identity, receipts, invalid limits, rate caps, cancellation and circuit timing. The old Chaos browser count assertion now expects five.
- `scripts/repair-validation.mjs` / `npm run test:repair`: isolated real checks using existing images, owned labels and temporary data. It never attaches user volumes, overwrites `.env` or starts the full user stack.

## 3. The five primary scenarios

| Primary choice                                        | Actual ID / confirmation                | Trigger and detection                                                                                   | Actual recovery / verification                                                                                                                                      | Live evidence this run                                                                                            |
| ----------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| API Server Crash                                      | `crash-api` / `api-1`                   | Existing restricted adapter kills designated API-1; Observer probes and incident                        | Independent `api-start` Healer action; readiness, representative API reads and serving evidence                                                                     | Full target scenario **not run**                                                                                  |
| Redis Service Failure — existing supported substitute | `crash-redis` / `redis`                 | Existing Redis crash, not a connection-only toxic; real PING and API dependency symptoms                | `redis-start`, authenticated PING and both APIs ready; clients reconnect                                                                                            | **Not run**; no Redis keys flushed or volumes removed                                                             |
| Video Gateway Crash                                   | `crash-video-gateway` / `video-gateway` | Existing gateway crash; HTTP/incident evidence                                                          | `gateway-start`; gateway health and advancing authorized HLS segments through the gateway                                                                           | Full target scenario **not run**                                                                                  |
| Network Latency / Connection Disruption               | `network-timeout` / `demo-dependency`   | Existing adapter adds 3500ms downstream latency for 8–30s to the isolated read-only recommendation path | Owned toxic expiry/removal plus circuit protection, half-open reads and verified CLOSED/available response; no Redis restart or Healer container repair claim       | Real adapter/Toxiproxy/circuit mechanism **PASS**; complete administrator-controller/Healer lifecycle **not run** |
| Traffic Surge / Overload                              | `traffic-surge` / `api-tier`            | Bounded local catalog reads; actual latency/error/RPS metrics must establish overload                   | Existing independent `api-scale-out` starts the pre-provisioned API-3; serving evidence and normal-load scale-in verification. Traffic ending alone is not a repair | Real local HTTP rate/cap test **PASS**; full overload/scale-out scenario **not run**                              |

Redis substitution is deliberate: the repository has no existing isolated Redis connection-only proxy path. The current Redis service disables persistence; a crash can lose volatile cache/presence/rate-limit keys and Pub/Sub deliveries, while PostgreSQL chat/user history remains durable. Therefore this substitute does **not** meet strict retention of every in-memory Redis key. Use an isolated demo and review that limitation; a separately verified Redis connection-only adapter is still needed if all keys must survive. No Redis crash was performed in this run.

Load defaults: **8 concurrent clients, 50 requests/s, 3000 total requests, 60 seconds**. Hard validation: at most 1000 clients, 1000 requests/s, 100000 requests and 120 seconds. Existing explicit environment limits are preserved and may differ from defaults. `CHAOS_SURGE_RPS` and `CHAOS_SURGE_MAX_REQUESTS` are configurable; invalid values fail closed. Conservative traffic may not produce overload on a fast host: report the observed result, never lower health evidence requirements to force a success.

## 4. Commands and actual results

| Command                                                  | Exit | Actual result                                                                   |
| -------------------------------------------------------- | ---: | ------------------------------------------------------------------------------- |
| `npm test` before edits                                  |    0 | 249 tests / 23 files                                                            |
| `npm run typecheck` final implementation                 |    0 | Root and all workspaces                                                         |
| `npm run lint` final implementation                      |    0 | Passed                                                                          |
| `npm test` final implementation                          |    0 | 313 tests / 29 files                                                            |
| `npm run build` final implementation                     |    0 | React/Vite and API bundles; existing large-chunk warning remains                |
| `npm run format:check`                                   |    0 | Passed                                                                          |
| `node infrastructure/dynamic/compose.mjs config --quiet` |    0 | Existing generated composition plus repair policy validates                     |
| `node infrastructure/chaos/compose.mjs config --quiet`   |    0 | Validates                                                                       |
| `npm run test:repair` final real isolated run            |    0 | PostgreSQL/Observer, actual failure episode, Toxiproxy/circuit and cleanup pass |
| Earlier isolated latency check                           |    1 | Exposed circuit reset timing; fixed and rerun successfully                      |

Initial compiler/lint/test failures during development were corrected. Mocked tests establish the named logic, not live service recovery. No `npm ci`, complete Docker rebuild or full-stack startup was performed in the repair validation run. Git delivery was separately authorized by the user afterward.

## 5. Live isolated evidence

[Raw actual measurements](ONE_RUN_REPAIR_MEASUREMENTS.json) record the final fixture run, timestamps, PostgreSQL plans and cleanup.

- All **seven real repository migrations** applied to a new temporary PostgreSQL instance.
- Observer uses **streamshield_observer**, prepared by the existing restricted-role setup script. No production grant was widened.
- With the real observer write lock held by the test session, health probes advance, persistence becomes false, both independently checked components retain their actual health, and dashboard GET remains fast. After unlocking, persistence becomes true again.
- A bounded pause/unpause of the labelled read-only fixture while writes were blocked produced one actual detected failure, later RESOLVED, with **one durable incident** after recovery rather than replayed duplicates. This is a persistence test with explicit test restoration, not an autonomous Healer claim.
- PostgreSQL enforced a real statement timeout (`57014`). EXPLAIN shows the existing `monitoring_one_active` index; no speculative index migration or higher statement timeout was needed.
- The existing real fault adapter confirmed an actual Toxiproxy latency toxic. Two timed-out reads opened the existing Circuit; one caller was refused. Adapter expiry removed the owned toxic; two real successful half-open reads closed the Circuit. The final toxic list was empty.
- All three uniquely labelled fixture containers and the fixture network were removed. No original service was stopped. Existing `.env` checksum was unchanged, and no user/named database volume was attached or removed.

## 6. Remaining blockers and operator behavior

The cloud has no running user stack and only about 4.9 GB free under Docker VFS. The full stack contains more than thirty services; attempting it previously exhausted this host's disk. This run deliberately uses small isolated checks rather than repeating that failure. Windows browser authentication, its actual 200 response body, local firewall/ports, full publishing and all five complete live recovery lifecycles remain unverified. Redis connection-only key-preserving failure is also unimplemented as described above.

A refused configuration must stay refused. Inspect the displayed controller/audit/observer/Healer/adapter/component/cooldown reason, `/control/incidents`, `/control/recoveries` and the read-only terminal watcher. A destructive experiment that remains unverified does not become successful when a container merely runs; new injection stays locked until appropriate functional recovery evidence exists. If verification escalates, stop the presentation and investigate the actual incident/playbook/representative endpoint; do not erase journals, reset the database, raise budgets to bypass admission or paint a service green.

## 7. Windows commands without rewriting existing configuration

Use Docker Desktop Linux containers, Node.js 24 and the already configured final branch. Fetch and pull the repair branch, preserving local changes. If a patch was previously applied or unrelated edits prevent checkout/pull, stop and reconcile those edits; do not discard them:

```powershell
Set-Location E:\StreamShield\StreamShield
git status --short --branch
git branch --show-current
git fetch origin feature/final-self-healing-presentation
git switch feature/final-self-healing-presentation
git pull --ff-only origin feature/final-self-healing-presentation
$before = (Get-FileHash .env -Algorithm SHA256).Hash
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
node infrastructure/dynamic/compose.mjs config --quiet
```

Stop if checkout/pull conflicts. Do not reset or overwrite local work. The repairs are based on `2cfea8c`; publishing the branch does not update the Windows drive automatically. If downloading source from GitHub instead, preserve the existing `.env`, `.local` configuration and database volumes; extracting an archive does not perform a safe merge of local edits.

For an **already running, configured final stack**, rebuild only the web image that serves the compiled frontend, then apply only services changed by this repair. These are operational commands for the Windows host; they were not run against its stack here:

```powershell
node infrastructure/dynamic/compose.mjs build web
node infrastructure/dynamic/compose.mjs up -d --no-deps --no-build --force-recreate web api api-2 observer healer chaos-controller chaos-fault-adapter
npm.cmd run final:status
npm.cmd run chaos:probe
npm.cmd run final:watch -- --once
(Get-FileHash .env -Algorithm SHA256).Hash -eq $before
```

For a **stopped but previously configured stack with existing images**, ordinary startup is `node infrastructure/dynamic/compose.mjs up -d --no-build --wait`, then inspect using `final:status`. Do not run a competing `npm run dev` on 5173. Do not run `final:up` or setup helpers as a no-overwrite troubleshooting step: they regenerate configuration and write `.env`. A missing configuration/image or missing stopped API-3 is an explicit prerequisite, not a reason to bypass admission. The existing configured spare can be provisioned with `node infrastructure/dynamic/compose.mjs --profile spare create api-3`; this creates it stopped and retains volumes.

Sign in as an existing administrator. Open **http://localhost:5173/control/chaos**, `/control/demo` or `/control/presentation` (or use the already configured 127.0.0.1 origin consistently). Both allowed origins already exist in the normal local configuration; do not publish private controller APIs. Bare CMD calls without the session cookie remain 401; inspect the logged-in browser's JSON response instead of disabling authorization.

If administrator provisioning is needed, use the existing trusted terminal role command with the actual registered username: `node infrastructure/dynamic/compose.mjs exec -T api-2 node scripts/set-role.mjs YOUR_USERNAME administrator`, then refresh the authenticated browser.

Sequential demo:

1. Wait for fresh real component health, persistence, independent Healer leader, fault adapter, sufficient budgets and an empty active-fault set. Every scenario must show its real readiness reason; traffic additionally requires stopped pre-provisioned API-3 and the required playbook.
2. Start a genuine source from Studio/OBS if demonstrating media; keep the broadcaster open. `npm.cmd run final:demo` is the existing bounded test-pattern publisher and creates its own demo account.
3. Choose API Server Crash; type **api-1**, acknowledge impact and confirm. Watch actual injection, incident, Healer receipt, readiness and representative verification. Wait for verified healthy baseline.
4. Repeat Redis substitute (**redis**) only in an isolated demo accepting volatile Redis-key loss; then Video Gateway (**video-gateway**), Network Latency (**demo-dependency**), and Traffic Surge (**api-tier**), one at a time. Network expiry and traffic end are labelled cleanup; do not call either a Healer restart.
5. If a fault or recovery fails, cancel observation/clean the owned temporary fault using the existing UI, inspect the incident and stop advancing. Crashes require the independent Healer or reviewed operator restoration; cancellation cannot undo them.

Logs: `node infrastructure/dynamic/compose.mjs logs --tail 100 observer healer chaos-controller chaos-fault-adapter`. Keep logs private unless redacted. The focused isolated check is `npm.cmd run test:repair`; it requires the three existing images named in its script and does not rebuild/pull them. Full-stack tests remain `npm.cmd run test:final` on an explicitly owned, healthy, appropriately resourced local demo; they are not represented as passed here. Historical final tests also exercise extended backend scenarios.

Stop the test-pattern terminal with Ctrl+C. Use `npm.cmd run final:down` only when intentionally shutting down your demo, not to investigate a disabled button. Never add `-v` or remove database volumes.

## 8. Final Git state

The user explicitly authorized committing and pushing the reviewed repairs after the initial uncommitted handoff. Delivery uses the existing `feature/final-self-healing-presentation` branch and preserves its history; no force push or automatic merge is authorized. `.env` is unchanged. Only source, tests, configuration examples and evidence belong to the repair commit; credentials, generated bundles, node_modules and local Docker data remain excluded. Live acceptance remains PARTIAL regardless of Git delivery.
