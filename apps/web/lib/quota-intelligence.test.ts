import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCompressionStats } from "./gateway";

const WEB_DIR = join(import.meta.dir, "..");

function headers(map: Record<string, string>): Headers {
  return new Headers(map);
}

describe("readCompressionStats (chat compression badge)", () => {
  it("returns null when no compression headers are present", () => {
    expect(readCompressionStats(headers({}))).toBeNull();
  });

  it("parses a real compression hit, incl. the estimated USD", () => {
    const stats = readCompressionStats(
      headers({
        "X-Zintus-Original-Tokens": "12800",
        "X-Zintus-Compressed-Tokens": "4600",
        "X-Zintus-Tokens-Saved": "8200",
        "X-Zintus-Compression-Ratio": "0.36",
        "X-Zintus-Cost-Saved-Usd": "0.0312",
      }),
    );
    expect(stats).not.toBeNull();
    expect(stats!.tokensSaved).toBe(8200);
    expect(stats!.originalTokens).toBe(12800);
    expect(stats!.costSavedUsd).toBeCloseTo(0.0312, 6);
  });

  it("omits the USD estimate when the gateway can't price the saving", () => {
    const stats = readCompressionStats(
      headers({
        "X-Zintus-Original-Tokens": "1000",
        "X-Zintus-Compressed-Tokens": "700",
        "X-Zintus-Tokens-Saved": "300",
        "X-Zintus-Compression-Ratio": "0.70",
      }),
    );
    expect(stats).not.toBeNull();
    expect(stats!.costSavedUsd).toBeUndefined();
  });

  it("returns null when there is no real saving (no badge shown)", () => {
    expect(
      readCompressionStats(
        headers({
          "X-Zintus-Original-Tokens": "1000",
          "X-Zintus-Compressed-Tokens": "1000",
          "X-Zintus-Tokens-Saved": "0",
          "X-Zintus-Compression-Ratio": "1.00",
        }),
      ),
    ).toBeNull();
  });
});

describe("route-options panel honesty", () => {
  // The panel must render ONLY the gateway's BYOK actions and never invent a
  // paid/credits/overflow path (managed keys are gated; the API never sends one).
  it("ships no paid/credits/overflow option in the UI", () => {
    const src = readFileSync(
      join(WEB_DIR, "app/_components/RouteOptionsPanel.tsx"),
      "utf8",
    );
    const lowered = src.toLowerCase();
    expect(lowered).not.toContain("use_credits");
    expect(lowered).not.toContain("credits");
    expect(lowered).not.toContain("buy ");
    expect(lowered).not.toContain("upgrade");
    // Renders exactly the four BYOK option ids the gateway can return.
    for (const id of [
      "compress_harder",
      "switch_provider",
      "use_local",
      "wait",
    ]) {
      expect(src).toContain(id);
    }
  });
});
