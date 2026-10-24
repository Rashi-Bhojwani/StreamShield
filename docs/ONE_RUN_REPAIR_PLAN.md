# One-run repair plan

Work on the requested `feature/final-self-healing-presentation` baseline `2cfea8c`. Initial working tree was clean. Preserve the user's `.env`, named volumes, all history and additional backend scenarios. Do not commit or push without subsequent explicit user authorization.

## Confirmed code defects

- `useChaos` trusts an unchecked TypeScript cast, accepts future timestamps and uses a hardcoded 12s threshold. Errors appear as controller outages; Presentation buttons ignore overall freshness.
- All primary pages expose more than five scenarios. The primary catalog will be shared and select crash-api, crash-redis, crash-video-gateway, network-timeout and traffic-surge without deleting backend capabilities. Redis service crash is the existing supported substitute for a connection-only failure, which currently has no isolated Redis network adapter. This substitute cannot guarantee retention of volatile Redis keys; the results document that limitation explicitly.
- Observer health probing waits for per-component SQL persistence/maintenance and publication. Slow writes can starve observations. `/snapshot` depends on durable SQL reads even when fresh in-memory observations exist. Separate probe time, durability and optional dashboard/event transport.
- Admission collapses observer/healer/persistence/adapter failures into one vague prerequisite; timestamps can be future-dated on server paths as well.
- The load generator has a time bound and concurrency setting but no explicit shared request-rate/total-request bound or hard validation at its entry point.

## Implementation

1. Shared runtime snapshot validation, timestamp/freshness utility and exactly-five primary catalog. Return server time and configured observation TTL; browser freshness uses monotonic elapsed time to avoid Windows/browser clock offsets.
2. Accurate frontend authentication, transport, contract, controller, audit, stale, conflicting-experiment and scenario-specific denial messages. Recheck the latest admission state when confirming a dialog. Keep historical results visibly distinct from current readiness.
3. Non-overlapping probes with a single coalescing asynchronous persistence writer. Preserve pending failure evidence across failed writes and avoid acknowledging observations that arrived during a write. Separate optional delivery/maintenance from durable writes. Return fresh component health during persistence outages, with explicit failed persistence and unknown durable incident counts.
4. Reduce avoidable write amplification; inspect real SQL/indexes and use bounded lock waits, not increased timeouts. Share freshness semantics across observer, verifier, admission and UI.
5. Strict bounded local surge inputs, global RPS/request caps, deadline abort and reliable cancellation. Preserve the existing independent Healer, typed targets, audit journal, cooldown, budgets, confirmation and recovery verification.
6. Regression tests for timestamps, schemas, disabled reasons, confirmation, persistence failure/backpressure, admission, cleanup, live five-card UI and load safety. Run lint, formatting, typecheck, build and existing tests.

## Validation constraints

There are no running local services. The cloud host uses Docker VFS and has only about 4.9 GB free; the full topology previously exhausted this host's disk. Do not rebuild/start all services, alter the existing `.env`, stop unrelated services or delete volumes. Use bounded isolated real database/protocol checks where feasible and clearly separate them from mocked tests and historical evidence. No live five-scenario claim without actual injection, observation and verified restoration in this run. Document the Windows configured-stack commands and exact remaining validation blockers.

## Outcome

Implementation and 313 regression tests pass, along with lint/typecheck/build/format and both Compose validations. Real isolated validation passes using the restricted Observer database role: slow persistence does not block probes/GET, one buffered failure episode persists once, a real statement timeout is enforced, and an actual bounded latency toxic expires with verified Circuit recovery. The full five-scenario live presentation remains unverified due to the resource and Windows-access limits; see [actual report](ONE_RUN_REPAIR_RESULTS.md). The initial repair run did not commit or push. The user subsequently explicitly authorized committing and pushing the reviewed repairs on the same branch.
