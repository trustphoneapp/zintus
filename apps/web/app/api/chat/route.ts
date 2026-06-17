import type { ContextMode, ProviderId } from "@multipleai/types";

export const runtime = "nodejs";

export async function POST() {
  return new Response(
    [
      "Chat routing runs through the Bun gateway, not Next.js.",
      "",
      "Start it from the repo root:",
      "  bun run dev:gateway",
      "",
      "Then add keys with the CLI:",
      "  bun run dev:cli -- keys set groq <your-key>",
    ].join("\n"),
    {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    },
  );
}

// Keep a typed export so this file stays a valid route module if extended later.
export type ChatApiBody = {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  provider?: ProviderId;
  mode?: ContextMode;
};
