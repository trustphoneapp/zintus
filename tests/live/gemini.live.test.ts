/**
 * Opt-in live end-to-end test. It hits the real Gemini API and is therefore NOT
 * part of `bun run test` (which must stay offline and never touch the network or
 * a real keychain). Run it explicitly with a key:
 *
 *   GEMINI_API_KEY=... bun run test:live
 *
 * Without GEMINI_API_KEY set it skips, so it is safe to wire into CI behind a
 * secret without breaking forks/PRs that have none.
 */
import { describe, expect, test } from "bun:test";
import { geminiProvider } from "@zintus/providers";
import type { TokenUsage } from "@zintus/types";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const describeLive = GEMINI_API_KEY ? describe : describe.skip;

describeLive("live: Gemini provider", () => {
  test("returns non-empty content and provider usage tokens", async () => {
    const result = await geminiProvider.streamChat(
      [{ role: "user", content: "Reply with the single word: pong" }],
      { apiKey: GEMINI_API_KEY ?? undefined },
    );

    let output = "";
    let usage: TokenUsage | null = result.usage ?? null;
    for await (const chunk of result.stream) {
      if (chunk.content) {
        output += chunk.content;
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    expect(output.trim().length).toBeGreaterThan(0);
    expect(usage).not.toBeNull();
    expect(usage?.totalTokens).toBeGreaterThan(0);
    expect(usage?.inputTokens).toBeGreaterThan(0);
  }, 30_000);
});
