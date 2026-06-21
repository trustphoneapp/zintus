// MIT License — see LICENSE file
import { compress } from "../pipeline/pipeline.js";
import type { CompressContext, Provider } from "../pipeline/types.js";
import {
  detectProvider,
  normalizeOpenAI,
  normalizeAnthropic,
  denormalizeToOpenAI,
  denormalizeToAnthropic,
} from "./adapter.js";
import { QuotaController } from "../quota/controller.js";

export interface ProxyConfig {
  port?: number;
  upstreamUrl?: string;
  provider?: Provider;
  apiKey?: string;
  tokenBudget?: number;
  mlEnabled?: boolean;
}

const DEFAULT_PORT = 8787;

const PROVIDER_ENDPOINTS: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  groq: "https://api.groq.com",
  generic: "https://api.openai.com",
};

export function createProxy(config: ProxyConfig = {}) {
  const port = config.port ?? DEFAULT_PORT;
  const quotaController = new QuotaController();

  const server = Bun.serve({
    port,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      // Health check
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "content-type": "application/json" },
        });
      }

      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const provider = config.provider ?? detectProvider(url, request.headers);
      const normalized =
        provider === "anthropic"
          ? normalizeAnthropic(body)
          : normalizeOpenAI(body);

      const ctx: CompressContext = {
        provider,
        model: normalized.model,
        tokenBudget: config.tokenBudget,
        quotaRemaining: quotaController.getQuotaRemaining(),
      };

      const { messages, systemPrompt } = await compress(
        { messages: normalized.messages, systemPrompt: normalized.systemPrompt },
        ctx,
      );

      let upstreamBody: Record<string, unknown>;
      if (provider === "anthropic") {
        upstreamBody = denormalizeToAnthropic(normalized, messages, systemPrompt);
      } else {
        upstreamBody = denormalizeToOpenAI(normalized, messages, systemPrompt);
      }

      const upstream = config.upstreamUrl ?? PROVIDER_ENDPOINTS[provider];
      const apiKey = config.apiKey ?? process.env["TOKZEN_API_KEY"];
      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: "No API key configured" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      const upstreamHeaders: Record<string, string> = {
        "content-type": "application/json",
      };

      if (provider === "anthropic") {
        upstreamHeaders["x-api-key"] = apiKey;
        upstreamHeaders["anthropic-version"] = "2023-06-01";
      } else {
        upstreamHeaders["authorization"] = `Bearer ${apiKey}`;
      }

      const upstreamResponse = await fetch(`${upstream}${url.pathname}`, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamBody),
      });

      // Record rate-limit headers for quota tracking
      const rlHeaders: Record<string, string | null> = {};
      for (const [k] of [
        ["x-ratelimit-remaining-requests"],
        ["x-ratelimit-remaining-tokens"],
        ["x-ratelimit-limit-requests"],
        ["x-ratelimit-limit-tokens"],
      ]) {
        if (k) rlHeaders[k] = upstreamResponse.headers.get(k);
      }
      quotaController.recordResponseHeaders(rlHeaders);

      // Stream response back transparently
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: {
          "content-type": upstreamResponse.headers.get("content-type") ?? "application/json",
        },
      });
    },
  });

  return server;
}

// CLI entry point
if (import.meta.main) {
  const port = parseInt(process.env["PORT"] ?? String(DEFAULT_PORT));
  const provider = (process.env["TOKZEN_PROVIDER"] ?? "openai") as Provider;
  createProxy({ port, provider });
  console.log(`[tokzen proxy] listening on port ${port}`);
}
