import { describe, expect, test } from "bun:test";
import { QuotaCounter } from "../src/QuotaCounter.js";

// The real Durable Object counter. Atomicity in production comes from the
// runtime serialising requests to a single object instance; here we verify the
// read-add-write logic itself (exact accumulation, ignores junk/negatives) plus
// the self-prune alarm that bounds storage growth.

function fakeState() {
  const m = new Map<string, unknown>();
  const meta = { alarmAt: null as number | null };
  const state = {
    storage: {
      get: async (k: string) => m.get(k),
      put: async (k: string, v: unknown) => {
        m.set(k, v);
      },
      setAlarm: async (t: number) => {
        meta.alarmAt = t;
      },
      deleteAll: async () => {
        m.clear();
      },
    },
  } as unknown as DurableObjectState;
  return { state, map: m, meta };
}

const add = (c: QuotaCounter, n: string) =>
  c.fetch(new Request("https://quota/add", { method: "POST", body: n }));
const get = (c: QuotaCounter) => c.fetch(new Request("https://quota/get"));

async function total(res: Response): Promise<number> {
  return ((await res.json()) as { total: number }).total;
}

describe("QuotaCounter", () => {
  test("starts at zero", async () => {
    const c = new QuotaCounter(fakeState().state);
    expect(await total(await get(c))).toBe(0);
  });

  test("sequential adds accumulate exactly", async () => {
    const c = new QuotaCounter(fakeState().state);
    expect(await total(await add(c, "100"))).toBe(100);
    expect(await total(await add(c, "50"))).toBe(150);
    expect(await total(await get(c))).toBe(150);
  });

  test("ignores non-positive and junk deltas", async () => {
    const c = new QuotaCounter(fakeState().state);
    await add(c, "100");
    expect(await total(await add(c, "-5"))).toBe(100);
    expect(await total(await add(c, "not-a-number"))).toBe(100);
    expect(await total(await add(c, "0"))).toBe(100);
  });

  test("each write arms a future prune alarm; the alarm wipes stale storage", async () => {
    const f = fakeState();
    const c = new QuotaCounter(f.state);
    await add(c, "100");
    expect(f.meta.alarmAt).toBeGreaterThan(Date.now()); // armed ~40d out
    expect(f.map.size).toBeGreaterThan(0);

    await c.alarm(); // fired after a stale month
    expect(f.map.size).toBe(0);
    expect(await total(await get(c))).toBe(0); // back to a clean zero
  });
});
