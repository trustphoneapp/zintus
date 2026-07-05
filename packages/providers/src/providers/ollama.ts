/// <reference types="node" />
import type {
  ChatMessage,
  Provider,
  StreamChatOptions,
  StreamChatResult,
} from "@zintus/types";
import { assertOkResponse } from "../utils.js";
import { usageFromProviderFields } from "../token-estimate.js";
import { isOllamaVisionModel } from "../capabilities.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/** Installed model names from `/api/tags`, or null when Ollama is unreachable. */
async function installedModelNames(baseUrl: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) return null;
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => m?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return null;
  }
}

/**
 * The first INSTALLED multimodal model (llava/moondream/… — see
 * OLLAMA_VISION_FAMILIES), or null when none is installed or Ollama is down.
 * This is the runtime half of local vision: the gateway calls it to resolve an
 * image request against what the user actually pulled, then pins that model so
 * the router's static `supportsVision("ollama", model)` check agrees.
 */
export async function installedLocalVisionModel(
  baseUrl = process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_URL,
): Promise<string | null> {
  const names = await installedModelNames(baseUrl);
  return names?.find((n) => isOllamaVisionModel(n)) ?? null;
}

/**
 * Convert engine ChatMessages to Ollama's native `/api/chat` shape. Ollama does
 * NOT speak OpenAI content parts: text rides in `content` and images ride in a
 * per-message `images: [base64]` array (raw base64, no data: prefix — exactly
 * what ImageContentBlock.data already is). Plain-string messages pass through
 * untouched; tool blocks are not sent (local tool turns never reach here).
 */
export function toOllamaMessages(
  messages: ChatMessage[],
): Array<{ role: string; content: string; images?: string[] }> {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const text = m.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const images = m.content
      .filter((b): b is Extract<typeof b, { type: "image" }> => b.type === "image")
      .map((b) => b.data);
    return images.length > 0
      ? { role: m.role, content: text, images }
      : { role: m.role, content: text };
  });
}

/**
 * Resolve the model to serve when the caller didn't pick one. The static
 * defaultModel ("llama3.3") is only a catalog label — users install whatever
 * they install, and requesting a model that isn't in `ollama list` 404s.
 * Prefer the static default when it IS installed, else the first installed
 * model; a clear error when Ollama is up but empty. Cached briefly so every
 * turn doesn't re-hit /api/tags.
 */
let cachedDefault: { at: number; model: string | null } | null = null;
async function installedDefaultModel(baseUrl: string): Promise<string | null> {
  if (cachedDefault && Date.now() - cachedDefault.at < 30_000) {
    return cachedDefault.model;
  }
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) return null;
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    const names = (data.models ?? [])
      .map((m) => m?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    const preferred = names.find(
      (n) => n === ollamaProvider.defaultModel || n.startsWith(`${ollamaProvider.defaultModel}:`),
    );
    const model = preferred ?? names[0] ?? null;
    cachedDefault = { at: Date.now(), model };
    return model;
  } catch {
    return null;
  }
}

export const ollamaProvider: Provider = {
  id: "ollama",
  name: "Ollama",
  color: "#8B5CF6",
  priority: 99,
  keyRegex: null,
  defaultModel: "llama3.3",

  async streamChat(
    messages: ChatMessage[],
    options: StreamChatOptions = {},
  ): Promise<StreamChatResult> {
    const baseUrl = process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_URL;
    let model = options.model;
    const hasImages = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image"),
    );
    // Image turn: the resolved model MUST be a multimodal family. Without an
    // explicit pick, resolve the first INSTALLED vision model; if none exists,
    // say exactly what to pull instead of letting a text model hallucinate over
    // an image it never saw.
    if (hasImages && (!model || !isOllamaVisionModel(model))) {
      const vision = await installedLocalVisionModel(baseUrl);
      if (!vision) {
        throw new Error(
          "No local vision model is installed — run `ollama pull moondream` (small) or `ollama pull llava` first.",
        );
      }
      model = vision;
    }
    // The router forwards the CATALOG default ("llama3.3") when the user only
    // picked the provider — but users serve whatever they pulled, and a
    // not-installed model 404s. Resolve our own placeholder against what is
    // actually installed; an explicitly-pinned other model still errors
    // honestly rather than being swapped.
    if (!model || model === ollamaProvider.defaultModel) {
      const installed = await installedDefaultModel(baseUrl);
      if (installed) {
        model = installed;
      } else if (cachedDefault?.model === null) {
        // Tags answered but no models exist — say exactly what to do.
        throw new Error(
          "Ollama is running but has no models installed — run `ollama pull llama3.2` (or any model) first.",
        );
      } else {
        model = model ?? ollamaProvider.defaultModel; // tags unreachable; let /api/chat surface the real error
      }
    }
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
      body: JSON.stringify({
        model,
        messages: toOllamaMessages(messages),
        stream: true,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens,
        },
      }),
    });

    await assertOkResponse(response, "Ollama");

    if (!response.body) {
      throw new Error("Ollama returned an empty response body");
    }

    const stream = (async function* () {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let servedModelEmitted = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            try {
              const parsed = JSON.parse(trimmed) as {
                model?: string;
                message?: { content?: string };
                done?: boolean;
                prompt_eval_count?: number;
                eval_count?: number;
              };
              if (!servedModelEmitted && parsed.model) {
                servedModelEmitted = true;
                yield { servedModel: parsed.model };
              }
              if (parsed.message?.content) {
                yield { content: parsed.message.content };
              }
              if (parsed.done) {
                const usage = usageFromProviderFields({
                  inputTokens: parsed.prompt_eval_count,
                  outputTokens: parsed.eval_count,
                });
                if (usage) {
                  yield { usage };
                }
                yield { done: true };
              }
            } catch {
              // Skip malformed NDJSON lines.
            }
          }
        }

        yield { done: true };
      } finally {
        reader.releaseLock();
      }
    })();

    return { stream };
  },

  async validateKey(): Promise<boolean> {
    const baseUrl = process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_URL;
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  },
};
