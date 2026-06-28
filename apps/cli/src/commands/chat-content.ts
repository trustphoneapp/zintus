/**
 * Pure, side-effect-free helpers for the `chat --image` path. Kept out of
 * chat.ts (which pulls in the engine/keychain) so they're unit-testable on
 * their own.
 *
 * SECURITY: image bytes / base64 NEVER enter a log line, a thrown message, or
 * the terminal. `@zintus/media` already guarantees its errors carry only sizes
 * and mime labels; we only ever add the user-supplied file PATH (safe). We also
 * never inject a synthetic `[Image: name]` text marker — the image rides as a
 * structured content block, not as prose.
 */
import { MediaError, processImage } from "@zintus/media";
import type { ContentBlock, ImageContentBlock } from "@zintus/types";

/** A single chat message accepts at most this many attached images. */
export const MAX_IMAGES = 4;

/**
 * Build the user message content. With no images this returns the plain prompt
 * string (the original, unchanged text-only shape). With images it returns an
 * ordered block array: the TEXT PROMPT FIRST, then each image in the order the
 * user passed `--image`. No base64 is logged or injected as text here.
 */
export function buildChatContent(
  prompt: string,
  images: ImageContentBlock[],
): string | ContentBlock[] {
  if (images.length === 0) return prompt;
  const blocks: ContentBlock[] = [{ type: "text", text: prompt }, ...images];
  return blocks;
}

/**
 * Turn a failed image load into a clear, actionable, base64-free message. The
 * file path is the only user data we echo. `@zintus/media` throws a typed
 * {@link MediaError}; a missing/unreadable file surfaces as a Node fs error
 * (carrying a `.code`) instead.
 */
export function describeImageError(path: string, error: unknown): string {
  if (error instanceof MediaError) {
    switch (error.code) {
      case "UNSUPPORTED_TYPE":
        return `Unsupported image type: ${path}\n  ${error.message}`;
      case "DIMENSIONS_TOO_LARGE":
      case "OUTPUT_TOO_LARGE":
        return (
          `Image too large to send as-is: ${path}\n  ${error.message}\n` +
          `  Resize/compress it first (longest edge <= 2048px, <= 4MB), then retry.`
        );
      case "INPUT_TOO_LARGE":
        return `Image file too large: ${path}\n  ${error.message}`;
      case "EMPTY_INPUT":
        return `Image file is empty: ${path}`;
      case "DECODE_FAILED":
        return `Image looks corrupt or truncated: ${path}\n  ${error.message}`;
      case "UNSUPPORTED_INPUT":
      default:
        return `Could not process image: ${path}\n  ${error.message}`;
    }
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  if (code === "ENOENT") return `Image not found: ${path}`;
  if (code === "EISDIR") return `Not a file (it's a directory): ${path}`;
  if (code === "EACCES") return `Cannot read image (permission denied): ${path}`;
  const detail = error instanceof Error ? `\n  ${error.message}` : "";
  return `Could not read image: ${path}${detail}`;
}

/**
 * Load and process up to {@link MAX_IMAGES} image paths into vision-ready
 * `ImageContentBlock`s via the Node `@zintus/media` path (magic-byte mime
 * detection + genuine EXIF/metadata strip). The Node path CANNOT downscale or
 * re-compress, so an over-size source is REJECTED (resize first) rather than
 * silently passed through. Throws an `Error` with a clear, base64-free message
 * on the first failure; preserves input order in the output.
 */
export async function loadImages(paths: string[]): Promise<ImageContentBlock[]> {
  if (paths.length > MAX_IMAGES) {
    throw new Error(
      `Too many images: ${paths.length} given, but a single message accepts at most ${MAX_IMAGES}. ` +
        `Send fewer --image flags.`,
    );
  }
  const blocks: ImageContentBlock[] = [];
  for (const path of paths) {
    try {
      blocks.push(await processImage({ path }));
    } catch (error) {
      throw new Error(describeImageError(path, error));
    }
  }
  return blocks;
}

/**
 * Honest per-turn quota line. `used` is the tokens spent against this provider's
 * free tier today (the engine's `tokensToday`); `limit` is the provider's daily
 * cap. The cap is `null`/`undefined` when the engine has no reported denominator
 * — in that case we say "limit unknown" and NEVER fabricate one (the audit
 * flagged the old code inventing a 1,000,000 denominator). Returns `null` when
 * there is no usage figure at all (so the caller omits the line entirely).
 */
export function formatQuotaUsage(
  used: number | undefined,
  limit: number | null | undefined,
): string | null {
  if (used == null) return null;
  if (limit == null) {
    return `quota ${used.toLocaleString()} tok used today (limit unknown)`;
  }
  return `quota ${used.toLocaleString()}/${limit.toLocaleString()} tok`;
}

/** Per-turn transparency facts, mirroring the gateway's `metadata` frame. Every
 *  numeric field is optional: the engine only reports what it actually measured,
 *  and the renderer omits anything absent rather than inventing a value. */
export interface TurnFacts {
  /** Display name for the winning provider (falls back to its id). */
  providerLabel: string;
  /** Concrete model the request routed to. */
  model: string;
  /** The "why this provider/model" headline from the engine's route trace. */
  routeReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Estimate-only USD this turn would cost on a paid API (0 on free tiers). */
  costUsd?: number;
  /** Tokens spent against this provider's free tier today. */
  quotaUsed?: number;
  /** Provider's daily token cap — `null`/`undefined` when not reported. */
  quotaLimit?: number | null;
}

/**
 * Render the post-turn transparency summary the CLI prints after a chat reply:
 * provider · model, the route-reason headline, then the real per-turn facts
 * (tokens in/out, cost estimate, quota). HONEST BY CONSTRUCTION: each fact is
 * emitted only when present, costs show "$0 (free tier)" rather than a fake
 * charge, and the quota denominator is the engine's real value or "unknown" —
 * never a fabricated 1,000,000. Returns plain text (no ANSI) so it is directly
 * unit-testable; the caller applies any colouring.
 */
export function formatTurnSummary(facts: TurnFacts): string {
  const lines: string[] = [];
  lines.push(
    facts.model
      ? `${facts.providerLabel} · ${facts.model}`
      : facts.providerLabel,
  );
  const reason = facts.routeReason?.trim();
  if (reason) {
    lines.push(`why: ${reason}`);
  }
  const parts: string[] = [];
  if (facts.inputTokens != null && facts.outputTokens != null) {
    parts.push(
      `${facts.inputTokens.toLocaleString()} in / ${facts.outputTokens.toLocaleString()} out tok`,
    );
  }
  if (facts.costUsd != null) {
    parts.push(
      facts.costUsd > 0 ? `~$${facts.costUsd.toFixed(4)} est` : "$0 (free tier)",
    );
  }
  const quota = formatQuotaUsage(facts.quotaUsed, facts.quotaLimit);
  if (quota) parts.push(quota);
  if (parts.length > 0) {
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

/**
 * Map a routing/engine error to a clear user-facing string. The router throws a
 * bare `unsupported_capability` when an image request can't reach a
 * vision-capable provider/model; we turn that into the honest capability error
 * with actionable provider suggestions (mirrors the gateway's
 * UNSUPPORTED_VISION_ERROR — no upsell, just what to do). Any other error is
 * returned verbatim.
 */
export function normalizeChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "unsupported_capability") {
    return [
      "Image input requires a vision-capable provider or local vision model.",
      "None of your available providers can see images. Try one of:",
      "  • gemini     — add a Gemini API key for image understanding",
      "  • openrouter — pick a vision-capable OpenRouter model",
      "  • ollama     — run a local vision model (LLaVA, Qwen-VL, Moondream, Gemma vision)",
    ].join("\n");
  }
  return message;
}
