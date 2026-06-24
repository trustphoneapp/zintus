import type { ErrorHook } from "./handler.js";

/**
 * Build an optional error sink for the gateway's `onError` hook.
 *
 * Wiring is entirely opt-in and dependency-free by default:
 *   - SENTRY_DSN set  → lazily load `@sentry/node` and report exceptions.
 *   - neither set      → returns `undefined`, i.e. exactly today's behaviour
 *     (errors still go to the structured JSON log via the handler), with zero
 *     overhead and no extra dependency required to run the gateway.
 *
 * `@sentry/node` is imported through a non-literal specifier so the gateway
 * typechecks and runs even when the package isn't installed. It only needs to
 * be present in environments that actually set SENTRY_DSN.
 */
export function createErrorSink(
  env: NodeJS.ProcessEnv = process.env,
  log?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void,
): ErrorHook | undefined {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) {
    return undefined;
  }

  // Initialise lazily and asynchronously. Errors that arrive before the dynamic
  // import resolves are held in a small bounded buffer and flushed once the
  // client is ready, so early-boot failures aren't silently dropped. If the
  // package is missing we degrade to the structured log.
  let captureException:
    | ((error: unknown, hint?: Record<string, unknown>) => void)
    | null = null;
  let initFailed = false;
  const MAX_PENDING = 50;
  const pending: Array<{ error: unknown; hint: Record<string, unknown> }> = [];

  const report = (error: unknown, hint: Record<string, unknown>): void => {
    if (captureException) {
      captureException(error, hint);
    } else if (!initFailed && pending.length < MAX_PENDING) {
      pending.push({ error, hint });
    }
  };

  const specifier = "@sentry/node";
  void (async () => {
    try {
      const Sentry = (await import(specifier)) as {
        init: (opts: Record<string, unknown>) => void;
        captureException: (error: unknown, hint?: Record<string, unknown>) => void;
      };
      Sentry.init({
        dsn,
        environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "production",
        tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0") || 0,
      });
      captureException = Sentry.captureException.bind(Sentry);
      // Flush anything captured during the init window.
      for (const item of pending.splice(0)) {
        captureException(item.error, item.hint);
      }
      log?.("info", "observability.sentry_ready", {});
    } catch (error) {
      initFailed = true;
      pending.length = 0;
      log?.("warn", "observability.sentry_init_failed", {
        hint: "SENTRY_DSN is set but @sentry/node could not be loaded; install it to enable error tracking.",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return (error, context) => {
    report(error, {
      tags: { path: context.path },
      extra: { requestId: context.requestId },
    });
  };
}
