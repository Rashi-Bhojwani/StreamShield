#!/usr/bin/env node
// Public entry point for owned, disposable chaos demonstrations. Actual fault
// authority and recovery verification remain in the existing isolated runner.
import { fileURLToPath } from "node:url";

const usage = `StreamShield chaos demonstration

Usage:
  npm run chaos -- --interactive  Open the signed-in live demo and five failure controls.
  npm run chaos -- --verify       Inject and verify four faults in a new disposable fixture.
  npm run chaos -- --help         Print this help without starting Docker services.

Interactive controls require administrator access, impact acknowledgement and
the exact typed target. Automated verification creates its own sample source,
accounts and ss-light-* project, then applies real API/gateway/edge crashes and
a bounded recommendation-network fault. The fifth, manual-authorization failure
is available interactively; it is not claimed as an automatic repair.

Only disposable fixtures are targets. The persistent streamshield-main app is
outside this runner's fault scope. No arbitrary host, project or service target
is accepted. Keep one fixture at a time and wait for READY before using buttons.
Results: test-results/light-four/measurements.json (automated) or
         test-results/light-demo/measurements.json (interactive).
Setup:   docs/WINDOWS_LOCAL_STUDIO.md
`;

const args = process.argv.slice(2);
if (!args.length || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
  console.log(usage);
} else if (
  args.length !== 1 ||
  !["--interactive", "--verify"].includes(args[0])
) {
  console.error(
    "Choose exactly one documented mode. Arbitrary targets are not supported.\n\n" +
      usage,
  );
  process.exitCode = 2;
} else {
  // Supported probe budgets; respect explicit operator overrides. Import in this
  // process so Windows Ctrl+C reaches the runner's existing cleanup handlers.
  process.env.OBS_INTERVAL_MS ??= "4000";
  process.env.OBS_TIMEOUT_MS ??= "3000";
  process.env.OBS_STALE_MS ??= "20000";
  process.env.HEALER_PROBE_TIMEOUT_MS ??= "3000";
  process.env.CHAOS_PROBE_TIMEOUT_MS ??= "3000";
  const runner = new URL("./light-demo.mjs", import.meta.url);
  process.argv = [
    process.execPath,
    fileURLToPath(runner),
    ...(args[0] === "--interactive" ? ["--interactive"] : []),
  ];
  await import(runner.href);
}
