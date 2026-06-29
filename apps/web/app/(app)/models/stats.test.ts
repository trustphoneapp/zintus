import { describe, expect, it } from "bun:test";
import type { CatalogModelDto } from "@/lib/gateway";
import {
  formatLatencyMs,
  formatThroughputTps,
  formatUptime,
  hasMeasuredStats,
  modelStats,
  type CatalogModelStats,
} from "./format";

/** Minimal catalog model; `stats` is spread in per-test. */
function model(extra: Record<string, unknown> = {}): CatalogModelDto {
  return {
    id: "m",
    object: "model",
    owned_by: "Groq",
    display_name: "Test model",
    context_window: 8192,
    capabilities: { vision: false, tools: true, structured_output: "json_object" },
    pricing: { input_per_1m: null, output_per_1m: null },
    free: true,
    local: false,
    data_policy: { tag: "no_train", badge: "no-training" },
    ...extra,
  } as CatalogModelDto;
}

describe("modelStats", () => {
  it("returns null when the gateway omits the stats block (older gateway)", () => {
    expect(modelStats(model())).toBeNull();
  });

  it("parses a fully measured stats block", () => {
    const stats = modelStats(
      model({
        stats: {
          latency_p95_ms: 123,
          throughput_tps: 45.5,
          uptime: 0.99,
          samples: 50,
        },
      }),
    );
    expect(stats).toEqual({
      latency_p95_ms: 123,
      throughput_tps: 45.5,
      uptime: 0.99,
      samples: 50,
    });
  });

  it("preserves null metrics (insufficient samples) — never coerced to 0", () => {
    const stats = modelStats(
      model({
        stats: {
          latency_p95_ms: null,
          throughput_tps: null,
          uptime: null,
          samples: 1,
        },
      }),
    );
    expect(stats).toEqual({
      latency_p95_ms: null,
      throughput_tps: null,
      uptime: null,
      samples: 1,
    });
  });
});

describe("hasMeasuredStats", () => {
  it("false for null stats or all-null metrics", () => {
    expect(hasMeasuredStats(null)).toBe(false);
    const empty: CatalogModelStats = {
      latency_p95_ms: null,
      throughput_tps: null,
      uptime: null,
      samples: 3,
    };
    expect(hasMeasuredStats(empty)).toBe(false);
  });

  it("true when at least one metric is measured", () => {
    const partial: CatalogModelStats = {
      latency_p95_ms: 200,
      throughput_tps: null,
      uptime: null,
      samples: 40,
    };
    expect(hasMeasuredStats(partial)).toBe(true);
  });
});

describe("formatLatencyMs — null renders an em dash, never a fake 0", () => {
  it("null → —", () => {
    expect(formatLatencyMs(null)).toBe("—");
  });
  it("rounds to whole milliseconds", () => {
    expect(formatLatencyMs(320.6)).toBe("321 ms");
  });
});

describe("formatThroughputTps", () => {
  it("null → —", () => {
    expect(formatThroughputTps(null)).toBe("—");
  });
  it("one decimal under 100, whole at/above", () => {
    expect(formatThroughputTps(45.5)).toBe("45.5 tok/s");
    expect(formatThroughputTps(123.4)).toBe("123 tok/s");
  });
});

describe("formatUptime — null renders an em dash, never a fake 100%", () => {
  it("null → —", () => {
    expect(formatUptime(null)).toBe("—");
  });
  it("formats a success rate 0..1 as a percent", () => {
    expect(formatUptime(0.99)).toBe("99%");
    expect(formatUptime(0.995)).toBe("99.5%");
    expect(formatUptime(1)).toBe("100%");
  });
});
