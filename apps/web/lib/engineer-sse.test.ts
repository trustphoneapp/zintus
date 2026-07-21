import { afterEach, describe, expect, test } from "bun:test";
import { streamEngineerEvents } from "./engineer";
import { acceptEngineerEvent, parseEngineerSse } from "./engineer-sse";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });

const event = (sequence: number) => ({ eventId: `e-${sequence}`, sequence, previousState: "PLANNING", nextState: "PLAN_READY", reasonCode: "READY", timestamp: "2026-07-14T00:00:00Z", evidenceIds: [] });

describe("Engineer resumable SSE", () => {
  test("parses CRLF, multiline data, heartbeats, retry, and a partial trailing frame", () => {
    const first = JSON.stringify(event(1));
    const parsed = parseEngineerSse(`retry: 1200\r\n\r\n: heartbeat\r\n\r\nid: 1\r\nevent: state\r\ndata: ${first}\r\n\r\nid: 2\r\ndata:`);
    expect(parsed.retryMs).toBe(1200);
    expect(parsed.events).toEqual([{ id: 1, event: event(1) }]);
    expect(parsed.remainder).toContain("id: 2");
  });

  test("rejects sequence spoofing and detects duplicates and gaps", () => {
    expect(() => parseEngineerSse(`id: 2\ndata: ${JSON.stringify(event(1))}\n\n`)).toThrow("sequence mismatch");
    expect(acceptEngineerEvent(2, 2)).toBe("DUPLICATE");
    expect(acceptEngineerEvent(2, 4)).toBe("GAP");
    expect(acceptEngineerEvent(2, 3)).toBe("ACCEPT");
  });

  test("reconnects after a network failure and resumes from the accepted cursor", async () => {
    const requests: string[] = [];
    let call = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      call += 1;
      if (call === 1) throw new Error("network down");
      if (call === 2) {
        return new Response(`id: 1\nevent: state\ndata: ${JSON.stringify(event(1))}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({ run: { state: "COMPLETED" }, lastError: null });
    }) as unknown as typeof fetch;
    const accepted: number[] = [];
    await streamEngineerEvents("run-1", (item) => accepted.push(item.sequence), new AbortController().signal, {
      maxReconnects: 2,
      reconnectDelayMs: 1,
    });
    expect(accepted).toEqual([1]);
    expect(requests.filter((url) => url.includes("/events"))).toHaveLength(2);
  });

  test("reports clean non-terminal disconnects after the reconnect budget is exhausted", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("/events")
      ? new Response("retry: 100\n\n", { headers: { "Content-Type": "text/event-stream" } })
      : Response.json({ run: { state: "PLANNING" }, lastError: null })) as typeof fetch;
    await expect(streamEngineerEvents("run-2", () => undefined, new AbortController().signal, {
      maxReconnects: 1,
      reconnectDelayMs: 1,
    })).rejects.toThrow("reconnect budget exhausted");
  });

  test("keeps reconnecting by default across a temporary local gateway outage", async () => {
    const controller = new AbortController();
    let attempts = 0;
    globalThis.fetch = (async (_input: string | URL | Request) => {
      attempts += 1;
      if (attempts === 3) controller.abort();
      throw new Error("gateway restarting");
    }) as unknown as typeof fetch;
    await expect(streamEngineerEvents("run-restart", () => undefined, controller.signal, {
      reconnectDelayMs: 1,
    })).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  test("treats REVIEW_APPROVED as a stream boundary only when the gateway says publication is disabled", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("/events")
      ? new Response("", { headers: { "Content-Type": "text/event-stream", "X-Zintus-Engineer-Review-Approved-Terminal": "false" } })
      : Response.json({ run: { state: "REVIEW_APPROVED" }, lastError: null })) as typeof fetch;
    await expect(streamEngineerEvents("run-publishing", () => undefined, new AbortController().signal, {
      maxReconnects: 1, reconnectDelayMs: 1,
    })).rejects.toThrow("reconnect budget exhausted");

    globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("/events")
      ? new Response("", { headers: { "Content-Type": "text/event-stream", "X-Zintus-Engineer-Review-Approved-Terminal": "true" } })
      : Response.json({ run: { state: "REVIEW_APPROVED" }, lastError: null })) as typeof fetch;
    await expect(streamEngineerEvents("run-review-only", () => undefined, new AbortController().signal, {
      maxReconnects: 1, reconnectDelayMs: 1,
    })).resolves.toBeUndefined();
  });
});
