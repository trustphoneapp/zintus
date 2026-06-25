/**
 * Relay error sink — opt-in, zero-dependency, Workers-native.
 *
 * Mirrors the gateway's opt-in pattern (apps/gateway/src/observability.ts:
 * SENTRY_DSN set → report, unset → no-op) but adapted for a Cloudflare Worker:
 *   - The relay cannot pull in `@sentry/node` (Node-only) or add a hard
 *     dependency, so instead of dynamically importing an SDK we POST a minimal
 *     Sentry *envelope* directly to the DSN's ingest endpoint with `fetch`.
 *     This is the documented transport Sentry SDKs use under the hood and works
 *     in any runtime with `fetch` + WebCrypto.
 *   - When SENTRY_DSN is unset (or malformed) `createErrorSink` returns
 *     `undefined` → exactly today's behaviour (errors still hit the structured
 *     `console.error` in index.ts), with zero overhead and no dependency.
 *
 * PII/secrets: every string that reaches the payload is passed through
 * `redactSecrets`, and we deliberately send only the error type/message/stack
 * plus the request *pathname* (never the query string, body, headers, cookies
 * or user identity), so tokens in URLs and key material in messages can't leak.
 *
 * Refs (transport/shape, not copied):
 *   - Sentry Envelopes: https://develop.sentry.dev/sdk/data-model/envelopes/
 *   - Sentry for Cloudflare Workers (@sentry/cloudflare / toucan-js are the
 *     heavyweight equivalents): https://docs.sentry.io/platforms/javascript/guides/cloudflare/
 */

import { redactSecrets } from "./redact.js";

export interface ErrorContext {
  path?: string;
  method?: string;
}

export type ErrorReporter = (error: unknown, ctx: ErrorContext) => Promise<void>;

interface ParsedDsn {
  publicKey: string;
  ingestUrl: string;
}

/** Parse `https://<publicKey>@<host>/<projectId>` → ingest envelope URL. */
function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\/+/, "");
    if (!publicKey || !projectId) return null;
    return {
      publicKey,
      ingestUrl: `${u.protocol}//${u.host}/api/${projectId}/envelope/`,
    };
  } catch {
    return null;
  }
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Build a single-event Sentry envelope (newline-delimited JSON), fully redacted. */
function buildEnvelope(
  error: unknown,
  ctx: ErrorContext,
  environment: string,
): { eventId: string; body: string } {
  const eventId = randomHex(16);
  const now = new Date();

  const type = error instanceof Error ? error.name || "Error" : "Error";
  const rawValue = error instanceof Error ? error.message : String(error);
  const rawStack = error instanceof Error ? error.stack ?? "" : "";

  const event = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: "javascript",
    level: "error",
    logger: "zintus-relay",
    environment,
    transaction: ctx.path,
    tags: { path: ctx.path ?? "", method: ctx.method ?? "" },
    exception: {
      values: [{ type, value: redactSecrets(rawValue) }],
    },
    extra: rawStack ? { stack: redactSecrets(rawStack) } : {},
  };

  const envelopeHeader = JSON.stringify({ event_id: eventId, sent_at: now.toISOString() });
  const itemHeader = JSON.stringify({ type: "event" });
  return { eventId, body: `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}` };
}

// Memoise the parsed DSN → reporter so we don't re-parse on every error.
let memo: { dsn: string; reporter: ErrorReporter | undefined } | null = null;

/**
 * Returns an error reporter when `SENTRY_DSN` is configured, else `undefined`
 * (a true no-op — the caller skips reporting entirely). The reporter never
 * throws: a failed/blocked ingest must not turn into a second error.
 */
export function createErrorSink(env: {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
}): ErrorReporter | undefined {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return undefined;

  if (memo && memo.dsn === dsn) return memo.reporter;

  const parsed = parseDsn(dsn);
  const environment = env.SENTRY_ENVIRONMENT?.trim() || "production";

  const reporter: ErrorReporter | undefined = parsed
    ? async (error, ctx) => {
        try {
          const { body } = buildEnvelope(error, ctx, environment);
          await fetch(parsed.ingestUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-sentry-envelope",
              "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=zintus-relay/0.1.0`,
            },
            body,
          });
        } catch {
          // Never throw from the error path.
        }
      }
    : undefined;

  memo = { dsn, reporter };
  return reporter;
}
