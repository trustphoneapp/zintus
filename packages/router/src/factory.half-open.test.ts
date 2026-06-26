import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, Provider, ProviderId } from "@zintus/types";
import { ProviderHttpError, estimateUsage } from "@zintus/providers";
import { createRouter } from "./factory.js";
import { QuotaLedger } from "./quota-ledger.js";

// Integration / concurrency coverage for the circuit-breaker HALF-OPEN probe
// gate in factory.ts (the `halfOpenProbes` Set, ~lines 137-142 and 500-521).
//
// The half-open gate is the one circuit-breaker mechanism that *only* shows up
// under concurrency, so the ledger-level unit tests (error-streak.test.ts) can't
// reach it. The contract:
//   - A provider with recent errors but still BELOW ERROR_STREAK_THRESHOLD (3)
//     stays eligible — it is "degraded" / recovering.
//   - A degraded provider admits at most ONE in-flight probe at a time. While a
//     probe is in flight, a concurrent request must NOT pile onto it; instead it
//     releases its reservation and FAILS OVER to the next eligible candidate.
//   - Healthy providers (zero recent errors) are never gated.
//
// This test drives the gate end-to-end through createRouter().routeAndStream()
// under genuine concurrency, gating on promises (no wall-clock sleeps) so it is
// deterministic, and it counts concurrent entries into the degraded provider so
// a skeptic who removes the gate makes it go red instead of hanging.

const WINDOW_MS = 5 * 60_000; // ERROR_STREAK_WINDOW_MS in factory.ts
const THRESHOLD = 3; // ERROR_STREAK_THRESHOLD in factory.ts

const dbPaths: string[] = [];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function stubProvider(
  id: ProviderId,
  priority: number,
  streamChat: Provider["streamChat"],
): Provider {
  return {
    id,
    name: id,
    color: "#000000",
    priority,
    keyRegex: /^test$/,
    defaultModel: "test-model",
    streamChat,
    async validateKey() {
      return true;
    },
  };
}

function createTestRouter(providers: Provider[], priorityOrder: ProviderId[]) {
  const dbPath = join(
    tmpdir(),
    `zintus-half-open-${Date.now()}-${Math.random()}.db`,
  );
  dbPaths.push(dbPath);
  mock.module("@zintus/providers", () => ({
    listProviders: () => providers,
    ProviderHttpError,
    estimateUsage,
  }));
  return {
    router: createRouter({
      dbPath,
      getApiKey: async () => "test-key",
      providerPriority: priorityOrder,
    }),
    dbPath,
  };
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) {
    out += chunk;
  }
  return out;
}

afterEach(() => {
  mock.restore();
  for (const path of dbPaths.splice(0)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
});

describe("createRouter half-open probe gate (concurrency)", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

  test("admits one concurrent probe to a degraded provider; the rest fail over", async () => {
    // Concurrency instrumentation for the degraded provider (gemini).
    let geminiEntries = 0;
    let geminiConcurrent = 0;
    let geminiMaxConcurrent = 0;
    let cohereCalls = 0;

    let phase: "seed" | "probe" = "seed";
    const firstEntry = deferred(); // resolves when the first probe enters gemini
    const secondEntry = deferred(); // resolves only if a SECOND probe ever enters
    const block = deferred(); // controls when the in-flight probe completes

    const gemini = stubProvider("gemini", 1, async () => {
      if (phase === "seed") {
        // A 4xx (non-429) is recorded as an error but does NOT trigger
        // failover or a cooldown, so it seeds exactly ONE recent error and
        // leaves gemini eligible-but-degraded for the probe phase.
        throw new ProviderHttpError("bad request", 400);
      }
      geminiEntries += 1;
      geminiConcurrent += 1;
      geminiMaxConcurrent = Math.max(geminiMaxConcurrent, geminiConcurrent);
      if (geminiEntries === 1) firstEntry.resolve();
      if (geminiEntries >= 2) secondEntry.resolve();
      try {
        await block.promise; // hold the probe in flight, provably
      } finally {
        geminiConcurrent -= 1;
      }
      return {
        stream: (async function* () {
          yield { content: "from gemini" };
        })(),
      };
    });

    const cohere = stubProvider("cohere", 2, async () => {
      cohereCalls += 1;
      return {
        stream: (async function* () {
          yield { content: "from cohere" };
        })(),
      };
    });

    const { router, dbPath } = createTestRouter(
      [gemini, cohere],
      ["gemini", "cohere"],
    );

    // 1) Seed gemini as DEGRADED: one request whose streamChat throws a 400.
    //    No failover (not 429/5xx), no cooldown → exactly one recent error.
    await expect(router.routeAndStream({ messages })).rejects.toThrow();

    // Verify the seed via an independent read-only ledger on the same WAL db:
    // gemini has 1 recent error (degraded, BELOW threshold), cohere has none.
    const probe = new QuotaLedger(dbPath);
    try {
      const geminiErrors = probe.recentErrorCount("gemini", WINDOW_MS, Date.now());
      const cohereErrors = probe.recentErrorCount("cohere", WINDOW_MS, Date.now());
      expect(geminiErrors).toBe(1);
      expect(geminiErrors).toBeLessThan(THRESHOLD); // still eligible / half-open
      expect(cohereErrors).toBe(0); // fallback stays healthy
    } finally {
      probe.close();
    }

    // 2) Probe phase: gemini's streamChat now BLOCKS, so the first probe is
    //    provably in flight while a concurrent request routes.
    phase = "probe";

    // Request A enters gemini (the single admitted probe) and blocks there.
    const aPromise = router.routeAndStream({ messages });
    await firstEntry.promise; // gemini is now in halfOpenProbes, A is in flight

    // 3) Request B fires while A is still blocked inside gemini. With the gate,
    //    B must skip the in-flight degraded provider and fail over to cohere.
    const bPromise = router.routeAndStream({ messages });

    // Race B's result against a (gate-removed) SECOND entry into gemini so the
    // test resolves fast either way instead of hanging: if the gate is gone, B
    // blocks on gemini and `secondEntry` wins; with the gate, B resolves first.
    const outcome = await Promise.race([
      bPromise.then((result) => ({ tag: "b" as const, result })),
      secondEntry.promise.then(() => ({ tag: "second-probe" as const })),
    ]);

    try {
      // The gate held: B never entered the degraded provider...
      expect(outcome.tag).toBe("b");
      // ...it failed over to the healthy fallback.
      if (outcome.tag === "b") {
        expect(outcome.result.providerId).toBe("cohere");
      }
      // The gap-closer: never more than ONE concurrent entry into the degraded
      // provider while it is degraded. Remove `halfOpenProbes` and this is 2.
      expect(geminiMaxConcurrent).toBe(1);
      expect(geminiEntries).toBe(1);
      expect(cohereCalls).toBe(1);
    } finally {
      // Release the in-flight probe so A can complete cleanly.
      block.resolve();
    }

    // 4) Drain everything to a clean finish (and reclaim reservations).
    const settled = await Promise.allSettled([aPromise, bPromise]);
    const fulfilled = settled.filter(
      (s): s is PromiseFulfilledResult<Awaited<typeof aPromise>> =>
        s.status === "fulfilled",
    );
    const drained = await Promise.all(
      fulfilled.map((s) => drain(s.value.stream)),
    );

    // A completed via the degraded provider once the probe was released.
    const aResult = await aPromise;
    expect(aResult.providerId).toBe("gemini");
    expect(drained).toContain("from gemini");
    expect(drained).toContain("from cohere");
    // Even after release, the degraded provider was entered exactly once.
    expect(geminiEntries).toBe(1);
    expect(geminiMaxConcurrent).toBe(1);
  });
});
