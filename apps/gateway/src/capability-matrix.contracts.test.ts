import { afterEach, describe, expect, test } from "bun:test";
import { PROVIDER_IDS, type ProviderId } from "@zintus/types";
import {
  MODEL_CAPABILITIES,
  supportsTools,
  supportsVision,
  structuredOutputLevel,
} from "@zintus/providers";
import { createMockProvider } from "@zintus/test-utils";
import { createTestGateway } from "@zintus/test-utils/bun";

// P1 CONTRACT MATRIX (OpenRouter×Manus plan §P1): for EVERY provider in the
// union, the gateway's capability gating must agree exactly with the
// capability registry — a tools / image / strict-schema request forced at a
// provider either routes (registry says capable) or 422s with
// `unsupported_capability` (registry says not). Expectations are COMPUTED from
// the registry functions rather than hardcoded, so adding provider #23 in
// manifest.ts automatically extends the matrix and any gating/registry drift
// fails here. This is the unit half of the "/v1 drop-in guarantee"; live keyed
// conformance against the real APIs is a [HUMAN] gate.

function chatRequest(body: Record<string, unknown>): Request {
  return new Request("http://test.local/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      ...body,
    }),
  });
}

const WEATHER_TOOL = {
  name: "get_weather",
  description: "test tool",
  parameters: { type: "object", properties: {} },
};

const IMAGE_MESSAGES = [
  {
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      {
        type: "image",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
        bytes: 1024,
        exifStripped: true,
      },
    ],
  },
];

describe("capability contract matrix — gating mirrors the registry for all providers", () => {
  let cleanup: () => void = () => {};
  afterEach(() => cleanup());

  async function gatewayFor(id: ProviderId) {
    const gw = await createTestGateway({
      providers: [
        createMockProvider({
          id,
          content: '{"ok":true}',
          // The model-aware capability gate fails closed on an unknown model
          // id, so the mock must serve the provider's REAL registry default.
          defaultModel: MODEL_CAPABILITIES[id].model,
        }),
      ],
    });
    cleanup = gw.cleanup;
    return gw.handler;
  }

  async function expectGate(res: Response, capable: boolean, cap: string) {
    if (capable) {
      expect(res.status).toBe(200);
    } else {
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        error: { type: string; required: string[] };
      };
      expect(body.error.type).toBe("unsupported_capability");
      expect(body.error.required).toContain(cap);
    }
  }

  for (const id of PROVIDER_IDS) {
    test(`${id}: tools request ${supportsTools(id) ? "routes" : "422s"}`, async () => {
      const handler = await gatewayFor(id);
      const res = await handler(
        chatRequest({ provider: id, tools: [WEATHER_TOOL] }),
      );
      await expectGate(res, supportsTools(id), "tools");
    });

    test(`${id}: image request ${supportsVision(id) ? "routes" : "422s"}`, async () => {
      const handler = await gatewayFor(id);
      const res = await handler(
        chatRequest({ provider: id, messages: IMAGE_MESSAGES }),
      );
      await expectGate(res, supportsVision(id), "vision");
    });

    const strict = structuredOutputLevel(id) === "json_schema";
    test(`${id}: strict json_schema request ${strict ? "routes" : "422s"}`, async () => {
      const handler = await gatewayFor(id);
      const res = await handler(
        chatRequest({
          provider: id,
          response_format: {
            type: "json_schema",
            schema: { type: "object", properties: { ok: { type: "boolean" } } },
            strict: true,
          },
        }),
      );
      await expectGate(res, strict, "json_schema");
    });
  }

  // Ollama local vision is RUNTIME-resolved, not registry-static: an explicit
  // ollama image request serves when an installed multimodal model resolves
  // (the gateway pins it as the request model) and 422s when none does. The
  // matrix loop above covers the none-installed default (localVisionModel →
  // null); this covers the installed path deterministically.
  test("ollama: image request routes via the runtime-resolved local vision model", async () => {
    const gw = await createTestGateway({
      providers: [
        createMockProvider({
          id: "ollama",
          content: '{"ok":true}',
          defaultModel: MODEL_CAPABILITIES.ollama.model,
        }),
      ],
      localVisionModel: async () => "moondream:latest",
    });
    cleanup = gw.cleanup;
    const res = await gw.handler(
      chatRequest({ provider: "ollama", messages: IMAGE_MESSAGES }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model?: string };
    // The resolved vision model was pinned into the request.
    expect(body.model).toBe("moondream:latest");
  });

  // AUTO image routing falls back to the installed local vision model when no
  // static vision candidate is eligible (e.g. no Gemini key): the router's
  // unsupported_capability is retried once via ollama before any 422. Without
  // an installed local vision model the honest 422 stands (matrix loop above +
  // handler tests cover that via the null default).
  test("auto: image request with no vision candidate falls back to local vision", async () => {
    const gw = await createTestGateway({
      providers: [
        createMockProvider({
          id: "ollama",
          content: '{"ok":true}',
          defaultModel: MODEL_CAPABILITIES.ollama.model,
        }),
      ],
      localVisionModel: async () => "moondream:latest",
    });
    cleanup = gw.cleanup;
    // No `provider` → auto routing; the only candidate (ollama) is statically
    // non-vision, so the router throws and the gateway retries via local vision.
    const res = await gw.handler(chatRequest({ messages: IMAGE_MESSAGES }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model?: string };
    expect(body.model).toBe("moondream:latest");
  });
});
