import { afterEach, describe, expect, test } from "bun:test";
import { fetchGithubPublicationToken } from "./serve.js";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

describe("Engineer cloud connector readiness", () => {
  test("bounds a stalled relay probe so local gateway startup can continue", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;

    const started = Date.now();
    await expect(fetchGithubPublicationToken({
      session_id: "session-1", gateway_secret: "secret-1", relay_url: "https://relay.invalid",
    }, false, 10)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(250);
  });
});
