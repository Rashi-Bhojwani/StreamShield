import type { Server } from "node:http";

export type StartupStage =
  | "api_configuration"
  | "platform_configuration"
  | "resources"
  | "postgres"
  | "redis"
  | "platform_routes"
  | "realtime"
  | "public_listener"
  | "media_auth_listener";

export class StartupFailure extends Error {
  constructor(
    readonly stage: StartupStage,
    cause: unknown,
  ) {
    super("API startup failed at " + stage, { cause });
    this.name = "StartupFailure";
  }
}

export async function startupStep<T>(stage: StartupStage, run: () => T) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StartupFailure) throw error;
    throw new StartupFailure(stage, error);
  }
}

/** Only serialize reviewed error fields. Never pass a driver error, Zod input,
 * environment object or SQL detail to the logger's generic error serializer. */
export function startupDiagnostic(
  error: unknown,
  env: Record<string, string | undefined>,
) {
  const values = Object.entries(env)
    .filter(
      ([key, value]) =>
        /PASSWORD|SECRET|TOKEN|CREDENTIAL|AUTHORIZATION|COOKIE|(?:^|_)KEY$/i.test(
          key,
        ) && Boolean(value),
    )
    .flatMap(([, value]) => [value!, encodeURIComponent(value!)])
    .sort((a, b) => b.length - a.length);
  const clean = (input: string) => {
    let text = input;
    for (const value of values) text = text.replaceAll(value, "[redacted]");
    return text
      .replace(/(\b[a-z][\w+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/gi, "$1[redacted]@")
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
      .replace(
        /([?&](?:pass(?:word)?|token|key|secret)=)[^\s&#]*/gi,
        "$1[redacted]",
      )
      .split("")
      .filter((character) => {
        const code = character.charCodeAt(0);
        return (code >= 32 && code !== 127) || [9, 10, 13].includes(code);
      })
      .join("")
      .slice(0, 3000);
  };
  const failures: {
    type: string;
    message: string;
    code?: string;
    stack?: string;
  }[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && failures.length < 4 && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      failures.push({
        type: /^[A-Za-z][\w]{0,60}$/.test(current.name)
          ? clean(current.name)
          : "Error",
        message: clean(current.message),
        ...(typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)
          ? { code: clean(code) }
          : {}),
        ...(current.stack
          ? { stack: clean(current.stack.split("\n").slice(0, 6).join("\n")) }
          : {}),
      });
      current = current.cause;
    } else {
      failures.push({
        type: "UnknownError",
        message: "Non-Error startup failure; raw value withheld",
      });
      break;
    }
  }
  return {
    event: "api_startup_failed",
    stage: error instanceof StartupFailure ? error.stage : "bootstrap",
    instanceId: /^[a-zA-Z0-9_-]{1,40}$/.test(env.API_INSTANCE_ID || "")
      ? clean(env.API_INSTANCE_ID!)
      : "api",
    failures,
  };
}

/** A listener is not ready until binding succeeds; EADDRINUSE must reject startup. */
export function listenReady(server: Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    const remove = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      remove();
      reject(error);
    };
    const onListening = () => {
      remove();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      remove();
      reject(error);
    }
  });
}
