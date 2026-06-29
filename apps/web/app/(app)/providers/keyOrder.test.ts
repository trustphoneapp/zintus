import { describe, expect, it } from "bun:test";
import {
  combineKeyList,
  moveKey,
  normalizeKeyList,
  removeKeyAt,
  splitKeyList,
} from "./keyOrder";

describe("normalizeKeyList", () => {
  it("trims, drops blanks, and dedupes order-preserving", () => {
    expect(normalizeKeyList([" a ", "b", "a", "", "  ", "c", "b"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("returns [] for an all-blank list", () => {
    expect(normalizeKeyList(["", "   ", "\t"])).toEqual([]);
  });
});

describe("combineKeyList (mirrors keychain getKeys)", () => {
  it("puts the primary first, then the fallback tail", () => {
    expect(combineKeyList("primary", ["f1", "f2"])).toEqual([
      "primary",
      "f1",
      "f2",
    ]);
  });

  it("a lone primary reads back as a 1-element list (single-key back-compat)", () => {
    expect(combineKeyList("solo")).toEqual(["solo"]);
    expect(combineKeyList("solo", [])).toEqual(["solo"]);
  });

  it("a missing/blank primary collapses to just the fallbacks", () => {
    expect(combineKeyList(null, ["f1"])).toEqual(["f1"]);
    expect(combineKeyList("   ", ["f1"])).toEqual(["f1"]);
    expect(combineKeyList(undefined)).toEqual([]);
  });

  it("dedupes a fallback that equals the primary", () => {
    expect(combineKeyList("primary", ["primary", "f1"])).toEqual([
      "primary",
      "f1",
    ]);
  });
});

describe("splitKeyList (mirrors keychain setKeys)", () => {
  it("first element is the primary, the rest is the fallback tail", () => {
    expect(splitKeyList(["primary", "f1", "f2"])).toEqual({
      primary: "primary",
      fallbacks: ["f1", "f2"],
    });
  });

  it("a single key splits to a primary with no fallbacks", () => {
    expect(splitKeyList(["solo"])).toEqual({ primary: "solo", fallbacks: [] });
  });

  it("an empty/blank list yields a null primary", () => {
    expect(splitKeyList([])).toEqual({ primary: null, fallbacks: [] });
    expect(splitKeyList(["", "  "])).toEqual({ primary: null, fallbacks: [] });
  });

  it("round-trips through combineKeyList preserving order", () => {
    const list = ["primary", "f1", "f2"];
    const { primary, fallbacks } = splitKeyList(list);
    expect(combineKeyList(primary, fallbacks)).toEqual(list);
  });
});

describe("removeKeyAt", () => {
  it("removes the key at the index", () => {
    expect(removeKeyAt(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });

  it("re-promotes the next key to primary when index 0 is removed", () => {
    expect(removeKeyAt(["a", "b", "c"], 0)).toEqual(["b", "c"]);
  });

  it("is a no-op for an out-of-range index", () => {
    expect(removeKeyAt(["a"], 5)).toEqual(["a"]);
    expect(removeKeyAt(["a"], -1)).toEqual(["a"]);
  });
});

describe("moveKey", () => {
  it("moves a key up (toward primary)", () => {
    expect(moveKey(["a", "b", "c"], 2, "up")).toEqual(["a", "c", "b"]);
  });

  it("moves a key down (away from primary)", () => {
    expect(moveKey(["a", "b", "c"], 0, "down")).toEqual(["b", "a", "c"]);
  });

  it("is a no-op at the boundaries", () => {
    expect(moveKey(["a", "b"], 0, "up")).toEqual(["a", "b"]);
    expect(moveKey(["a", "b"], 1, "down")).toEqual(["a", "b"]);
  });
});
