import { describe, expect, test } from "bun:test";
import { hairlineCssPx } from "./hairline";

describe("hairlineCssPx", () => {
  // One device pixel per dPR — the R2 table (docs/launch/research/R2).
  test("maps each real-world scale factor to exactly one device pixel", () => {
    expect(hairlineCssPx(1)).toBe("1px"); // 100% / non-Retina
    expect(hairlineCssPx(1.25)).toBe("0.8px"); // Windows 125%
    expect(hairlineCssPx(1.5)).toBe("0.6667px"); // Windows 150%
    expect(hairlineCssPx(1.75)).toBe("0.5714px"); // Windows 175%
    expect(hairlineCssPx(2)).toBe("0.5px"); // Retina / 200% — matches the static fallback token
    expect(hairlineCssPx(3)).toBe("0.3333px"); // 300%
  });

  test("degrades to 1px on nonsense input instead of breaking edges", () => {
    expect(hairlineCssPx(0)).toBe("1px");
    expect(hairlineCssPx(Number.NaN)).toBe("1px");
    expect(hairlineCssPx(-2)).toBe("1px");
    expect(hairlineCssPx(Number.POSITIVE_INFINITY)).toBe("1px");
  });
});
