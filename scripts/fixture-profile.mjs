/** Compact mode retains independent fault targets and live media verification.
 * It omits optional telemetry and shares trusted control processes only. */
export function fixtureProfile(args) {
  const crashOnly = args.includes("--only-crashes");
  const lightweight = args.includes("--lightweight");
  const interactive = args.includes("--interactive");
  const smoke = args.includes("--smoke");
  if (
    (crashOnly && lightweight) ||
    (interactive && !lightweight) ||
    (smoke && !interactive)
  )
    throw Error("invalid_demo_profile");
  const compact = crashOnly || lightweight;
  return {
    crashOnly,
    lightweight,
    compact,
    interactive,
    smoke,
    minimumGB: (driver) => (driver === "vfs" && !compact ? 8 : 4),
    label: lightweight
      ? "streamshield.light-run"
      : crashOnly
        ? "streamshield.two-run"
        : "streamshield.four-run",
    projectPrefix: lightweight
      ? "ss-light-"
      : crashOnly
        ? "ss-two-"
        : "ss-four-",
    output: interactive
      ? "test-results/light-demo"
      : lightweight
        ? "test-results/light-four"
        : crashOnly
          ? "test-results/two-scenario"
          : "test-results/four-scenario",
  };
}

/** Change only the disposable demo gateway; never the user's generated config. */
export function demoBackupEdge(config, host, port) {
  const declaration = `server ${host}:${port} `;
  if (config.split(declaration).length !== 2)
    throw Error("demo_backup_edge_declaration_missing_or_ambiguous");
  return config.replace(declaration, declaration + "backup ");
}
