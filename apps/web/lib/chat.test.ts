import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { streamChat } from "./chat.server";

beforeAll(() => {
  const dir = join(tmpdir(), "zintus-web-test");
  mkdirSync(dir, { recursive: true });
  process.env.ZINTUS_QUOTA_PATH = join(dir, "quota.db");
});

describe("streamChat", () => {
  it("requires a key when a cloud provider is forced", async () => {
    await expect(
      streamChat({
        messages: [{ role: "user", content: "hello" }],
        provider: "groq",
        apiKeys: {},
      }),
    ).rejects.toThrow(/API key|No providers available/);
  });
});
