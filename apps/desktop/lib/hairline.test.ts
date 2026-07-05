import { describe, expect, test } from "bun:test";
import { HAIRLINE_INIT_SCRIPT, hairlineCssPx } from "./hairline";

describe("hairlineCssPx", () => {
  // One device pixel per dPR — the R2 table (docs/launch/research/R2).
  test("maps each real-world scale factor to exactly one device pixel", () => {
    expect(hairlineCssPx(1)).toBe("1px"); // 100% / non-Retina
    expect(hairlineCssPx(1.25)).toBe("0.8px"); // Windows 125%
    expect(hairlineCssPx(1.5)).toBe("0.6667px"); // Windows 150%
    expect(hairlineCssPx(1.75)).toBe("0.5714px"); // Windows 175%
    expect(hairlineCssPx(2)).toBe("0.5px"); // Retina / 200% — byte-identical to the old static token
    expect(hairlineCssPx(3)).toBe("0.3333px"); // 300%
  });

  test("degrades to 1px on nonsense input instead of breaking edges", () => {
    expect(hairlineCssPx(0)).toBe("1px");
    expect(hairlineCssPx(Number.NaN)).toBe("1px");
    expect(hairlineCssPx(-2)).toBe("1px");
    expect(hairlineCssPx(Number.POSITIVE_INFINITY)).toBe("1px");
  });
});

describe("HAIRLINE_INIT_SCRIPT", () => {
  // The inline script is a hand-minified mirror of applyHairline/watchHairline.
  // Pin the load-bearing pieces so an edit to one side can't silently drift.
  test("sets --hairline from devicePixelRatio with the same rounding", () => {
    expect(HAIRLINE_INIT_SCRIPT).toContain('"--hairline"');
    expect(HAIRLINE_INIT_SCRIPT).toContain("window.devicePixelRatio||1");
    expect(HAIRLINE_INIT_SCRIPT).toContain("Math.round(10000/d)/10000");
  });

  test("re-subscribes on resolution change and never throws", () => {
    expect(HAIRLINE_INIT_SCRIPT).toContain('matchMedia("(resolution: "+d+"dppx)")');
    expect(HAIRLINE_INIT_SCRIPT).toContain("{once:true}");
    expect(HAIRLINE_INIT_SCRIPT.startsWith("(function(){try{")).toBe(true);
    expect(HAIRLINE_INIT_SCRIPT.endsWith("catch(e){}})();")).toBe(true);
  });

  test("evaluates the same width the typed helper computes", () => {
    // Execute the script body against a stub DOM to prove behavioral parity.
    const set: string[] = [];
    const sandbox = {
      window: { devicePixelRatio: 1.5 },
      document: {
        documentElement: {
          style: {
            setProperty: (k: string, v: string) => set.push(`${k}:${v}`),
          },
        },
      },
      matchMedia: () => ({ addEventListener: () => {} }),
    };
    // eslint-disable-next-line no-new-func
    new Function(
      "window",
      "document",
      "matchMedia",
      HAIRLINE_INIT_SCRIPT,
    )(sandbox.window, sandbox.document, sandbox.matchMedia);
    expect(set).toEqual([`--hairline:${hairlineCssPx(1.5)}`]);
  });
});
