import { describe, expect, test } from "bun:test";
import { BUNDLED_SNAPSHOT, type ModelRates, type PriceSnapshot } from "@zintus/burn";
import {
  crossCheckOpenRouter,
  KV_CURRENT,
  KV_LAST_REPORT,
  KV_PENDING,
  kvHistoryKey,
  readCurrentSnapshot,
  refresh,
  type KvLike,
  type OpenRouterModel,
} from "../src/refresh.js";

class FakeKv implements KvLike {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

const rates = (): ModelRates[] => BUNDLED_SNAPSHOT.rates.map((r) => ({ ...r }));

describe("readCurrentSnapshot", () => {
  test("falls back to the bundled snapshot on empty, corrupt, or invalid KV", async () => {
    const kv = new FakeKv();
    expect((await readCurrentSnapshot(kv)).version).toBe(BUNDLED_SNAPSHOT.version);

    await kv.put(KV_CURRENT, "{not json");
    expect((await readCurrentSnapshot(kv)).version).toBe(BUNDLED_SNAPSHOT.version);

    await kv.put(KV_CURRENT, JSON.stringify({ version: -1, generatedAt: "x", rates: [] }));
    expect((await readCurrentSnapshot(kv)).version).toBe(BUNDLED_SNAPSHOT.version);
  });
});

describe("refresh pipeline", () => {
  test("identical rates → unchanged, version NOT bumped, nothing published", async () => {
    const kv = new FakeKv();
    const report = await refresh({ kv, proposedRates: rates() });
    expect(report.outcome).toBe("unchanged");
    expect(report.version).toBe(BUNDLED_SNAPSHOT.version);
    expect(kv.store.has(KV_CURRENT)).toBe(false);
    expect(kv.store.has(KV_LAST_REPORT)).toBe(true);
  });

  test("a small (<10%) move publishes a version bump with history", async () => {
    const kv = new FakeKv();
    const proposed = rates();
    const groq = proposed.find((r) => r.model === "llama-3.3-70b-versatile");
    if (!groq) throw new Error("fixture missing groq rate");
    groq.inPer1M = groq.inPer1M * 1.05;

    const report = await refresh({ kv, proposedRates: proposed });
    expect(report.outcome).toBe("published");
    expect(report.version).toBe(BUNDLED_SNAPSHOT.version + 1);
    expect(report.alerts).toEqual([]);
    expect(report.moves).toHaveLength(1);

    const published = JSON.parse(kv.store.get(KV_CURRENT) ?? "{}") as PriceSnapshot;
    expect(published.version).toBe(BUNDLED_SNAPSHOT.version + 1);
    expect(kv.store.has(kvHistoryKey(published.version))).toBe(true);
  });

  test("a >10% move is BLOCKED: stored pending, current untouched", async () => {
    const kv = new FakeKv();
    const proposed = rates();
    const deepseek = proposed.find((r) => r.provider === "deepseek");
    if (!deepseek) throw new Error("fixture missing deepseek rate");
    deepseek.outPer1M = deepseek.outPer1M * 1.5;

    const report = await refresh({ kv, proposedRates: proposed });
    expect(report.outcome).toBe("blocked_by_alerts");
    expect(report.alerts).toHaveLength(1);
    expect(kv.store.has(KV_CURRENT)).toBe(false);
    expect(kv.store.has(KV_PENDING)).toBe(true);
  });

  test("force publishes the same >10% move (the human-approval path)", async () => {
    const kv = new FakeKv();
    const proposed = rates();
    const deepseek = proposed.find((r) => r.provider === "deepseek");
    if (!deepseek) throw new Error("fixture missing deepseek rate");
    deepseek.outPer1M = deepseek.outPer1M * 1.5;

    const report = await refresh({ kv, proposedRates: proposed, force: true });
    expect(report.outcome).toBe("published");
    expect(report.forced).toBe(true);
    expect(kv.store.has(KV_CURRENT)).toBe(true);
  });

  test("invalid proposed rates never publish and report the problems", async () => {
    const kv = new FakeKv();
    const proposed = rates();
    const first = proposed[0];
    if (!first) throw new Error("fixture empty");
    first.inPer1M = -5;

    const report = await refresh({ kv, proposedRates: proposed });
    expect(report.outcome).toBe("invalid");
    expect(report.problems.length).toBeGreaterThan(0);
    expect(kv.store.has(KV_CURRENT)).toBe(false);
    expect(kv.store.has(KV_PENDING)).toBe(false);
  });

  test("versions chain across successive publishes", async () => {
    const kv = new FakeKv();
    const bump = (factor: number): ModelRates[] => {
      const proposed = rates();
      const groq = proposed.find((r) => r.model === "llama-3.3-70b-versatile");
      if (!groq) throw new Error("fixture missing groq rate");
      groq.inPer1M = Math.round(groq.inPer1M * factor * 1e6) / 1e6;
      return proposed;
    };

    const first = await refresh({ kv, proposedRates: bump(1.05) });
    expect(first.version).toBe(BUNDLED_SNAPSHOT.version + 1);
    const second = await refresh({ kv, proposedRates: bump(1.08) });
    expect(second.outcome).toBe("published");
    expect(second.version).toBe(BUNDLED_SNAPSHOT.version + 2);
    expect(kv.store.has(kvHistoryKey(first.version))).toBe(true);
    expect(kv.store.has(kvHistoryKey(second.version))).toBe(true);
  });
});

describe("crossCheckOpenRouter — warnings only", () => {
  const orModels: OpenRouterModel[] = [
    {
      id: "deepseek/deepseek-chat",
      // USD per token; ×1e6 = per-1M. 0.00000014 → $0.14/1M (matches ours).
      pricing: { prompt: "0.00000014", completion: "0.00000028" },
    },
    {
      id: "mistralai/mistral-large",
      // $4/1M in vs our $2/1M — 50% drift on the larger base, must warn.
      pricing: { prompt: "0.000004", completion: "0.000006" },
    },
  ];

  test("agreeing market prices produce no warnings", () => {
    const warnings = crossCheckOpenRouter(BUNDLED_SNAPSHOT, orModels).filter(
      (w) => w.provider === "deepseek",
    );
    expect(warnings).toEqual([]);
  });

  test("large divergence warns with both prices attached", () => {
    const warnings = crossCheckOpenRouter(BUNDLED_SNAPSHOT, orModels).filter(
      (w) => w.provider === "mistral",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.field).toBe("inPer1M");
    expect(warnings[0]?.ours).toBe(2.0);
    expect(warnings[0]?.market).toBe(4.0);
    expect(warnings[0]?.drift).toBeCloseTo(0.5, 6);
  });

  test("unmapped routes and missing market entries are skipped silently", () => {
    const warnings = crossCheckOpenRouter(BUNDLED_SNAPSHOT, []);
    expect(warnings).toEqual([]);
  });

  test("malformed market prices are ignored rather than warned on", () => {
    const warnings = crossCheckOpenRouter(BUNDLED_SNAPSHOT, [
      { id: "deepseek/deepseek-chat", pricing: { prompt: "not-a-number" } },
    ]);
    expect(warnings).toEqual([]);
  });
});
