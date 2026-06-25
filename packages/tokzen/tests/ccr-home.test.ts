import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCCRStore } from "../src/ccr/store";

// Locks in the TOKZEN_HOME isolation: createCCRStore() with no explicit path
// must write under TOKZEN_HOME, not the real ~/.tokzen. This is what makes the
// test suite hermetic on a read-only $HOME (and in CI).
describe("TOKZEN_HOME isolation", () => {
  const original = process.env.TOKZEN_HOME;
  const dir = join(tmpdir(), `tokzen-home-test-${Date.now()}-${Math.random()}`);

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TOKZEN_HOME;
    } else {
      process.env.TOKZEN_HOME = original;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("writes ccr.db under TOKZEN_HOME when no path is given", () => {
    process.env.TOKZEN_HOME = dir;
    const store = createCCRStore();
    store.store("hello world", "prose", { sessionId: "s1" });
    store.close();
    expect(existsSync(join(dir, "ccr.db"))).toBe(true);
  });
});
