/** Pending evidence is deliberately distinct from a truthy successful result. */
export const pendingFixture = (evidence) => ({ pending: true, evidence });

export function redactFixtureText(value, secrets = []) {
  let text = String(value);
  for (const secret of [...new Set(secrets)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    for (const variant of [
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ])
      text = text.replaceAll(variant, "[redacted]");
  return text
    .replace(/(\b[a-z][\w+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/gi, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(
      /([?&](?:pass(?:word)?|token|key|secret)=)[^\s&#]*/gi,
      "$1[redacted]",
    );
}

export function fixtureError(error, redact = String) {
  const clip = (value) => redact(String(value)).slice(-4000);
  const result = {
    name: clip(error?.name || "Error"),
    message: clip(error?.message || "Unknown fixture error"),
  };
  for (const key of ["code", "status", "httpStatus", "signal"])
    if (["string", "number"].includes(typeof error?.[key]))
      result[key] = clip(error[key]);
  if (error?.cause && error.cause !== error)
    result.cause = {
      message: clip(error.cause.message || "Underlying request failed"),
      code: clip(error.cause.code || "unknown"),
    };
  if (error?.stderr?.length) result.stderr = clip(error.stderr);
  return result;
}

/** Preserve the probe's last exception even if subsequent probes just say pending.
 * All callers name their stage; no callback is allowed to swallow its exception. */
export function fixtureWaiter(
  result,
  {
    redact = String,
    guard = () => {},
    onStage = () => {},
    now = () => performance.now(),
    wall = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  return async (stage, probe, timeoutMs = 90000) => {
    result.currentStage = stage;
    onStage(stage);
    const started = now();
    const record = {
      stage,
      status: "WAITING",
      startedAt: new Date(wall()).toISOString(),
      timeoutMs,
      attempts: 0,
    };
    (result.waits ||= []).push(record);
    const finish = (status) => {
      record.status = status;
      record.elapsedMs = now() - started;
      record.finishedAt = new Date(wall()).toISOString();
    };
    while (now() - started < timeoutMs) {
      try {
        await guard();
      } catch (error) {
        record.lastError = fixtureError(error, redact);
        record.lastErrorAt = new Date(wall()).toISOString();
        finish("FAIL");
        throw error;
      }
      record.attempts++;
      try {
        const value = await probe();
        if (value && value.pending !== true) {
          finish("PASS");
          return value;
        }
        record.lastObservation = JSON.parse(
          redact(
            JSON.stringify(value?.pending ? value.evidence : { ready: false }),
          ),
        );
        record.lastObservationAt = new Date(wall()).toISOString();
      } catch (error) {
        record.lastError = fixtureError(error, redact);
        record.lastErrorAt = new Date(wall()).toISOString();
      }
      await sleep(500);
    }
    finish("FAIL");
    const error = new Error(
      "fixture_wait_timeout:" +
        stage +
        (record.lastError ? ": " + record.lastError.message : ""),
    );
    error.stage = stage;
    throw error;
  };
}

export function fixtureAdmission(snapshot, ids) {
  if (!Array.isArray(snapshot?.scenarios))
    throw Error("invalid_scenario_catalog");
  const missing = ids.filter(
    (id) => !snapshot.scenarios.some((s) => s.id === id),
  );
  const denied = snapshot.scenarios
    .filter((s) => ids.includes(s.id) && s.available !== true)
    .map(({ id, reason }) => ({ id, reason }));
  if (missing.length || denied.length || snapshot.available !== true)
    return pendingFixture({
      missing,
      denied,
      available: snapshot.available,
      unavailableReason: snapshot.unavailableReason || null,
      activeId: snapshot.activeId || null,
    });
  return { observedAt: snapshot.observedAt, scenarioIds: ids };
}

/** These pinned monitoring images run without root. Named volumes initialize
 * ownership from the image; disposable tmpfs replacements must do so explicitly. */
export function fixtureDataTmpfs(service, target) {
  const owner =
    service === "prometheus"
      ? ",uid=65534,gid=65534"
      : service === "grafana"
        ? ",uid=472,gid=0"
        : "";
  return target + ":rw,size=256m" + owner;
}

export function fixtureServiceState(service, container, redact = String) {
  const state = container.State;
  return {
    service,
    status: state.Status,
    exitCode: state.ExitCode,
    oom: state.OOMKilled,
    startedAt: state.StartedAt,
    finishedAt: state.FinishedAt,
    restartCount: container.RestartCount,
    health: state.Health?.Status || null,
    recentHealth:
      state.Health?.Log?.slice(-3).map((x) => ({
        start: x.Start,
        end: x.End,
        exit: x.ExitCode,
        output: redact(String(x.Output)).slice(-2000),
      })) || [],
  };
}

/** Safe startup markers only: no arbitrary log message, command or environment. */
export function fixtureStartupEvents(logs, redact = String) {
  const stages = new Set([
    "api_configuration",
    "platform_configuration",
    "resources",
    "postgres",
    "redis",
    "platform_routes",
    "realtime",
    "public_listener",
    "media_auth_listener",
  ]);
  return redact(String(logs))
    .split("\n")
    .flatMap((line) => {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return [];
      }
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      if (
        row.event === "fixture_runtime_import" &&
        ["STARTING", "IMPORTED", "FAILED"].includes(row.state)
      )
        return [
          {
            event: row.event,
            state: row.state,
            ...(row.state === "FAILED" &&
            typeof row.code === "string" &&
            /^[A-Z0-9_]{2,60}$/.test(row.code || "")
              ? { code: row.code }
              : {}),
          },
        ];
      if (
        row.event === "fixture_startup_step" &&
        stages.has(row.stage) &&
        ["STARTING", "COMPLETE", "FAILED"].includes(row.state)
      )
        return [{ event: row.event, stage: row.stage, state: row.state }];
      if (row.event === "api_startup_failed" && stages.has(row.stage))
        return [
          {
            event: row.event,
            stage: row.stage,
            codes: (Array.isArray(row.failures) ? row.failures : [])
              .map((f) => f?.code)
              .filter(
                (code) =>
                  typeof code === "string" && /^[A-Z0-9_]{2,60}$/.test(code),
              ),
          },
        ];
      return [];
    })
    .slice(-16);
}
