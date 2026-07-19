import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 1_048_576;
const MAX_PAST_AGE_MS = 300_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const REPLAY_TTL_MS = 300_000;
const SIGNATURE_PREFIX = "sha256=";
const SIGNATURE_LENGTH = SIGNATURE_PREFIX.length + 64;
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;
const textEncoder = new TextEncoder();

export type WebhookVerificationErrorCode =
  | "INVALID_TIMESTAMP"
  | "TIMESTAMP_EXPIRED"
  | "TIMESTAMP_IN_FUTURE"
  | "BODY_TOO_LARGE"
  | "MISSING_SIGNATURE"
  | "MALFORMED_SIGNATURE"
  | "INVALID_SIGNATURE"
  | "REPLAYED"
  | "REPLAY_STORE_ERROR";

export type WebhookVerificationResult =
  | { ok: true }
  | { ok: false; code: WebhookVerificationErrorCode };

export interface WebhookReplayStore {
  claim(key: string, ttlMs: number): Promise<boolean>;
}

export interface VerifyWebhookOptions {
  timestamp: number;
  body: string;
  signatureHeader: string | undefined;
  key: Uint8Array;
  now: number;
  replayStore: WebhookReplayStore;
}

/** Verifies a signed webhook and atomically reserves its replay identity. */
export async function verifyWebhook({
  timestamp,
  body,
  signatureHeader,
  key,
  now,
  replayStore,
}: VerifyWebhookOptions): Promise<WebhookVerificationResult> {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(now) || now < 0) {
    return { ok: false, code: "INVALID_TIMESTAMP" };
  }

  // Subtract only after ordering the operands. The nonnegative difference of
  // two safe nonnegative integers is itself safe, unlike `now + skew` near the
  // upper safe-integer boundary.
  if (timestamp <= now) {
    if (now - timestamp > MAX_PAST_AGE_MS) return { ok: false, code: "TIMESTAMP_EXPIRED" };
  } else if (timestamp - now > MAX_FUTURE_SKEW_MS) {
    return { ok: false, code: "TIMESTAMP_IN_FUTURE" };
  }

  const bodyBytes = textEncoder.encode(body);
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return { ok: false, code: "BODY_TOO_LARGE" };
  if (signatureHeader === undefined) return { ok: false, code: "MISSING_SIGNATURE" };

  // `$` can match before a terminal line terminator in JavaScript. The exact
  // byte-length gate makes newline-suffixed signatures unambiguously malformed.
  if (signatureHeader.length !== SIGNATURE_LENGTH) return { ok: false, code: "MALFORMED_SIGNATURE" };
  const signatureMatch = SIGNATURE_PATTERN.exec(signatureHeader);
  if (signatureMatch === null) return { ok: false, code: "MALFORMED_SIGNATURE" };

  const canonicalBytes = textEncoder.encode(`${timestamp}.${body}`);
  const expectedDigest = createHmac("sha256", key).update(canonicalBytes).digest();
  const suppliedDigest = Buffer.from(signatureMatch[1]!, "hex");
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) return { ok: false, code: "INVALID_SIGNATURE" };

  const replayKey = `zintus:webhook:replay:v1:${createHash("sha256").update(canonicalBytes).digest("hex")}`;
  try {
    if (!(await replayStore.claim(replayKey, REPLAY_TTL_MS))) return { ok: false, code: "REPLAYED" };
  } catch {
    return { ok: false, code: "REPLAY_STORE_ERROR" };
  }
  return { ok: true };
}
