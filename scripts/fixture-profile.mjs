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

/** Compact fixtures do not create API-3. Keep the real two API peers and auth
 * routing intact rather than asking Docker DNS for an omitted spare. */
export function demoWithoutSpareApi(config, port) {
  const declaration = `server api-3:${Number(port)} resolve max_fails=1 fail_timeout=5s;`;
  if (!Number.isInteger(Number(port)) || config.split(declaration).length !== 2)
    throw Error("demo_spare_api_declaration_missing_or_ambiguous");
  return config.replace(declaration, "");
}

/** Protect both real HLS routes, including new segment requests. Health remains
 * a process probe; an unavailable signing authority is a separate prerequisite. */
export function demoMediaAuthority(config, port) {
  const marker = "location ~ ^/(primary|standby)/ {";
  if (config.split(marker).length !== 2 || !Number.isInteger(Number(port)))
    throw Error("demo_media_gate_config_drift");
  return config.replace(
    marker,
    `
    location = /_demo_media_authority {
      internal;
      set $demo_authority http://chaos-controller:${Number(port)};
      proxy_pass $demo_authority/media-access;
      proxy_pass_request_body off;
      proxy_set_header Content-Length '';
      proxy_set_header Cookie '';
      proxy_set_header Authorization '';
      proxy_connect_timeout 2s;
      proxy_read_timeout 3s;
    }
    location @demo_authority_unavailable {
      add_header X-Media-Authority unavailable always;
      add_header Cache-Control no-store always;
      return 503;
    }
    ${marker}
      auth_request /_demo_media_authority;
      error_page 401 403 = @demo_authority_unavailable;
  `,
  );
}
