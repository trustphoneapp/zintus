import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { verifyWebhook, type VerifyWebhookOptions } from "./webhook-verifier";

const NOW = 1_700_000_000_000;
const KEY = new TextEncoder().encode("test-webhook-key");

function sign(timestamp: number, body: string, key: Uint8Array = KEY): string {
  return `sha256=${createHmac("sha256", key).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

class Store {
  readonly calls: Array<{ key: string; ttlMs: number }> = [];
  constructor(private readonly result = true) {}
  async claim(key: string, ttlMs: number): Promise<boolean> { this.calls.push({ key, ttlMs }); return this.result; }
}

function input(overrides: Partial<VerifyWebhookOptions> = {}): VerifyWebhookOptions {
  const timestamp = overrides.timestamp ?? NOW;
  const body = overrides.body ?? "body";
  const key = overrides.key ?? KEY;
  return {
    timestamp, body, key, now: overrides.now ?? NOW, replayStore: overrides.replayStore ?? new Store(),
    signatureHeader: "signatureHeader" in overrides ? overrides.signatureHeader : sign(timestamp, body, key),
  };
}

describe("verifyWebhook", () => {
  test("accepts a valid UTF-8 request and derives a stable namespaced replay key", async () => {
    const first = new Store();
    const second = new Store();
    expect(await verifyWebhook(input({ body: "こんにちは🌍", signatureHeader: sign(NOW, "こんにちは🌍"), replayStore: first }))).toEqual({ ok: true });
    expect(await verifyWebhook(input({ replayStore: second }))).toEqual({ ok: true });
    expect(first.calls[0]).toMatchObject({ ttlMs: 300_000 });
    expect(first.calls[0]!.key).toMatch(/^zintus:webhook:replay:v1:[0-9a-f]{64}$/);
    expect(second.calls[0]!.key).toBe((await (async () => { const third = new Store(); await verifyWebhook(input({ replayStore: third })); return third.calls[0]!.key; })()));
  });

  test("rejects malformed, newline-suffixed, and invalid signatures before claiming", async () => {
    const valid = sign(NOW, "body");
    for (const header of [undefined, "", valid + "\n", valid + "\r", valid + "\r\n", valid + " ", valid + "\t", `sha256=${"A".repeat(64)}`]) {
      const store = new Store();
      const result = await verifyWebhook(input({ signatureHeader: header, replayStore: store }));
      expect(result.ok).toBe(false);
      expect(store.calls).toHaveLength(0);
    }
  });

  test("uses safe directional timestamp differences at ordinary and maximum-safe boundaries", async () => {
    for (const [timestamp, now, expected] of [
      [NOW - 300_000, NOW, true], [NOW + 30_000, NOW, true],
      [NOW - 300_001, NOW, false], [NOW + 30_001, NOW, false],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 30_000, true],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 30_001, false],
      [Number.MAX_SAFE_INTEGER - 300_000, Number.MAX_SAFE_INTEGER, true],
      [Number.MAX_SAFE_INTEGER - 300_001, Number.MAX_SAFE_INTEGER, false],
    ] as const) {
      const store = new Store();
      const result = await verifyWebhook(input({ timestamp, now, signatureHeader: sign(timestamp, "body"), replayStore: store }));
      expect(result.ok).toBe(expected);
      expect(store.calls).toHaveLength(expected ? 1 : 0);
    }
  });

  test("rejects invalid time values and bodies above one MiB before replay claims", async () => {
    for (const value of [Number.NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, -1]) {
      const store = new Store();
      expect(await verifyWebhook(input({ timestamp: value, replayStore: store }))).toEqual({ ok: false, code: "INVALID_TIMESTAMP" });
      expect(store.calls).toHaveLength(0);
    }
    const oversized = "😀".repeat(262_145);
    const store = new Store();
    expect(await verifyWebhook(input({ body: oversized, signatureHeader: sign(NOW, oversized), replayStore: store }))).toEqual({ ok: false, code: "BODY_TOO_LARGE" });
    expect(store.calls).toHaveLength(0);
  });

  test("fails closed for replay and replay-store errors", async () => {
    expect(await verifyWebhook(input({ replayStore: new Store(false) }))).toEqual({ ok: false, code: "REPLAYED" });
    expect(await verifyWebhook(input({ replayStore: { claim: async () => { throw new Error("secret"); } } }))).toEqual({ ok: false, code: "REPLAY_STORE_ERROR" });
  });
});
