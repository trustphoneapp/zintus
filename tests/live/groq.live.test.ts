/**
 * Opt-in live end-to-end test. It hits a real provider and is therefore NOT part
 * of `bun run test` (which must stay offline and never touch the network or a
 * real keychain). Run it explicitly with a key:
 *
 *   GROQ_API_KEY=gsk_... bun run test:live
 *
 * Without GROQ_API_KEY set it skips, so it is safe to wire into CI behind a
 * secret without breaking forks/PRs that have none.
 */
import { describe, expect, test } from "bun:test";
import { createRouter } from "@multipleai/router";

const GROQ_API_KEY = process.env.GROQ_API_KEY?.trim();
const describeLive = GROQ_API_KEY ? describe : describe.skip;

describeLive("live: Groq via the router", () => {
  test("streams a non-empty completion from a real provider", async () => {
    const router = createRouter({
      dbPath: `${process.env.TMPDIR ?? "/tmp"}/multipleai-live-${Date.now()}.db`,
      getApiKey: async (id) => (id === "groq" ? (GROQ_API_KEY ?? null) : null),
    });

    const result = await router.routeAndStream({
      provider: "groq",
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
    });

    let output = "";
    for await (const chunk of result.stream) {
      output += chunk;
    }

    expect(result.providerId).toBe("groq");
    expect(output.trim().length).toBeGreaterThan(0);
  }, 30_000);
});
