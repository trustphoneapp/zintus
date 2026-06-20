import { beforeAll, describe, expect, it } from "bun:test";
import { validateAndStoreKey } from "./keys.js";

// ZINTUS_SKIP_VALIDATE=1 makes validation use the local (offline) format check
// instead of the remote worker, so this test never touches the network. The bad
// key fails the provider's keyRegex before any fetch or keychain write.
describe("validateAndStoreKey", () => {
  beforeAll(() => {
    process.env.ZINTUS_SKIP_VALIDATE = "1";
  });

  it("returns an error result instead of exiting on an invalid key", async () => {
    const result = await validateAndStoreKey("groq", "not-a-valid-groq-key");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
