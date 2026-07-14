import { expect, test } from "bun:test";
import { accountSlug } from "../src/slug.js";

test("account slugs are stable lowercase URL segments", () => {
  expect(accountSlug("  Ada Lovelace  ")).toBe("ada-lovelace");
});
