import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  JsonSchema,
  Provider,
  ProviderId,
  StreamChatOptions,
  StreamChatResult,
} from "@zintus/types";
import {
  ProviderHttpError,
  estimateUsage,
  structuredOutputLevel,
  supportsTools,
  supportsVision,
} from "@zintus/providers";
// Snapshot the REAL module by value at load so teardown can un-leak the module
// mock (bun's mock.restore() does NOT undo mock.module()); prevents the stubbed
// listProviders from leaking into sibling files (e.g. engine.test.ts).
import * as providersModuleLive from "@zintus/providers";
const realProvidersModule = { ...providersModuleLive };

/**
 * Structured-output (validate→repair) integration test: real engine → router →
 * quota ledger against stubbed providers (no network). Proves the buffered
 * structured branch validates, repairs, and labels guarantee/served-level
 * correctly. `gemini` + `gemini-2.5-flash` is a json_schema-level model in the
 * provider capability registry, so the served level is "json_schema".
 */

function stubProvider(
  id: ProviderId,
  streamChat: (
    messages: never,
    options: StreamChatOptions,
  ) => Promise<StreamChatResult>,
): Provider {
  return {
    id,
    name: id,
    color: "#000000",
    priority: 1,
    keyRegex: /^test$/,
    defaultModel: "gemini-2.5-flash",
    streamChat: streamChat as Provider["streamChat"],
    async validateKey() {
      return true;
    },
  };
}

/** A provider whose successive turns yield the texts in `responses` in order
 *  (last one repeats once exhausted). Counts how many turns it served. */
function scriptedProvider(id: ProviderId, responses: string[]) {
  let calls = 0;
  const provider = stubProvider(id, async () => {
    const text = responses[Math.min(calls, responses.length - 1)] ?? "";
    calls += 1;
    return {
      stream: (async function* () {
        yield { content: text };
      })(),
    };
  });
  return { provider, calls: () => calls };
}

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
  },
  required: ["name", "age"],
  additionalProperties: false,
};

describe("engine structured output (validate→repair)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zintus-engine-structured-"));
  });

  afterEach(() => {
    mock.restore();
    mock.module("@zintus/providers", () => realProvidersModule);
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeEngine(provider: Provider) {
    mock.module("@zintus/providers", () => ({
      listProviders: () => [provider],
      ProviderHttpError,
      estimateUsage,
      structuredOutputLevel,
      supportsTools,
      supportsVision,
    }));
    const { createEngine } = await import("./engine.js");
    return createEngine({
      conversationsPath: join(dir, "conversations.db"),
      dbPath: join(dir, "quota.db"),
      cachePath: join(dir, "cache.db"),
      memoryPath: join(dir, "memory.db"),
      getApiKey: async () => "test-key",
      persistConversations: true,
      persistTraces: true,
    });
  }

  test("(a) conforming JSON → parsed set, valid + guaranteed true, no repair", async () => {
    const { provider, calls } = scriptedProvider("gemini", [
      '{"name":"Ada","age":36}',
    ]);
    const engine = await makeEngine(provider);

    const result = await engine.routeAndStream({
      provider: "gemini",
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Give me a person" }],
      responseFormat: { type: "json_schema", schema: SCHEMA, strict: true },
    });

    // The stream replays the buffered text as a single chunk.
    let text = "";
    for await (const chunk of result.stream) text += chunk;
    expect(text).toBe('{"name":"Ada","age":36}');

    expect(result.parsed).toEqual({ name: "Ada", age: 36 });
    expect(result.structuredOutput).toMatchObject({
      requested: "json_schema",
      servedLevel: "json_schema",
      valid: true,
      guaranteed: true,
      repairAttempts: 0,
    });
    expect(result.structuredOutput?.issues).toBeUndefined();
    // First response was already valid — only one provider turn.
    expect(calls()).toBe(1);
  });

  test("(b) invalid then a repair returns valid JSON → repairAttempts >= 1, valid true", async () => {
    const { provider, calls } = scriptedProvider("gemini", [
      // First turn: wrong type for `age` (string, schema wants number).
      '{"name":"Ada","age":"thirty-six"}',
      // Repair turn: corrected.
      '{"name":"Ada","age":36}',
    ]);
    const engine = await makeEngine(provider);

    const result = await engine.routeAndStream({
      provider: "gemini",
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Give me a person" }],
      responseFormat: { type: "json_schema", schema: SCHEMA },
    });

    let text = "";
    for await (const chunk of result.stream) text += chunk;
    expect(text).toBe('{"name":"Ada","age":36}');

    expect(result.structuredOutput?.valid).toBe(true);
    expect(result.structuredOutput?.repairAttempts).toBeGreaterThanOrEqual(1);
    expect(result.parsed).toEqual({ name: "Ada", age: 36 });
    // One initial turn + one repair turn.
    expect(calls()).toBe(2);
  });

  test("(c) still invalid after exhausting repairs → valid false, parsed undefined", async () => {
    const { provider, calls } = scriptedProvider("gemini", [
      "this is not JSON at all",
    ]);
    const engine = await makeEngine(provider);

    const result = await engine.routeAndStream({
      provider: "gemini",
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Give me a person" }],
      responseFormat: { type: "json_schema", schema: SCHEMA },
    });

    let text = "";
    for await (const chunk of result.stream) text += chunk;

    expect(result.structuredOutput?.valid).toBe(false);
    expect(result.structuredOutput?.guaranteed).toBe(false);
    // Default maxRepairAttempts is 2 (server cap) — one initial + two repairs.
    expect(result.structuredOutput?.repairAttempts).toBe(2);
    expect(result.structuredOutput?.issues?.length).toBeGreaterThan(0);
    expect(result.parsed).toBeUndefined();
    expect(calls()).toBe(3);
  });

  test("json_object request → syntactic validity only (no schema)", async () => {
    const { provider } = scriptedProvider("gemini", [
      'Here is the JSON: {"any":"shape","n":1}',
    ]);
    const engine = await makeEngine(provider);

    const result = await engine.routeAndStream({
      provider: "gemini",
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Give me JSON" }],
      responseFormat: { type: "json_object" },
    });

    let text = "";
    for await (const chunk of result.stream) text += chunk;

    expect(result.structuredOutput?.requested).toBe("json_object");
    expect(result.structuredOutput?.valid).toBe(true);
    expect(result.structuredOutput?.repairAttempts).toBe(0);
    // extractJsonObject salvaged the JSON out of the surrounding prose.
    expect(result.parsed).toEqual({ any: "shape", n: 1 });
  });

  // ── Honesty: served_level/guaranteed reflect the level ACTUALLY served ──────
  test("(honesty) json_object → gemini is labeled served_level json_object, guaranteed FALSE", async () => {
    // gemini IS json_schema-capable, but a json_object request only enforces native
    // JSON mode (no schema). The engine must NOT over-claim json_schema/guaranteed.
    const { provider } = scriptedProvider("gemini", ['{"any":"shape","n":1}']);
    const engine = await makeEngine(provider);

    const result = await engine.routeAndStream({
      provider: "gemini",
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Give me JSON" }],
      responseFormat: { type: "json_object" },
    });

    let text = "";
    for await (const chunk of result.stream) text += chunk;

    expect(result.structuredOutput?.requested).toBe("json_object");
    expect(result.structuredOutput?.servedLevel).toBe("json_object");
    expect(result.structuredOutput?.valid).toBe(true);
    // Even though validation passed, json_object is NOT a guaranteed schema.
    expect(result.structuredOutput?.guaranteed).toBe(false);
  });

  // ── Repair preserves strict role alternation (assistant turn, then user) ─────
  test("(repair) re-dispatch appends an assistant turn then a user turn — roles alternate", async () => {
    // Capture the messages each provider turn receives so we can assert the repair
    // conversation never has consecutive same-role turns (Gemini requires this).
    const seenMessages: { role: string }[][] = [];
    let calls = 0;
    const responses = [
      // First turn: wrong type for `age` → invalid → forces a repair.
      '{"name":"Ada","age":"thirty-six"}',
      // Repair turn: corrected.
      '{"name":"Ada","age":36}',
    ];
    const provider = stubProvider("gemini", async (messages) => {
      seenMessages.push(
        (messages as unknown as { role: string }[]).map((m) => ({ role: m.role })),
      );
      const text = responses[Math.min(calls, responses.length - 1)] ?? "";
      calls += 1;
      return {
        stream: (async function* () {
          yield { content: text };
        })(),
      };
    });
    const engine = await makeEngine(provider);

    const result = await engine.routeAndStream({
      provider: "gemini",
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Give me a person" }],
      responseFormat: { type: "json_schema", schema: SCHEMA },
    });

    let text = "";
    for await (const chunk of result.stream) text += chunk;
    expect(result.structuredOutput?.valid).toBe(true);
    expect(result.structuredOutput?.repairAttempts).toBeGreaterThanOrEqual(1);

    // Two turns: the initial and the repair re-dispatch.
    expect(seenMessages.length).toBe(2);
    const repairTurn = seenMessages[1]!;
    // The repair conversation ends with assistant(prior output) THEN user(repair),
    // and never has two same-role turns back to back.
    const roles = repairTurn.map((m) => m.role);
    expect(roles.slice(-2)).toEqual(["assistant", "user"]);
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i]).not.toBe(roles[i - 1]);
    }
  });

  // ── A tools request must never be served a cached plain-text answer ──────────
  test("(cache) a tools request does NOT return a cached text answer", async () => {
    let calls = 0;
    const provider = stubProvider("gemini", async (_messages, options) => {
      calls += 1;
      const hasTools = (options.tools?.length ?? 0) > 0;
      return {
        stream: (async function* () {
          if (hasTools) {
            yield {
              toolCall: {
                type: "tool_call" as const,
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
              },
            };
          } else {
            yield { content: "the weather is sunny" };
          }
        })(),
      };
    });
    const engine = await makeEngine(provider);

    const messages = [{ role: "user" as const, content: "weather in Paris?" }];

    // 1) Prime the cache with a plain-text (non-tools) answer for this prompt.
    const first = await engine.routeAndStream({
      provider: "gemini",
      model: "gemini-2.5-flash",
      messages,
    });
    let firstText = "";
    for await (const chunk of first.stream) firstText += chunk;
    expect(firstText).toBe("the weather is sunny");
    expect(calls).toBe(1);

    // 2) Same prompt, now WITH tools — must bypass the cache READ and hit the model,
    //    surfacing tool calls instead of replaying the cached text.
    const second = await engine.routeAndStream({
      provider: "gemini",
      model: "gemini-2.5-flash",
      messages,
      tools: [
        {
          name: "get_weather",
          description: "Get the weather",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    let secondText = "";
    for await (const chunk of second.stream) secondText += chunk;

    // The model was actually invoked (not a cache replay), and tool calls surfaced.
    expect(calls).toBe(2);
    expect(secondText).not.toBe("the weather is sunny");
    expect(second.toolCalls?.length).toBe(1);
    expect(second.toolCalls?.[0]?.name).toBe("get_weather");
  });
});
